import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { threadKey } from "../src/threads.ts";
import { type E2e, startScout } from "./e2e.ts";
import { ANN, BOB, type Call, SCOUT, TEAM_CHANNEL } from "./fake-slack.ts";
import { until } from "./helpers.ts";

const toolUse = { stopReason: "toolUse" } as const;
type Transcript = { messages: unknown[] };

/** Scout's posts and edits in Slack that carry `text`, and whether Slack took each. */
function carrying(e2e: E2e, text: string): Call[] {
	return e2e.slack.calls.filter((c) => (c.method === "chat.postMessage" || c.method === "chat.update") && String(c.args.text).includes(text));
}

/**
 * The messages Scout posted in a thread to show a run ("Working…"), which its answer then replaces: their ts, as fake
 * Slack numbered its posts (posts Slack failed got none).
 */
function runMessages(e2e: E2e, threadTs: string): string[] {
	let n = 0;
	return e2e.slack.calls.flatMap((c) => {
		if (c.method !== "chat.postMessage" || c.failed === true) return [];
		const ts = `1700000100.${String(++n).padStart(6, "0")}`;
		return c.args.thread_ts === threadTs && c.args.text === "Working…" ? [ts] : [];
	});
}

/**
 * Every call Slack failed has since gone through: Slack's client tries each again on its own, for minutes, so a test
 * that closed fake Slack before then would leave it trying against nothing.
 */
async function retried(e2e: E2e): Promise<void> {
	const key = (c: Call) => `${c.method} ${JSON.stringify(c.args)}`;
	await until(
		() => {
			const calls = e2e.slack.calls;
			return calls.every((c, i) => c.failed !== true || calls.slice(i + 1).some((later) => later.failed !== true && key(later) === key(c)));
		},
		30_000,
		"Slack's client to get every refused call through",
	);
}

/** The last user message of a transcript: what the model is answering. */
function asked(transcript: Transcript): string {
	const users = transcript.messages.filter((m) => (m as { role?: string }).role === "user");
	return JSON.stringify(users.at(-1) ?? "");
}

/** A Slack timestamp for now, unique per call, as messages said while Scout was down carry. */
let tick = 0;
function nowTs(): string {
	return `${Math.floor(Date.now() / 1000)}.${String(++tick).padStart(6, "0")}`;
}

/**
 * When things go wrong around Scout: Slack failing or not answering, Scout stopped in the middle of a run, and Scout
 * draining for a deploy while people keep talking. Each is driven through Scout as `main.ts` starts it (test/e2e.ts),
 * and checked where people see it: Slack.
 */
