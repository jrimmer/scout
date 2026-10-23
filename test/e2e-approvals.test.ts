import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { connectMcp, type McpConnection } from "../src/mcp.ts";
import { threadKey } from "../src/threads.ts";
import { type E2e, type E2eOptions, startScout } from "./e2e.ts";
import { ANN, BOB, TEAM_CHANNEL } from "./fake-slack.ts";
import { tempDir, until } from "./helpers.ts";

const toolUse = { stopReason: "toolUse" } as const;
const WAIT = 20_000;
const ENDINGS = new Set(["white_check_mark", "warning", "hand", "raising_hand"]);
const HOME = "C0HOME0001";

/**
 * Who may approve: Ann is an admin, Bob is not (an Authelia-style users file, which the roles file's groups refer to),
 * and Slack users map to those accounts through the people file. The files live in a directory of their own.
 */
function people(roles: unknown) {
	const dir = tempDir("scout-e2e-approvals-");
	const write = (name: string, content: string) => {
		const path = join(dir, name);
		writeFileSync(path, content);
		return path;
	};
	const directory = write(
		"users.yml",
		["users:", "  ann:", "    email: ann@example.com", "    groups:", "      - admins", "  bob:", "    email: bob@example.com", "    groups:", "      - users", ""].join("\n"),
	);
	return {
		dir,
		env: {
			SCOUT_DIRECTORY: "authelia-file",
			SCOUT_DIRECTORY_SOURCE: directory,
			SCOUT_ROLES_FILE: write("roles.json", JSON.stringify(roles)),
			SCOUT_PEOPLE_FILE: write("people.json", JSON.stringify({ [ANN]: "ann", [BOB]: "bob" })),
			// Where an allowed host is saved (it names the repository the environment does, so that one is the environment's).
			SCOUT_REPOS_FILE: write("repos.json", JSON.stringify([{ name: "app", gitUrl: "unused", slug: "acme/app", base: "main" }])),
		},
		write,
		close: () => rmSync(dir, { recursive: true, force: true }),
	};
}

/** An MCP server whose one tool changes something and needs a person's approval; `written` counts the changes made. */
async function grafana() {
	const written: string[] = [];
	const server = new McpServer({ name: "grafana", version: "1" });
	server.registerTool("write_rules", { description: "Write alert rules", annotations: { readOnlyHint: false } }, async () => {
		written.push("rules");
		return { content: [{ type: "text", text: "written" }] };
	});
	const mcp = await connectMcp({ servers: { grafana: { command: "unused", writes: "approve" } } }, () => {
		const [client, other] = InMemoryTransport.createLinkedPair();
		void server.connect(other);
		return client;
	});
	return { mcp, written, close: () => Promise.all(mcp.map((c) => c.client.close())) };
}

/** Start Scout with the people above (and, if given, an MCP server), run `body`, and close everything even on failure. */
async function withScout(
	options: { roles?: unknown; env?: Record<string, string>; mcp?: McpConnection[]; setup?: (e2e: E2e) => void },
	body: (e2e: E2e, files: ReturnType<typeof people>) => Promise<void>,
): Promise<void> {
	const files = people(options.roles ?? { approve: { "*": ["admins"] } });
	const given: E2eOptions = { env: { ...files.env, ...options.env }, ...(options.mcp === undefined ? {} : { mcp: options.mcp }) };
	const e2e = await startScout(given);
	try {
		await body(e2e, files);
	} finally {
		await e2e.close();
		files.close();
	}
}

/** The same, with a Grafana server that needs approval to write. */
async function withGrafana(body: (e2e: E2e, written: string[]) => Promise<void>, options: { roles?: unknown; env?: Record<string, string> } = {}): Promise<void> {
	const g = await grafana();
	try {
		await withScout({ ...options, mcp: g.mcp }, (e2e) => body(e2e, g.written));
	} finally {
		await g.close();
	}
}

