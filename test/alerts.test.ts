import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
});
