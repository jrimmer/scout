import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * `npm run setup`: walks whoever runs Scout through setting it up, one step at a time (docs/setup.md is the same path
 * in prose). Every step can `verify` what is already set, silently and without asking anything, and `configure` what
 * isn't, so running it again only asks about what is missing or broken, and `--check` is every step's verify and
 * nothing else. The last step is the doctor, the same check `npm run doctor` runs at any time.
 *
 * Everything outside (the network, other programs, the person's answers) comes in through `Ctx`, so tests drive the
 * whole walk with scripted answers.
 */

export type Result = { state: "ok"; detail: string } | { state: "todo" } | { state: "bad"; detail: string; fix?: string };

export interface Ui {
	say(text: string): void;
	ask(question: string, options?: { default?: string; secret?: boolean }): Promise<string>;
	choose<T extends string>(question: string, options: { value: T; label: string }[], preferred?: T): Promise<T>;
	confirm(question: string, preferred?: boolean): Promise<boolean>;
}

export type Run = (command: string, args: string[], options?: { cwd?: string; env?: Record<string, string>; input?: string; inherit?: boolean }) => Promise<{ code: number; stdout: string; stderr: string }>;

export type Ctx = {
	env: EnvFile;
	ui: Ui;
	fetch: typeof fetch;
	run: Run;
	/** Where Scout is checked out. */
	dir: string;
	home: string;
	slackApi: string;
};

export type Step = {
	id: string;
	title: string;
	/** Something to leave for later: not asking for it isn't a failure of the install. */
	optional?: boolean;
	verify(ctx: Ctx): Promise<Result>;
	configure(ctx: Ctx): Promise<void>;
};

const ok = (detail: string): Result => ({ state: "ok", detail });
const bad = (detail: string, fix?: string): Result => ({ state: "bad", detail, ...(fix === undefined ? {} : { fix }) });
const todo: Result = { state: "todo" };

/* ------------------------------------------------------------------------------------------------ the .env file */

/** The settings file, edited in place: comments and other lines stay as they are, and it is only readable by its owner. */
export class EnvFile {
	readonly path: string;
	#lines: string[];

	constructor(path: string) {
		this.path = path;
		this.#lines = existsSync(path) ? readFileSync(path, "utf8").replace(/\n$/, "").split("\n") : ["# Written by `npm run setup`. Every setting there is: .env.example."];
	}

	get(key: string): string | undefined {
		const line = [...this.#lines].reverse().find((l) => l.startsWith(`${key}=`));
		if (line === undefined) return undefined;
		const value = line.slice(key.length + 1).trim();
		const quoted = /^(["'])(.*)\1$/.exec(value);
		return quoted === null ? value : quoted[1] === '"' ? quoted[2]!.replace(/\\(["\\])/g, "$1") : quoted[2]!;
	}

	set(key: string, value: string): void {
		const text = /[\s#"'\\$]/.test(value) ? `"${value.replace(/(["\\])/g, "\\$1")}"` : value;
		const at = this.#lines.findIndex((l) => l.startsWith(`${key}=`));
		if (at >= 0) this.#lines[at] = `${key}=${text}`;
		else this.#lines.push(`${key}=${text}`);
	}

	save(): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const temp = `${this.path}.new`;
		writeFileSync(temp, `${this.#lines.join("\n")}\n`, { mode: 0o600 });
		chmodSync(temp, 0o600);
		renameSync(temp, this.path);
	}
}

/* ---------------------------------------------------------------------------------------------------- helpers */

/** Answer for a setting that may already have a value: Enter keeps it. */
async function ask(ctx: Ctx, key: string, question: string, options: { fallback?: string; secret?: boolean } = {}): Promise<string> {
	const current = ctx.env.get(key) ?? options.fallback;
	const answer = await ctx.ui.ask(question, { ...(current === undefined || options.secret === true ? {} : { default: current }), ...(options.secret === true ? { secret: true } : {}) });
	const value = answer.trim() === "" ? (current ?? "") : answer.trim();
	if (value !== "") ctx.env.set(key, value);
	return value;
}

type Reply = { status: number; body: Record<string, unknown>; headers: Headers };

async function call(ctx: Ctx, url: string, init: RequestInit = {}): Promise<Reply | Error> {
	try {
		const response = await ctx.fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
		const text = await response.text();
		let body: Record<string, unknown> = {};
		try {
			body = JSON.parse(text) as Record<string, unknown>;
		} catch {}
		return { status: response.status, body, headers: response.headers };
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

const reachFix = "Is the address right, and can this machine reach it?";

/** Host and port of a repository URL, for `ssh://git@host:2222/x/y.git` and `git@host:x/y.git` alike. */
export function sshHostOf(url: string): { host: string; port: number } | undefined {
	const scp = /^[\w.-]+@([\w.-]+):(?!\d+\/)/.exec(url);
	if (scp !== null) return { host: scp[1]!, port: 22 };
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "ssh:") return undefined;
		return { host: parsed.hostname, port: parsed.port === "" ? 22 : Number(parsed.port) };
	} catch {
		return undefined;
	}
}

const keyPath = (ctx: Ctx) => (ctx.env.get("SCOUT_GIT_SSH_KEY") ?? "~/.ssh/scout_ed25519").replace(/^~(?=\/|$)/, ctx.home);
const codeHostAuth = (ctx: Ctx): Record<string, string> => ({ authorization: `${ctx.env.get("SCOUT_CODEHOST") === "github" ? "Bearer" : "token"} ${ctx.env.get("SCOUT_CODEHOST_TOKEN") ?? ""}`, accept: "application/json" });
const apiBase = (ctx: Ctx) => (ctx.env.get("SCOUT_CODEHOST_API") ?? (ctx.env.get("SCOUT_CODEHOST") === "github" ? "https://api.github.com" : "")).replace(/\/$/, "");

/** The Slack manifest with the preview domain set to the code host's, ready to paste. */
export function manifestFor(manifest: string, domain: string): string {
	return manifest.replace(/(unfurl_domains:\n)((?:\s+- .*\n)+)/, `$1    - ${domain}\n`);
}

/* ------------------------------------------------------------------------------------------------------ steps */

const prerequisites: Step = {
	id: "prerequisites",
	title: "This machine",
	async verify(ctx) {
		const [major] = process.versions.node.split(".").map(Number);
		if ((major ?? 0) < 24) return bad(`Node ${process.versions.node} is too old; Scout needs 24 or later`, "install.sh puts Node 24 in /usr/local, or take it from nodejs.org/en/download.");
		const missing: string[] = [];
		for (const program of ["git", "ssh", "ssh-keygen", "ssh-keyscan"]) if ((await ctx.run("sh", ["-c", `command -v ${program}`])).code !== 0) missing.push(program);
		if (missing.length > 0) return bad(`missing: ${missing.join(", ")}`, "Install git and openssh-client (Debian, Ubuntu) or openssh-clients (Fedora).");
		return ok(`Node ${process.versions.node}, git and ssh`);
	},
	async configure(ctx) {
		ctx.ui.say("Nothing to ask here: install what's listed above, then try again.");
	},
};

const codehost: Step = {
	id: "codehost",
	title: "Code host account",
	async verify(ctx) {
		const token = ctx.env.get("SCOUT_CODEHOST_TOKEN");
		if (!ctx.env.get("SCOUT_CODEHOST") || token === undefined || token === "") return todo;
		const api = apiBase(ctx);
		if (api === "") return bad("SCOUT_CODEHOST_API isn't set", "It's the Forgejo address plus /api/v1.");
		const reply = await call(ctx, `${api}/user`, { headers: codeHostAuth(ctx) });
		if (reply instanceof Error) return bad(`can't reach ${api}: ${reply.message}`, reachFix);
		if (reply.status === 401) return bad("the code host refused the token", "Make a new token for Scout's account and run this step again.");
		if (reply.status !== 200) return bad(`${api}/user answered ${reply.status}`, reachFix);
		const login = String(reply.body.login ?? "");
		const key = keyPath(ctx);
		if (!existsSync(key)) return bad(`logged in as ${login}, but there's no SSH key at ${key}`, "Run this step again to make one.");
		return ok(`${login} on ${new URL(api).host}`);
	},
	async configure(ctx) {
		ctx.ui.say("Scout needs an account of its own on your code host, so its pull requests are its own and you can revoke it without touching yours.");
		const kind = await ctx.ui.choose("Which code host?", [{ value: "forgejo", label: "Forgejo or Gitea" }, { value: "github", label: "GitHub" }], (ctx.env.get("SCOUT_CODEHOST") as "forgejo" | "github" | undefined) ?? "forgejo");
		ctx.env.set("SCOUT_CODEHOST", kind);
		if (kind === "forgejo") {
			const address = await ctx.ui.ask("Its address, like https://git.example.com", { default: apiBase(ctx).replace(/\/api\/v1$/, "") });
			if (address.trim() !== "") ctx.env.set("SCOUT_CODEHOST_API", `${address.trim().replace(/\/$/, "").replace(/\/api\/v1$/, "")}/api/v1`);
			ctx.ui.say("Make a token on Scout's account with write:issue, write:repository, read:user and write:notification.");
		} else {
			ctx.ui.say("Make a classic token on Scout's account with repo and notifications.");
		}
		await ask(ctx, "SCOUT_CODEHOST_TOKEN", "Its API token", { secret: true });
		const key = keyPath(ctx);
		if (!existsSync(key)) {
			mkdirSync(dirname(key), { recursive: true, mode: 0o700 });
			const made = await ctx.run("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "scout", "-f", key]);
			if (made.code !== 0) {
				ctx.ui.say(`Couldn't make the SSH key: ${made.stderr.trim()}`);
				return;
			}
			ctx.ui.say(`Made Scout's SSH key at ${key}.`);
		}
		ctx.env.set("SCOUT_GIT_SSH_KEY", key.startsWith(ctx.home) ? `~${key.slice(ctx.home.length)}` : key);
		const pub = readFileSync(`${key}.pub`, "utf8").trim();
		ctx.ui.say(`Add this public key to Scout's account (Settings, SSH keys), where the host will clone and push with it:\n\n${pub}\n`);
		await ctx.ui.ask("Press Enter when it's added");
	},
};

const slack: Step = {
	id: "slack",
	title: "Slack app",
	async verify(ctx) {
		const bot = ctx.env.get("SLACK_BOT_TOKEN");
		const app = ctx.env.get("SLACK_APP_TOKEN");
		if (!bot || !app) return todo;
		if (!bot.startsWith("xoxb-")) return bad("SLACK_BOT_TOKEN should start with xoxb-", "It's the Bot User OAuth Token under Install App.");
		if (!app.startsWith("xapp-")) return bad("SLACK_APP_TOKEN should start with xapp-", "It's an app-level token with connections:write, under Basic Information.");
		const auth = await call(ctx, `${ctx.slackApi}/auth.test`, { method: "POST", headers: { authorization: `Bearer ${bot}` } });
		if (auth instanceof Error) return bad(`can't reach Slack: ${auth.message}`, reachFix);
		if (auth.body.ok !== true) return bad(`Slack refused the bot token (${String(auth.body.error)})`, "Install the app again and copy the new Bot User OAuth Token.");
		const socket = await call(ctx, `${ctx.slackApi}/apps.connections.open`, { method: "POST", headers: { authorization: `Bearer ${app}` } });
		if (socket instanceof Error) return bad(`can't reach Slack: ${socket.message}`, reachFix);
		if (socket.body.ok !== true) return bad(`Slack refused the app token (${String(socket.body.error)})`, "Basic Information, App-Level Tokens: make one with the connections:write scope.");
		return ok(`${String(auth.body.team)}, as @${String(auth.body.user)}`);
	},
	async configure(ctx) {
		const manifest = join(ctx.dir, "slack-manifest.yaml");
		const domain = ctx.env.get("SCOUT_CODEHOST_API") === undefined ? "" : new URL(ctx.env.get("SCOUT_CODEHOST_API")!).hostname;
		const ready = join(ctx.dir, "slack-manifest.local.yaml");
		writeFileSync(ready, domain === "" ? readFileSync(manifest, "utf8") : manifestFor(readFileSync(manifest, "utf8"), domain));
		ctx.ui.say(`In Slack:\n  1. api.slack.com/apps, Create New App, From a manifest, and paste ${ready}${domain === "" ? "" : ` (link previews already set to ${domain})`}.\n  2. Basic Information, App-Level Tokens: make one with connections:write.\n  3. Install App, then copy the Bot User OAuth Token.`);
		await ask(ctx, "SLACK_APP_TOKEN", "The app-level token (xapp-…)", { secret: true });
		await ask(ctx, "SLACK_BOT_TOKEN", "The Bot User OAuth Token (xoxb-…)", { secret: true });
	},
};

const repository: Step = {
	id: "repository",
	title: "The repository Scout works on",
	async verify(ctx) {
		const url = ctx.env.get("SCOUT_REPO_URL");
		const slug = ctx.env.get("SCOUT_REPO_SLUG");
		if (!url || !slug || url.includes("git.example.com")) return todo;
		const where = sshHostOf(url);
		if (where === undefined) return bad("SCOUT_REPO_URL should be an ssh:// address", "Scout clones with its SSH key, like ssh://git@git.example.com/team/repo.git.");
		const known = await ctx.run("ssh-keygen", ["-F", where.port === 22 ? where.host : `[${where.host}]:${where.port}`]);
		if (known.code !== 0) return bad(`${where.host} isn't in known_hosts yet`, "Run this step again; it fetches the host key and asks you to check it.");
		const base = ctx.env.get("SCOUT_REPO_BASE") ?? "main";
		const key = keyPath(ctx);
		const sshCommand = `ssh -i ${key} -o IdentitiesOnly=yes -o BatchMode=yes`;
		const listed = await ctx.run("git", ["ls-remote", "--exit-code", url, `refs/heads/${base}`], { env: { GIT_SSH_COMMAND: sshCommand } });
		if (listed.code !== 0) return bad(`can't read ${url} (${listed.stderr.trim().split("\n").pop() ?? `git exited ${listed.code}`})`, `Is Scout's public key on its account, is the account a collaborator with write access, and does branch ${base} exist?`);
		const api = apiBase(ctx);
		if (api !== "") {
			const repo = await call(ctx, `${api}/repos/${slug}`, { headers: codeHostAuth(ctx) });
			if (!(repo instanceof Error) && repo.status === 404) return bad(`the API doesn't know ${slug}`, "SCOUT_REPO_SLUG is owner/name, as the code host spells it.");
			const permissions = repo instanceof Error ? undefined : (repo.body.permissions as { push?: boolean } | undefined);
			if (permissions?.push === false) return bad(`${slug} is read-only for Scout's account`, "Add the account as a collaborator with write access.");
		}
		return ok(`${slug}, branch ${base}`);
	},
	async configure(ctx) {
		const url = await ask(ctx, "SCOUT_REPO_URL", "The repository's ssh address, like ssh://git@git.example.com/team/repo.git", { fallback: "" });
		const where = sshHostOf(url);
		const guess = /[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url)?.[1];
		await ask(ctx, "SCOUT_REPO_SLUG", "Its owner/name on the code host", { ...(guess === undefined ? {} : { fallback: guess }) });
		await ask(ctx, "SCOUT_REPO_BASE", "Its main branch", { fallback: "main" });
		if (where === undefined) return;
		const target = where.port === 22 ? where.host : `[${where.host}]:${where.port}`;
		if ((await ctx.run("ssh-keygen", ["-F", target])).code === 0) return;
		const scanned = await ctx.run("ssh-keyscan", ["-p", String(where.port), "-t", "ed25519,rsa,ecdsa", where.host]);
		if (scanned.stdout.trim() === "") {
			ctx.ui.say(`Couldn't fetch ${where.host}'s host key: ${scanned.stderr.trim() || "no answer"}`);
			return;
		}
		const shown = await ctx.run("ssh-keygen", ["-lf", "-"], { input: scanned.stdout });
		ctx.ui.say(`${where.host} offers these host keys:\n${shown.stdout.trim()}\nCheck one against your code host's (Scout never answers ssh's "are you sure?", so it's trusted once, here).`);
		if (!(await ctx.ui.confirm(`Trust ${where.host}?`, false))) return;
		mkdirSync(join(ctx.home, ".ssh"), { recursive: true, mode: 0o700 });
		const known = join(ctx.home, ".ssh", "known_hosts");
		writeFileSync(known, `${existsSync(known) ? readFileSync(known, "utf8").replace(/\n?$/, "\n") : ""}${scanned.stdout}`, { mode: 0o600 });
	},
};

const sandbox: Step = {
	id: "sandbox",
	title: "Sandboxes",
	async verify(ctx) {
		const driver = ctx.env.get("SCOUT_SANDBOX_DRIVER");
		if (driver === undefined) return todo;
		if (driver === "local") return ok("local (no isolation: for trying it out only)");
		if (driver === "spoond") {
			const url = (ctx.env.get("SCOUT_SPOOND_URL") ?? "").replace(/\/$/, "");
			const token = ctx.env.get("SCOUT_SPOOND_TOKEN") ?? "";
			if (url === "" || token === "") return bad("SCOUT_SPOOND_URL and SCOUT_SPOOND_TOKEN aren't both set");
			if (token.startsWith("file:")) return ok(`spoond at ${url} (token from a file; the doctor checks it)`);
			const reply = await call(ctx, `${url}/api/leases`, { headers: { authorization: `Bearer ${token}` } });
			if (reply instanceof Error) return bad(`can't reach spoond: ${reply.message}`, reachFix);
			if (reply.status === 401 || reply.status === 403) return bad("spoond refused the token", "Make a new one for Scout.");
			return reply.status === 200 ? ok(`spoond at ${url}`) : bad(`spoond answered ${reply.status}`);
		}
		const docker = await ctx.run("docker", ["info", "--format", "{{.ServerVersion}}"]);
		if (docker.code !== 0) return bad("Docker doesn't answer", "Install it (apt-get install docker.io) and add Scout's user to the docker group; then log in again.");
		const image = ctx.env.get("SCOUT_SANDBOX_IMAGE") ?? "scout-sandbox:latest";
		if ((await ctx.run("docker", ["image", "inspect", image])).code !== 0) return bad(`the image ${image} isn't built`, "docker build -t scout-sandbox:latest sandbox");
		const ran = await ctx.run("docker", ["run", "--rm", "--network", "none", image, "true"]);
		return ran.code === 0 ? ok(`Docker ${docker.stdout.trim()}, image ${image}`) : bad(`a container from ${image} won't run (${ran.stderr.trim().split("\n").pop() ?? ran.code})`);
	},
	async configure(ctx) {
		const driver = await ctx.ui.choose("Where should each thread's sandbox run?", [
			{ value: "docker", label: "Docker on this machine" },
			{ value: "spoond", label: "A spoond server (microVMs, with per-repository network allowlists)" },
			{ value: "local", label: "Nowhere: no isolation at all, for trying it out" },
		], (ctx.env.get("SCOUT_SANDBOX_DRIVER") as "docker" | "spoond" | "local" | undefined) ?? "docker");
		ctx.env.set("SCOUT_SANDBOX_DRIVER", driver);
		if (driver === "spoond") {
			await ask(ctx, "SCOUT_SPOOND_URL", "spoond's address, like https://spoond.example.com:8890");
			await ask(ctx, "SCOUT_SPOOND_TOKEN", "Its token (or file:/path/to/token)", { secret: true });
			ctx.env.set("SCOUT_SPOOND_TRANSPORT", "rest");
		} else if (driver === "docker") {
			const image = ctx.env.get("SCOUT_SANDBOX_IMAGE") ?? "scout-sandbox:latest";
			if ((await ctx.run("docker", ["info"])).code === 0 && (await ctx.run("docker", ["image", "inspect", image])).code !== 0) {
				ctx.ui.say("The sandbox image has to be built once. Add your repositories' toolchains to sandbox/Dockerfile first if you know them.");
				if (await ctx.ui.confirm("Build it now? (a few minutes)", true)) await ctx.run("docker", ["build", "-t", image, join(ctx.dir, "sandbox")], { inherit: true });
			}
		} else {
			ctx.ui.say("Local sandboxes run commands directly on this machine. Use them to try Scout, not to let people use it.");
		}
	},
};

const model: Step = {
	id: "model",
	title: "The model",
	async verify(ctx) {
		const name = ctx.env.get("SCOUT_MODEL");
		if (!name) return todo;
		const [provider] = name.split("/");
		if (provider === "gateway") {
			const url = (ctx.env.get("SCOUT_GATEWAY_URL") ?? "").replace(/\/$/, "");
			if (url === "") return bad("SCOUT_GATEWAY_URL isn't set");
			const reply = await call(ctx, `${url}/models`, { headers: { authorization: `Bearer ${ctx.env.get("SCOUT_GATEWAY_KEY") ?? ""}` } });
			if (reply instanceof Error) return bad(`can't reach the gateway: ${reply.message}`, reachFix);
			if (reply.status === 401 || reply.status === 403) return bad("the gateway refused the key", "Check SCOUT_GATEWAY_KEY.");
			return reply.status < 500 ? ok(`${name} through ${url}`) : bad(`the gateway answered ${reply.status}`);
		}
		if (provider === "anthropic") {
			const key = ctx.env.get("ANTHROPIC_API_KEY");
			if (!key) return bad("ANTHROPIC_API_KEY isn't set");
			const reply = await call(ctx, "https://api.anthropic.com/v1/models", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
			if (reply instanceof Error) return bad(`can't reach Anthropic: ${reply.message}`, reachFix);
			return reply.status === 200 ? ok(name) : bad(`Anthropic answered ${reply.status}`, "Check ANTHROPIC_API_KEY.");
		}
		if (provider === "openai") {
			const key = ctx.env.get("OPENAI_API_KEY");
			if (!key) return bad("OPENAI_API_KEY isn't set");
			const reply = await call(ctx, "https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${key}` } });
			if (reply instanceof Error) return bad(`can't reach OpenAI: ${reply.message}`, reachFix);
			return reply.status === 200 ? ok(name) : bad(`OpenAI answered ${reply.status}`, "Check OPENAI_API_KEY.");
		}
		return ok(`${name} (the doctor makes the first real call)`);
	},
	async configure(ctx) {
		const via = await ctx.ui.choose("Which model service?", [
			{ value: "anthropic", label: "Anthropic, with an API key" },
			{ value: "openai", label: "OpenAI, with an API key" },
			{ value: "gateway", label: "A model gateway (Bifrost, LiteLLM, …) that speaks the OpenAI API" },
		], (ctx.env.get("SCOUT_MODEL")?.split("/")[0] as "anthropic" | "openai" | "gateway" | undefined) ?? "anthropic");
		if (via === "anthropic") {
			await ask(ctx, "ANTHROPIC_API_KEY", "Its API key", { secret: true });
			await ask(ctx, "SCOUT_MODEL", "Model (provider/modelId)", { fallback: "anthropic/claude-opus-5-5" });
		} else if (via === "openai") {
			await ask(ctx, "OPENAI_API_KEY", "Its API key", { secret: true });
			await ask(ctx, "SCOUT_MODEL", "Model (provider/modelId, like openai/<model>)");
		} else {
			await ask(ctx, "SCOUT_GATEWAY_URL", "The gateway's OpenAI base, like https://llm.example.com/v1");
			await ask(ctx, "SCOUT_GATEWAY_KEY", "Its key", { secret: true });
			const name = await ctx.ui.ask("The model's name on the gateway, like lunaroute/deepseek-4.1-flash", { default: ctx.env.get("SCOUT_MODEL")?.replace(/^gateway\//, "") ?? "" });
			if (name.trim() !== "") ctx.env.set("SCOUT_MODEL", `gateway/${name.trim().replace(/^gateway\//, "")}`);
		}
	},
};

const people: Step = {
	id: "people",
	title: "Who may ask",
	async verify(ctx) {
		const mode = ctx.env.get("SCOUT_REQUESTER_CHECK");
		if (mode === undefined) return todo;
		if (mode === "warn") return ok("warn: everyone is let in, and who would be refused is logged (for trying it out)");
		if (mode === "off") return bad("off: everyone may ask", "Only for a test install; set SCOUT_REQUESTER_CHECK=enforce before opening it up.");
		if (ctx.env.get("SCOUT_PEOPLE_FILE") === undefined && ctx.env.get("SCOUT_DIRECTORY") === undefined && ctx.env.get("SCOUT_ROLES_FILE") === undefined) return bad("enforce, but nobody is mapped to a code host login", "Name people in a people file, a directory or a roles file; docs/setup.md, step 8.");
		return ok(`${mode}${ctx.env.get("SCOUT_PEOPLE_FILE") === undefined ? "" : `, ${Object.keys(JSON.parse(readFileSync(resolve(ctx.dir, ctx.env.get("SCOUT_PEOPLE_FILE")!), "utf8")) as object).length} people mapped`}`);
	},
	async configure(ctx) {
		const mode = await ctx.ui.choose("Who may ask Scout for work?", [
			{ value: "enforce", label: "Only people who can write to the repository (you map Slack people to code host logins)" },
			{ value: "warn", label: "Everyone, while you try it: Scout logs who it would refuse" },
		], "enforce");
		ctx.env.set("SCOUT_REQUESTER_CHECK", mode);
		if (mode !== "enforce") return;
		const file = join(ctx.dir, "people.json");
		const mapped: Record<string, string> = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>) : {};
		ctx.ui.say("Name each person as their Slack member ID, an equals sign and their code host login, like U0123ABC=alice (the ID is in Slack: profile, ⋮, Copy member ID). A blank line ends the list.");
		for (;;) {
			const line = (await ctx.ui.ask("Person")).trim();
			if (line === "") break;
			const [id, login] = line.split("=").map((s) => s.trim());
			if (!id || !login || !/^[UW][A-Z0-9]+$/.test(id)) {
				ctx.ui.say("That should look like U0123ABC=alice.");
				continue;
			}
			const bot = ctx.env.get("SLACK_BOT_TOKEN");
			const who = bot === undefined ? undefined : await call(ctx, `${ctx.slackApi}/users.info?user=${id}`, { headers: { authorization: `Bearer ${bot}` } });
			if (who !== undefined && !(who instanceof Error) && who.body.ok === false) {
				ctx.ui.say(`Slack doesn't know ${id} (${String(who.body.error)}).`);
				continue;
			}
			const api = apiBase(ctx);
			const account = api === "" ? undefined : await call(ctx, `${api}/users/${login}`, { headers: codeHostAuth(ctx) });
			if (account !== undefined && !(account instanceof Error) && account.status === 404) {
				ctx.ui.say(`The code host has no user ${login}.`);
				continue;
			}
			mapped[id] = login;
			ctx.ui.say(`${id} is ${login}.`);
		}
		writeFileSync(file, `${JSON.stringify(mapped, null, 2)}\n`);
		ctx.env.set("SCOUT_PEOPLE_FILE", file);
	},
};

const initiative: Step = {
	id: "initiative",
	title: "How much Scout does on its own",
	async verify(ctx) {
		const value = ctx.env.get("SCOUT_INITIATIVE");
		return value === undefined ? todo : /^(asked|own|team)$/.test(value) ? ok(value) : bad(`SCOUT_INITIATIVE is "${value}"`, "asked, own or team.");
	},
	async configure(ctx) {
		ctx.env.set(
			"SCOUT_INITIATIVE",
			await ctx.ui.choose("How much should Scout do without being asked?", [
				{ value: "asked", label: "asked: only what people ask for" },
				{ value: "own", label: "own: also look after its own pull requests, branches and profile" },
				{ value: "team", label: "team: also watch alerts, remind reviewers, post weekly reports (the default)" },
			], "team"),
		);
	},
};

const home: Step = {
	id: "home",
	title: "Scout's home channel",
	optional: true,
	async verify(ctx) {
		const name = ctx.env.get("SCOUT_REFLECT_CHANNEL");
		const bot = ctx.env.get("SLACK_BOT_TOKEN");
		if (!name) return todo;
		if (!bot) return bad("no Slack token to look the channel up with");
		let cursor = "";
		for (let page = 0; page < 20; page++) {
			const reply = await call(ctx, `${ctx.slackApi}/conversations.list?types=public_channel&exclude_archived=true&limit=1000${cursor === "" ? "" : `&cursor=${cursor}`}`, { headers: { authorization: `Bearer ${bot}` } });
			if (reply instanceof Error) return bad(`can't reach Slack: ${reply.message}`, reachFix);
			if (reply.body.ok !== true) return bad(`Slack wouldn't list channels (${String(reply.body.error)})`);
			const channels = (reply.body.channels ?? []) as { name: string; is_member?: boolean }[];
			const found = channels.find((c) => c.name === name);
			if (found !== undefined) return found.is_member === true ? ok(`#${name}`) : bad(`#${name} exists, but Scout isn't in it`, `/invite @Scout in #${name}.`);
			cursor = String((reply.body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "");
			if (cursor === "") break;
		}
		return bad(`there's no public channel #${name}`, `Create it and /invite @Scout.`);
	},
	async configure(ctx) {
		ctx.ui.say("Scout's home channel is where it posts proposals, weekly reports and requests to whoever runs it. Make a public channel for it and invite Scout (/invite @Scout).");
		const name = (await ctx.ui.ask("Its name, without the # (Enter to leave it for later)", { default: ctx.env.get("SCOUT_REFLECT_CHANNEL") ?? "" })).trim().replace(/^#/, "");
		if (name !== "") ctx.env.set("SCOUT_REFLECT_CHANNEL", name);
	},
};

const backups: Step = {
	id: "backups",
	title: "Backups",
	async verify(ctx) {
		const value = ctx.env.get("SCOUT_BACKUP");
		return value === undefined ? todo : value === "none" ? ok("none, on purpose") : value === "litestream" ? ok("Litestream (the doctor checks it once Scout runs)") : bad(`SCOUT_BACKUP is "${value}"`, "litestream or none.");
	},
	async configure(ctx) {
		const choice = await ctx.ui.choose("Back up Scout's threads and notes?", [
			{ value: "litestream", label: "Yes, with Litestream (set up beside Scout: docs/operations.md, Backups)" },
			{ value: "none", label: "No, this is a test or throwaway install" },
		], "litestream");
		ctx.env.set("SCOUT_BACKUP", choice);
		if (choice === "litestream") ctx.ui.say("Litestream runs as its own service. The doctor will say Backups need attention until it does: docs/operations.md#backups.");
	},
};

export const STEPS: Step[] = [prerequisites, codehost, slack, repository, sandbox, model, people, initiative, home, backups];

/* ------------------------------------------------------------------------------------------------------ the walk */

const mark = (r: Result) => (r.state === "ok" ? "✅" : r.state === "bad" ? "❌" : "·");

/**
 * Walk the steps. A step that checks out is passed over; one that has nothing yet is configured; one that is set but
 * broken says what is wrong first. After configuring, it is checked again, and what is still wrong is shown with how
 * to fix it, until it checks out or the person skips it. Returns whether everything checks out.
 */
export async function walk(ctx: Ctx, steps: Step[], options: { check?: boolean; redo?: string[] } = {}): Promise<boolean> {
	let all = true;
	for (const step of steps) {
		let result = await step.verify(ctx);
		if (options.check === true) {
			ctx.ui.say(`${mark(result)} ${step.title}: ${result.state === "ok" ? result.detail : result.state === "bad" ? `${result.detail}${result.fix === undefined ? "" : ` (${result.fix})`}` : step.optional === true ? "not set (optional)" : "not set up yet"}`);
			if (result.state === "bad" || (result.state === "todo" && step.optional !== true)) all = false;
			continue;
		}
		if (result.state === "ok" && options.redo?.includes(step.id) !== true) {
			ctx.ui.say(`✅ ${step.title}: ${result.detail}`);
			continue;
		}
		ctx.ui.say(`\n── ${step.title}`);
		if (result.state === "bad") ctx.ui.say(`❌ ${result.detail}${result.fix === undefined ? "" : `\n   ${result.fix}`}`);
		for (;;) {
			await step.configure(ctx);
			ctx.env.save();
			result = await step.verify(ctx);
			if (result.state === "ok") {
				ctx.ui.say(`✅ ${result.detail}`);
				break;
			}
			if (result.state === "todo" && step.optional === true) break;
			if (result.state === "bad") ctx.ui.say(`❌ ${result.detail}${result.fix === undefined ? "" : `\n   ${result.fix}`}`);
			const next = await ctx.ui.choose("What now?", [{ value: "again", label: "Fix it and try this step again" }, { value: "skip", label: "Skip it for now (run npm run setup again later)" }], "again");
			if (next === "skip") {
				all = step.optional === true && result.state === "todo" ? all : false;
				break;
			}
		}
	}
	return all;
}
