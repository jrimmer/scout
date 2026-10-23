import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { LocalDriver } from "../src/drivers/local.ts";
import type { NetworkPolicy, SandboxDriver, SandboxSpec } from "../src/drivers/types.ts";
import { type E2e, type E2eOptions, startScout } from "./e2e.ts";
import { type FakeSlack, fakeSlack, TEAM_CHANNEL } from "./fake-slack.ts";
import { tempDir, until } from "./helpers.ts";

const toolUse = { stopReason: "toolUse" } as const;
const MINUTE = 60_000;
const HOME_CHANNEL = "C0HOME0001";
type Transcript = { messages: unknown[] };

/**
 * Fake Slack with Scout's home channel, #scout (SCOUT_REFLECT_CHANNEL), for announcements; `scopes` added to the
 * app's. Shared with `startScout`, so the test closes it (`closeAll`).
 */
async function slackWithHome(scopes: string[] = []): Promise<FakeSlack> {
	const slack = await fakeSlack();
	slack.channels.set(HOME_CHANNEL, { id: HOME_CHANNEL, name: "scout", is_channel: true, is_private: false, is_member: true });
	slack.scopes.push(...scopes);
	return slack;
}

/** Scout on a fake Slack it shares, with the home channel and the dashboard on; `close` closes both. */
async function startWithHome(options: E2eOptions & { scopes?: string[] } = {}) {
	const slack = await slackWithHome(options.scopes);
	const e2e = await startScout({ ...options, slack, env: { SCOUT_REFLECT_CHANNEL: "scout", SCOUT_DASH_ADDR: "127.0.0.1:0", ...options.env } });
	let starts = 1;
	return {
		e2e,
		restart: async () => {
			starts++;
			return e2e.restart();
		},
		close: async () => {
			await e2e.close();
			await slack.close(starts);
		},
	};
}

/** What Scout said in its home channel, top level, in order. */
function home(e2e: E2e): string[] {
	return e2e.slack.called("chat.postMessage").filter((c) => c.args.channel === HOME_CHANNEL && c.args.thread_ts === undefined).map((c) => String(c.args.text));
}

/**
 * `/scout <text>` from Ann in #team; returns what Scout answered her. Answered before `deliver` returns, so it also
 * serves to let what Scout started before it reach Slack, before a test checks that something didn't.
 */
async function slash(e2e: E2e, text: string): Promise<string> {
	const envelope = e2e.slack.envelope("slash-command");
	(envelope.payload as { text: string }).text = text;
	const before = e2e.slack.responded.length;
	await e2e.slack.receiver.deliver(envelope);
	await until(() => e2e.slack.responded.length > before, 20_000, `the answer to /scout ${text}`);
	return String(e2e.slack.responded.at(-1)?.body.text);
}

/** A page of the live dashboard. */
async function dash(e2e: E2e, path: string): Promise<string> {
	const response = await fetch(`http://127.0.0.1:${e2e.service.dashboardPort}${path}`);
	assert.equal(response.status, 200, `GET ${path}`);
	return response.text();
}

/** The dashboard's grid as plain text, a line per row, from its HTML; and the HTML of each row, to check its styles. */
function grid(html: string): { text: string; rows: string[] } {
	const rows = html.split('<span class="gr"').slice(1);
	const plain = (row: string) =>
		row
			.replace(/^[^>]*>/, "")
			.replace(/<[^>]+>/g, "")
			.replaceAll("&lt;", "<")
			.replaceAll("&gt;", ">")
			.replaceAll("&quot;", '"')
			.replaceAll("&#39;", "'")
			.replaceAll("&amp;", "&");
	return { text: rows.map(plain).join("\n"), rows };
}

/**
 * The dashboard's stream (server-sent events: the whole grid, then the rows that changed), read until a row's text
 * matches `pattern` or 20 seconds pass; returns the rows' text it saw.
 */
async function streamed(response: Response, pattern: RegExp): Promise<string> {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	const deadline = Date.now() + 20_000;
	let buffer = "";
	let seen = "";
	while (!pattern.test(seen) && Date.now() < deadline) {
		let timer: unknown;
		const chunk = await Promise.race([reader.read(), new Promise<undefined>((resolve) => (timer = setTimeout(resolve, deadline - Date.now())))]);
		clearTimeout(timer as never);
		if (chunk === undefined || chunk.done) break;
		buffer += decoder.decode(chunk.value, { stream: true });
		const events = buffer.split("\n\n");
		buffer = events.pop() ?? "";
		for (const event of events) {
			const data = JSON.parse(event.split("\n").find((l) => l.startsWith("data: "))!.slice("data: ".length)) as string | { html: string }[];
			const html = typeof data === "string" ? data : data.map((row) => `<span class="gr" id="r">${row.html}</span>`).join("");
			seen += `${grid(html).text}\n`;
		}
	}
	return seen;
}

