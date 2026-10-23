import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { IncomingMessage } from "../src/bridge.ts";
import { Slack, type SlackHandlers } from "../src/slack.ts";
import { ANN, BOB, ELSEWHERE_CHANNEL, fakeSlack, type FakeSlack, SCOUT, SECRET_CHANNEL, TEAM, TEAM_CHANNEL } from "./fake-slack.ts";

/**
 * slack.ts against real Bolt: Socket Mode envelopes (test/fixtures/slack) go through Bolt's routing and middleware,
 * and its WebClient calls a stand-in for Slack's Web API over HTTP, so what's asserted is what Slack would receive.
 */
describe("slack", () => {
	let fake: FakeSlack;
	let slack: Slack;
	/** What each handler was called with, by handler. */
	let seen: Record<string, unknown[]>;
	/** Slack apps made in a test (each calls auth.test when made), for closing the fake only once they're answered. */
	let apps: number;

	const record =
		<T>(name: string, answer?: (value: never) => T) =>
		async (value: unknown): Promise<T> => {
			(seen[name] ??= []).push(value);
			return (answer?.(value as never) ?? undefined) as T;
		};

	beforeEach(async () => {
		fake = await fakeSlack();
		slack = new Slack({ botToken: "xoxb-test", appToken: "xapp-test" }, { receiver: fake.receiver, apiUrl: fake.apiUrl });
		seen = {};
		apps = 1;
	});

	afterEach(async () => {
		mock.restoreAll();
		await slack.stop();
		await fake.close(apps);
	});

	async function start(more: Partial<SlackHandlers> = {}) {
		await slack.identify();
		await slack.start({ onMessage: record("message"), onReaction: record("reaction"), ...more });
	}

	const deliver = (name: string, change?: (payload: Record<string, unknown>) => void) => {
		const envelope = fake.envelope(name);
		change?.(envelope.payload);
		return fake.receiver.deliver(envelope);
	};
	const event = (payload: Record<string, unknown>) => payload.event as Record<string, unknown>;
	/** Errors Slack-side handlers log, kept out of the test output and available to assert on. */
	const quietErrors = () => mock.method(console, "error", () => {});

	describe("messages", () => {
		it("passes a mention in a public channel to the bridge, with the channel's name", async () => {
			await start();
			await deliver("message-mention");
			assert.deepEqual(seen.message, [
				{ channel: TEAM_CHANNEL, channelType: "channel", channelName: "team", user: ANN, text: `<@${SCOUT}> what does the build do?`, ts: "1700000000.000100" },
			] satisfies IncomingMessage[]);
			await deliver("message-thread-reply");
			assert.equal(fake.called("conversations.info").length, 1, "the channel's name is looked up once");
		});

		it("passes a thread reply with its thread", async () => {
			await start();
			await deliver("message-thread-reply");
			assert.deepEqual(seen.message, [
				{ channel: TEAM_CHANNEL, channelType: "channel", channelName: "team", user: BOB, text: "and the tests too, please", ts: "1700000000.000200", threadTs: "1700000000.000100" },
			]);
		});

		it("passes shared files that can be downloaded, and leaves out deleted ones", async () => {
			await start();
			await deliver("message-file-share");
			const [message] = seen.message as IncomingMessage[];
			assert.deepEqual(message?.files, [
				{ name: "build.log", mimetype: "text/plain", size: 2048, url: "https://files.slack.com/files-pri/T0ACME0001-F0LOG00001/download/build.log" },
			]);
		});

		it("passes direct messages and private channels on, for the bridge to decline, without looking up a name", async () => {
			await start();
			await deliver("message-im");
			await deliver("message-private");
			assert.deepEqual(
				(seen.message as IncomingMessage[]).map((m) => [m.channelType, m.channelName, m.channel]),
				[
					["im", "", "D0ANNDM001"],
					["group", "", SECRET_CHANNEL],
				],
			);
			assert.equal(fake.called("conversations.info").length, 0);
		});

		it("ignores bots, Scout itself, and messages that aren't people talking", async () => {
			await start();
			await deliver("message-bot");
			await deliver("message-other-bot-user");
			await deliver("message-join");
			await deliver("message-mention", (p) => Object.assign(event(p), { user: SCOUT }));
			assert.equal(seen.message, undefined);
		});

		it("keeps listening after a message's handler fails", async () => {
			const errors = quietErrors();
			let calls = 0;
			await start({
				onMessage: async () => {
					if (++calls === 1) throw new Error("boom");
				},
			});
			await deliver("message-mention");
			await deliver("message-thread-reply");
			assert.equal(calls, 2);
			assert.match(String(errors.mock.calls[0]?.arguments[0]), /message C0TEAM0001\/1700000000\.000100 failed/);
		});

		it("passes edits with their new text and thread, but not Slack adding a link preview", async () => {
			await start({ onEdit: record("edit"), onDelete: (d) => void (seen.delete ??= []).push(d) });
			await deliver("message-changed");
			await deliver("message-unfurled");
			assert.deepEqual(seen.edit, [{ channel: TEAM_CHANNEL, ts: "1700000000.000200", user: BOB, text: "and the docs too, please", threadTs: "1700000000.000100" }]);
			await deliver("message-changed", (p) => Object.assign((event(p).message as Record<string, unknown>), { bot_id: "B0DEPLOY01" }));
			assert.equal(seen.edit?.length, 1, "a bot's edit isn't one");
			await deliver("message-deleted");
			assert.deepEqual(seen.delete, [{ channel: TEAM_CHANNEL, ts: "1700000000.000200" }]);
			assert.equal(seen.message, undefined, "neither is a new message");
		});

		it("keeps listening after an edit's handler fails", async () => {
			const errors = quietErrors();
			await start({ onEdit: async () => Promise.reject(new Error("boom")) });
			await deliver("message-changed");
			await deliver("message-mention");
			assert.equal(seen.message?.length, 1);
			assert.match(String(errors.mock.calls[0]?.arguments[0]), /edit in C0TEAM0001 failed/);
		});
	});

	describe("reactions", () => {
		it("passes reactions on messages, and ignores Scout's own and those on files", async () => {
			await start();
			await deliver("reaction-added");
			await deliver("reaction-added", (p) => Object.assign(event(p), { user: SCOUT }));
			await deliver("reaction-file");
			assert.deepEqual(seen.reaction, [{ channel: TEAM_CHANNEL, ts: "1700000000.000900", name: "+1", user: ANN, eventTs: "1700000003.000100" }]);
		});

		it("ignores reactions from bots and other apps: no stop, retry, approval or 🔍 from them", async () => {
			await start({ onLook: record("look") });
			fake.users.set("U0OTHERBOT", { id: "U0OTHERBOT", name: "deploybot", is_bot: true, profile: { display_name: "", real_name: "Deploy Bot", email: "" } } as never);
			for (const reaction of ["octagonal_sign", "repeat", "+1"]) await deliver("reaction-added", (p) => Object.assign(event(p), { user: "U0OTHERBOT", reaction }));
			await deliver("reaction-added", (p) => Object.assign(event(p), { user: ANN, bot_id: "B0OTHER001" }));
			await deliver("reaction-look", (p) => Object.assign(event(p), { user: "U0OTHERBOT" }));
			assert.equal(seen.reaction, undefined);
			assert.equal(seen.look, undefined);
			// When Slack can't say who reacted, only a stop counts: stopping is always safe.
			fake.queue("users.info", { ok: false, error: "fatal_error" }, { ok: false, error: "fatal_error" });
			await deliver("reaction-added", (p) => Object.assign(event(p), { user: "U0UNKNOWN1", reaction: "+1" }));
			await deliver("reaction-added", (p) => Object.assign(event(p), { user: "U0UNKNOWN2", reaction: "octagonal_sign" }));
			assert.deepEqual((seen.reaction as { name: string; user: string }[]).map((r) => [r.name, r.user]), [["octagonal_sign", "U0UNKNOWN2"]]);
		});

		it("looks into a message on 🔍, finding a reply through its thread", async () => {
			await start({ onLook: record("look") });
			// History has only top-level messages: the reply is found in its thread.
			fake.queue("conversations.history", { ok: true, messages: [{ type: "message", user: ANN, text: "the parent", ts: "1700000000.000100" }] });
			fake.queue("conversations.replies", {
				ok: true,
				messages: [
					{ type: "message", user: ANN, text: "the parent", ts: "1700000000.000100", thread_ts: "1700000000.000100" },
					{ type: "message", user: BOB, text: "the deploy failed again", ts: "1700000000.000200", thread_ts: "1700000000.000100" },
				],
			});
			await deliver("reaction-look");
			assert.deepEqual(seen.look, [{ user: ANN, channel: TEAM_CHANNEL, channelName: "team", ts: "1700000000.000200", author: BOB, text: "the deploy failed again", threadTs: "1700000000.000100" }]);
			assert.equal(seen.reaction, undefined, "🔍 is a request, not a reaction to pass on");
			assert.deepEqual(fake.called("conversations.history")[0]?.args, { channel: TEAM_CHANNEL, latest: "1700000000.000200", inclusive: true, limit: "1" });
		});

		it("doesn't look into messages in private channels, or ones it can't find", async () => {
			await start({ onLook: record("look") });
			fake.queue("conversations.history", { ok: true, messages: [{ type: "message", user: BOB, text: "secret", ts: "1700000000.000200" }] });
			await deliver("reaction-look", (p) => Object.assign(event(p).item as object, { channel: SECRET_CHANNEL }));
			await deliver("reaction-look");
			assert.equal(seen.look, undefined);
		});

		it("passes 🔍 on as a reaction where looking isn't wired up", async () => {
			await start();
			await deliver("reaction-look");
			assert.deepEqual((seen.reaction as { name: string }[]).map((r) => r.name), ["mag"]);
		});
	});

	describe("Ask Scout about this", () => {
		it("opens a form quoting the message, carrying where it was", async () => {
			await start();
			const acked = await deliver("shortcut-ask");
			assert.equal(acked, null);
			const [open] = fake.called("views.open");
			assert.equal(open?.args.trigger_id, "1.1700000007.trigger");
			const view = open?.args.view as { callback_id: string; private_metadata: string; blocks: { text?: { text: string } }[] };
			assert.equal(view.callback_id, "scout_ask_form");
			assert.deepEqual(JSON.parse(view.private_metadata), { channel: TEAM_CHANNEL, ts: "1700000000.000200", threadTs: "1700000000.000100", author: BOB, text: "the deploy failed again\nsee the log" });
			assert.equal(view.blocks[0]?.text?.text, "> the deploy failed again\n> see the log");
		});

		it("starts on the message when the form is sent in a public channel Scout is in", async () => {
			await start({ onAsk: record("ask") });
			const acked = await deliver("view-submission-ask");
			assert.equal(acked, null);
			assert.deepEqual(seen.ask, [
				{ user: ANN, channel: TEAM_CHANNEL, channelName: "team", ts: "1700000000.000200", threadTs: "1700000000.000100", author: BOB, text: "the deploy failed again", request: "why did it fail?" },
			]);
		});

		it("says in the form that it only works in public channels it's in", async () => {
			await start({ onAsk: record("ask") });
			for (const channel of [SECRET_CHANNEL, ELSEWHERE_CHANNEL]) {
				const acked = await deliver("view-submission-ask", (p) => {
					const view = p.view as { private_metadata: string };
					view.private_metadata = JSON.stringify({ ...JSON.parse(view.private_metadata), channel });
				});
				assert.deepEqual(acked, { response_action: "errors", errors: { request: "I only work in public channels I'm in. Invite me here, or ask me in a channel I'm in." } });
			}
			assert.equal(seen.ask, undefined);
		});

		it("remembers a channel it can work in, so the next form needn't ask Slack", async () => {
			await start({ onAsk: record("ask") });
			await deliver("view-submission-ask");
			await deliver("view-submission-ask");
			assert.equal(seen.ask?.length, 2);
			assert.equal(fake.called("conversations.info").length, 1);
		});

		it("takes the form when Slack is slow to say where it was sent, and checks afterwards", async () => {
			await start({ onAsk: record("ask") });
			fake.stall("conversations.info", 2_500);
			const started = Date.now();
			assert.equal(await deliver("view-submission-ask"), null, "taken, not an error");
			assert.ok(Date.now() - started < 2_900, "within Slack's three seconds");
			assert.equal(seen.ask?.length, 1, "and started once Slack said it was a channel Scout's in");
		});

		it("tells the person privately when a form it took turns out to be from a channel it can't work in", async () => {
			await start({ onAsk: record("ask") });
			fake.stall("conversations.info", 2_500);
			await deliver("view-submission-ask", (p) => {
				const view = p.view as { private_metadata: string };
				view.private_metadata = JSON.stringify({ ...JSON.parse(view.private_metadata), channel: ELSEWHERE_CHANNEL });
			});
			assert.equal(seen.ask, undefined);
			const [told] = fake.called("chat.postMessage");
			assert.equal(told?.args.channel, ANN);
			assert.match(String(told?.args.text), /^About your Ask Scout request in <#C0ELSE0001>: I only work in public channels I'm in\./);
		});
	});

	describe("buttons", () => {
		it("approves or declines a change, and the message then says who decided", async () => {
			await start({ onDecision: record("decision", (d: { approve: boolean }) => (d.approve ? "Ann approved." : "Ann declined.")) });
			assert.equal(await deliver("action-approve"), null);
			await deliver("action-decline");
			assert.deepEqual(seen.decision, [
				{ user: ANN, channel: TEAM_CHANNEL, conversationId: 17, approve: true },
				{ user: ANN, channel: TEAM_CHANNEL, conversationId: 17, approve: false },
			]);
			assert.deepEqual(fake.responded[0], {
				path: "/hooks/actions/T0ACME0001/3/action-approve",
				body: { replace_original: true, text: "Ann approved.", blocks: [{ type: "context", elements: [{ type: "mrkdwn", text: "Ann approved." }] }] },
			});
		});

		it("allows or declines a network request: final answers replace the buttons, others go just to whoever pressed", async () => {
			await start({ onEgress: record("egress", (d: { allow: boolean }) => (d.allow ? { text: "Allowed.", final: true } : { text: "Only admins decide.", final: false })) });
			await deliver("action-egress-allow");
			await deliver("action-egress-decline");
			assert.deepEqual(seen.egress, [
				{ user: ANN, id: 4, allow: true },
				{ user: ANN, id: 4, allow: false },
			]);
			assert.deepEqual(
				fake.responded.map((r) => r.body),
				[
					{ replace_original: true, text: "Allowed.", blocks: [{ type: "section", text: { type: "mrkdwn", text: "Allowed." } }] },
					{ replace_original: false, response_type: "ephemeral", text: "Only admins decide." },
				],
			);
		});

		it("uses one of a thread's approaches: the comparison is replaced, or a note goes just to whoever pressed", async () => {
			const answers: (string | { text: string; blocks: unknown[] })[] = [{ text: "Ann chose approach 2.", blocks: [{ type: "markdown", text: "Ann chose approach 2." }] }, "That one is gone."];
			await start({ onUseApproach: record("use", () => answers.shift()!) });
			await deliver("action-use-approach");
			await deliver("action-use-approach");
			assert.deepEqual(seen.use, [
				{ user: ANN, channel: TEAM_CHANNEL, parentId: 31, index: 2 },
				{ user: ANN, channel: TEAM_CHANNEL, parentId: 31, index: 2 },
			]);
			assert.deepEqual(
				fake.responded.map((r) => r.body),
				[
					{ replace_original: true, text: "Ann chose approach 2.", blocks: [{ type: "markdown", text: "Ann chose approach 2." }] },
					{ response_type: "ephemeral", replace_original: false, text: "That one is gone." },
				],
			);
		});

		it("ignores a button whose value isn't a number", async () => {
			await start({ onDecision: record("decision", () => "x"), onUseApproach: record("use", () => "x") });
			await deliver("action-approve", (p) => void ((p.actions as { value: string }[])[0]!.value = "not-a-number"));
			await deliver("action-use-approach", (p) => void ((p.actions as { value: string }[])[0]!.value = "nope"));
			assert.equal(seen.decision, undefined);
			assert.equal(seen.use, undefined);
			assert.deepEqual(fake.responded, []);
		});

		it("creates a public channel for someone who wrote directly, with a free name, and says so", async () => {
			await start();
			fake.queue("conversations.create", { ok: false, error: "name_taken" });
			await deliver("action-create-channel");
			assert.deepEqual(fake.called("conversations.create").map((c) => c.args), [
				{ name: "ann_scout", is_private: false },
				{ name: "ann_scout-2", is_private: false },
			]);
			assert.deepEqual(fake.called("conversations.invite")[0]?.args, { channel: "C0NEW00001", users: ANN });
			assert.equal(fake.called("chat.postMessage")[0]?.args.text, `Hi <@${ANN}>. This channel is ours, and it's public, so anyone can follow along.`);
			assert.deepEqual(fake.responded[0]?.body, { replace_original: true, text: "Done: <#C0NEW00001>. Mention me there and we'll get going." });
		});

		it("says when it couldn't create the channel", async () => {
			quietErrors();
			await start();
			fake.queue("conversations.create", { ok: false, error: "restricted_action" });
			await deliver("action-create-channel");
			assert.deepEqual(fake.responded[0]?.body, { replace_original: false, text: "I couldn't create the channel. Could you make one and invite me?" });
		});
	});

	describe("/scout", () => {
		it("answers just to whoever asked", async () => {
			await start({ onCommand: record("command", () => "Nothing running.") });
			assert.equal(await deliver("slash-command"), null);
			assert.deepEqual(seen.command, [{ user: ANN, channel: TEAM_CHANNEL, channelName: "team", text: "status" }]);
			assert.deepEqual(fake.responded, [{ path: "/hooks/commands/T0ACME0001/1/slash", body: { response_type: "ephemeral", text: "Nothing running." } }]);
		});

		it("says something went wrong when answering fails", async () => {
			quietErrors();
			await start({ onCommand: async () => Promise.reject(new Error("boom")) });
			await deliver("slash-command");
			assert.deepEqual(fake.responded[0]?.body, { response_type: "ephemeral", text: "Something went wrong on my side. Try again in a minute?" });
		});
	});

	describe("links, App Home and workflows", () => {
		it("previews the links it knows, and leaves the rest", async () => {
			const blocks = [{ type: "section", text: { type: "mrkdwn", text: "*Fix the build*" } }];
			await start({ onLinks: record("links", () => ({ "https://code.example.com/acme/web/pulls/7": { blocks } })) });
			await deliver("link-shared");
			assert.deepEqual(seen.links, [["https://code.example.com/acme/web/pulls/7", "https://code.example.com/acme/web/issues/9"]]);
			assert.deepEqual(fake.called("chat.unfurl")[0]?.args, { channel: TEAM_CHANNEL, ts: "1700000000.001000", unfurls: { "https://code.example.com/acme/web/pulls/7": { blocks } } });
		});

		it("doesn't unfurl when it knows none of the links, or can't tell", async () => {
			quietErrors();
			let calls = 0;
			await start({ onLinks: async () => (++calls === 1 ? {} : Promise.reject(new Error("forge down"))) });
			await deliver("link-shared");
			await deliver("link-shared");
			assert.equal(calls, 2);
			assert.equal(fake.called("chat.unfurl").length, 0);
		});

		it("shows App Home on its tab only", async () => {
			const view = { type: "home" as const, blocks: [{ type: "section", text: { type: "mrkdwn", text: "Hi Ann" } }] };
			await start({ home: record("home", () => view) });
			await deliver("app-home-opened");
			await deliver("app-home-opened", (p) => Object.assign(event(p), { tab: "messages" }));
			assert.deepEqual(seen.home, [ANN]);
			assert.deepEqual(fake.called("views.publish").map((c) => c.args), [{ user_id: ANN, view }]);
		});

		it("runs the Ask Scout workflow step and completes it with the thread's link, using the step's own token", async () => {
			await start({ onWorkflowAsk: record("workflow", () => "https://acme.slack.com/archives/C0TEAM0001/p1700000010000100") });
			await deliver("function-executed");
			assert.deepEqual(seen.workflow, [{ channel: TEAM_CHANNEL, user: ANN, request: "Summarize yesterday's failed deploys", about: "Deploy 42 failed at 03:10" }]);
			const [done] = fake.called("functions.completeSuccess");
			assert.deepEqual(done?.args, { team_id: TEAM, function_execution_id: "Fx0EXEC0001", outputs: { thread_link: "https://acme.slack.com/archives/C0TEAM0001/p1700000010000100" } });
			assert.equal(done?.token, "xwfp-test-function-token");
		});

		it("fails the workflow step without a request or a person who ran it, or when starting fails", async () => {
			await start({ onWorkflowAsk: async () => Promise.reject(new Error("Invite Scout to the channel first.")) });
			await deliver("function-executed", (p) => Object.assign(event(p).inputs as object, { request: "  " }));
			await deliver("function-executed", (p) => void delete (event(p).inputs as Record<string, unknown>).interactivity);
			await deliver("function-executed");
			assert.deepEqual(
				fake.called("functions.completeError").map((c) => c.args.error),
				[
					"Ask Scout needs a channel and a request.",
					"Ask Scout acts for the person who runs the workflow, so a person has to start it: from a link, a shortcut or a button, not a schedule or a webhook.",
					"Invite Scout to the channel first.",
				],
			);
			assert.equal(fake.called("functions.completeSuccess").length, 0);
		});
	});

	describe("the chat surface", () => {
		it("posts and updates without link previews, in the thread when there is one", async () => {
			await slack.identify();
			const ts = await slack.surface.post(TEAM_CHANNEL, "1700000000.000100", { text: "Working on it", blocks: [{ type: "markdown", text: "Working on it" }] });
			await slack.surface.post(TEAM_CHANNEL, undefined, { text: "Top level", blocks: [] });
			await slack.surface.update(TEAM_CHANNEL, ts, { text: "Done", blocks: [{ type: "markdown", text: "Done" }] });
			assert.equal(ts, "1700000100.000001");
			assert.deepEqual(fake.called("chat.postMessage").map((c) => c.args), [
				{ channel: TEAM_CHANNEL, thread_ts: "1700000000.000100", text: "Working on it", blocks: [{ type: "markdown", text: "Working on it" }], unfurl_links: false },
				{ channel: TEAM_CHANNEL, text: "Top level", blocks: [], unfurl_links: false },
			]);
			assert.deepEqual(fake.called("chat.update")[0]?.args, { channel: TEAM_CHANNEL, ts, text: "Done", blocks: [{ type: "markdown", text: "Done" }] });
			assert.equal(fake.called("users.list").length, 0, "no names to look up, no directory read");
		});

		it("turns @names into mentions by handle or display name, but not in code or package names", async () => {
			const text = "Thanks @ann and @Bob. Run `npm i @ann/tool`, and see @scope/package; @nobody.";
			await slack.surface.post(TEAM_CHANNEL, undefined, { text, blocks: [{ type: "markdown", text }, { type: "divider" }] });
			await slack.surface.post(TEAM_CHANNEL, undefined, { text: "again @ann", blocks: [] });
			const [first, second] = fake.called("chat.postMessage");
			const want = `Thanks <@${ANN}> and <@${BOB}>. Run \`npm i @ann/tool\`, and see @scope/package; @nobody.`;
			assert.equal(first?.args.text, want);
			assert.deepEqual(first?.args.blocks, [{ type: "markdown", text: want }, { type: "divider" }]);
			assert.equal(second?.args.text, `again <@${ANN}>`);
			assert.equal(fake.called("users.list").length, 1, "the directory is cached");
		});

		it("still posts when the directory can't be read, with names as written", async () => {
			quietErrors();
			fake.queue("users.list", { ok: false, error: "missing_scope" });
			await slack.surface.post(TEAM_CHANNEL, undefined, { text: "Thanks @ann", blocks: [] });
			assert.equal(fake.called("chat.postMessage")[0]?.args.text, "Thanks @ann");
		});

		it("reacts, treating a reaction that's already there (or already gone) as done", async () => {
			fake.queue("reactions.add", { ok: true }, { ok: false, error: "already_reacted" }, { ok: false, error: "message_not_found" });
			fake.queue("reactions.remove", { ok: false, error: "no_reaction" });
			await slack.surface.react?.(TEAM_CHANNEL, "1700000000.000100", "eyes", true);
			await slack.surface.react?.(TEAM_CHANNEL, "1700000000.000100", "eyes", true);
			await slack.surface.react?.(TEAM_CHANNEL, "1700000000.000100", "eyes", false);
			await assert.rejects(slack.surface.react!(TEAM_CHANNEL, "1700000000.000100", "eyes", true), /message_not_found/);
			assert.deepEqual(fake.called("reactions.add")[0]?.args, { channel: TEAM_CHANNEL, timestamp: "1700000000.000100", name: "eyes" });
		});

		it("attaches a file to the thread", async () => {
			await slack.surface.attach?.(TEAM_CHANNEL, "1700000000.000100", { name: "diff.patch", title: "The change", content: "+fixed\n" });
			assert.deepEqual(fake.called("files.getUploadURLExternal")[0]?.args, { filename: "diff.patch", length: "7" });
			assert.equal(fake.uploads.length, 1);
			assert.match(fake.uploads[0]!, /\r\n\r\n\+fixed\n\r\n/, "the file's content, as a form upload");
			assert.deepEqual(fake.called("files.completeUploadExternal")[0]?.args, { files: [{ id: "F0FILE0001", title: "The change" }], channel_id: TEAM_CHANNEL, thread_ts: "1700000000.000100" });
		});

		it("waits out Slack's rate limit and sends anyway", async () => {
			fake.queue("chat.postMessage", { status: 429, headers: { "retry-after": "0" }, body: { ok: false, error: "ratelimited" } });
			const ts = await slack.surface.post(TEAM_CHANNEL, undefined, { text: "hello", blocks: [] });
			assert.equal(ts, "1700000100.000001");
			assert.equal(fake.called("chat.postMessage").length, 2);
		});

		it("says why a post failed", async () => {
			fake.queue("chat.postMessage", { ok: false, error: "not_in_channel" });
			await assert.rejects(slack.surface.post(ELSEWHERE_CHANNEL, undefined, { text: "hello", blocks: [] }), /not_in_channel/);
		});
	});

	describe("the rest of the Web API", () => {
		it("learns who it is, its scopes, and the workspace", async () => {
			assert.equal(await slack.identify(), SCOUT);
			assert.equal(slack.botUserId, SCOUT);
			assert.ok(slack.scopes.includes("chat:write") && slack.scopes.includes("commands"));
			assert.equal(slack.teamUrl, "https://acme.slack.com/");
			assert.equal(slack.teamId, TEAM);
		});

		it("finds what was said while it wasn't listening, oldest first: channel messages and thread replies", async () => {
			fake.queue("users.conversations", { ok: true, channels: [{ id: TEAM_CHANNEL, name: "team" }] });
			fake.queue("conversations.history", {
				ok: true,
				messages: [
					{ type: "message", user: ANN, text: "second", ts: "1700000050.000000" },
					{ type: "message", subtype: "bot_message", bot_id: "B0DEPLOY01", text: "deployed", ts: "1700000040.000000" },
					{ type: "message", subtype: "channel_join", user: BOB, text: "joined", ts: "1700000030.000000" },
					{ type: "message", subtype: "file_share", user: BOB, text: "a log", ts: "1700000020.000000", files: [{ name: "a.log", mimetype: "text/plain", size: 3, url_private: "https://files.slack.com/a.log" }] },
					{ type: "message", user: ANN, text: "before", ts: "1700000000.000000" },
				],
			});
			fake.queue(
				"conversations.replies",
				{
					ok: true,
					messages: [
						{ type: "message", user: ANN, text: "parent", ts: "1699999000.000000", thread_ts: "1699999000.000000" },
						{ type: "message", user: BOB, text: "a reply", ts: "1700000030.500000", thread_ts: "1699999000.000000" },
					],
				},
				{ ok: false, error: "thread_not_found" },
			);
			const missed = await slack.missed(1700000000_000, [
				{ channel: TEAM_CHANNEL, threadTs: "1699999000.000000" },
				{ channel: TEAM_CHANNEL, threadTs: "1699990000.000000" },
			]);
			assert.deepEqual(
				missed.map((m) => [m.ts, m.user, m.text, m.threadTs, m.files?.length]),
				[
					["1700000020.000000", BOB, "a log", undefined, 1],
					["1700000030.500000", BOB, "a reply", "1699999000.000000", undefined],
					["1700000050.000000", ANN, "second", undefined, undefined],
				],
			);
			assert.deepEqual(fake.called("conversations.history")[0]?.args, { channel: TEAM_CHANNEL, oldest: "1700000000.000000", limit: "200" });
		});

		it("makes a channel's canvas, then edits it", async () => {
			const id = await slack.channelCanvas(TEAM_CHANNEL, undefined, "# Team");
			assert.equal(await slack.channelCanvas(TEAM_CHANNEL, id, "# Team, again"), id);
			assert.deepEqual(fake.called("conversations.canvases.create")[0]?.args, { channel_id: TEAM_CHANNEL, document_content: { type: "markdown", markdown: "# Team" } });
			assert.deepEqual(fake.called("canvases.edit")[0]?.args, { canvas_id: "F0CANVAS01", changes: [{ operation: "replace", document_content: { type: "markdown", markdown: "# Team, again" } }] });
		});

		it("knows people's names (cached) and emails", async () => {
			assert.equal(await slack.nameOf(ANN), "Ann");
			assert.equal(await slack.nameOf(ANN), "Ann");
			assert.equal(await slack.nameOf(BOB), "Bob Example", "no display name: the real name");
			assert.equal(fake.called("users.info").length, 2);
			assert.equal(await slack.emailOf(ANN), "ann@example.com");
			assert.equal(await slack.emailOf("U0NOBODY01"), undefined);
		});

		it("finds channels by ID and by name, across pages", async () => {
			assert.equal(await slack.channelName(TEAM_CHANNEL), "team");
			assert.equal(await slack.channelId("team"), TEAM_CHANNEL, "known from the lookup before");
			fake.queue(
				"conversations.list",
				{ ok: true, channels: [{ id: "C0PAGE0001", name: "first-page" }], response_metadata: { next_cursor: "page2" } },
				{ ok: true, channels: [{ id: "C0PAGE0002", name: "deploys" }], response_metadata: { next_cursor: "" } },
			);
			assert.equal(await slack.channelId("deploys"), "C0PAGE0002");
			assert.equal(fake.called("conversations.list")[1]?.args.cursor, "page2");
			assert.equal(await slack.channelId("first-page"), "C0PAGE0001", "learned while paging");
			assert.equal(await slack.channelId("no-such-channel"), undefined);
		});

		it("broadcasts a thread's outcome to the channel, and links to messages", async () => {
			await slack.broadcast(TEAM_CHANNEL, "1700000000.000100", "Opened acme/web#7");
			assert.deepEqual(fake.called("chat.postMessage")[0]?.args, { channel: TEAM_CHANNEL, thread_ts: "1700000000.000100", reply_broadcast: true, text: "Opened acme/web#7", unfurl_links: false });
			assert.equal(await slack.permalink(TEAM_CHANNEL, "1700000000.000100"), "https://acme.slack.com/archives/C0TEAM0001/p1700000000000100");
			fake.queue("chat.getPermalink", { ok: false, error: "message_not_found" });
			assert.equal(await slack.permalink(TEAM_CHANNEL, "1.2"), undefined);
		});

		it("reads a user group's members", async () => {
			fake.queue("usergroups.users.list", { ok: true, users: [ANN, BOB] });
			assert.deepEqual(await slack.groupMembers("S0ADMINS01"), new Set([ANN, BOB]));
			assert.deepEqual(fake.called("usergroups.users.list")[0]?.args, { usergroup: "S0ADMINS01" });
		});

		it("downloads private files with its token, and says when Slack won't hand one over", async () => {
			assert.equal(new TextDecoder().decode(await slack.download(`${fake.filesUrl}build.log`, 1024)), "file contents");
			const other = new Slack({ botToken: "xoxb-other", appToken: "xapp-test" }, { receiver: fake.receiver, apiUrl: fake.apiUrl });
			apps++;
			await assert.rejects(other.download(`${fake.filesUrl}build.log`, 1024), /Slack answered 403/);
		});

		it("sends its token only to Slack's file host, and reads no more than the limit", async () => {
			// A remote file's url_private is whatever the app that shared it said: here, somewhere that isn't Slack.
			const seen: (string | undefined)[] = [];
			const elsewhere = createServer((req, res) => {
				seen.push(req.headers.authorization);
				res.end("stolen");
			});
			await new Promise<void>((resolve) => elsewhere.listen(0, "127.0.0.1", resolve));
			const there = `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}/x`;
			try {
				await assert.rejects(slack.download(there, 1024), /not a Slack file URL/);
				await assert.rejects(slack.download("https://attacker.example/files-pri/T0/F0/x", 1024), /not a Slack file URL/);
				await assert.rejects(slack.download("http://files.slack.com/files-pri/T0/F0/x", 1024), /not a Slack file URL/, "https only");
				await assert.rejects(slack.download(`${fake.filesUrl}moved?to=${encodeURIComponent(there)}`, 1024), /away from Slack/);
				assert.deepEqual(seen, [], "nothing was asked of the other host");
			} finally {
				elsewhere.close();
			}
			await assert.rejects(slack.download(`${fake.filesUrl}build.log`, 5), /over 5 bytes/);
		});

		it("offers a public channel to someone who wrote directly", () => {
			const offer = slack.channelOffer(ANN);
			assert.match(offer.text, /I don't work in direct messages/);
			const button = (offer.blocks[1] as { elements: { action_id: string; value: string }[] }).elements[0];
			assert.deepEqual([button?.action_id, button?.value], ["scout_create_channel", ANN]);
		});
	});
});
