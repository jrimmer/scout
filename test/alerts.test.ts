import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Alert, AlertLog, AlertWatcher, alertMatches, DEFAULT_ALERT_POLICY, gatusAlerts, grafanaAlerts, parseAlertPolicy } from "../src/alerts.ts";
import { loadProfile } from "../src/profile.ts";
import { tempDir } from "./helpers.ts";

const check = (success: boolean, timestamp = "2026-10-20T06:00:00Z") => ({ success, timestamp, status: success ? 200 : 502, conditionResults: [{ condition: "[STATUS] < 400", success }] });
const answer = (body: unknown) => (async () => Response.json(body)) as unknown as typeof fetch;

describe("alerts", () => {
	it("calls a Gatus endpoint down after two failed checks in a row, not one", async () => {
		const alerts = await gatusAlerts(
			"http://gatus",
			answer([
				{ key: "apps_photos", name: "Photos", group: "Apps", results: [check(false, "2026-10-20T05:59:00Z"), check(false)] },
				{ key: "apps_blip", name: "Blip", group: "Apps", results: [check(true), check(false)] },
				{ key: "apps_home", name: "Home", group: "Apps", results: [check(true), check(true)] },
			]),
		);
		assert.deepEqual(alerts.map((a) => a.key), ["gatus:apps_photos"]);
		assert.equal(alerts[0]!.title, "Apps / Photos is down");
		assert.match(alerts[0]!.detail, /HTTP 502; failed: \[STATUS\] < 400; 2 checks in a row since 2026-10-20T05:59:00Z/);
		assert.deepEqual(alerts[0]!.labels, { group: "Apps", name: "Photos", endpoint: "apps_photos" });
	});

	it("reads Grafana's firing alerts with their labels", async () => {
		const alerts = await grafanaAlerts(
			"http://grafana",
			"tok",
			answer([
				{ fingerprint: "f1", labels: { alertname: "DiskSpaceHigh", instance: "vm1", mountpoint: "/data", severity: "warning" }, annotations: { summary: "Disk > 80% on vm1" }, startsAt: "2026-10-20T05:00:00Z", status: { state: "active" } },
				{ fingerprint: "f2", labels: { alertname: "Old" }, startsAt: "2026-10-20T05:00:00Z", status: { state: "suppressed" } },
			]),
		);
		assert.deepEqual(alerts, [
			{
				key: "grafana:f1",
				source: "grafana",
				title: "DiskSpaceHigh on vm1 /data (warning)",
				detail: "Disk > 80% on vm1; firing since 2026-10-20T05:00:00Z",
				labels: { alertname: "DiskSpaceHigh", instance: "vm1", mountpoint: "/data", severity: "warning" },
			},
		]);
	});

	it("records what's already firing at first, then raises new alerts once and resolves cleared ones", async () => {
		const alert = (key: string): Alert => ({ key, source: "gatus", title: key, detail: "down", labels: {} });
		let now: Alert[] = [alert("gatus:a")];
		let readable = true;
		const events: string[] = [];
		const watcher = new AlertWatcher({
			log: new AlertLog(":memory:"),
			sources: [{ source: "gatus", read: async () => (readable ? now : Promise.reject(new Error("down"))) }],
			handlers: {
				baseline: async (alerts) => void events.push(`baseline ${alerts.map((a) => a.key)}`),
				firing: async (a) => (events.push(`firing ${a.key}`), { channel: "C1", threadTs: "1.1" }),
				resolved: async (a) => void events.push(`resolved ${a.key} in ${a.threadTs ?? "no thread"}`),
				returned: async (a) => void events.push(`returned ${a.key} in ${a.threadTs} (${a.returns})`),
			},
		});
		await watcher.poll();
		now = [alert("gatus:a"), alert("gatus:b")];
		await watcher.poll();
		await watcher.poll();
		// A source that can't be read resolves nothing.
		readable = false;
		await watcher.poll();
		readable = true;
		now = [];
		await watcher.poll();
		assert.deepEqual(events, ["baseline gatus:a", "firing gatus:b", "resolved gatus:a in no thread", "resolved gatus:b in 1.1"]);
	});

	it("upgrades an alert table from before flapping was handled", () => {
		const path = join(tempDir("scout-alerts-"), "scout.sqlite");
		const old = new DatabaseSync(path);
		old.exec("CREATE TABLE alerts (key TEXT PRIMARY KEY, alert TEXT NOT NULL, opened_at INTEGER NOT NULL, channel TEXT, thread_ts TEXT)");
		old.prepare("INSERT INTO alerts VALUES (?, ?, ?, NULL, NULL)").run("gatus:x", JSON.stringify({ key: "gatus:x", source: "gatus", title: "x", detail: "", labels: {} }), 1);
		old.close();
		const log = new AlertLog(path);
		assert.deepEqual(log.open().map((a) => [a.key, a.returns]), [["gatus:x", 0]]);
		log.close();
	});

	it("keeps a flapping alert in its thread instead of starting over each time", async () => {
		const flapping: Alert = { key: "grafana:disk", source: "grafana", title: "DiskSpaceHigh", detail: "80%", labels: {} };
		let firing = false;
		const events: string[] = [];
		const watcher = new AlertWatcher({
			log: new AlertLog(":memory:"),
			sources: [{ source: "grafana", read: async () => (firing ? [flapping] : []) }],
			handlers: {
				baseline: async () => {},
				firing: async (a) => (events.push(`firing ${a.key}`), { channel: "C1", threadTs: "2.2" }),
				resolved: async () => void events.push("resolved"),
				returned: async (a) => void events.push(`returned in ${a.threadTs} (${a.returns})`),
			},
		});
		const hour = 60 * 60 * 1000;
		await watcher.poll(0);
		for (const [at, state] of [[hour, true], [2 * hour, false], [3 * hour, true], [4 * hour, false], [5 * hour, true], [6 * hour, false]] as const) {
			firing = state;
			await watcher.poll(at);
		}
		// Long after it last cleared, it's a new incident again.
		firing = true;
		await watcher.poll(13 * hour);
		assert.deepEqual(events, ["firing grafana:disk", "resolved", "returned in 2.2 (1)", "resolved", "returned in 2.2 (2)", "resolved", "firing grafana:disk"]);
	});

	it("reads the alert policy from the profile, a source's own setting overriding the general one", () => {
		const { policy, problems } = parseAlertPolicy({
			ignore: "name=Cloudflare OS",
			"grafana.investigate": "severity=critical, severity=page",
			"gatus.down_after": "3",
			returns_within: "2h",
			"gatus.returns_within": "30m",
		});
		assert.deepEqual(problems, []);
		assert.deepEqual(policy.gatus, { ignore: ["name=Cloudflare OS"], downAfter: 3, returnsWithinMs: 30 * 60_000 });
		assert.deepEqual(policy.grafana, { ignore: ["name=Cloudflare OS"], investigate: ["severity=critical", "severity=page"], downAfter: 2, returnsWithinMs: 2 * 3_600_000 });
		assert.deepEqual(parseAlertPolicy({}).policy.grafana, DEFAULT_ALERT_POLICY);
	});

	it("says what it couldn't read in the alert policy instead of quietly using a default", () => {
		const { policy, problems } = parseAlertPolicy({ "gatus.down_after": "two", returns_within: "soon", "prometheus.ignore": "x", "grafana.down_after": "3", investgate: "x" });
		assert.equal(problems.length, 5);
		assert.match(problems.join("\n"), /gatus\.down_after: "two"/);
		assert.match(problems.join("\n"), /no alert source called prometheus/);
		assert.match(problems.join("\n"), /investgate: not an alert setting/);
		assert.equal(policy.gatus.downAfter, 2);
	});

	it("matches an alert by any label's value, or by one label", () => {
		const alert = { labels: { alertname: "DiskSpaceCritical", host: "dns", severity: "critical" } };
		assert.ok(alertMatches(alert, "dns"));
		assert.ok(alertMatches(alert, "severity=Critical"));
		assert.ok(alertMatches(alert, "severity = CRITICAL"));
		assert.ok(!alertMatches(alert, "host=critical"));
		assert.ok(!alertMatches(alert, "nope"));
		assert.ok(!alertMatches(alert, "severity="));
	});

	it("investigates only what the policy says, ignores what it says, and lets an ignored open alert go quietly", async () => {
		const alert = (key: string, labels: Record<string, string>): Alert => ({ key, source: "grafana", title: key, detail: "", labels });
		let now: Alert[] = [];
		const events: string[] = [];
		let policy = { ...DEFAULT_ALERT_POLICY, investigate: ["severity=critical"] } as typeof DEFAULT_ALERT_POLICY;
		const watcher = new AlertWatcher({
			log: new AlertLog(":memory:"),
			sources: [{ source: "grafana", read: async () => now }],
			policy: () => policy,
			handlers: {
				baseline: async () => {},
				firing: async (a, investigate) => (events.push(`${investigate ? "investigate" : "post"} ${a.key}`), { channel: "C1", threadTs: "3.3" }),
				resolved: async (a) => void events.push(`resolved ${a.key}`),
				returned: async () => {},
			},
		});
		await watcher.poll();
		now = [alert("grafana:disk", { severity: "critical" }), alert("grafana:cpu", { severity: "warning" })];
		await watcher.poll();
		policy = { ...policy, ignore: ["severity=warning"] };
		now = [...now, alert("grafana:mem", { severity: "warning" })];
		await watcher.poll();
		assert.deepEqual(events, ["investigate grafana:disk", "post grafana:cpu"]);
	});

	it("waits for the profile's number of failed Gatus checks", async () => {
		const endpoint = { key: "core_api", name: "api", results: [check(true), check(false), check(false)] };
		assert.equal((await gatusAlerts("http://gatus", answer([endpoint]), 2)).length, 1);
		assert.equal((await gatusAlerts("http://gatus", answer([endpoint]), 3)).length, 0);
	});

	it("takes the alert policy from responder.md's frontmatter and keeps it out of the instructions", () => {
		const dir = tempDir("scout-profile-");
		writeFileSync(join(dir, "system.md"), "You are Scout.");
		writeFileSync(join(dir, "responder.md"), "---\n# Only wake people for what matters: see docs/operations.md\ngrafana.investigate: severity=critical\n---\nLook into it calmly.\n");
		const profile = loadProfile(dir);
		assert.equal(profile.responder, "Look into it calmly.");
		assert.deepEqual(profile.alertPolicy.grafana.investigate, ["severity=critical"]);
		assert.equal(profile.alertPolicy.gatus.investigate, undefined);
		assert.deepEqual(profile.problems, []);
	});
});