/** A Prometheus gauge's value from /metrics. */
function gauge(metrics: string, name: string): number | undefined {
	const line = metrics.split("\n").find((l) => l.startsWith(`${name} `));
	return line === undefined ? undefined : Number(line.split(" ")[1]);
}

/**
 * The process's clock, moved on by `by` for everything that reads it (`Date.now()` and `new Date()`), for what Scout
 * times by the real clock rather than the service's `now` (the fallback models' steady period, when pull requests
 * were opened). `restore` puts it back.
 */
function shiftedClock() {
	const RealDate = Date;
	let offset = 0;
	globalThis.Date = new Proxy(RealDate, {
		construct: (target, args, newTarget) => Reflect.construct(target, args.length === 0 ? [RealDate.now() + offset] : args, newTarget),
		get: (target, property, receiver) => (property === "now" ? () => RealDate.now() + offset : Reflect.get(target, property, receiver)),
	});
	return {
		by: (ms: number) => void (offset += ms),
		restore: () => void (globalThis.Date = RealDate),
	};
}

/** The next Monday after `from`'s day (never `from`'s own), at `hour` local time. */
function nextMonday(from: number, hour: number): number {
	const day = new Date(from);
	day.setHours(hour, 0, 0, 0);
	do day.setDate(day.getDate() + 1);
	while (day.getDay() !== 1);
	return day.getTime();
}

