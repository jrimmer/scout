import { execFile } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord";
import {
	type ExecutionError,
	FileError,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type WatchChange,
	type WatchTarget,
	err,
	ok,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

const run = promisify(execFile);

export type SandboxConfig = {
	dataDir: string;
	/** Random per install, so names stay unique if the data directory is ever reset. */
	instance: string;
	repo: { gitUrl: string; base: string };
	sandbox: { image: string; network: string; memory: string };
	git: { name: string; email: string };
};

/** Where one thread's files live on the host. The container mounts `root` at the same path, so paths agree. */
export type ThreadPaths = { root: string; repo: string; home: string; tmp: string };

export function threadPaths(dataDir: string, instance: string, conversationId: number): ThreadPaths {
	const root = join(dataDir, "threads", `${instance}-${conversationId}`);
	return { root, repo: join(root, "repo"), home: join(root, "home"), tmp: join(root, "tmp") };
}

export function branchFor(instance: string, conversationId: number): string {
	return `scout/${instance}-${conversationId}`;
}

function containerFor(instance: string, conversationId: number): string {
	return `scout-${instance}-${conversationId}`;
}

/**
 * One workspace per Slack thread: a clone of the repo on its own branch, and a container that runs commands in it.
 *
 * The harness, credentials, and Slack stay on the host. The container gets the thread's directory and nothing else:
 * no host environment, no git credentials, no network unless configured. Pushing and opening pull requests happen
 * on the host (see codehost.ts).
 */
export class Workspaces {
	readonly #config: SandboxConfig;
	readonly #dataDir: string;
	readonly #prepared = new Map<number, Promise<ThreadPaths>>();
	#mirror: Promise<void> = Promise.resolve();

	constructor(config: SandboxConfig) {
		this.#config = config;
		mkdirSync(config.dataDir, { recursive: true });
		this.#dataDir = realpathSync(config.dataDir);
	}

	paths(conversationId: number): ThreadPaths {
		return threadPaths(this.#dataDir, this.#config.instance, conversationId);
	}

	branch(conversationId: number): string {
		return branchFor(this.#config.instance, conversationId);
	}

	/** Execution environment for a conversation's tool calls; prepares the workspace on first use. */
	async env(conversationId: number): Promise<SandboxEnv> {
		const paths = await this.prepare(conversationId);
		const container = containerFor(this.#config.instance, conversationId);
		await this.#ensureContainer(conversationId, container, paths);
		return new SandboxEnv(container, paths);
	}

	prepare(conversationId: number): Promise<ThreadPaths> {
		let prepared = this.#prepared.get(conversationId);
		if (prepared === undefined) {
			prepared = this.#prepare(conversationId);
			prepared.catch(() => this.#prepared.delete(conversationId));
			this.#prepared.set(conversationId, prepared);
		}
		return prepared;
	}

	async #prepare(conversationId: number): Promise<ThreadPaths> {
		const paths = this.paths(conversationId);
		await mkdir(paths.home, { recursive: true });
		await mkdir(paths.tmp, { recursive: true });
		if (await exists(join(paths.repo, ".git"))) return paths;

		await this.#refreshMirror();
		const mirror = join(this.#dataDir, "mirror.git");
		const { gitUrl, base } = this.#config.repo;
		await git(["clone", "--no-hardlinks", "--quiet", mirror, paths.repo]);
		await git(["-C", paths.repo, "remote", "set-url", "origin", gitUrl]);
		await git(["-C", paths.repo, "checkout", "--quiet", "-b", this.branch(conversationId), `origin/${base}`]);
		await git(["-C", paths.repo, "config", "user.name", this.#config.git.name]);
		await git(["-C", paths.repo, "config", "user.email", this.#config.git.email]);
		return paths;
	}

	/** A local mirror makes each thread's clone cheap. Serialized: one fetch at a time. */
	#refreshMirror(): Promise<void> {
		const mirror = join(this.#dataDir, "mirror.git");
		const next = this.#mirror.then(async () => {
			if (await exists(mirror)) await git(["-C", mirror, "fetch", "--quiet", "--prune", "origin"]);
			else await git(["clone", "--mirror", "--quiet", this.#config.repo.gitUrl, mirror]);
		});
		this.#mirror = next.catch(() => {});
		return next;
	}

	async #ensureContainer(conversationId: number, name: string, paths: ThreadPaths): Promise<void> {
		const state = await run("docker", ["inspect", "-f", "{{.State.Running}}", name]).then(
			(out) => out.stdout.trim(),
			() => "missing",
		);
		if (state === "true") return;
		if (state === "false") {
			await run("docker", ["start", name]);
			return;
		}
		const { sandbox } = this.#config;
		await run("docker", [
			"run", "--detach", "--name", name,
			"--label", "scout.conversation=" + conversationId,
			"--network", sandbox.network,
			"--memory", sandbox.memory,
			"--pids-limit", "1024",
			"--cap-drop", "ALL",
			"--security-opt", "no-new-privileges",
			"--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
			"--env", `HOME=${paths.home}`,
			"--env", `TMPDIR=${paths.tmp}`,
			"--volume", `${paths.root}:${paths.root}`,
			"--workdir", paths.repo,
			sandbox.image,
			"sleep", "infinity",
		]);
	}

	/** Stop a thread's container; its files stay, and the next tool call starts it again. */
	async stop(conversationId: number): Promise<void> {
		await run("docker", ["stop", "--time", "5", containerFor(this.#config.instance, conversationId)]).catch(() => {});
	}
}

/**
 * Runs every command in the thread's container and confines file tools to the thread's directory.
 *
 * File reads and writes happen on the host against the bind-mounted directory (same path inside and out), so they
 * must not reach anything else on the host: every path is resolved, symlinks included, and checked against `root`.
 */
export class SandboxEnv extends NodeExecutionEnv {
	override readonly id: string;
	readonly container: string;
	readonly paths: ThreadPaths;

	constructor(container: string, paths: ThreadPaths) {
		super({ cwd: paths.repo });
		this.id = `docker:${container}`;
		this.container = container;
		this.paths = paths;
	}

	override async exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		const cwd = resolve(this.cwd, options?.cwd ?? ".");
		const inner = typeof command === "string" ? ["bash", "-lc", command] : [...command];
		// Killing the local `docker exec` does not stop the process in the container; a timeout inside it does.
		const timed = options?.timeout === undefined ? inner : ["timeout", "-k", "5", `${options.timeout}s`, ...inner];
		const envFlags = Object.entries(options?.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
		const argv = ["docker", "exec", "--workdir", cwd, ...envFlags, this.container, ...timed];
		// The docker CLI itself runs on the host; it gets the host environment, the container does not.
		const { env: _env, cwd: _cwd, inheritEnv: _inherit, ...rest } = options ?? {};
		return super.exec(argv, { ...rest, cwd: this.paths.root, inheritEnv: true }, context);
	}

	async #confine(path: string): Promise<Result<string, FileError>> {
		const absolute = resolve(this.cwd, path);
		let existing = absolute;
		let suffix = "";
		for (;;) {
			try {
				const real = await realpath(existing);
				const full = suffix === "" ? real : join(real, suffix);
				const rel = relative(this.paths.root, full);
				if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return ok(full);
				return err(new FileError("permission_denied", `Outside this thread's workspace: ${path}`, path));
			} catch {
				const parent = dirname(existing);
				if (parent === existing) return err(new FileError("not_found", `No such path: ${path}`, path));
				suffix = suffix === "" ? relative(parent, existing) : join(relative(parent, existing), suffix);
				existing = parent;
			}
		}
	}

	override async readTextFile(path: string, context: Context) {
		const p = await this.#confine(path);
		return p.ok ? super.readTextFile(p.value, context) : p;
	}
	override async openTextLineReader(path: string, context: Context) {
		const p = await this.#confine(path);
		return p.ok ? super.openTextLineReader(p.value, context) : p;
	}
	override async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context) {
		const p = await this.#confine(path);
		return p.ok ? super.readTextLines(p.value, options, context) : p;
	}
	override async readBinaryFile(path: string, context: Context) {
		const p = await this.#confine(path);
		return p.ok ? super.readBinaryFile(p.value, context) : p;
	}
	override async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context) {
		const p = await this.#confine(path);
		return p.ok ? super.openBinaryReader(p.value, options, context) : p;
	}
	override async writeFile(path: string, content: string | Uint8Array, context: Context) {
		const p = await this.#confine(path);
		return p.ok ? super.writeFile(p.value, content, context) : p;
	}
	override async appendFile(path: string, content: string | Uint8Array, context: Context) {
		const p = await this.#confine(path);
		return p.ok ? super.appendFile(p.value, content, context) : p;
	}
	override async truncateFile(path: string, size: number, context: Context) {
		const p = await this.#confine(path);
		return p.ok ? super.truncateFile(p.value, size, context) : p;
	}
	override async flushFile(path: string, context: Context) {
		const p = await this.#confine(path);
		return p.ok ? super.flushFile(p.value, context) : p;
	}
	override async renameFile(sourcePath: string, destinationPath: string, context: Context) {
		const source = await this.#confine(sourcePath);
		if (!source.ok) return source;
		const destination = await this.#confine(destinationPath);
		return destination.ok ? super.renameFile(source.value, destination.value, context) : destination;
	}
	override async fileInfo(path: string, context: Context) {
		const p = await this.#confine(path);
		return p.ok ? super.fileInfo(p.value, context) : p;
	}
	override async listDir(path: string, context: Context) {
		const p = await this.#confine(path);
		return p.ok ? super.listDir(p.value, context) : p;
	}
	override async openDirReader(path: string, context: Context) {
		const p = await this.#confine(path);
		return p.ok ? super.openDirReader(p.value, context) : p;
	}
	override async canonicalPath(path: string, context: Context) {
		const p = await this.#confine(path);
		return p.ok ? super.canonicalPath(p.value, context) : p;
	}
	override async exists(path: string, context: Context) {
		const p = await this.#confine(path);
		if (!p.ok) return p.error.code === "not_found" ? ok<boolean, FileError>(false) : p;
		return super.exists(p.value, context);
	}
	override async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) {
		const p = await this.#confine(path);
		return p.ok ? super.createDir(p.value, options, context) : p;
	}
	override async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context) {
		const p = await this.#confine(path);
		return p.ok ? super.remove(p.value, options, context) : p;
	}
	override async watch(targets: readonly WatchTarget[], onChange: (change: WatchChange) => void, context: Context) {
		const confined: WatchTarget[] = [];
		for (const target of targets) {
			const p = await this.#confine(target.path);
			if (!p.ok) return p;
			confined.push({ ...target, path: p.value });
		}
		return super.watch(confined, onChange, context);
	}
	/** Temp files (spilled command output too) go in the thread's directory, where the file tools can read them. */
	override async createTempDir(prefix: string | undefined, _context: Context) {
		try {
			return ok<string, FileError>(await mkdtemp(join(this.paths.tmp, prefix ?? "tmp-")));
		} catch (error) {
			return err<string, FileError>(new FileError("unknown", String(error)));
		}
	}
}

async function git(args: string[]): Promise<void> {
	await run("git", args, { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

async function exists(path: string): Promise<boolean> {
	return realpath(path).then(
		() => true,
		() => false,
	);
}
