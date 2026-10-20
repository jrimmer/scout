import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Alert, AlertLog, AlertWatcher, gatusAlerts, grafanaAlerts } from "../src/alerts.ts";

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
				{ fingerprint: "f1", labels: { alertname: "DiskSpaceHigh", instance: "vm1", severity: "warning" }, annotations: { summary: "Disk > 80% on vm1" }, startsAt: "2026-10-20T05:00:00Z", status: { state: "active" } },
				{ fingerprint: "f2", labels: { alertname: "Old" }, startsAt: "2026-10-20T05:00:00Z", status: { state: "suppressed" } },
			]),
		);
		assert.deepEqual(alerts, [
			{
				key: "grafana:f1",
				source: "grafana",
				title: "DiskSpaceHigh on vm1 (warning)",
				detail: "Disk > 80% on vm1; firing since 2026-10-20T05:00:00Z",
				labels: { alertname: "DiskSpaceHigh", instance: "vm1", severity: "warning" },
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
		const path = join(mkdtempSync(join(tmpdir(), "scout-alerts-")), "scout.sqlite");
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
});