describe("end to end: operations", () => {
	it("falls back to another model while its own fails: in the thread once, the home channel down and back, the dashboard and /metrics", async () => {
		const clock = shiftedClock();
		const scout = await startWithHome({
			models: ["f"],
			env: { SCOUT_FALLBACK_MODELS: "faux/f", SCOUT_FALLBACK_AFTER: "1", SCOUT_FALLBACK_FOR: "1", SCOUT_BACKUP: "none" },
		});
		const { e2e } = scout;
		const { slack, faux } = e2e;
		// faux/m fails while `down`; faux/f takes a look with a command, then answers.
		let down = true;
		const onF = [fauxAssistantMessage([fauxToolCall("bash", { command: "echo looked" })], toolUse), fauxAssistantMessage("Answered by f, after a look.")];
		const model = (_transcript: Transcript, _options: unknown, _state: unknown, which: { id: string }) => {
			if (which.id === "m") return down ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }) : fauxAssistantMessage("Answered by m.");
			return onF.shift() ?? fauxAssistantMessage("Answered by f.");
		};
		faux.setResponses(Array.from({ length: 10 }, () => model));
		const notice = "m isn't answering, so I'm using f for now.";
		const answerOf = (text: string) => slack.called("chat.update").find((c) => String(c.args.text).includes(text));
		const metrics = async () => dash(e2e, "/metrics");
		const status = async () => JSON.parse(await dash(e2e, "/status.json")) as { models: { primary: string; fallbacks: string[]; outages: { model: string; fallback?: string; failures: number; error?: string }[] } };
		try {
			await e2e.mention("why is the queue backing up?");
			// One failed call opens the breaker; Pi tries again (after 5 s), on the fallback.
			await until(() => answerOf("Answered by f, after a look.") !== undefined, 30_000, "the answer from the fallback");
			await e2e.service.scout.harness.waitForIdle(context);

			// The thread: said once, with the answer, though the run made two calls on the fallback.
			const blocks = JSON.stringify(answerOf("Answered by f, after a look.")?.args.blocks);
			assert.equal(blocks.split(notice).length - 1, 1, "the thread hears it once");
			// The home channel: once.
			await until(() => home(e2e).some((t) => t.startsWith("Heads up: m has failed")), 20_000, "the home channel to hear");
			assert.deepEqual(
				home(e2e).filter((t) => t.includes("Heads up")),
				["Heads up: m has failed 1 calls in a row (503 service unavailable), so I'm using f for now. I'll try m again every 1 minute."],
			);
			// /status.json, /metrics, and the dashboard's own lines.
			const outage = (await status()).models;
			assert.equal(outage.primary, "faux/m");
			assert.deepEqual(outage.fallbacks, ["faux/f"]);
			assert.deepEqual(outage.outages.map((o) => [o.model, o.fallback, o.error]), [["faux/m", "faux/f", "503 service unavailable"]]);
			const during = await metrics();
			assert.equal(gauge(during, "scout_model_on_fallback"), 1);
			assert.equal(gauge(during, "scout_models_failing"), 1);
			let page = "";
			await until(async () => ((page = grid(await dash(e2e, "/")).text), /fallback +f since \d\d:\d\d \(m failing: 503 service unavailable\)/.test(page)), 20_000, "the dashboard's fallback line");
			assert.match(page, /model +m failing +· falls back to f/);

			// The model answers again, a minute on: the next call tries it, and it's back. Nobody's told yet.
			down = false;
			clock.by(MINUTE + 1_000);
			await e2e.mention("and now?");
			await until(() => answerOf("Answered by m.") !== undefined, 20_000, "the answer from the model itself");
			await e2e.service.scout.harness.waitForIdle(context);
			assert.doesNotMatch(JSON.stringify(answerOf("Answered by m.")?.args.blocks), /isn't answering/, "this run wasn't on the fallback");
			assert.deepEqual((await status()).models.outages, []);
			const after = await metrics();
			assert.equal(gauge(after, "scout_model_on_fallback"), 0);
			assert.equal(gauge(after, "scout_models_failing"), 0);
			await until(async () => /model +m +· falls back to f/.test(grid(await dash(e2e, "/")).text), 20_000, "the dashboard's model line back to normal");

			// Ten minutes on, it has stayed up: the next answer says so in the home channel, once.
			clock.by(10 * MINUTE + 1_000);
			const third = slack.calls.length;
			await e2e.mention("still good?");
			await until(() => home(e2e).some((t) => t.includes("answering again")), 20_000, "the home channel to hear it's back");
			await e2e.service.scout.harness.waitForIdle(context);
			await slash(e2e, "help");
			const back = home(e2e).filter((t) => t.includes("answering again"));
			assert.equal(back.length, 1);
			assert.match(back[0]!, /^m is answering again, so I'm back on it\. It was out for about \d+ minutes?\./);
			const said = slack.calls.findIndex((c) => c.method === "chat.postMessage" && String(c.args.text).includes("answering again"));
			assert.ok(said >= third, "said only after it had stayed up for the steady period, not when it first answered");
			assert.equal(home(e2e).filter((t) => t.includes("Heads up")).length, 1);
		} finally {
			clock.restore();
			await scout.close();
		}
	});

	it("says when Scout's data isn't backed up: the dashboard, /status.json, /metrics, the home channel after a grace period, and the Monday report", async () => {
		let now = Date.now();
		const scout = await startWithHome({ now: () => now, env: { SCOUT_METRICS_TOKEN: "metrics-token" } });
		const { e2e } = scout;
		const authed = async (path: string) => {
			const response = await fetch(`http://127.0.0.1:${e2e.service.dashboardPort}${path}`, { headers: { authorization: "Bearer metrics-token" } });
			assert.equal(response.status, 200);
			return response.text();
		};
		const notices = () => home(e2e).filter((t) => t.startsWith("Heads up: my data isn't being backed up"));
		try {
			// No Litestream beside the databases: a standing line under the dashboard's top one, in red.
			const page = grid(await dash(e2e, "/"));
			const line = page.rows.find((r) => r.includes("not backed up off this machine"));
			assert.ok(line, "the dashboard's warning line");
			assert.match(line, /class="g-bad">! not backed up off this machine: no Litestream copy of pi\.sqlite or scout/);
			const status = JSON.parse(await authed("/status.json")) as { backup: { status: string; problems: string[] } };
			assert.deepEqual(status.backup, { status: "missing", problems: ["no Litestream copy of pi.sqlite or scout.sqlite"] });
			assert.equal(gauge(await authed("/metrics"), "scout_backup_ok"), 0);

			// Litestream may be starting alongside: nothing said in the home channel for the first 20 minutes.
			now += 19 * MINUTE;
			await e2e.service.tick.backup();
			await slash(e2e, "help");
			assert.deepEqual(notices(), [], "not within the grace period");
			now += 2 * MINUTE;
			await e2e.service.tick.backup();
			await until(() => notices().length > 0, 20_000, "the home channel's notice");
			now += 10 * MINUTE;
			await e2e.service.tick.backup();
			await slash(e2e, "help");
			assert.equal(notices().length, 1, "once a start");
			assert.match(notices()[0]!, /no Litestream copy of pi\.sqlite or scout\.sqlite\)\. If this box goes, every thread goes with it\. docs\/operations\.md#backups has the steps\.$/);

			// Monday, after the reflection hour: the weekly report says so too.
			now = nextMonday(now, 12);
			await e2e.service.tick.housekeeping();
			await until(() => home(e2e).some((t) => t.includes("Quiet week")), 20_000, "the weekly report");
			const report = home(e2e).find((t) => t.includes("Quiet week"))!;
			assert.match(report, /My data still isn't backed up off this machine \(no Litestream copy of pi\.sqlite or scout\.sqlite\); docs\/operations\.md#backups has the steps\./);

			// Litestream starts copying: all clear.
			const data = e2e.env.SCOUT_DATA_DIR;
			for (const db of ["pi.sqlite", "scout.sqlite"]) mkdirSync(join(data, `.${db}-litestream`, "generations"), { recursive: true });
			await e2e.service.tick.backup();
			assert.equal(gauge(await authed("/metrics"), "scout_backup_ok"), 1);
			assert.equal((JSON.parse(await authed("/status.json")) as { backup: { status: string } }).backup.status, "ok");
			await until(async () => !grid(await dash(e2e, "/")).text.includes("not backed up"), 20_000, "the dashboard's line to go");
		} finally {
			await scout.close();
		}
	});

	it("with SCOUT_BACKUP=none, shows backups as off on purpose and says nothing about them", async () => {
		let now = Date.now();
		const scout = await startWithHome({ now: () => now, env: { SCOUT_BACKUP: "none" } });
		const { e2e } = scout;
		try {
			const line = grid(await dash(e2e, "/")).rows.find((r) => r.includes("backups off"));
			assert.ok(line, "a line saying so");
			assert.match(line, /class="g-dim">backups off, on purpose \(SCOUT_BACKUP=none\)/);
			assert.equal((JSON.parse(await dash(e2e, "/status.json")) as { backup: { status: string } }).backup.status, "off");
			assert.equal(gauge(await dash(e2e, "/metrics"), "scout_backup_ok"), 1, "not an alert");

			now += 30 * MINUTE;
			await e2e.service.tick.backup();
			now = nextMonday(now, 12);
			await e2e.service.tick.housekeeping();
			await until(() => home(e2e).some((t) => t.includes("Quiet week")), 20_000, "the weekly report");
			await slash(e2e, "help");
			assert.ok(!home(e2e).some((t) => /backed up/.test(t)), "no notice, and no line in the report");
		} finally {
			await scout.close();
		}
	});

	it("reports the week on Monday after the reflection hour: pull requests merged, spend and waiting in the home channel, each channel's week and canvas", async () => {
		const clock = shiftedClock();
		// Wednesday noon of some week, so the week's work is all in "last week" on the Monday after.
		const wednesday = new Date();
		wednesday.setHours(12, 0, 0, 0);
		do wednesday.setDate(wednesday.getDate() + 1);
		while (wednesday.getDay() !== 3);
		clock.by(wednesday.getTime() - Date.now());
		const pricesDir = tempDir("scout-prices-");
		const prices = join(pricesDir, "prices.json");
		writeFileSync(prices, JSON.stringify({ "faux/m": { input: 1_000, output: 1_000 } }));
		let now = Date.now();
		const scout = await startWithHome({ now: () => now, scopes: ["canvases:write"], profile: { "channels/team/instructions.md": "---\nrepo: app\n---\n" }, env: { SCOUT_BACKUP: "none", SCOUT_REFLECT_HOUR: "3", SCOUT_PRICES_FILE: prices } });
		const { e2e } = scout;
		const { slack, host, faux } = e2e;
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "printf 'Be kind.\\n' > CONTRIBUTING.md && git add CONTRIBUTING.md && git commit -qm 'Add a contributing guide'" })], toolUse),
			fauxAssistantMessage([fauxToolCall("open_pull_request", { title: "Add a contributing guide", body: "Adds CONTRIBUTING.md." })], toolUse),
			fauxAssistantMessage("APPROVE\nSmall and right."),
			fauxAssistantMessage("I opened a pull request that adds CONTRIBUTING.md."),
		]);
		const reports = () => home(e2e).filter((t) => t.startsWith("Last week I opened"));
		const weeks = () => slack.called("chat.postMessage").filter((c) => c.args.channel === TEAM_CHANNEL && String(c.args.text).startsWith("*Last week here:*"));
		try {
			await e2e.mention('please add a CONTRIBUTING.md that says "Be kind."');
			await until(() => e2e.said().some((t) => t.includes("I opened a pull request")), 20_000, "the pull request");
			await e2e.service.scout.harness.waitForIdle(context);
			await until(() => slack.called("chat.postMessage").some((c) => c.args.reply_broadcast === true), 20_000, "the pull request's notice");
			host.merge("acme/app", 1);

			// Monday, before the reflection hour: housekeeping sees the merge, but the week isn't reported yet.
			now = nextMonday(now, 2);
			await e2e.service.tick.housekeeping();
			await slash(e2e, "help");
			assert.deepEqual(reports(), []);
			assert.deepEqual(weeks(), []);
			assert.equal(slack.called("conversations.canvases.create").length, 1, "the channel's canvas, made on the way");

			// After it: the week, once.
			now += 2 * 60 * MINUTE;
			await e2e.service.tick.housekeeping();
			await until(() => reports().length > 0, 20_000, "the weekly report");
			const report = reports()[0]!;
			assert.match(report, /^Last week I opened 1 pull request\. Of the 1 that were decided, 1 merged \(100%\)\./);
			const cost = Number(report.match(/Models cost \$(\d+\.\d\d) so far\./)?.[1]);
			assert.ok(cost > 0, `what the models cost: ${report}`);
			assert.match(report, /Waiting last week: the model took .+ to start answering, half the time/, "the capacity line");
			assert.equal(weeks().length, 1);
			const week = String(weeks()[0]?.args.text);
			assert.match(week, /^\*Last week here:\* 1 thread, 1 pull request merged\. Models cost \$\d+\.\d\d\./);
			assert.match(week, /in this channel's canvas, kept up to date/, "pointing to the canvas for the rest");
			assert.ok(slack.called("canvases.edit").some((c) => c.args.canvas_id === "F0CANVAS01"), "the canvas refreshed for the week");

			// Not again: later that day, nor after a restart.
			now += 60 * MINUTE;
			await e2e.service.tick.housekeeping();
			await scout.restart();
			await e2e.service.tick.housekeeping();
			await slash(e2e, "help");
			assert.equal(reports().length, 1);
			assert.equal(weeks().length, 1);
		} finally {
			clock.restore();
			await scout.close();
			rmSync(pricesDir, { recursive: true, force: true });
		}
	});

	it("shows a running thread on the live dashboard and its stream, and checks itself with /scout doctor", async () => {
		const scout = await startWithHome({ env: { SCOUT_BACKUP: "none" } });
		const { e2e } = scout;
		const { faux } = e2e;
		const started = join(e2e.root, "started");
		const done = join(e2e.root, "done");
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: `touch ${started}; for i in $(seq 600); do [ -f ${done} ] && break; sleep 0.05; done; echo ok` })], toolUse),
			// The doctor asks the model for a word while the run's command is still going.
			fauxAssistantMessage("OK"),
			fauxAssistantMessage("All the tests pass."),
		]);
		const stream = new AbortController();
		try {
			await e2e.mention("run the tests");
			await until(() => existsSync(started), 20_000, "the command to start");

			// The stream: the grid as it is, then rows as they change; within a refresh it shows the run.
			const response = await fetch(`http://127.0.0.1:${e2e.service.dashboardPort}/stream`, { signal: stream.signal });
			assert.equal(response.headers.get("content-type"), "text/event-stream");
			const shown = await streamed(response, /▶ #team 1 step/);
			assert.match(shown, /▶ #team 1 step/, "the stream shows the run, a step in");
			const page = grid(await dash(e2e, "/")).text;
			assert.match(page, /▶ #team 1 step/, "so does the page");
			assert.match(page, /working .* 1/);

			const checks = await slash(e2e, "doctor");
			assert.match(checks, /Settings: 1 repository, model faux\/m/);
			assert.match(checks, /Slack: /);
			assert.match(checks, /Running: up .*, 1 working/, "the doctor asked the running Scout");
			assert.doesNotMatch(checks, /❌|✗ /, `nothing failing:\n${checks}`);

			writeFileSync(done, "");
			await until(() => e2e.said().some((t) => t.includes("All the tests pass.")), 20_000, "the answer");
			assert.equal(faux.getPendingResponseCount(), 0);
		} finally {
			stream.abort();
			writeFileSync(done, "");
			await scout.close();
		}
	});

	it("reads its secrets again on SIGHUP: the code host gets the new token from then on", async () => {
		const seen: string[] = [];
		const recording = ((input: string | URL | Request, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (!url.includes("slack")) seen.push(`${new Headers(init?.headers).get("authorization")} ${url}`);
			return fetch(input, init);
		}) as typeof fetch;
		const previous = process.env.SCOUT_CODEHOST_TOKEN;
		const e2e = await startScout({ fetch: recording });
		const tokens = () => seen.filter((s) => s.includes("/notifications")).map((s) => s.split(" ").slice(0, 2).join(" "));
		try {
			await e2e.service.tick.inbox();
			assert.deepEqual([...new Set(tokens())], ["token forge-token"]);

			// The token is rotated where Scout reads it; nothing changes until Scout is told.
			process.env.SCOUT_CODEHOST_TOKEN = "rotated-token";
			await e2e.service.tick.inbox();
			assert.equal(tokens().at(-1), "token forge-token");
			e2e.service.signal("SIGHUP");
			await until(async () => (await e2e.service.tick.inbox(), tokens().at(-1) === "token rotated-token"), 20_000, "the new token");
			assert.deepEqual(e2e.exits, [], "and Scout carried on");
		} finally {
			if (previous === undefined) delete process.env.SCOUT_CODEHOST_TOKEN;
			else process.env.SCOUT_CODEHOST_TOKEN = previous;
			await e2e.close();
		}
	});

	it("builds a repository's image from its .scout/setup.sh on the housekeeping tick, and starts new threads from it", async () => {
		const sandboxes = tempDir("scout-sandboxes-");
		const driver = new SnapshotDriver(sandboxes);
		const e2e = await startScout({ driver });
		const { faux, repo } = e2e;
		mkdirSync(join(repo.seed, ".scout"), { recursive: true });
		repo.commit({ ".scout/setup.sh": "echo 'dependencies installed by setup' > .prebuilt\necho .prebuilt >> .git/info/exclude\n" }, "Add a setup script");
		repo.push();
		let seen = "";
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "cat .prebuilt" })], toolUse),
			(transcript: Transcript) => {
				seen = JSON.stringify(transcript.messages.at(-1));
				return fauxAssistantMessage("The dependencies are already there.");
			},
		]);
		try {
			await e2e.service.tick.housekeeping();
			assert.deepEqual(driver.saved, ["scout/app"], "the image was built and saved");

			await e2e.mention("are the dependencies installed?");
			await until(() => e2e.said().some((t) => t.includes("already there")), 20_000, "the answer");
			const thread = driver.opened.find((o) => !o.key.includes("-image-"));
			assert.equal(thread?.spec.snapshot, "scout/app", "the thread's sandbox started from the image");
			assert.match(seen, /dependencies installed by setup/, "with what the setup script made");

			// Nothing changed: the next tick doesn't build it again.
			await e2e.service.tick.housekeeping();
			assert.deepEqual(driver.saved, ["scout/app"]);
		} finally {
			await e2e.close();
			rmSync(sandboxes, { recursive: true, force: true });
		}
	});
});

