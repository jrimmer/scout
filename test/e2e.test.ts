import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Bridge } from "../src/bridge.ts";
import { loadConfig } from "../src/config.ts";
import { openScout } from "../src/scout.ts";
import { Slack } from "../src/slack.ts";
import { threadKey } from "../src/threads.ts";
import { ANN, fakeSlack, SCOUT, TEAM_CHANNEL } from "./fake-slack.ts";
import { bareRepo } from "./helpers.ts";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const toolUse = { stopReason: "toolUse" } as const;

/** Enough of Forgejo's API to open pull requests: what was asked for is kept, for the test to read. */
async function fakeForge() {
	const opened: { path: string; body: Record<string, unknown> }[] = [];
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const path = new URL(req.url ?? "/", "http://forge").pathname;
			res.setHeader("content-type", "application/json");
			const pulls = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(path);
			if (pulls !== null && req.method === "POST") {
				opened.push({ path, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> });
				res.writeHead(201).end(JSON.stringify({ html_url: `http://forge.test/${pulls[1]}/pulls/${opened.length}`, number: opened.length }));
				return;
			}
			res.writeHead(200).end(req.method === "GET" ? (path === "/user" ? JSON.stringify({ login: "scout" }) : "[]") : "{}");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	return {
		apiUrl: `http://127.0.0.1:${port}`,
		opened,
		close: () => {
			server.closeAllConnections();
			return new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

async function until(check: () => boolean, ms = 20_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/**
 * From a Slack event to a pull request, in one process: a Socket Mode envelope goes through Bolt and slack.ts, the
 * bridge, and Scout as openScout wires it (scripted model, local sandbox, the host-side mirror and code host tools),
 * and comes out as a branch in a git repository, a pull request on a stand-in Forgejo, and replies in Slack's Web API.
 */
describe("end to end", () => {
	it("turns a request in a channel into a reviewed pull request, and says so in the thread", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "scout-e2e-")));
		const remote = bareRepo(root, "app");
		mkdirSync(join(root, "profile", "channels", "team"), { recursive: true });
		writeFileSync(join(root, "profile", "system.md"), "You are Scout.");
		const slackApi = await fakeSlack();
		const forge = await fakeForge();
		const config = loadConfig({
			SCOUT_MODEL: "faux/m",
			SCOUT_REPO_URL: remote,
			SCOUT_REPO_SLUG: "acme/app",
			SCOUT_CODEHOST: "forgejo",
			SCOUT_CODEHOST_TOKEN: "forge-token",
			SCOUT_CODEHOST_API: forge.apiUrl,
			SCOUT_DATA_DIR: join(root, "data"),
			SCOUT_PROFILE_DIR: join(root, "profile"),
			SCOUT_SANDBOX_DRIVER: "local",
		});
		const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const slack = new Slack({ botToken: "xoxb-test", appToken: "xapp-test" }, { receiver: slackApi.receiver, apiUrl: slackApi.apiUrl });
		// As main.ts wires them: the pull request is announced in the thread it came from, and in the channel.
		const scout = await openScout({
			config,
			storage: new MemoryStorage(),
			dataDir: config.dataDir,
			instance: "e2e",
			context,
			models,
			watchProfile: false,
			mcp: [],
			pullOpened: (id, pull) => {
				const thread = scout.threads.byConversation(id);
				if (thread !== undefined) void slack.broadcast(thread.channel, thread.threadTs, `Opened <${pull.url}|${pull.slug}#${pull.number}>: ${pull.title}`);
			},
		});
		const bridge = new Bridge({
			harness: scout.harness,
			threads: scout.threads,
			surface: slack.surface,
			botUserId: await slack.identify(),
			nameOf: (user) => slack.nameOf(user),
			agent: scout.workAgent,
			context,
			channelOffer: (user) => slack.channelOffer(user),
			search: scout.search,
			repoFor: scout.repoFor,
			reactionsOn: () => true,
			reactionEmoji: (phase) => scout.reactionEmoji(phase),
			modelFor: scout.modelFor,
		});
		await slack.start({ onMessage: (message) => bridge.onMessage(message), onReaction: (reaction) => bridge.onReaction(reaction) });

		let reviewed = "";
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "printf 'Be kind.\\n' > CONTRIBUTING.md && git add CONTRIBUTING.md && git commit -qm 'Add a contributing guide'" })], toolUse),
			fauxAssistantMessage([fauxToolCall("open_pull_request", { title: "Add a contributing guide", body: "Adds CONTRIBUTING.md, as asked in #team." })], toolUse),
			(transcript) => {
				reviewed = JSON.stringify(transcript);
				return fauxAssistantMessage("APPROVE\nSmall and right.");
			},
			fauxAssistantMessage("I opened a pull request that adds CONTRIBUTING.md."),
		]);

		try {
			const envelope = slackApi.envelope("message-mention");
			Object.assign(envelope.payload.event as object, { text: `<@${SCOUT}> please add a CONTRIBUTING.md that says "Be kind."` });
			await slackApi.receiver.deliver(envelope);

			const thread = scout.threads.get(threadKey(TEAM_CHANNEL, "1700000000.000100"));
			assert.ok(thread, "the mention started a thread on the message");
			const said = () => slackApi.calls.filter((c) => c.method === "chat.postMessage" || c.method === "chat.update").map((c) => String(c.args.text));
			await until(() => said().some((t) => t.includes("I opened a pull request that adds CONTRIBUTING.md.")));
			await scout.harness.waitForIdle(context);
			// The run's ending reaction goes out just after its answer.
			const reacted = () => slackApi.calls.filter((c) => c.method === "reactions.add" || c.method === "reactions.remove");
			await until(() => reacted().length > 0);

			// The change: on Scout's branch in the repository, not on main.
			const branch = git("--git-dir", remote, "for-each-ref", "--format=%(refname:short)", "refs/heads/scout/");
			assert.match(branch, /^scout\//);
			assert.equal(git("--git-dir", remote, "show", `${branch}:CONTRIBUTING.md`), "Be kind.");
			assert.throws(() => git("--git-dir", remote, "show", "main:CONTRIBUTING.md"), "main is untouched");

			// The pull request: from that branch into main, with the self-review it passed.
			assert.equal(forge.opened.length, 1);
			const [pull] = forge.opened;
			assert.equal(pull?.path, "/repos/acme/app/pulls");
			assert.equal(pull?.body.title, "Add a contributing guide");
			assert.equal(pull?.body.head, branch);
			assert.equal(pull?.body.base, "main");
			assert.match(String(pull?.body.body), /^Adds CONTRIBUTING\.md, as asked in #team\./);
			assert.match(String(pull?.body.body), /Scout's self-review[\s\S]*APPROVE\nSmall and right\./);
			assert.match(reviewed, /\+Be kind\./, "the self-review saw the diff");

			// Slack: replies in the thread, the pull request announced there and in the channel, and status reactions.
			const inThread = slackApi.called("chat.postMessage").filter((c) => c.args.thread_ts === "1700000000.000100");
			assert.ok(inThread.length > 0, "Scout answered in the thread");
			assert.ok(inThread.every((c) => c.args.channel === TEAM_CHANNEL));
			const broadcast = slackApi.called("chat.postMessage").find((c) => c.args.reply_broadcast === true);
			assert.equal(broadcast?.args.text, "Opened <http://forge.test/acme/app/pulls/1|acme/app#1>: Add a contributing guide");
			assert.ok(reacted().every((c) => c.args.channel === TEAM_CHANNEL && c.args.timestamp === "1700000000.000100"));
			assert.equal(faux.getPendingResponseCount(), 0);
		} finally {
			await slack.stop();
			await scout.close();
			await forge.close();
			await slackApi.close();
		}
	});

	it("declines direct messages and private channels through the same path, offering a public channel", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "scout-e2e-")));
		mkdirSync(join(root, "profile"));
		const slackApi = await fakeSlack();
		const config = loadConfig({
			SCOUT_MODEL: "faux/m",
			SCOUT_REPO_URL: join(root, "nowhere.git"),
			SCOUT_REPO_SLUG: "acme/app",
			SCOUT_CODEHOST_TOKEN: "t",
			SCOUT_CODEHOST_API: "http://forge.invalid/api/v1",
			SCOUT_DATA_DIR: join(root, "data"),
			SCOUT_PROFILE_DIR: join(root, "profile"),
			SCOUT_SANDBOX_DRIVER: "local",
		});
		const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const slack = new Slack({ botToken: "xoxb-test", appToken: "xapp-test" }, { receiver: slackApi.receiver, apiUrl: slackApi.apiUrl });
		const scout = await openScout({ config, storage: new MemoryStorage(), dataDir: config.dataDir, instance: "e2e", context, models, watchProfile: false, mcp: [] });
		const bridge = new Bridge({
			harness: scout.harness,
			threads: scout.threads,
			surface: slack.surface,
			botUserId: await slack.identify(),
			nameOf: (user) => slack.nameOf(user),
			agent: scout.workAgent,
			context,
			channelOffer: (user) => slack.channelOffer(user),
		});
		await slack.start({ onMessage: (message) => bridge.onMessage(message), onReaction: (reaction) => bridge.onReaction(reaction) });
		try {
			await slackApi.receiver.deliver(slackApi.envelope("message-im"));
			await slackApi.receiver.deliver(slackApi.envelope("message-private"));
			const posts = slackApi.called("chat.postMessage");
			assert.equal(posts.length, 2);
			assert.equal(posts[0]?.args.channel, "D0ANNDM001");
			assert.match(String(posts[0]?.args.text), /I don't work in direct messages/);
			assert.equal((posts[0]?.args.blocks as { elements?: { value?: string }[] }[])[1]?.elements?.[0]?.value, ANN, "with a button for a channel of their own");
			assert.equal(posts[1]?.args.channel, "C0SECRET01");
			assert.match(String(posts[1]?.args.text), /public/);
			assert.equal(scout.threads.get(threadKey("C0SECRET01", "1700000000.000500")), undefined, "no thread, no work");
			assert.equal(faux.getPendingResponseCount(), 0);
		} finally {
			await slack.stop();
			await scout.close();
			await slackApi.close();
		}
	});
});