const writeRules = () => fauxAssistantMessage([fauxToolCall("mcp__grafana__write_rules", {})], toolUse);
const lastSaid = (transcript: { messages: unknown[] }) => JSON.stringify(transcript.messages.at(-1));
/** Records what the model was told last, then says `text`. */
const remember = (told: string[], text: string) => (transcript: { messages: unknown[] }) => {
	told.push(lastSaid(transcript));
	return fauxAssistantMessage(text);
};

const said = (e2e: E2e, text: string | RegExp) => e2e.said().some((t) => (typeof text === "string" ? t.includes(text) : text.test(t)));
const saidSoon = (e2e: E2e, text: string | RegExp) => until(() => said(e2e, text), WAIT, `Scout to say ${String(text)}`);
const inThread = (e2e: E2e, ts: string, channel = TEAM_CHANNEL) => e2e.slack.called("chat.postMessage").filter((c) => c.args.thread_ts === ts && c.args.channel === channel);
const idle = (e2e: E2e) => e2e.service.scout.harness.waitForIdle(context);
function reactionsByMessage(e2e: E2e): Map<string, string[]> {
	const by = new Map<string, string[]>();
	for (const c of e2e.slack.called("reactions.add")) by.set(String(c.args.timestamp), [...(by.get(String(c.args.timestamp)) ?? []), String(c.args.name)]);
	return by;
}
/** Wait until `requests` messages are marked as ended and nothing is half-way, so a test can close without a call in flight. */
async function ended(e2e: E2e, requests: number): Promise<void> {
	await until(
		() => {
			const by = reactionsByMessage(e2e);
			return by.size >= requests && [...by.values()].every((names) => ENDINGS.has(names.at(-1) ?? ""));
		},
		WAIT,
		`${requests} request(s) to be marked as ended`,
	);
}

let replies = 0;
const stamp = (base: string) => `${base}.${String(100 + replies++ * 100).padStart(6, "0")}`;

/** Someone replies in a thread, without mentioning Scout (fixture: message-thread-reply). */
async function say(e2e: E2e, threadTs: string, user: string, text: string): Promise<void> {
	const envelope = e2e.slack.envelope("message-thread-reply");
	const ts = stamp("1700000500");
	Object.assign(envelope.payload.event as object, { text, user, ts, event_ts: ts, thread_ts: threadTs, client_msg_id: `e2e-say-${ts}`, channel: TEAM_CHANNEL });
	Object.assign(envelope.payload, { event_id: `Ev-e2e-say-${ts}` });
	await e2e.slack.receiver.deliver(envelope);
}

/** A reaction on a message (fixture: reaction-added). */
async function react(e2e: E2e, name: string, ts: string, user: string): Promise<void> {
	const envelope = e2e.slack.envelope("reaction-added");
	const event = envelope.payload.event as { reaction: string; user: string; item: { channel: string; ts: string }; event_ts: string };
	Object.assign(event, { reaction: name, user, event_ts: stamp("1700000900") });
	Object.assign(event.item, { channel: TEAM_CHANNEL, ts });
	await e2e.slack.receiver.deliver(envelope);
}

/** Someone presses Approve or Decline on the buttons in a thread (fixtures: action-approve, action-decline); what Slack's message became. */
async function press(e2e: E2e, button: "approve" | "decline", conversationId: string, user: string): Promise<{ replace_original?: boolean; text?: string; blocks?: unknown }> {
	const before = e2e.slack.responded.length;
	const envelope = e2e.slack.envelope(`action-${button}`);
	const payload = envelope.payload as { user: { id: string }; actions: { value: string }[] };
	payload.user.id = user;
	payload.actions[0]!.value = conversationId;
	await e2e.slack.receiver.deliver(envelope);
	await until(() => e2e.slack.responded.length > before, WAIT, "the buttons' replacement");
	return e2e.slack.responded.at(-1)!.body;
}

type Asked = { ts: string; conversationId: string; answerTs: string };
/**
 * Ann asks for a change that needs approval; waits for Scout to ask for it, in its answer and with buttons.
 * The model says `answer` after the first refusal and what it is told then goes in `told`.
 */
