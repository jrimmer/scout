import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { connectMcp } from "../src/mcp.ts";
import { threadKey } from "../src/threads.ts";
import { startScout } from "./e2e.ts";
import { ANN, TEAM_CHANNEL } from "./fake-slack.ts";
import { git, until } from "./helpers.ts";

const toolUse = { stopReason: "toolUse" } as const;

/**
 * From Slack to the code host and back, through Scout as main.ts starts it (src/service.ts): a Socket Mode envelope
 * goes through Bolt and slack.ts, the service's handlers, the bridge and the harness (scripted model, local sandbox,
 * the host-side mirror and code host tools), and comes out as a branch in a git repository, a pull request on a
 * stand-in Forgejo, and calls to Slack's Web API.
 */
describe("end to end", () => {
	it("turns a request in a channel into a reviewed pull request, and says so in the thread", async () => {
		const e2e = await startScout();
		const { slack, host, faux } = e2e;
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
			const ts = await e2e.mention('please add a CONTRIBUTING.md that says "Be kind."');
			const scout = e2e.service.scout;
			const thread = scout.threads.get(threadKey(TEAM_CHANNEL, ts));
			assert.ok(thread, "the mention started a thread on the message");
			await until(() => e2e.said().some((t) => t.includes("I opened a pull request that adds CONTRIBUTING.md.")), 20_000, "the answer");
			await scout.harness.waitForIdle(context);
			// The run's ending reaction goes out just after its answer, and the pull request's notice once reviewers are asked.
			const reacted = () => slack.calls.filter((c) => c.method === "reactions.add" || c.method === "reactions.remove");
			await until(() => reacted().length > 0, 20_000, "a status reaction");
			const broadcast = () => slack.called("chat.postMessage").find((c) => c.args.reply_broadcast === true);
			await until(() => broadcast() !== undefined, 20_000, "the pull request's notice");

			// The change: on Scout's branch in the repository, not on main.
			const remote = e2e.repo.remote;
			const branch = git("--git-dir", remote, "for-each-ref", "--format=%(refname:short)", "refs/heads/scout/");
			assert.match(branch, /^scout\//);
			assert.equal(git("--git-dir", remote, "show", `${branch}:CONTRIBUTING.md`), "Be kind.");
			assert.throws(() => git("--git-dir", remote, "show", "main:CONTRIBUTING.md"), "main is untouched");

			// The pull request: from that branch into main, with the self-review it passed.
			const opened = host.opened();
			assert.equal(opened.length, 1);
			const [pull] = opened;
			assert.equal(pull?.slug, "acme/app");
			assert.equal(pull?.title, "Add a contributing guide");
			assert.equal(pull?.pull?.head, branch);
			assert.equal(pull?.pull?.base, "main");
			assert.match(String(pull?.body), /^Adds CONTRIBUTING\.md, as asked in #team\./);
			assert.match(String(pull?.body), /Scout's self-review[\s\S]*APPROVE\nSmall and right\./);
			assert.match(reviewed, /\+Be kind\./, "the self-review saw the diff");
			assert.deepEqual(host.called("GET", /\/pulls\/1\/files$/).length, 1, "the files' owners were looked up to ask for reviews");

			// Slack: replies in the thread, the pull request announced there and in the channel, and status reactions.
			const inThread = slack.called("chat.postMessage").filter((c) => c.args.thread_ts === ts);
			assert.ok(inThread.length > 0, "Scout answered in the thread");
			assert.ok(inThread.every((c) => c.args.channel === TEAM_CHANNEL));
			assert.equal(broadcast()?.args.text, `Opened <${host.webUrl}/acme/app/pulls/1|acme/app#1>: Add a contributing guide`);
			assert.ok(reacted().every((c) => c.args.channel === TEAM_CHANNEL && c.args.timestamp === ts));
			assert.equal(faux.getPendingResponseCount(), 0);
			assert.deepEqual(e2e.exits, []);
		} finally {
			await e2e.close();
		}
	});

	it("declines direct messages and private channels through the same path, offering a public channel", async () => {
		const e2e = await startScout();
		const { slack, faux } = e2e;
		try {
			await slack.receiver.deliver(slack.envelope("message-im"));
			await slack.receiver.deliver(slack.envelope("message-private"));
			const posts = slack.called("chat.postMessage");
			assert.equal(posts.length, 2);
			assert.equal(posts[0]?.args.channel, "D0ANNDM001");
			assert.match(String(posts[0]?.args.text), /I don't work in direct messages/);
			assert.equal((posts[0]?.args.blocks as { elements?: { value?: string }[] }[])[1]?.elements?.[0]?.value, ANN, "with a button for a channel of their own");
			assert.equal(posts[1]?.args.channel, "C0SECRET01");
			assert.match(String(posts[1]?.args.text), /public/);
			assert.equal(e2e.service.scout.threads.get(threadKey("C0SECRET01", "1700000000.000500")), undefined, "no thread, no work");
			assert.equal(faux.getPendingResponseCount(), 0);
		} finally {
			await e2e.close();
		}
	});

	it("drains and stops on SIGINT, and after a restart on the same data carries on in the same thread", async () => {
		const e2e = await startScout();
		const { faux } = e2e;
		try {
			faux.setResponses([fauxAssistantMessage("The build runs the tests, then the type check.")]);
			const ts = await e2e.mention("what does the build do?");
			await until(() => e2e.said().some((t) => t.includes("runs the tests")), 20_000, "the first answer");
			const before = e2e.service.scout.threads.get(threadKey(TEAM_CHANNEL, ts))?.conversationId;
			assert.ok(before !== undefined);

			e2e.service.signal("SIGINT");
			assert.ok(e2e.service.draining() !== undefined, "draining at once");
			await until(() => e2e.exits.length > 0, 20_000, "Scout to stop");
			assert.deepEqual(e2e.exits, [0], "a clean stop, for the service manager to start it again");

			const service = await e2e.restart();
			await service.caughtUp;
			assert.equal(service.scout.threads.get(threadKey(TEAM_CHANNEL, ts))?.conversationId, before, "the thread is still known");
			faux.setResponses([
				(transcript) => {
					assert.match(JSON.stringify(transcript.messages), /runs the tests, then the type check/, "with what was said before the restart");
					return fauxAssistantMessage("And the linter, since last week.");
				},
			]);
			await e2e.mention("anything else?", { threadTs: ts });
			await until(() => e2e.said().some((t) => t.includes("And the linter")), 20_000, "the answer after the restart");
			assert.equal(faux.getPendingResponseCount(), 0);

			// SIGTERM stops at once; a second signal while stopping ends the process without waiting.
			service.signal("SIGTERM");
			service.signal("SIGTERM");
			await until(() => e2e.exits.length === 3, 20_000, "Scout to stop again");
			assert.deepEqual(e2e.exits, [0, 1, 0]);
		} finally {
			await e2e.close();
		}
	});

	it("asks for approval with buttons before a tool changes something, and makes the change once someone approves", async () => {
		// An MCP server whose write tool needs a person's approval (writes: "approve"); it counts what it was asked to do.
		const written: string[] = [];
		const grafana = new McpServer({ name: "grafana", version: "1" });
		grafana.registerTool("write_rules", { description: "Write alert rules", annotations: { readOnlyHint: false } }, async () => {
			written.push("rules");
			return { content: [{ type: "text", text: "written" }] };
		});
		const mcp = await connectMcp({ servers: { grafana: { command: "unused", writes: "approve" } } }, () => {
			const [client, server] = InMemoryTransport.createLinkedPair();
			void grafana.connect(server);
			return client;
		});
		const e2e = await startScout({ mcp });
		const { slack, faux } = e2e;
		const results: string[] = [];
		const writeRules = () => fauxAssistantMessage([fauxToolCall("mcp__grafana__write_rules", {})], toolUse);
		const remember = (text: string) => (transcript: { messages: unknown[] }) => {
			results.push(JSON.stringify(transcript.messages.at(-1)));
			return fauxAssistantMessage(text);
		};
		faux.setResponses([writeRules(), remember("Raising the threshold needs someone's approval first.")]);
		try {
			const ts = await e2e.mention("raise the disk alert threshold to 90%");
			const scout = e2e.service.scout;
			const buttons = () => slack.called("chat.postMessage").find((c) => JSON.stringify(c.args.blocks ?? []).includes("scout_approve"));
			await until(() => buttons() !== undefined, 20_000, "the approval buttons");
			assert.match(results[0] ?? "", /needs a person's approval first/);
			assert.deepEqual(written, [], "nothing changed before someone approved");
			assert.equal(buttons()?.args.thread_ts, ts, "the buttons are in the thread");
			const conversationId = scout.threads.get(threadKey(TEAM_CHANNEL, ts))!.conversationId;
			const elements = (buttons()?.args.blocks as { elements?: { action_id?: string; value?: string }[] }[]).flatMap((b) => b.elements ?? []);
			const approve = elements.find((e) => e.action_id === "scout_approve")?.value;
			assert.equal(approve, String(conversationId), "the Approve button names the thread's conversation");
			await scout.harness.waitForIdle(context);

			// Ann presses Approve: the thread hears "approve" from her, and Scout makes the change.
			faux.setResponses([writeRules(), remember("Done: the disk alert fires at 90% now.")]);
			const envelope = slack.envelope("action-approve");
			const payload = envelope.payload as { actions: { value: string }[]; container: { message_ts: string } };
			payload.actions[0]!.value = approve!;
			await slack.receiver.deliver(envelope);
			await until(() => e2e.said().some((t) => t.includes("Done: the disk alert fires at 90% now.")), 20_000, "the answer after approval");
			await scout.harness.waitForIdle(context);
			assert.deepEqual(written, ["rules"], "the change was made, once");
			assert.match(results[1] ?? "", /written/);
			await until(() => slack.responded.length > 0, 5_000, "the buttons' replacement");
			assert.match(String(slack.responded.at(-1)?.body.text), /Approved by <@U0ANN00001>/);
			assert.equal(scout.approvals.waiting(conversationId), false, "the approval was used up by the change");
			assert.equal(faux.getPendingResponseCount(), 0);
		} finally {
			await e2e.close();
			await Promise.all(mcp.map((c) => c.client.close()));
		}
	});
});
