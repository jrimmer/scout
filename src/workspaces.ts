import { mkdirSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Connection, type ConnectionOptions, type Reply, RemoteExecutionEnv, type RequestOptions } from "@earendil-works/pi-env";
import type { NetworkPolicy, SandboxDriver, SandboxHandle, SandboxSpec } from "./drivers/types.ts";
import { Mirror } from "./sandbox.ts";

const run = promisify(execFile);
/** Bytes per write when copying a bundle into a sandbox. */
const CHUNK = 4 * 1024 * 1024;

export type WorkspaceRepo = {
	name: string;
	gitUrl: string;
	base: string;
	/** This repository's own sandbox image. */
	image?: string;
	/** A saved sandbox its threads start from (spoond). */
	snapshot?: string;
	/** Hosts its sandboxes may reach, on substrates that can limit egress; otherwise the default network. */
	egress?: string[];
};

export type WorkspacesConfig = {
	dataDir: string;
	/** Random per install; keeps sandbox and branch names unique if the data directory is ever reset. */
	instance: string;
	/** The first is the default. */
	repos: WorkspaceRepo[];
	driver: SandboxDriver;
	sandbox: { image: string; network: "none" | "open"; size?: string };
	git: { name: string; email: string };
};

/**
 * A daemon connection that knows when it's idle. Substrates may limit open connections (spoond limits streams per
 * account), so a thread holds one only while its tools run, not while it waits for people.
 */
class TrackedConnection extends Connection {
	inFlight = 0;
	lastUsed = Date.now();
	/** Scout closed it; what its transport says from here on is about its own ending. */
	closing = false;

	override close(): void {
		this.closing = true;
		super.close();
	}

	override async request(op: string, json: Record<string, unknown>, options?: RequestOptions): Promise<Reply> {
		this.inFlight++;
		try {
			return await super.request(op, json, options);
		} finally {
			this.inFlight--;
			this.lastUsed = Date.now();
		}
	}
}

/** A prepared workspace; `connection` is its daemon's, absent on substrates that serve files and commands themselves. */
type Opened = { handle: SandboxHandle; connection?: TrackedConnection; repo: WorkspaceRepo };

/** Left in a sandbox built as an image (`buildImage`); a thread that finds it adopts the prebuilt checkout. */
const IMAGE_MARK = ".scout/image";

/** The snapshot a repository's image is saved as. */
export function imageName(repoName: string): string {
	return `scout/${repoName}`;
}

/** How long a sandbox connection may sit unused before it's closed; the next tool call opens it again. */
const IDLE_DISCONNECT_MS = 2 * 60 * 1000;

/**
 * One workspace per conversation: a sandbox from the configured driver, holding a clone of the conversation's
 * repository on its own branch. Everything inside goes through the sandbox's pi-env daemon, so this works the same on
 * any substrate, and nothing a thread writes ever lands on Scout's host.
 *
 * Git crosses the boundary as bundles: the host-owned mirror makes one of the base branch for the clone, and the
 * sandbox makes one of its new commits for a pull request. No sandbox holds credentials or reaches the code host.
 */
export class Workspaces {
	readonly #config: WorkspacesConfig;
	readonly #dataDir: string;
	readonly #mirrors = new Map<string, Mirror>();
	readonly #open = new Map<number, Promise<Opened>>();
	readonly #connected = new Set<number>();
	/** Which repository a conversation works in; set once the harness exists. */
	repoOf: (conversationId: number) => Promise<string | undefined> = async () => undefined;
	/** A conversation's own base branch, when it isn't the repository's (a reviewed pull request's branch). */
	baseOf: (conversationId: number) => Promise<string | undefined> = async () => undefined;
	/** The snapshot Scout built for a repository (images.ts), which its new threads start from, if there is one. */
	builtImage: (repoName: string) => string | undefined = () => undefined;
	/** What a conversation is about and where it's discussed, to label its sandbox for people. */
	describe: (conversationId: number) => Promise<{ about?: string; link?: string }> = async () => ({});
	readonly #sweep: ReturnType<typeof setInterval>;

	constructor(config: WorkspacesConfig) {
		if (config.repos.length === 0) throw new Error("no repositories configured");
		this.#config = config;
		mkdirSync(config.dataDir, { recursive: true });
		this.#dataDir = realpathSync(config.dataDir);
		for (const repo of config.repos) {
			this.#mirrors.set(repo.name, new Mirror(join(this.#dataDir, "mirrors", `${repo.name}.git`), repo.gitUrl));
		}
		this.#sweep = setInterval(() => void this.disconnectIdle(), 30_000);
		this.#sweep.unref();
	}