describe("end to end: resilience", () => {
	it("keeps a final answer Slack won't take, and delivers it once Slack is back, sending nothing twice", async () => {
		const e2e = await startScout();
		const { slack, faux } = e2e;
		const answer = "The login test is the flaky one: it races the session cookie.";
		// Slack goes down just as the model answers, so the answer is the first thing it refuses.
		faux.setResponses([
			() => {
				slack.down(2_500);
				return fauxAssistantMessage(answer);
			},
		]);
		try {
			const ts = await e2e.mention("which test is flaky?");
			await until(() => carrying(e2e, answer).some((c) => c.failed !== true), 20_000, "the answer, once Slack is back");
			await e2e.service.scout.harness.waitForIdle(context);

			const tries = carrying(e2e, answer);
			assert.ok(tries.some((c) => c.failed === true), "Slack refused the answer at first");
			const delivered = tries.filter((c) => c.failed !== true);
			assert.equal(delivered.length, 1, "the answer arrived once");
			assert.equal(delivered[0]?.method, "chat.update", "into the run's own message, not a new one");
			assert.equal(slack.called("chat.postMessage").filter((c) => c.failed !== true && c.args.thread_ts === ts).length, 1, "one message in the thread");
			assert.deepEqual([delivered[0]?.args.ts], runMessages(e2e, ts), "the run's, which the answer replaced");
			assert.deepEqual(e2e.exits, []);
		} finally {
			await retried(e2e).catch(() => {});
			await e2e.close();
		}
	});

	it("delivers the answer of a run Scout was restarted in the middle of, while Slack wasn't answering", async () => {
		const e2e = await startScout();
		const { slack, faux } = e2e;
		const answer = "The release notes are in CHANGELOG.md, under 2.3.";
		// The first process's model call never answers: it's stopped while waiting on it.
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		let calls = 0;
		faux.setResponses([
			async (_transcript, options) => {
				calls++;
				// Until the test lets it go, or Scout stops and gives up on it, as a provider's call would.
				await Promise.race([held, new Promise((resolve) => options?.signal?.addEventListener("abort", resolve))]);
				return fauxAssistantMessage("(the first process never gets this)");
			},
			() => {
				calls++;
				return fauxAssistantMessage(answer);
			},
		]);
		try {
			const ts = await e2e.mention("where are the release notes?");
			await until(() => calls === 1 && runMessages(e2e, ts).length === 1, 20_000, "the run, waiting on the model");

			// Scout stops; while it's away and as it comes back, Slack takes no messages: it doesn't answer, then drops them.
			await e2e.service.close();
			const before = slack.calls.length;
			slack.down(3_000, { methods: ["chat.postMessage", "chat.update"], hang: true });
			const service = await e2e.restart();
			await until(() => carrying(e2e, answer).some((c) => c.failed !== true), 30_000, "the answer, after the restart and the outage");
			await service.scout.harness.waitForIdle(context);

			assert.equal(calls, 2, "the restarted Scout asked the model again");
			const after = slack.calls.slice(before);
			assert.ok(after.some((c) => c.failed === true && (c.method === "chat.update" || c.method === "chat.postMessage")), "Slack didn't answer at first");
			const delivered = carrying(e2e, answer).filter((c) => c.failed !== true);
			assert.equal(delivered.length, 1, "the answer arrived once");
			assert.equal(delivered[0]?.method, "chat.update");
			assert.deepEqual([delivered[0]?.args.ts], runMessages(e2e, ts), "into the run's message from before the restart, and no second one");
			assert.ok(!slack.called("chat.postMessage").some((c) => c.failed !== true && String(c.args.text).includes(answer)));
		} finally {
			release();
			await retried(e2e).catch(() => {});
			await e2e.close();
		}
	});

	it("carries a run on after Scout stops in the middle of a command, and answers in the same message", async () => {
		const e2e = await startScout();
		const { faux } = e2e;
		const started = join(e2e.root, "started");
		const done = join(e2e.root, "done");
		const results: string[] = [];
		const answer = "The test suite needs Postgres running; that's why it hung.";
		faux.setResponses([
			// A command that runs until the test says it may finish (or half a minute, whichever comes first).
			fauxAssistantMessage([fauxToolCall("bash", { command: `touch ${started}; for i in $(seq 600); do [ -f ${done} ] && break; sleep 0.05; done; echo finished` })], toolUse),
			(transcript: Transcript) => {
				results.push(JSON.stringify(transcript.messages.at(-1)));
				return fauxAssistantMessage(answer);
			},
		]);
		try {
			const ts = await e2e.mention("why does the test suite hang?");
			const conversationId = e2e.service.scout.threads.get(threadKey(TEAM_CHANNEL, ts))?.conversationId;
			assert.ok(conversationId !== undefined);
			await until(() => existsSync(started), 20_000, "the command to start");

			// Stopped mid-command, and started again on the same data directory.
			const service = await e2e.restart();
			writeFileSync(done, "");
			await until(() => e2e.said().some((t) => t.includes(answer)), 30_000, "the answer after the restart");
			await service.scout.harness.waitForIdle(context);

			assert.equal(service.scout.threads.get(threadKey(TEAM_CHANNEL, ts))?.conversationId, conversationId, "the same conversation carried on");
			assert.equal(results.length, 1, "the model was asked once more, after the command");
			assert.match(results[0] ?? "", /"role":"toolResult".*bash was interrupted/, "told the command was cut off by the restart");
			const delivered = carrying(e2e, answer);
			assert.equal(delivered.length, 1);
			assert.equal(delivered[0]?.method, "chat.update");
			assert.deepEqual([delivered[0]?.args.ts], runMessages(e2e, ts), "the answer replaced the run message from before the restart");
			assert.equal(faux.getPendingResponseCount(), 0);
		} finally {
			writeFileSync(done, "");
			await e2e.close();
		}
	});

	it("reads back what people said while Scout was down, and answers it, in a new thread and an old one", async () => {
		const e2e = await startScout();
		const { slack, faux } = e2e;
		const reply = (transcript: Transcript) => {
			const question = asked(transcript);
			if (question.includes("rollback")) return fauxAssistantMessage("Roll back with `npm run deploy -- --previous`.");
			if (question.includes("staging")) return fauxAssistantMessage("Staging deploys from the staging branch, the same way.");
			return fauxAssistantMessage("The deploy script builds, then restarts the service.");
		};
		faux.setResponses([reply]);
		try {
			const ts = await e2e.mention("what does the deploy script do?");
			await until(() => e2e.said().some((t) => t.includes("builds, then restarts")), 20_000, "the first answer");
			await e2e.service.scout.harness.waitForIdle(context);

			// Scout is down. Meanwhile: a new request in the channel, a follow-up in the thread, and people talking.
			await e2e.service.close();
			slack.wrote({ channel: TEAM_CHANNEL, user: BOB, text: `<@${SCOUT}> how do I roll back a bad deploy? (rollback)`, ts: nowTs() });
			slack.wrote({ channel: TEAM_CHANNEL, user: ANN, text: "lunch?", ts: nowTs() });
			slack.wrote({ channel: TEAM_CHANNEL, user: ANN, text: `<@${SCOUT}> and for staging?`, ts: nowTs(), thread_ts: ts });
			faux.setResponses([reply, reply]);

			const service = await e2e.restart();
			await service.caughtUp;
			await until(() => e2e.said().some((t) => t.includes("Roll back with")) && e2e.said().some((t) => t.includes("Staging deploys")), 30_000, "both answers");
			await service.scout.harness.waitForIdle(context);

			const rollback = slack.history[0]!;
			assert.ok(service.scout.threads.get(threadKey(TEAM_CHANNEL, rollback.ts)), "the missed request started a thread on its message");
			assert.equal(runMessages(e2e, rollback.ts).length, 1, "answered in its own thread");
			assert.equal(runMessages(e2e, ts).length, 2, "the follow-up was answered in the old thread");
			assert.equal(e2e.said().filter((t) => t.includes("Roll back with")).length, 1, "once");
			assert.equal(e2e.said().filter((t) => t.includes("Staging deploys")).length, 1, "once");
			assert.equal(faux.getPendingResponseCount(), 0, "people talking among themselves started nothing");
		} finally {
			await e2e.close();
		}
	});

	it("drains for a restart while people keep asking, says so in their threads, and answers them after the restart", async () => {
		const e2e = await startScout({ env: { SCOUT_DASH_ADDR: "127.0.0.1:0" } });
		const { faux } = e2e;
		const started = join(e2e.root, "started");
		const done = join(e2e.root, "done");
		const reply = (transcript: Transcript) => {
			const question = asked(transcript);
			if (question.includes("on-call")) return fauxAssistantMessage("Bob is on call this week.");
			return fauxAssistantMessage("The build passed.");
		};
		faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: `touch ${started}; for i in $(seq 600); do [ -f ${done} ] && break; sleep 0.05; done; echo built` })], toolUse)]);
		try {
			const build = await e2e.mention("run the build");
			await until(() => existsSync(started), 20_000, "the build to start");

			e2e.service.signal("SIGINT");
			assert.ok(e2e.service.draining() !== undefined);
			const status = (await (await fetch(`http://127.0.0.1:${e2e.service.dashboardPort}/status.json`)).json()) as { draining?: number };
			assert.equal(typeof status.draining, "number", "the dashboard says Scout is draining");

			// Someone asks while Scout drains: their request is taken, and waits for the restart.
			faux.setResponses([reply, reply]);
			const question = await e2e.mention("who is on-call?", { user: BOB });
			const runMessage = () => e2e.slack.called("chat.postMessage").find((c) => c.args.thread_ts === question && c.args.text === "Working…");
			await until(() => runMessage() !== undefined, 20_000, "the request's run message");
			// What each run waits on is shown every few seconds (the waits tick): this one waits on the drain.
			const restarting = () => e2e.slack.called("chat.update").some((c) => JSON.stringify(c.args.blocks).includes("I'm restarting for an update"));
			await until(async () => (await e2e.service.tick.waits(), restarting()), 20_000, "the thread to say Scout is restarting");
			assert.ok(!e2e.said().some((t) => t.includes("on call this week")), "not answered before the restart");

			writeFileSync(done, "");
			await until(() => e2e.exits.length > 0, 30_000, "the drain to end");
			assert.deepEqual(e2e.exits, [0]);

			const service = await e2e.restart();
			await until(() => e2e.said().some((t) => t.includes("The build passed.")) && e2e.said().some((t) => t.includes("Bob is on call this week.")), 30_000, "both answers after the restart");
			await service.scout.harness.waitForIdle(context);
			const messageOf = (text: string) => e2e.slack.called("chat.update").find((c) => String(c.args.text).includes(text))?.args.ts;
			assert.deepEqual([messageOf("Bob is on call")], runMessages(e2e, question), "the late request's answer is in its own thread");
			assert.deepEqual([messageOf("The build passed")], runMessages(e2e, build), "and the build's in the build's");
			assert.equal(faux.getPendingResponseCount(), 0);
		} finally {
			writeFileSync(done, "");
			await e2e.close();
		}
	});
});
