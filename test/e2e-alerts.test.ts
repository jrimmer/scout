import { rmSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { threadKey } from "../src/threads.ts";
import { type E2e, startScout } from "./e2e.ts";
import { fakeAlerts } from "./fake-alerts.ts";
import { ANN, BOB, TEAM_CHANNEL } from "./fake-slack.ts";
import { until } from "./helpers.ts";

const toolUse = { stopReason: "toolUse" } as const;
const ALERTS_CHANNEL = "C0ALERTS01";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** #team works in acme/app, and owns the alerts about db1, with Bob on call. */
const TEAM_OWNS_DB1 = { "channels/team/instructions.md": `---\nrepo: app\nalerts: db1\noncall: <@${BOB}>\n---\nSmall changes, tests first.` };

/**
 * Scout watching a fake Gatus and Grafana, with #alerts as the place for alerts no channel claims. `clock.now` is the
 * time Scout goes by, moved with `clock.at`.
 */
async function start(options: { profile?: Record<string, string>; env?: Record<string, string> } = {}) {
	const alerts = await fakeAlerts();
	const clock = { time: Date.now(), now: () => clock.time };
	const e2e = await startScout({
		env: {
			SCOUT_ALERTS_GATUS_URL: alerts.gatusUrl,
			SCOUT_ALERTS_GRAFANA_URL: alerts.grafanaUrl,
			SCOUT_ALERTS_GRAFANA_TOKEN: alerts.grafanaToken,
			SCOUT_ALERTS_CHANNEL: "alerts",
			...options.env,
		},
		profile: options.profile ?? {},
		now: clock.now,
	});
	e2e.slack.channels.set(ALERTS_CHANNEL, { id: ALERTS_CHANNEL, name: "alerts", is_channel: true, is_private: false, is_member: true });
	return {
		e2e,
		alerts,
		clock,
		close: async () => {
			await finish(e2e);
			await alerts.close();
		},
	};
}

/**
 * Slack calls Scout makes after an answer (permalinks for the code host and the list of its work) have gone out. Closing
 * Slack under one sends its client into retries that keep the process alive, so wait for the calls to stop, then close.
 */
async function finish(e2e: E2e, quietMs = 150): Promise<void> {
	let calls = -1;
	let since = Date.now();
	await until(() => {
		if (e2e.slack.calls.length !== calls) {
			calls = e2e.slack.calls.length;
			since = Date.now();
		}
		return Date.now() - since >= quietMs;
	}, 20_000, "Slack to go quiet").catch(() => {});
	await e2e.close();
	rmSync(e2e.root, { recursive: true, force: true });
}

/** Scout's posts, in order, with the channel and thread they went to. */
const posts = (e2e: E2e) => e2e.slack.called("chat.postMessage").map((p) => ({ channel: String(p.args.channel), thread: p.args.thread_ts === undefined ? undefined : String(p.args.thread_ts), text: String(p.args.text) }));
const postsMatching = (e2e: E2e, text: RegExp) => posts(e2e).filter((p) => text.test(p.text));
/** The timestamp fake Slack gave the first post matching `text` (it numbers them in order). */
const tsOfPost = (e2e: E2e, text: RegExp): string => {
	const at = posts(e2e).findIndex((p) => text.test(p.text));
	assert.ok(at >= 0, `a post matching ${text}`);
	return `1700000100.${String(at + 1).padStart(6, "0")}`;
};
/**
 * Every request someone made in Slack has had its 👀 and then its ending reaction (✅, or the like): they are paced, so
 * they come a moment after the answer, and Slack must not be closed under them.
 */
async function reactionsDone(e2e: E2e, requests = 1): Promise<void> {
	const endings = () => e2e.slack.called("reactions.add").filter((c) => ["white_check_mark", "raising_hand", "warning", "hand"].includes(String(c.args.name))).length;
	await until(() => endings() >= requests, 20_000, `the ending reactions of ${requests} request(s)`);
}
/** Wait for what Scout says (posted or edited), then for the run that said it to be over. */
async function said(e2e: E2e, text: string): Promise<void> {
	await until(() => e2e.said().some((t) => t.includes(text)), 20_000, `Scout to say "${text}"`);
	await e2e.service.scout.harness.waitForIdle(context);
}

describe("end to end: alerts", () => {
	it("on its first look lists what is already firing in the alerts channel and opens no thread for it", async () => {
		const { e2e, alerts, close } = await start();
		try {
			alerts.endpoint("prod_db", "DB", "prod");
			alerts.down("prod_db");
			alerts.fire("fp-cpu", { alertname: "HighCPU", instance: "web1", severity: "warning" });
			await e2e.service.tick.alerts();
			assert.deepEqual(
				posts(e2e).map((p) => [p.channel, p.thread, p.text]),
				[[ALERTS_CHANNEL, undefined, "I'm watching Gatus and Grafana for alerts now. From here on, each new one gets a thread in the channel that owns it (or here), where I look into it.\n2 already firing, which I'll leave be unless you ask:\n• prod / DB is down\n• HighCPU on web1 (warning)"]],
			);
			await e2e.service.tick.alerts();
			assert.equal(posts(e2e).length, 1, "and nothing more while nothing changes");
			assert.equal(alerts.reads.gatus, 2);
			assert.equal(alerts.reads.grafana, 2);
		} finally {
			await close();
		}
	});

	it("starts an investigation thread in the alerts channel for a Gatus endpoint that goes down", async () => {
		const { e2e, alerts, close } = await start();
		let seen = "";
		try {
			alerts.endpoint("prod_api", "API", "prod");
			await e2e.service.tick.alerts();
			assert.match(posts(e2e)[0]?.text ?? "", /Nothing is firing right now\./);

			alerts.down("prod_api");
			e2e.faux.setResponses([
				(transcript) => {
					seen = JSON.stringify(transcript);
					return fauxAssistantMessage("The API answers 503: its database connection pool is exhausted. Restart the pool or raise its limit.");
				},
			]);
			await e2e.service.tick.alerts();
			await said(e2e, "database connection pool is exhausted");

			const [root] = postsMatching(e2e, /🔴/);
			assert.equal(root?.channel, ALERTS_CHANNEL);
			assert.equal(root?.thread, undefined, "its own message, in the channel, for everyone to see");
			assert.match(root?.text ?? "", /^🔴 \*prod \/ API is down\*\nHTTP 503; errors: answered 503; 2 checks in a row since \S+\nI'm looking into it in this thread\.$/);
			const ts = tsOfPost(e2e, /🔴/);
			assert.ok(e2e.service.scout.threads.get(threadKey(ALERTS_CHANNEL, ts)) !== undefined, "the thread is a conversation");
			assert.match(seen, /An alert fired\. Confirm whether it's still happening/, "with the responder's instructions");
			assert.match(seen, /Its labels: \{\\"group\\":\\"prod\\",\\"name\\":\\"API\\",\\"endpoint\\":\\"prod_api\\"\}/);
			assert.match(seen, /This alert just fired in Gatus: prod \/ API is down/);

			// Still down at the next look: the same alert, not a new thread.
			await e2e.service.tick.alerts();
			assert.equal(postsMatching(e2e, /🔴/).length, 1);
			assert.equal(e2e.faux.getPendingResponseCount(), 0);
		} finally {
			await close();
		}
	});

	it("takes a Grafana alert to the channel whose profile owns it, mentioning whoever is on call", async () => {
		const { e2e, alerts, close } = await start({ profile: TEAM_OWNS_DB1 });
		try {
			await e2e.service.tick.alerts();
			alerts.fire("fp-disk", { alertname: "DiskAlmostFull", instance: "db1", mountpoint: "/var", severity: "critical" }, { summary: "Disk is 95% full" });
			e2e.faux.setResponses([fauxAssistantMessage("/var is full of old WAL files. Archive them.")]);
			await e2e.service.tick.alerts();
			await said(e2e, "full of old WAL files");

			const [root] = postsMatching(e2e, /🔴/);
			assert.equal(root?.channel, TEAM_CHANNEL, "not #alerts: #team's profile claims db1");
			assert.match(root?.text ?? "", new RegExp(`^🔴 \\*DiskAlmostFull on db1 /var \\(critical\\)\\*\\nDisk is 95% full; firing since \\S+\\n<@${BOB}> I'm looking into it in this thread\\.$`));
			assert.equal(postsMatching(e2e, /🔴/).length, 1);
		} finally {
			await close();
		}
	});

	it("says in the thread when the alert resolves, and how long it lasted", async () => {
		const { e2e, alerts, clock, close } = await start();
		try {
			await e2e.service.tick.alerts();
			alerts.fire("fp-1", { alertname: "QueueBacklog", instance: "worker1" });
			e2e.faux.setResponses([fauxAssistantMessage("The queue is backed up behind one slow job.")]);
			await e2e.service.tick.alerts();
			await said(e2e, "backed up behind one slow job");
			const ts = tsOfPost(e2e, /🔴/);

			clock.time += 12 * MINUTE;
			alerts.clear("fp-1");
			await e2e.service.tick.alerts();
			const resolved = posts(e2e).filter((p) => p.text.includes("Resolved"));
			assert.deepEqual(resolved.map((p) => [p.channel, p.thread, p.text]), [[ALERTS_CHANNEL, ts, "🟢 Resolved after 12 min."]]);
			await e2e.service.tick.alerts();
			assert.equal(posts(e2e).filter((p) => p.text.includes("Resolved")).length, 1, "once");
		} finally {
			await close();
		}
	});

	it("keeps a flapping alert in its first thread, and starts a new one only after the flap window", async () => {
		const { e2e, alerts, clock, close } = await start();
		try {
			await e2e.service.tick.alerts();
			alerts.fire("fp-flap", { alertname: "SlowQueries", instance: "db2" });
			e2e.faux.setResponses([fauxAssistantMessage("Slow queries from the nightly report.")]);
			await e2e.service.tick.alerts();
			await said(e2e, "nightly report");
			const ts = tsOfPost(e2e, /🔴/);

			// It clears and returns, twice, within the hour: the same incident, said in its thread, with nothing new to investigate.
			for (const times of ["once", "2 times"]) {
				clock.time += 10 * MINUTE;
				alerts.clear("fp-flap");
				await e2e.service.tick.alerts();
				clock.time += 10 * MINUTE;
				alerts.fire("fp-flap", { alertname: "SlowQueries", instance: "db2" });
				await e2e.service.tick.alerts();
				assert.ok(
					posts(e2e).some((p) => p.thread === ts && p.text === `🔴 It's back (${times} since it first fired). Same incident, so I'm keeping it here rather than starting over; ask me if you want another look.`),
					`back ${times}`,
				);
			}
			assert.equal(postsMatching(e2e, /🔴 \*/).length, 1, "one root message throughout");
			assert.equal(posts(e2e).filter((p) => p.thread === ts && p.text.startsWith("🟢")).length, 2);
			assert.equal(e2e.faux.getPendingResponseCount(), 0);

			// Gone for good, and back a day later: a new incident, a thread of its own.
			alerts.clear("fp-flap");
			await e2e.service.tick.alerts();
			clock.time += DAY;
			alerts.fire("fp-flap", { alertname: "SlowQueries", instance: "db2" });
			e2e.faux.setResponses([fauxAssistantMessage("Slow again, now from the backup job.")]);
			await e2e.service.tick.alerts();
			await said(e2e, "from the backup job");
			assert.equal(postsMatching(e2e, /🔴 \*/).length, 2);
		} finally {
			await close();
		}
	});

	it("follows the responder's policy: ignored alerts are never posted, and ones it does not investigate are posted with a thread to ask in", async () => {
		const policy = "---\nignore: name=Cloudflare OS\ngrafana.investigate: severity=critical\n---\nLook into it carefully, and name the likely owner.";
		const { e2e, alerts, close } = await start({ profile: { "responder.md": policy } });
		let seen = "";
		try {
			alerts.endpoint("cf", "Cloudflare OS", "external");
			await e2e.service.tick.alerts();
			alerts.down("cf");
			alerts.fire("fp-warn", { alertname: "HighLatency", instance: "web1", severity: "warning" });
			alerts.fire("fp-crit", { alertname: "NodeDown", instance: "web2", severity: "critical" });
			e2e.faux.setResponses([
				(transcript) => {
					seen = JSON.stringify(transcript);
					return fauxAssistantMessage("web2 stopped answering at 14:02; its host rebooted.");
				},
			]);
			await e2e.service.tick.alerts();
			await said(e2e, "its host rebooted");

			assert.equal(postsMatching(e2e, /Cloudflare/).length, 0, "the ignored one is never posted");
			assert.match(seen, /Look into it carefully, and name the likely owner\./);
			const left = postsMatching(e2e, /🟠/);
			assert.equal(left.length, 1);
			assert.match(left[0]?.text ?? "", /^🟠 \*HighLatency on web1 \(warning\)\*\nfiring since \S+\nNot one I look into on my own\. Ask me in this thread if you'd like me to\.$/);
			assert.equal(postsMatching(e2e, /🔴/).length, 1, "the critical one is investigated");
			assert.match(postsMatching(e2e, /🔴/)[0]?.text ?? "", /NodeDown on web2 \(critical\)/);
			assert.equal(e2e.faux.getPendingResponseCount(), 0);

			// The thread of the one it left alone is there for anyone who wants it looked into.
			const ts = tsOfPost(e2e, /🟠/);
			await until(() => e2e.service.scout.threads.get(threadKey(ALERTS_CHANNEL, ts)) !== undefined, 20_000, "the thread");
			e2e.faux.setResponses([fauxAssistantMessage("Latency is up on web1 since the deploy at 13:50.")]);
			await e2e.mention("please look into this one", { channel: ALERTS_CHANNEL, threadTs: ts });
			await said(e2e, "since the deploy at 13:50");
			await reactionsDone(e2e);
		} finally {
			await close();
		}
	});

	it("does not call an alert resolved when the monitoring cannot be read", async () => {
		const { e2e, alerts, close } = await start();
		try {
			await e2e.service.tick.alerts();
			alerts.fire("fp-out", { alertname: "ErrorRate", instance: "api1" });
			e2e.faux.setResponses([fauxAssistantMessage("Errors began after the 14:00 deploy.")]);
			await e2e.service.tick.alerts();
			await said(e2e, "after the 14:00 deploy");

			alerts.clear("fp-out");
			alerts.fail(2);
			await e2e.service.tick.alerts();
			assert.equal(posts(e2e).filter((p) => p.text.includes("Resolved")).length, 0, "an unreadable source says nothing about its alerts");
			assert.equal(e2e.service.health.list().length, 0, "and a blip is not a problem to report");

			await e2e.service.tick.alerts();
			assert.equal(posts(e2e).filter((p) => p.text.includes("Resolved")).length, 1, "it resolves when the monitoring answers and the alert is gone");
		} finally {
			await close();
		}
	});

	it("leaves alerts alone when it was told to act only when asked", async () => {
		const { e2e, alerts, close } = await start({ env: { SCOUT_INITIATIVE: "asked" } });
		try {
			alerts.fire("fp-quiet", { alertname: "HighCPU", instance: "web1" });
			await e2e.service.tick.alerts();
			alerts.fire("fp-quiet-2", { alertname: "HighMemory", instance: "web1" });
			await e2e.service.tick.alerts();
			assert.deepEqual(posts(e2e), []);
			assert.equal(alerts.reads.gatus + alerts.reads.grafana, 0, "it does not even look");
		} finally {
			await close();
		}
	});

	it("says nothing, rather than guessing, for an alert no channel claims when there is no alerts channel", async () => {
		const { e2e, alerts, close } = await start({ env: { SCOUT_ALERTS_CHANNEL: "" } });
		try {
			await e2e.service.tick.alerts();
			alerts.fire("fp-lost", { alertname: "HighCPU", instance: "web1" });
			await e2e.service.tick.alerts();
			assert.deepEqual(posts(e2e), []);
			assert.equal(e2e.faux.getPendingResponseCount(), 0);
		} finally {
			await close();
		}
	});
});

describe("end to end: Scout's own initiative in threads", () => {
	it("starts a thread in the channel when a schedule someone set up comes due, once per time", async () => {
		const clock = { time: Date.now(), now: () => clock.time };
		const e2e = await startScout({ now: clock.now });
		try {
			// Ann asks, in a thread, for something every day at 14:30; Scout sets the schedule up.
			e2e.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("schedule", { cron: "30 14 * * *", when: "every day at 14:30", task: "Check for dependency updates and report what you find." })], toolUse),
				fauxAssistantMessage("Scheduled: every day at 14:30."),
			]);
			await e2e.mention("every day at 14:30, check for dependency updates");
			await said(e2e, "Scheduled: every day at 14:30.");
			assert.deepEqual(e2e.service.scout.schedules.all().map((s) => [s.channel, s.cron, s.createdBy]), [["team", "30 14 * * *", ANN]]);

			// Before its time, nothing.
			const day = new Date();
			day.setHours(14, 0, 0, 0);
			clock.time = day.getTime();
			await e2e.service.tick.schedules();
			assert.equal(postsMatching(e2e, /Schedule #1/).length, 0);

			// At its time: a thread of its own in the channel, which says which schedule started it, and the work.
			day.setHours(14, 30, 5, 0);
			clock.time = day.getTime();
			e2e.faux.setResponses([fauxAssistantMessage("Two dependencies have updates: left-pad and right-pad.")]);
			await e2e.service.tick.schedules();
			await said(e2e, "left-pad and right-pad");
			const roots = postsMatching(e2e, /Schedule #1/);
			assert.deepEqual(roots.map((p) => [p.channel, p.thread, p.text]), [
				[TEAM_CHANNEL, undefined, `⏰ Schedule #1, every day at 14:30: Check for dependency updates and report what you find.\nSet up by <@${ANN}>. Anyone here can ask me to change, pause or stop it.`],
			]);

			// The same minute again does not run it again; the next day does.
			await e2e.service.tick.schedules();
			assert.equal(postsMatching(e2e, /Schedule #1/).length, 1);
			clock.time += DAY;
			e2e.faux.setResponses([fauxAssistantMessage("Nothing new today.")]);
			await e2e.service.tick.schedules();
			await said(e2e, "Nothing new today.");
			assert.equal(postsMatching(e2e, /Schedule #1/).length, 2);
			assert.equal(e2e.faux.getPendingResponseCount(), 0);
			await reactionsDone(e2e);
		} finally {
			await finish(e2e);
		}
	});

	it("follows up once in a thread that stalled on a question nobody answered", async () => {
		const clock = { offset: 0, now: () => Date.now() + clock.offset };
		const e2e = await startScout({ now: clock.now });
		const prompts: string[] = [];
		try {
			e2e.faux.setResponses([fauxAssistantMessage("Moving to Postgres is doable. Which version do you run today?")]);
			await e2e.mention("should we move to Postgres?");
			await said(e2e, "Which version do you run today?");

			// Three days on, still nobody has answered.
			await e2e.service.tick.housekeeping();
			assert.equal(e2e.faux.getPendingResponseCount(), 0);
			assert.equal(postsMatching(e2e, /Where things stand/).length, 0, "not yet: it waits the three days");
			clock.offset = 4 * DAY;
			e2e.faux.setResponses([
				(transcript) => {
					prompts.push(JSON.stringify(transcript));
					return fauxAssistantMessage("Where things stand: the move is doable. Still open: your Postgres version. Waiting on <@U0ANN00001>. Which version is it?");
				},
			]);
			await e2e.service.tick.housekeeping();
			await said(e2e, "Where things stand");
			assert.match(prompts[0] ?? "", /Nobody has replied here for 3 days, and your last answer was waiting on someone\./);
			assert.ok(e2e.slack.calls.some((c) => (c.method === "chat.postMessage" || c.method === "chat.update") && c.args.channel === TEAM_CHANNEL && String(c.args.text).includes("Where things stand")));

			// One follow-up, not one a day.
			clock.offset = 8 * DAY;
			await e2e.service.tick.housekeeping();
			assert.equal(e2e.faux.getPendingResponseCount(), 0);
			assert.equal(prompts.length, 1);
			await reactionsDone(e2e);
		} finally {
			await finish(e2e);
		}
	});

	it("does not follow up in a thread where someone has answered", async () => {
		const clock = { offset: 0, now: () => Date.now() + clock.offset };
		const e2e = await startScout({ now: clock.now });
		try {
			e2e.faux.setResponses([fauxAssistantMessage("Which Postgres version do you run today?")]);
			const ts = await e2e.mention("should we move to Postgres?");
			await said(e2e, "Which Postgres version");
			e2e.faux.setResponses([fauxAssistantMessage("Version 16 is fine for that.")]);
			await e2e.mention("we run 16", { threadTs: ts, user: BOB });
			await said(e2e, "Version 16 is fine for that.");

			clock.offset = 5 * DAY;
			await e2e.service.tick.housekeeping();
			assert.equal(e2e.faux.getPendingResponseCount(), 0);
			assert.equal(e2e.said().some((t) => t.includes("Where things stand")), false, "no recap");
			await reactionsDone(e2e, 2);
		} finally {
			await finish(e2e);
		}
	});
});