	/** Close daemon connections nothing has used for a while. Their sandboxes keep running; files stay. */
	async disconnectIdle(now = Date.now(), idleMs = IDLE_DISCONNECT_MS): Promise<number> {
		let closed = 0;
		for (const [id, pending] of this.#open) {
			const opened = await pending.catch(() => undefined);
			const connection = opened?.connection;
			if (connection === undefined || connection.inFlight > 0 || now - connection.lastUsed < idleMs) continue;
			if (this.#open.get(id) !== pending) continue;
			this.#open.delete(id);
			this.#connected.delete(id);
			try {
				connection.close();
			} catch {}
			closed++;
		}
		return closed;
	}

	/** Conversations with a daemon connection open right now. */
	get connected(): number {
		return this.#connected.size;
	}

	get driver(): SandboxDriver {
		return this.#config.driver;
	}

	/** A repository by name; the default for an empty or unknown name. */
	repo(name: string | undefined): WorkspaceRepo {
		return this.#config.repos.find((r) => r.name === name) ?? this.#config.repos[0]!;
	}

	mirrorFor(name: string | undefined): Mirror {
		return this.#mirrors.get(this.repo(name).name)!;
	}

	/** The default repository's mirror. */
	get mirror(): Mirror {
		return this.mirrorFor(undefined);
	}

	branch(conversationId: number): string {
		return `scout/${this.#config.instance}-${conversationId}`;
	}

	key(conversationId: number): string {
		return `${this.#config.instance}-${conversationId}`;
	}

	/** What a repository's sandboxes get: its image, and its egress allowlist where the substrate can enforce one. */
	spec(repo: WorkspaceRepo, conversationId: number): SandboxSpec {
		const { driver, sandbox } = this.#config;
		let network: NetworkPolicy = { mode: sandbox.network };
		if (repo.egress !== undefined) {
			const allow: NetworkPolicy = { mode: "allow", hosts: repo.egress };
			if (driver.supports(allow)) network = allow;
			else console.error(`${driver.name} can't limit ${repo.name}'s sandboxes to its egress list; using "${sandbox.network}"`);
		}
		const snapshot = this.builtImage(repo.name) ?? repo.snapshot;
		return {
			image: repo.image ?? sandbox.image,
			...(snapshot === undefined ? {} : { snapshot }),
			network,
			...(sandbox.size === undefined ? {} : { size: sandbox.size }),
			labels: { conversation: String(conversationId), repo: repo.name, instance: this.#config.instance },
		};
	}

	/** The conversation's environment: its repository's working tree, in its sandbox. Prepared on first use. */
	async env(conversationId: number): Promise<ExecutionEnv> {
		const opened = await this.#ensure(conversationId);
		return this.#envAt(conversationId, opened, `${opened.handle.workdir}/repo`);
	}

	#envAt(conversationId: number, opened: Opened, cwd: string): ExecutionEnv {
		return this.#envFor(`sandbox:${this.key(conversationId)}`, opened, cwd);
	}

	#envFor(id: string, opened: Opened, cwd: string): ExecutionEnv {
		const shellEnv = opened.handle.env;
		if (opened.connection === undefined) return opened.handle.connect!({ id, cwd, ...(shellEnv === undefined ? {} : { shellEnv }) });
		return new RemoteExecutionEnv({
			connection: opened.connection,
			id,
			cwd,
			...(shellEnv === undefined ? {} : { shellEnv }),
		});
	}

	#ensure(conversationId: number): Promise<Opened> {
		let opened = this.#open.get(conversationId);
		if (opened === undefined) {
			opened = this.#prepare(conversationId);
			opened.catch(() => this.#open.delete(conversationId));
			this.#open.set(conversationId, opened);
		}
		return opened;
	}

