import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type Ctx, EnvFile, manifestFor, type Run, sshHostOf, STEPS, type Ui, walk } from "../src/setup.ts";
import { tempDir } from "./helpers.ts";

/** Answers in order; `ask` and `choose` fail loudly if a step asks something the test didn't expect. */
function scripted(answers: string[]) {
	const said: string[] = [];
	const asked: string[] = [];
	const ui: Ui = {
		say: (text) => void said.push(text),
		async ask(question) {
			asked.push(question);
			const next = answers.shift();
			if (next === undefined) throw new Error(`asked "${question}" with no answer left`);
			return next;
		},
		async choose(question, options) {
			asked.push(question);
			const next = answers.shift();
			assert.ok(options.some((o) => o.value === next), `"${question}" has no option "${String(next)}"`);
			return next as never;
		},
		async confirm(question) {
			asked.push(question);
			return answers.shift() === "y";
		},
	};
	return { ui, said, asked, left: () => answers.length };
}

/** The outside world: Slack, a code host and Anthropic that accept the right credentials, and a machine with everything installed. */
function world(options: { botToken?: string } = {}) {
	const fetched: string[] = [];
	const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		fetched.push(url);
		const auth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "");
		if (url.endsWith("/auth.test")) return json(auth === `Bearer ${options.botToken ?? "xoxb-1"}` ? { ok: true, team: "Acme", user: "scout" } : { ok: false, error: "invalid_auth" });
		if (url.endsWith("/apps.connections.open")) return json({ ok: true, url: "wss://x" });
		if (url.includes("/users.info")) return json({ ok: true });
		if (url.includes("/conversations.list")) return json({ ok: true, channels: [{ name: "scout-hq", is_member: true }] });
		if (url === "https://git.example.org/api/v1/user") return auth === "token tok" ? json({ login: "scout" }) : json({}, 401);
		if (url === "https://git.example.org/api/v1/users/alice") return json({ login: "alice" });
		if (url === "https://git.example.org/api/v1/repos/team/app") return json({ permissions: { push: true } });
		if (url === "https://api.anthropic.com/v1/models") return json({ data: [] });
		return json({ error: `unexpected ${url}` }, 404);
	}) as typeof fetch;
	return { fetcher, fetched };
}

function context(root: string, ui: Ui, fetcher: typeof fetch): { ctx: Ctx; commands: string[] } {
	const commands: string[] = [];
	const home = join(root, "home");
	mkdirSync(home, { recursive: true });
	const run: Run = async (command, args, opts) => {
		commands.push([command, ...args].join(" "));
		const known = join(home, ".ssh", "known_hosts");
		if (command === "ssh-keygen" && args[0] === "-t") {
			const file = args[args.indexOf("-f") + 1]!;
			writeFileSync(file, "private");
			writeFileSync(`${file}.pub`, "ssh-ed25519 AAAA scout");
		}
		if (command === "ssh-keygen" && args[0] === "-F") return { code: existsSync(known) ? 0 : 1, stdout: "", stderr: "" };
		if (command === "ssh-keygen" && args[0] === "-lf") return { code: 0, stdout: "256 SHA256:abc git.example.org (ED25519)\n", stderr: "" };
		if (command === "ssh-keyscan") return { code: 0, stdout: "git.example.org ssh-ed25519 AAAAkey\n", stderr: "" };
		void opts;
		return { code: 0, stdout: "", stderr: "" };
	};
	mkdirSync(join(root, "scout"), { recursive: true });
	writeFileSync(join(root, "scout", "slack-manifest.yaml"), "settings:\n  unfurl_domains:\n    - code.example.com\n    - other.example.com\noauth_config:\n  x: 1\n");
	return { ctx: { env: new EnvFile(join(root, "scout", ".env")), ui, fetch: fetcher, run, dir: join(root, "scout"), home, slackApi: "https://slack.test/api" }, commands };
}

/** Every answer for a first run, in the order the steps ask. */
const FIRST_RUN = [
	"forgejo", "https://git.example.org", "tok", "", // code host: kind, address, token, "key added"
	"xapp-1", "xoxb-1", // Slack: app token, bot token
	"ssh://git@git.example.org/team/app.git", "", "", "y", // repository: URL, slug (guessed), base (main), trust the host
	"local", // sandbox
	"anthropic", "sk-ant", "", // model: service, key, model name (kept)
	"enforce", "U0123ABC=alice", "", // who may ask
	"team", // initiative
	"scout-hq", // home channel
	"none", // backups
];