/**
 * Local sandboxes that can be saved as images, as spoond's can: a snapshot is a copy of the sandbox's directory, and a
 * sandbox opened from one starts as a copy of it. Records what it was asked.
 */
class SnapshotDriver implements SandboxDriver {
	readonly name = "local-snapshots";
	readonly opened: { key: string; spec: SandboxSpec }[] = [];
	readonly saved: string[] = [];
	readonly #local: LocalDriver;
	readonly #root: string;

	constructor(root: string) {
		this.#root = root;
		this.#local = new LocalDriver({ root: join(root, "sandboxes") });
	}

	#dir(key: string): string {
		return join(this.#root, "sandboxes", key.replace(/[^a-zA-Z0-9_.-]/g, "-"));
	}

	supports(_policy: NetworkPolicy): boolean {
		return true;
	}

	async open(key: string, spec: SandboxSpec) {
		this.opened.push({ key, spec });
		if (spec.snapshot !== undefined && !existsSync(this.#dir(key))) cpSync(join(this.#root, "snapshots", spec.snapshot), this.#dir(key), { recursive: true });
		return this.#local.open(key, spec);
	}

	suspend(key: string): Promise<void> {
		return this.#local.suspend(key);
	}

	remove(key: string): Promise<void> {
		return this.#local.remove(key);
	}

	async snapshot(key: string, name: string): Promise<{ name: string; version: number }> {
		cpSync(this.#dir(key), join(this.#root, "snapshots", name), { recursive: true });
		this.saved.push(name);
		return { name, version: this.saved.length };
	}
}