async function askForChange(e2e: E2e, told: string[] = [], answer = "Raising the threshold needs someone's approval first. Reply approve, or react 👍."): Promise<Asked> {
	e2e.faux.setResponses([writeRules(), remember(told, answer)]);
	const ts = await e2e.mention("raise the disk alert threshold to 90%");
	const buttons = () => e2e.slack.called("chat.postMessage").find((c) => JSON.stringify(c.args.blocks ?? []).includes("scout_approve"));
	await until(() => buttons() !== undefined, WAIT, "the approval buttons");
	await idle(e2e);
	const conversationId = String(e2e.service.scout.threads.get(threadKey(TEAM_CHANNEL, ts))!.conversationId);
	// Scout's answer is its run message, edited: the timestamp of the last edit. A 👍 there approves.
	const answerTs = String(e2e.slack.called("chat.update").at(-1)?.args.ts);
	assert.equal(e2e.service.scout.approvals.askedIn(answerTs), Number(conversationId), "the answer is where a 👍 approves");
	assert.equal(buttons()?.args.thread_ts, ts, "the buttons are in the thread");
	return { ts, conversationId, answerTs };
}

/**
 * Changes made through tools that need a person's approval, and who may give it: the Approve and Decline buttons, a
 * reply of "approve", and a 👍 on Scout's request, with the roles file (admins approve; others can't).
 */