describe("setup: the settings file", () => {
	it("changes the line that's there, adds the rest, keeps comments, quotes what needs it, and is private", () => {
		const root = tempDir("scout-setup-");
		const path = join(root, ".env");
		writeFileSync(path, "# mine\nA=1\nB=two words\n");
		const env = new EnvFile(path);
		assert.equal(env.get("B"), "two words");
		env.set("A", "2");
		env.set("C", 'say "hi" # now');
		env.save();
		const text = readFileSync(path, "utf8");
		assert.match(text, /^# mine\nA=2\nB=two words\nC="say \\"hi\\" # now"\n$/);
		assert.equal(new EnvFile(path).get("C"), 'say "hi" # now');
		assert.equal(statSync(path).mode & 0o777, 0o600);
	});

	it("starts a new file with a note, not .env.example's placeholders", () => {
		const env = new EnvFile(join(tempDir("scout-setup-"), ".env"));
		assert.equal(env.get("SLACK_BOT_TOKEN"), undefined);
	});
});

describe("setup: small parts", () => {
	it("reads the host out of ssh:// and scp-style addresses", () => {
		assert.deepEqual(sshHostOf("ssh://git@git.example.org:2222/team/app.git"), { host: "git.example.org", port: 2222 });
		assert.deepEqual(sshHostOf("ssh://git@git.example.org/team/app.git"), { host: "git.example.org", port: 22 });
		assert.deepEqual(sshHostOf("git@github.com:team/app.git"), { host: "github.com", port: 22 });
		assert.equal(sshHostOf("https://git.example.org/team/app.git"), undefined);
	});

	it("points the manifest's link previews at the code host", () => {
		const out = manifestFor("a:\n  unfurl_domains:\n    - code.example.com\n    - two.example.com\nb: 1\n", "git.example.org");
		assert.equal(out, "a:\n  unfurl_domains:\n    - git.example.org\nb: 1\n");
	});
});

describe("setup: the walk", () => {
	it("sets everything up from nothing, checking each step, and a second run asks nothing", async () => {
		const root = tempDir("scout-setup-");
		const { fetcher, fetched } = world();
		const first = scripted([...FIRST_RUN]);
		const { ctx } = context(root, first.ui, fetcher);
		assert.equal(await walk(ctx, STEPS), true, first.said.join("\n"));
		assert.equal(first.left(), 0, "every answer was used");
		assert.ok(first.said.some((s) => s.includes("ssh-ed25519 AAAA scout")), "the public key was shown for the account");

		const env = new EnvFile(join(root, "scout", ".env"));
		assert.equal(env.get("SCOUT_CODEHOST_API"), "https://git.example.org/api/v1");
		assert.equal(env.get("SLACK_BOT_TOKEN"), "xoxb-1");
		assert.equal(env.get("SCOUT_REPO_SLUG"), "team/app");
		assert.equal(env.get("SCOUT_REPO_BASE"), "main");
		assert.equal(env.get("SCOUT_MODEL"), "anthropic/claude-opus-5-5");
		assert.equal(env.get("SCOUT_REQUESTER_CHECK"), "enforce");
		assert.deepEqual(JSON.parse(readFileSync(env.get("SCOUT_PEOPLE_FILE")!, "utf8")), { U0123ABC: "alice" });
		assert.match(readFileSync(join(root, "scout", "slack-manifest.local.yaml"), "utf8"), /- git\.example\.org\n/);
		assert.equal(statSync(env.path).mode & 0o777, 0o600);
		assert.ok(fetched.includes("https://slack.test/api/auth.test") && fetched.includes("https://api.anthropic.com/v1/models"), "credentials were tried, not just stored");

		// Again: everything checks out, so nothing is asked.
		const second = scripted([]);
		const again = context(root, second.ui, fetcher).ctx;
		assert.equal(await walk(again, STEPS), true, second.said.join("\n"));
		assert.deepEqual(second.asked, []);
		assert.ok(second.said.every((s) => s.startsWith("✅")), second.said.join("\n"));
	});

	it("says what is wrong with a credential and asks for it again", async () => {
		const root = tempDir("scout-setup-");
		// Slack only accepts the second bot token; after the first is refused, try the step again.
		const { fetcher } = world({ botToken: "xoxb-2" });
		const answers = [...FIRST_RUN];
		answers.splice(6, 0, "again", "xapp-2", "xoxb-2");
		const run = scripted(answers);
		const { ctx } = context(root, run.ui, fetcher);
		assert.equal(await walk(ctx, STEPS), true, run.said.join("\n"));
		assert.ok(run.said.some((s) => s.includes("Slack refused the bot token (invalid_auth)")));
		assert.equal(run.left(), 0);
		assert.equal(new EnvFile(ctx.env.path).get("SLACK_BOT_TOKEN"), "xoxb-2");
	});

	it("leaves a step it's told to skip, and says the setup isn't finished", async () => {
		const root = tempDir("scout-setup-");
		const { fetcher } = world({ botToken: "never" });
		const answers = [...FIRST_RUN];
		answers.splice(6, 0, "skip");
		const run = scripted(answers);
		const { ctx } = context(root, run.ui, fetcher);
		assert.equal(await walk(ctx, STEPS), false);
	});

	it("--check asks nothing and fails on what's not set up", async () => {
		const root = tempDir("scout-setup-");
		const { fetcher } = world();
		const run = scripted([]);
		const { ctx } = context(root, run.ui, fetcher);
		assert.equal(await walk(ctx, STEPS, { check: true }), false);
		assert.deepEqual(run.asked, []);
		assert.ok(run.said.some((s) => s.startsWith("· Code host account: not set up yet")), run.said.join("\n"));
		assert.ok(run.said.some((s) => s.startsWith("· Scout's home channel: not set (optional)")));
	});
});