	async #prepare(conversationId: number): Promise<Opened> {
		const configured = this.repo(await this.repoOf(conversationId));
		const base = await this.baseOf(conversationId);
		const repo = base === undefined ? configured : { ...configured, base };
		const described = await this.describe(conversationId).catch(() => ({}));
		const handle = await this.#config.driver.open(this.key(conversationId), { ...this.spec(repo, conversationId), ...described });
		let connection: TrackedConnection | undefined;
		if (handle.connect === undefined) {
			const options: ConnectionOptions = {
				command: handle.daemonCommand,
				// Once Scout closes it (idle, or the lease going), its transport's last words are about that (spoond: the stream).
				onLog: (text) => {
					if (connection?.closing !== true) console.error(`sandbox ${this.key(conversationId)}: ${text.trimEnd()}`);
				},
			};
			connection = new TrackedConnection(options);
			this.#connected.add(conversationId);
		}
		const opened = { handle, ...(connection === undefined ? {} : { connection }), repo };
		const env = this.#envAt(conversationId, opened, handle.workdir);
		const clone = `${handle.workdir}/repo`;
		const cloned = await env.exists(`${clone}/.git`, BACKGROUND_CONTEXT);
		const prebuilt = await env.exists(`${handle.workdir}/${IMAGE_MARK}`, BACKGROUND_CONTEXT);
		if (!(cloned.ok && cloned.value)) await this.#clone(env, opened, clone, conversationId);
		else if (prebuilt.ok && prebuilt.value) await this.#fromImage(env, opened, clone, conversationId);
		return opened;
	}

	/**
	 * Build the repository's image (`scout/<repo>`): a sandbox from where its threads would otherwise start, its base
	 * cloned where threads keep their checkout, the repository's `.scout/setup.sh` run there, and the result saved as a
	 * snapshot. A thread that starts from it has its checkout already built: it only fetches the latest base. `label`
	 * names this build (the setup script and base it was made from), so saving the same build twice doesn't add a
	 * version.
	 */
	async buildImage(repoName: string, label: string): Promise<{ name: string; version: number }> {
		const driver = this.#config.driver;
		if (driver.snapshot === undefined) throw new Error(`${driver.name} sandboxes can't be saved as images`);
		const repo = this.repo(repoName);
		const key = `${this.#config.instance}-image-${repo.name}`;
		// Built from the configured start, not the last build, so builds don't drift. Setup scripts download things.
		const egress: NetworkPolicy | undefined = repo.egress === undefined ? undefined : { mode: "allow", hosts: repo.egress };
		const spec: SandboxSpec = {
			image: repo.image ?? this.#config.sandbox.image,
			...(repo.snapshot === undefined ? {} : { snapshot: repo.snapshot }),
			network: egress !== undefined && driver.supports(egress) ? egress : { mode: "open" },
			...(this.#config.sandbox.size === undefined ? {} : { size: this.#config.sandbox.size }),
			labels: { image: repo.name, instance: this.#config.instance },
			about: `building the ${repo.name} image`,
		};
		await driver.remove(key).catch(() => {});
		const handle = await driver.open(key, spec);
		const connection = handle.connect === undefined ? new TrackedConnection({ command: handle.daemonCommand }) : undefined;
		try {
			const opened: Opened = { handle, ...(connection === undefined ? {} : { connection }), repo };
			const id = `sandbox:${key}`;
			const clone = `${handle.workdir}/repo`;
			// Whatever the starting point had there gives way to a clean clone of the base.
			await must(this.#envFor(id, opened, "/"), ["rm", "-rf", clone, `${handle.workdir}/${IMAGE_MARK}`]);
			await this.#cloneBase(this.#envFor(id, opened, handle.workdir), opened, clone);
			const setup = await exec(this.#envFor(id, opened, clone), ["bash", ".scout/setup.sh"], BACKGROUND_CONTEXT, 3600);
			if (setup.code !== 0) throw new Error(`.scout/setup.sh failed (${setup.code}): ${setup.output.trim().slice(-1500)}`);
			await copyIn(this.#envFor(id, opened, handle.workdir), `${handle.workdir}/${IMAGE_MARK}`, new TextEncoder().encode(label));
			return await driver.snapshot(key, imageName(repo.name), { keep: 3, idempotencyKey: label });
		} finally {
			connection?.close();
			await driver.remove(key).catch(() => {});
		}
	}

	/**
	 * Bring the base branch's latest commits into the thread's clone, as `origin/<base>`, so the thread can rebase or
	 * merge onto it (sandboxes can't reach the code host themselves). Returns the base's name.
	 */
	async refreshBase(conversationId: number): Promise<string> {
		const opened = await this.#ensure(conversationId);
		const { repo, handle } = opened;
		const env = this.#envAt(conversationId, opened, `${handle.workdir}/repo`);
		const inside = await this.#baseBundleIn(env, opened);
		await must(env, ["git", "fetch", "--quiet", inside, `+refs/heads/${repo.base}:refs/remotes/origin/${repo.base}`]);
		await env.remove(inside, { force: true }, BACKGROUND_CONTEXT);
		return repo.base;
	}

	/** The repository's `.scout/setup.sh` on its base branch (the script's git blob, and the base commit), if it has one. */
	async setupScript(repoName: string): Promise<{ script: string; base: string } | undefined> {
		const repo = this.repo(repoName);
		const mirror = this.mirrorFor(repo.name);
		await mirror.refresh();
		const base = await run("git", ["-C", mirror.path, "rev-parse", `refs/heads/${repo.base}`]).then((r) => r.stdout.trim());
		const script = await run("git", ["-C", mirror.path, "rev-parse", "--verify", "--quiet", `refs/heads/${repo.base}:.scout/setup.sh`])
			.then((r) => r.stdout.trim())
			.catch(() => "");
		return script === "" ? undefined : { script, base };
	}

	/** A checkout that came built with the sandbox's image: bring it up to the base branch now, and start the thread's own. */
	async #fromImage(env: ExecutionEnv, opened: Opened, clone: string, conversationId: number): Promise<void> {
		const { repo } = opened;
		const inside = await this.#baseBundleIn(env, opened);
		// Forced, so files the setup script changed give way; what it built (ignored by git) stays.
		await must(env, ["git", "-C", clone, "fetch", "--quiet", inside, `+refs/heads/${repo.base}:refs/remotes/origin/${repo.base}`]);
		await must(env, ["git", "-C", clone, "checkout", "--quiet", "--force", "-B", this.branch(conversationId), `refs/remotes/origin/${repo.base}`]);
		await env.remove(inside, { force: true }, BACKGROUND_CONTEXT);
		await env.remove(`${opened.handle.workdir}/${IMAGE_MARK}`, { force: true }, BACKGROUND_CONTEXT);
	}

	async #clone(env: ExecutionEnv, opened: Opened, clone: string, conversationId: number): Promise<void> {
		await this.#cloneBase(env, opened, clone);
		await must(env, ["git", "-C", clone, "checkout", "--quiet", "-b", this.branch(conversationId)]);
	}

	/** The repository's base branch, cloned at `clone` from the host's mirror (as a bundle: no sandbox reaches the code host). */
	async #cloneBase(env: ExecutionEnv, opened: Opened, clone: string): Promise<void> {
		const { repo } = opened;
		const inside = await this.#baseBundleIn(env, opened);
		await must(env, ["git", "clone", "--quiet", "--branch", repo.base, inside, clone]);
		await must(env, ["git", "-C", clone, "remote", "set-url", "origin", repo.gitUrl]);
		await must(env, ["git", "-C", clone, "config", "user.name", this.#config.git.name]);
		await must(env, ["git", "-C", clone, "config", "user.email", this.#config.git.email]);
		await env.remove(inside, { force: true }, BACKGROUND_CONTEXT);
	}

	/** A bundle of the base branch, fresh from the mirror, inside the sandbox; returns its path there. */
	async #baseBundleIn(env: ExecutionEnv, opened: Opened): Promise<string> {
		const { repo } = opened;
		const mirror = this.mirrorFor(repo.name);
		await mirror.refresh();
		const host = await mkdtemp(join(tmpdir(), "scout-bundle-"));
		try {
			const bundle = join(host, "base.bundle");
			await run("git", ["-C", mirror.path, "bundle", "create", "--quiet", bundle, `refs/heads/${repo.base}`]);
			const inside = `${opened.handle.workdir}/.scout/base.bundle`;
			await copyIn(env, inside, await readFile(bundle));
			return inside;
		} finally {
			await rm(host, { recursive: true, force: true });
		}
	}

	/** Uncommitted changes in the working tree, as `git status --porcelain` lists them. */
	async status(conversationId: number): Promise<string> {
		const opened = await this.#ensure(conversationId);
		const env = this.#envAt(conversationId, opened, `${opened.handle.workdir}/repo`);
		return (await must(env, ["git", "status", "--porcelain"])).trim();
	}

	/**
	 * The conversation's commits beyond its base, as a bundle file on this host whose `HEAD` is the branch tip, for the
	 * mirror to fetch; undefined when there are none. The caller deletes the file.
	 */
	async exportBranch(conversationId: number): Promise<string | undefined> {
		const opened = await this.#ensure(conversationId);
		const env = this.#envAt(conversationId, opened, `${opened.handle.workdir}/repo`);
		const inside = `${opened.handle.workdir}/.scout/out.bundle`;
		await env.createDir(`${opened.handle.workdir}/.scout`, { recursive: true }, BACKGROUND_CONTEXT);
		const made = await exec(env, ["git", "bundle", "create", "--quiet", inside, "HEAD", `^refs/remotes/origin/${opened.repo.base}`]);
		if (made.code !== 0) {
			if (/empty bundle/i.test(made.output)) return undefined;
			throw new Error(`git bundle failed: ${made.output.trim()}`);
		}
		const bytes = await env.readBinaryFile(inside, BACKGROUND_CONTEXT);
		if (!bytes.ok) throw bytes.error;
		await env.remove(inside, { force: true }, BACKGROUND_CONTEXT);
		const path = join(await mkdtemp(join(tmpdir(), "scout-out-")), "out.bundle");
		await writeFile(path, bytes.value);
		return path;
	}

	/** Put a file someone shared where the thread's tools can read it: beside the repository, never committed. */
	async saveAttachment(conversationId: number, name: string, bytes: Uint8Array): Promise<string> {
		const opened = await this.#ensure(conversationId);
		const env = this.#envAt(conversationId, opened, opened.handle.workdir);
		const dir = `${opened.handle.workdir}/attachments`;
		await env.createDir(dir, { recursive: true }, BACKGROUND_CONTEXT);
		const safe = (name.split(/[\\/]/).pop() ?? "").replace(/[^\w.-]+/g, "_").replace(/^\.+/, "") || "file";
		let path = `${dir}/${safe}`;
		for (let n = 2; ; n++) {
			const there = await env.exists(path, BACKGROUND_CONTEXT);
			if (!(there.ok && there.value)) break;
			path = `${dir}/${n}-${safe}`;
		}
		await copyIn(env, path, bytes);
		return path;
	}

	/** Free a quiet thread's sandbox; its files stay, and the next tool call resumes it. */
	async suspend(conversationId: number): Promise<void> {
		await this.#close(conversationId);
		await this.#config.driver.suspend(this.key(conversationId)).catch(() => {});
	}

	/** Delete a conversation's sandbox and files, for work that is over (a job). */
	async remove(conversationId: number): Promise<void> {
		await this.#close(conversationId);
		await this.#config.driver.remove(this.key(conversationId)).catch(() => {});
	}

	async #close(conversationId: number): Promise<void> {
		const opened = this.#open.get(conversationId);
		this.#open.delete(conversationId);
		this.#connected.delete(conversationId);
		await opened?.then((o) => o.connection?.close()).catch(() => {});
	}

	async close(): Promise<void> {
		clearInterval(this.#sweep);
		await Promise.all([...this.#open.keys()].map((id) => this.#close(id)));
	}
}

async function copyIn(env: ExecutionEnv, path: string, bytes: Uint8Array): Promise<void> {
	const parent = path.slice(0, path.lastIndexOf("/"));
	await env.createDir(parent, { recursive: true }, BACKGROUND_CONTEXT);
	for (let offset = 0; offset === 0 || offset < bytes.length; offset += CHUNK) {
		const chunk = bytes.subarray(offset, offset + CHUNK);
		const done = offset === 0 ? await env.writeFile(path, chunk, BACKGROUND_CONTEXT) : await env.appendFile(path, chunk, BACKGROUND_CONTEXT);
		if (!done.ok) throw done.error;
		if (bytes.length === 0) break;
	}
}

async function exec(env: ExecutionEnv, argv: string[], context: Context = BACKGROUND_CONTEXT, timeout?: number): Promise<{ code: number; output: string }> {
	let output = "";
	const result = await env.exec(argv, { onOutput: (text) => (output += text), ...(timeout === undefined ? {} : { timeout }) }, context);
	if (!result.ok) throw result.error;
	return { code: result.value.exitCode, output };
}

async function must(env: ExecutionEnv, argv: string[]): Promise<string> {
	const { code, output } = await exec(env, argv);
	if (code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} failed (${code}): ${output.trim()}`);
	return output;
}