describe("e2e: approvals", () => {
	it("makes the change when an admin presses Approve, once, and the buttons become who approved", async () => {
		await withGrafana(async (e2e, written) => {
			const told: string[] = [];
			const { conversationId } = await askForChange(e2e, told);
			assert.match(told[0] ?? "", /needs a person's approval first/);
			assert.deepEqual(written, [], "nothing changed before anyone approved");

			e2e.faux.setResponses([writeRules(), remember(told, "Done: the disk alert fires at 90% now.")]);
			const replaced = await press(e2e, "approve", conversationId, ANN);
			assert.equal(replaced.replace_original, true);
			assert.equal(replaced.text, "👍 Approved by <@U0ANN00001>.");
			await saidSoon(e2e, "Done: the disk alert fires at 90% now.");
			await ended(e2e, 2);
			await idle(e2e);
			assert.deepEqual(written, ["rules"], "the change was made, once");
			assert.match(told[1] ?? "", /written/);
			assert.equal(e2e.service.scout.approvals.waiting(Number(conversationId)), false);
		});
	});

	it("does not make the change when someone who isn't an admin presses Approve, and the thread says who can", async () => {
		await withGrafana(async (e2e, written) => {
			const told: string[] = [];
			const { ts, conversationId } = await askForChange(e2e, told);
			e2e.faux.setResponses([writeRules(), remember(told, "Bob's approval doesn't count here: someone in admins has to approve.")]);
			await press(e2e, "approve", conversationId, BOB);
			await saidSoon(e2e, "Bob's approval doesn't count here");
			await ended(e2e, 2);
			await idle(e2e);
			assert.deepEqual(written, [], "nothing was changed");
			assert.match(told[1] ?? "", /The approval doesn't cover this: changes to grafana need someone in admins\./);

			// An admin can still approve afterwards, and then it goes through.
			e2e.faux.setResponses([writeRules(), remember(told, "Done, with Ann's approval.")]);
			await say(e2e, ts, ANN, "approve");
			await saidSoon(e2e, "Done, with Ann's approval.");
			await ended(e2e, 3);
			assert.deepEqual(written, ["rules"]);
		});
	});

	// BUG (reported with this suite): the button's reply is decided by `approvals.by(...) === user`, which is true for
	// anyone, because the grant is recorded before the roles are checked (service.ts decide). So a non-admin who
	// presses Approve is told "👍 Approved by <@them>." even though the change then refuses. The check that matters
	// (refuseApprover) runs only when the tool is called. The message should say it can't count, as it does for a
	// refused "approve" reply in the thread.
	it("tells a non-admin who presses Approve that it doesn't count, on the button itself", { todo: "the button says 'Approved by' for anyone: service.ts decide() grants before checking roles" }, async () => {
		await withGrafana(async (e2e) => {
			const { conversationId } = await askForChange(e2e);
			e2e.faux.setResponses([writeRules(), fauxAssistantMessage("Not approved.")]);
			const replaced = await press(e2e, "approve", conversationId, BOB);
			await saidSoon(e2e, "Not approved.");
			await ended(e2e, 2);
			await idle(e2e);
			// Last, so that a failure here leaves nothing running: the buttons say what happened to Bob's approval.
			assert.doesNotMatch(String(replaced.text), /Approved by/);
		});
	});

	it("declines the change when someone presses Decline: nothing is made, and Scout is told not to", async () => {
		await withGrafana(async (e2e, written) => {
			const told: string[] = [];
			const { conversationId } = await askForChange(e2e, told);
			e2e.faux.setResponses([remember(told, "Understood, I won't change the threshold.")]);
			const replaced = await press(e2e, "decline", conversationId, ANN);
			assert.equal(replaced.text, "✋ Declined by <@U0ANN00001>.");
			await saidSoon(e2e, "Understood, I won't change the threshold.");
			await ended(e2e, 2);
			await idle(e2e);
			assert.deepEqual(written, []);
			assert.match(told[1] ?? "", /Ann: @Scout I'm declining that change: please don't make it\./);
			assert.equal(e2e.service.scout.approvals.waiting(Number(conversationId)), false, "nothing is waiting for approval any more");
			// A late Approve finds nothing waiting.
			const late = await press(e2e, "approve", conversationId, ANN);
			assert.equal(late.text, "Nothing's waiting for approval there any more.");
		});
	});

	it("takes a 👍 on Scout's request from an admin as approval, as the README says", async () => {
		await withGrafana(async (e2e, written) => {
			const told: string[] = [];
			const { answerTs } = await askForChange(e2e, told);
			e2e.faux.setResponses([writeRules(), remember(told, "Done: the threshold is 90%.")]);
			await react(e2e, "+1", answerTs, ANN);
			await saidSoon(e2e, "Done: the threshold is 90%.");
			await ended(e2e, 2);
			await idle(e2e);
			assert.deepEqual(written, ["rules"]);
			assert.match(told[1] ?? "", /written/);
		});
	});

	it("ignores a 👍 on Scout's request from someone who isn't an admin, and a 👍 on any other message", async () => {
		await withGrafana(async (e2e, written) => {
			const told: string[] = [];
			const { ts, answerTs } = await askForChange(e2e, told);
			// A 👍 on the thread's first message is not on Scout's request: nothing happens at all.
			e2e.faux.setResponses([fauxAssistantMessage("I should not be asked.")]);
			await react(e2e, "+1", ts, ANN);
			assert.equal(e2e.faux.getPendingResponseCount(), 1, "no run was started");

			// Bob's 👍 on the request counts as "approve" from him, which the roles don't allow.
			e2e.faux.setResponses([writeRules(), remember(told, "That 👍 isn't from an admin, so I haven't changed anything.")]);
			await react(e2e, "+1", answerTs, BOB);
			await saidSoon(e2e, "That 👍 isn't from an admin");
			await ended(e2e, 2);
			await idle(e2e);
			assert.deepEqual(written, []);
			assert.match(told[1] ?? "", /need someone in admins/);
		});
	});

	it("takes \"approve\" as a reply only when it is the whole reply, so \"I don't approve\" changes nothing", async () => {
		await withGrafana(async (e2e, written) => {
			const { ts, conversationId } = await askForChange(e2e);
			e2e.faux.setResponses([fauxAssistantMessage("Noted, I'll wait.")]);
			await say(e2e, ts, ANN, "@Scout I don't approve, not yet");
			await saidSoon(e2e, "Noted, I'll wait.");
			await ended(e2e, 2);
			await idle(e2e);
			assert.equal(e2e.service.scout.approvals.by(Number(conversationId)), undefined, "no approval was recorded");
			assert.deepEqual(written, []);
		});
	});

	it("does not take approval from someone who may not ask for work in the repository at all", async () => {
		await withGrafana(
			async (e2e, written) => {
				e2e.host.collaborator("acme/app", "ann", "write");
				e2e.host.collaborator("acme/app", "bob", "read");
				const { ts, conversationId } = await askForChange(e2e);
				// A bare "approve" from Bob is only kept as context: it is not a request, so he isn't answered either.
				const posts = inThread(e2e, ts).length;
				await say(e2e, ts, BOB, "approve");
				assert.equal(e2e.service.scout.approvals.by(Number(conversationId)), undefined, "nothing was recorded");
				assert.equal(inThread(e2e, ts).length, posts);
				// Asking Scout outright gets the reason.
				await e2e.mention("approve", { user: BOB, threadTs: ts });
				await until(() => inThread(e2e, ts).some((c) => /<@U0BOB00001> You \(bob\) can't change acme\/app/.test(String(c.args.text))), WAIT, "Bob to be told no");
				assert.equal(e2e.service.scout.approvals.by(Number(conversationId)), undefined, "still nothing recorded");
				assert.deepEqual(written, []);
				await idle(e2e);
			},
			{ roles: { approve: { "*": ["admins", "users"] } }, env: { SCOUT_REQUESTER_CHECK: "enforce" } },
		);
	});
});

/** Hosts a sandbox can't reach: Scout asks in its home channel, and the people who decide say yes or no. */
describe("e2e: network access for sandboxes", () => {
	/** Scout with a home channel, and the repositories file to save to. */
	async function withHome(body: (e2e: E2e, files: ReturnType<typeof people>, file: string) => Promise<void>): Promise<void> {
		await withScout({ roles: { approve: { egress: ["admins"] } }, env: { SCOUT_REFLECT_CHANNEL: "scout" } }, async (e2e, files) => {
			e2e.slack.channels.set(HOME, { id: HOME, name: "scout", is_channel: true, is_private: false, is_member: true });
			await body(e2e, files, join(files.dir, "repos.json"));
		});
	}

	const needsNetwork = (host = "registry.npmjs.org") => fauxAssistantMessage([fauxToolCall("ask_for_network", { host, why: "npm ci couldn't fetch packages" })], toolUse);

	/** Ann asks for something that needs the network; waits for the question in the home channel; returns its buttons' request id. */
	async function askForHost(e2e: E2e, told: string[], host = "registry.npmjs.org"): Promise<{ ts: string; id: string; question: string }> {
		e2e.faux.setResponses([needsNetwork(host), remember(told, `I've asked for ${host}; I'll carry on when it's decided.`)]);
		const ts = await e2e.mention("install the dependencies");
		const posted = () => e2e.slack.called("chat.postMessage").find((c) => c.args.channel === HOME && JSON.stringify(c.args.blocks ?? []).includes("scout_egress_allow"));
		await until(() => posted() !== undefined, WAIT, "the question in the home channel");
		await saidSoon(e2e, `I've asked for ${host}`);
		await ended(e2e, 1);
		await idle(e2e);
		const blocks = posted()!.args.blocks as { elements?: { action_id?: string; value?: string }[] }[];
		const id = blocks.flatMap((b) => b.elements ?? []).find((el) => el.action_id === "scout_egress_allow")?.value;
		assert.ok(id !== undefined);
		return { ts, id, question: String(posted()!.args.text) };
	}

	/** Someone presses Allow or Decline on the question (fixtures: action-egress-allow, action-egress-decline). */
	async function decide(e2e: E2e, allow: boolean, id: string, user: string): Promise<{ replace_original?: boolean; response_type?: string; text?: string }> {
		const before = e2e.slack.responded.length;
		const envelope = e2e.slack.envelope(allow ? "action-egress-allow" : "action-egress-decline");
		const payload = envelope.payload as { user: { id: string }; actions: { value: string }[] };
		payload.user.id = user;
		payload.actions[0]!.value = id;
		await e2e.slack.receiver.deliver(envelope);
		await until(() => e2e.slack.responded.length > before, WAIT, "the answer to the button");
		return e2e.slack.responded.at(-1)!.body;
	}

	it("asks the home channel when a sandbox can't reach a host, and an admin's Allow saves it to the repositories file and tells the thread", async () => {
		await withHome(async (e2e, files, file) => {
			const told: string[] = [];
			const { ts, id, question } = await askForHost(e2e, told);
			assert.match(told[0] ?? "", /I've asked whoever runs me to allow registry\.npmjs\.org for app's sandboxes\. I'll say here when they decide\./);
			assert.match(question, /A thread|<https?:\/\/[^|]+\|A thread>/);
			assert.match(question, /in \*app\* couldn't reach `registry\.npmjs\.org`: npm ci couldn't fetch packages\nAllow `registry\.npmjs\.org` for app's sandboxes\?/);

			// A person who isn't an approver can't decide it, and is told so privately; it stays open.
			const refused = await decide(e2e, true, id, BOB);
			assert.equal(refused.response_type, "ephemeral");
			assert.match(String(refused.text), /^You can't decide this one: changes to egress need someone in admins\./);
			assert.equal(JSON.parse(readFileSync(file, "utf8"))[0].egress, undefined, "nothing was saved");

			const allowed = await decide(e2e, true, id, ANN);
			assert.equal(allowed.replace_original, true);
			assert.equal(allowed.text, "✅ Allowed by <@U0ANN00001>: `registry.npmjs.org` for app (saved to the repos file).");
			assert.deepEqual(JSON.parse(readFileSync(file, "utf8"))[0].egress, ["registry.npmjs.org"], "the host is in the repositories file");
			await until(() => inThread(e2e, ts).some((c) => /<@U0ANN00001> allowed `registry\.npmjs\.org` for app's sandboxes/.test(String(c.args.text))), WAIT, "the thread to be told");

			// Pressing it again finds it decided.
			const again = await decide(e2e, false, id, ANN);
			assert.equal(again.text, "Already allowed by <@U0ANN00001>.");

			// Asking for the same host later is answered without asking anyone.
			e2e.faux.setResponses([needsNetwork(), remember(told, "It's allowed already.")]);
			await e2e.mention("install the dependencies again");
			await saidSoon(e2e, "It's allowed already.");
			await ended(e2e, 2);
			assert.match(told.at(-1) ?? "", /registry\.npmjs\.org is already allowed for app\./);
		});
	});

	it("tells the thread when an admin declines a host, and leaves the repositories file alone", async () => {
		await withHome(async (e2e, files, file) => {
			const { ts, id } = await askForHost(e2e, [], "example.org");
			const declined = await decide(e2e, false, id, ANN);
			assert.equal(declined.text, "✋ Declined by <@U0ANN00001>: `example.org` for app.");
			await until(() => inThread(e2e, ts).some((c) => /<@U0ANN00001> declined `example\.org` for app's sandboxes, so I'll have to do without it\./.test(String(c.args.text))), WAIT, "the thread to be told");
			assert.equal(JSON.parse(readFileSync(file, "utf8"))[0].egress, undefined);
		});
	});

	it("says there is no one to ask when Scout has no home channel", async () => {
		await withScout({ roles: { approve: { egress: ["admins"] } } }, async (e2e) => {
			const told: string[] = [];
			e2e.faux.setResponses([needsNetwork(), remember(told, "I couldn't ask anyone.")]);
			await e2e.mention("install the dependencies");
			await saidSoon(e2e, "I couldn't ask anyone.");
			await ended(e2e, 1);
			assert.match(told[0] ?? "", /I'd ask for registry\.npmjs\.org to be allowed for app, but I have no home channel to ask in\./);
			assert.equal(e2e.slack.called("chat.postMessage").some((c) => JSON.stringify(c.args.blocks ?? []).includes("scout_egress")), false);
		});
	});
});
