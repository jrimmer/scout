import { execFile } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord";
import {
	ExecutionError,
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
 * A host-owned bare mirror of a remote. Clones made from it are cheap, and pushes go out through it, so the host
 * never runs git inside a clone an agent has written to.
 */
export class Mirror {
	readonly path: string;
	readonly gitUrl: string;
	#queue: Promise<void> = Promise.resolve();

	constructor(path: string, gitUrl: string) {
		this.path = path;
		this.gitUrl = gitUrl;
	}

	/** Fetch from the remote, or create the mirror. Serialized: one fetch at a time. */
	refresh(): Promise<void> {
		const next = this.#queue.then(async () => {
			if (await exists(this.path)) await git(["-C", this.path, "fetch", "--quiet", "--prune", "origin"]);
			else await git(["clone", "--mirror", "--quiet", this.gitUrl, this.path]);
		});
		this.#queue = next.catch(() => {});
		return next;
	}

	/** A fresh clone on a new branch from `base`, unless `dir` already holds one. */
	async clone(dir: string, branch: string, base: string, identity: { name: string; email: string }): Promise<void> {
		if (await exists(join(dir, ".git"))) return;
		await this.refresh();
		await git(["clone", "--no-hardlinks", "--quiet", this.path, dir]);
		await git(["-C", dir, "remote", "set-url", "origin", this.gitUrl]);
		await git(["-C", dir, "checkout", "--quiet", "-b", branch, `origin/${base}`]);
		await git(["-C", dir, "config", "user.name", identity.name]);
		await git(["-C", dir, "config", "user.email", identity.email]);
	}
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
	readonly mirror: Mirror;

	constructor(config: SandboxConfig) {
		this.#config = config;
		mkdirSync(config.dataDir, { recursive: true });
		this.#dataDir = realpathSync(config.dataDir);
		this.mirror = new Mirror(join(this.#dataDir, "mirror.git"), config.repo.gitUrl);
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
		await this.mirror.clone(paths.repo, this.branch(conversationId), this.#config.repo.base, this.#config.git);
		return paths;
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
 * File tools on the host, confined to one directory: every path is resolved, symlinks included, and checked against
 * `root`. With `protectGit`, nothing under a `.git` directory can be touched either, so a host that later runs git
 * in this directory runs none of the agent's hooks or config. It runs no commands; see `SandboxEnv` for that.
 */
export class ConfinedEnv extends NodeExecutionEnv {
	override readonly id: string;
	readonly root: string;
	readonly tmp: string;
	readonly #protectGit: boolean;

	constructor(options: { id: string; cwd: string; root: string; tmp: string; protectGit?: boolean }) {
		super({ cwd: options.cwd });
		this.id = options.id;
		this.root = options.root;
		this.tmp = options.tmp;
		this.#protectGit = options.protectGit ?? false;
	}

	override async exec(
		_command: string | readonly string[],
		_options: ShellExecOptions | undefined,
		_context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		return err(new ExecutionError("shell_unavailable", "There is no shell here; use the file tools."));
	}

	async #confine(path: string): Promise<Result<string, FileError>> {
		const absolute = resolve(this.cwd, path);
		let existing = absolute;
		let suffix = "";
		for (;;) {
			try {
				const real = await realpath(existing);
				const full = suffix === "" ? real : join(real, suffix);
				const rel = relative(this.root, full);
				const inside = rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
				if (!inside) return err(new FileError("permission_denied", `Outside this workspace: ${path}`, path));
				if (this.#protectGit && rel.split(sep).includes(".git")) {
					return err(new FileError("permission_denied", `Git's own files are off limits: ${path}`, path));
				}
				return ok(full);
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
	/** Temp files (spilled command output too) go inside the workspace, where the file tools can read them. */
	override async createTempDir(prefix: string | undefined, _context: Context) {
		try {
			return ok<string, FileError>(await mkdtemp(join(this.tmp, prefix ?? "tmp-")));
		} catch (error) {
			return err<string, FileError>(new FileError("unknown", String(error)));
		}
	}
}

/**
 * A thread's workspace: file tools confined to its directory (see `ConfinedEnv`), and every command run in its
 * container. The directory is bind-mounted at the same path, so both sides see the same files at the same paths.
 */
export class SandboxEnv extends ConfinedEnv {
	readonly container: string;
	readonly paths: ThreadPaths;

	constructor(container: string, paths: ThreadPaths) {
		super({ id: `docker:${container}`, cwd: paths.repo, root: paths.root, tmp: paths.tmp });
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
		// Stopping work stops everything running in the thread's container (all but its idle PID 1).
		context.abortSignal?.addEventListener(
			"abort",
			() => void run("docker", ["exec", this.container, "sh", "-c", "kill -KILL -1"]).catch(() => {}),
			{ once: true },
		);
		// The docker CLI itself runs on the host; it gets the host environment, the container does not. Node's own exec
		// (not ConfinedEnv's refusal) runs it, and spills long output into this workspace's tmp via createTempDir.
		const { env: _env, cwd: _cwd, inheritEnv: _inherit, ...rest } = options ?? {};
		return NodeExecutionEnv.prototype.exec.call(this, argv, { ...rest, cwd: this.root, inheritEnv: true }, context);
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
