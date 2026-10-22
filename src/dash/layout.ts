import { describeBackup } from "../backups.ts";
import { short } from "../capacity.ts";
import type { Snapshot } from "./collect.ts";
import { Grid, type Style } from "./grid.ts";

/** A run of text in one style; a line is runs from the left, and optionally runs pinned to the right. */
type Seg = { text: string; style?: Style };
type Line = { left: Seg[]; right?: Seg[] } | "rule" | { meter: { label: string; fraction: number; after: Seg[] } } | { spark: { label: string; values: number[]; after: Seg[] } };

export const WIDTH = 104;

/** The whole dashboard for one snapshot; `links.bench` adds the Benchmark page to the last line. */
export function layout(s: Snapshot, width = WIDTH, links: { bench?: boolean } = {}): Grid {
	const grid = new Grid(width);
	const half = Math.floor(width / 2);
	let y = 0;

	grid.put(1, y, `SCOUT · ${s.host} · ${s.model}`, "head");
	const up = `up ${duration(s.now - s.startedAt)} · ${clock(s.now)}`;
	grid.putRight(width - 1, y, up, "dim");
	if (s.draining !== undefined) grid.putRight(width - 1 - up.length, y, `draining for a restart, ${duration(s.now - s.draining)} · `, "warn");
	y += 2;

	// Standing, under the top line, for as long as it's true: a box that goes takes every thread with it.
	if (s.backup !== undefined && s.backup.status !== "ok") {
		const missing = s.backup.status === "missing";
		const text = missing ? `! not backed up off this machine: ${s.backup.problems.join("; ")}` : describeBackup(s.backup);
		drawLine(grid, 1, y, width - 2, { left: [{ text, style: missing ? "bad" : "dim" }], ...(missing ? { right: [{ text: "docs/operations.md#backups", style: "dim" }] } : {}) });
		y += 2;
	}

	if (s.alerts.length > 0) {
		y = panel(grid, 0, y, width, "needs a person", s.alerts.map((a) => ({ left: [{ text: `! ${a.message}`, style: "bad" }], right: [{ text: `for ${age(s.now - a.since)}`, style: "dim" }] })));
	}

	y = sideBySide(grid, y, width, half, ["now", nowLines(s)], ["pull requests", pullLines(s)]);
	if (s.capacity !== undefined || s.models !== undefined) y = panel(grid, 0, y, width, "capacity", [...modelLines(s), ...(s.capacity === undefined ? [] : capacityLines(s.capacity, s.now))]);
	y = panel(grid, 0, y, width, "threads", threadLines(s));
	y = sideBySide(grid, y, width, half, ["learning", learningLines(s)], ["spend", spendLines(s)]);
	if (s.learning.notes.length > 0) y = panel(grid, 0, y, width, "unreviewed notes", noteLines(s));
	if (s.reviews.latest.length > 0) y = panel(grid, 0, y, width, "pull request reviews", reviewLines(s));
	if (s.schedules.length > 0) y = panel(grid, 0, y, width, "schedules", scheduleLines(s));

	const x = 1 + grid.put(1, y, "scout · read-only", "dim");
	if (links.bench === true) grid.link(x + grid.put(x, y, " · ", "dim"), y, "benchmark", "/bench", "dim");
	grid.putRight(width - 1, y, `updated ${clock(s.now)}`, "dim");
	return grid;
}

function nowLines(s: Snapshot): Line[] {
	const lines: Line[] = [{ spark: { label: "working", values: s.history.working, after: [{ text: ` ${s.working.length}`, style: s.working.length > 0 ? "ok" : "dim" }] } }];
	if (s.working.length === 0) lines.push({ left: [{ text: "· idle", style: "dim" }] });
	for (const w of s.working.slice(0, 6)) {
		lines.push({
			left: [
				{ text: "▶ ", style: "ok" },
				{ text: `#${w.channel} `, style: "id" },
				{ text: `${w.steps} step${w.steps === 1 ? "" : "s"} `, style: "dim" },
				{ text: w.lastStep ?? "thinking", style: "text" },
			],
			right: [{ text: ` ${duration(s.now - w.startedAt)}`, style: "dim" }],
		});
	}
	if (s.working.length > 6) lines.push({ left: [{ text: `+${s.working.length - 6} more`, style: "dim" }] });
	lines.push("rule", { left: [{ text: "threads in the last day  ", style: "dim" }, { text: String(s.threadsToday) }] });
	return lines;
}

function pullLines(s: Snapshot): Line[] {
	const rate = (r: { merged: number; closed: number }) => (r.merged + r.closed === 0 ? undefined : r.merged / (r.merged + r.closed));
	const week = rate(s.pulls.week);
	const lastWeek = rate(s.pulls.lastWeek);
	const meterLine = (label: string, r: { merged: number; closed: number }, f: number | undefined): Line =>
		f === undefined
			? { left: [{ text: label.padEnd(12), style: "dim" }, { text: "nothing decided", style: "dim" }] }
			: { meter: { label, fraction: f, after: [{ text: ` ${Math.round(f * 100)}%`, style: "text" }, { text: ` ${r.merged}/${r.merged + r.closed}`, style: "dim" }] } };
	const lines: Line[] = [
		meterLine("merged 7d", s.pulls.week, week),
		meterLine("week before", s.pulls.lastWeek, lastWeek),
		{ left: [{ text: "open now    ", style: "dim" }, { text: String(s.pulls.openNow) }] },
		"rule",
	];
	if (s.pulls.latest.length === 0) lines.push({ left: [{ text: "· none yet", style: "dim" }] });
	for (const p of s.pulls.latest.slice(0, 6)) {
		const [glyph, style] = p.state === "merged" ? ["✓", "ok"] : p.state === "closed" ? ["✗", "bad"] : ["●", "state"];
		lines.push({
			left: [
				{ text: `${glyph} `, style: style as Style },
				{ text: `${p.kind === "profile" ? "profile" : (p.slug.split("/").pop() ?? p.slug)} `, style: "id" },
				{ text: p.title },
			],
			right: [{ text: ` ${age(s.now - p.openedAt)}`, style: "dim" }],
		});
	}
	return lines;
}

function threadLines(s: Snapshot): Line[] {
	if (s.threads.length === 0) return [{ left: [{ text: "· nobody has mentioned Scout yet", style: "dim" }] }];
	return s.threads.slice(0, 10).map((t) => ({
		left: [
			{ text: t.working ? "▶ " : "· ", style: t.working ? "ok" : "dim" },
			{ text: `#${t.channel}`.padEnd(28), style: "id" },
			{ text: `${t.runs} run${t.runs === 1 ? "" : "s"}`.padEnd(9), style: "text" },
			{ text: t.pulls === 0 ? "" : `${t.pulls} pull request${t.pulls === 1 ? "" : "s"}`, style: "state" },
		],
		right: [{ text: age(s.now - t.lastActivity), style: "dim" }],
	}));
}

function learningLines(s: Snapshot): Line[] {
	const l = s.learning;
	if (!l.profileRepo) {
		return [
			{ left: [{ text: "nightly reflection is off", style: "warn" }] },
			{ left: [{ text: "set SCOUT_PROFILE_REPO_URL to turn it on", style: "dim" }] },
			"rule",
			{ left: [{ text: "notes        ", style: "dim" }, { text: `${l.notes.length} unreviewed` }] },
		];
	}
	const lines: Line[] = [];
	if (l.last === undefined) lines.push({ left: [{ text: "no reflection yet", style: "dim" }] });
	else {
		lines.push({ left: [{ text: "last         ", style: "dim" }, { text: `${l.last.day} · ${l.last.threads} thread${l.last.threads === 1 ? "" : "s"}` }] });
		const p = l.last.proposal;
		lines.push(
			p === undefined
				? { left: [{ text: "proposal     ", style: "dim" }, { text: "none: nothing worth changing", style: "dim" }] }
				: { left: [{ text: "proposal     ", style: "dim" }, { text: p.state === "merged" ? "✓ " : p.state === "closed" ? "✗ " : "● ", style: p.state === "merged" ? "ok" : p.state === "closed" ? "bad" : "state" }, { text: p.title }] },
		);
	}
	lines.push({ left: [{ text: "next         ", style: "dim" }, { text: `after ${String(l.reflectHour).padStart(2, "0")}:00` }] });
	const decided = l.proposals.merged + l.proposals.closed;
	lines.push("rule", { left: [{ text: "merged 30d   ", style: "dim" }, { text: decided === 0 ? "nothing decided" : `${l.proposals.merged} of ${decided} proposals` }] });
	lines.push({ left: [{ text: "notes        ", style: "dim" }, { text: `${l.notes.length} unreviewed`, style: l.notes.length > 20 ? "warn" : "text" }] });
	return lines;
}

function spendLines(s: Snapshot): Line[] {
	const lines: Line[] = [
		{ left: [{ text: "since start  ", style: "dim" }, { text: dollars(s.spend.total) }] },
		{ spark: { label: "$ per hour", values: s.history.spendPerHour, after: [{ text: ` ${dollars(s.history.spendPerHour.at(-1) ?? 0)}`, style: "dim" }] } },
		"rule",
	];
	if (s.spend.byModel.length === 0) lines.push({ left: [{ text: "· no model calls yet", style: "dim" }] });
	for (const m of s.spend.byModel.slice(0, 5)) lines.push({ left: [{ text: m.model, style: "id" }], right: [{ text: dollars(m.cost) }] });
	const week = s.spend.week ?? [];
	if (week.length > 0) {
		lines.push("rule", { left: [{ text: "this week, by channel", style: "dim" }] });
		for (const c of week.slice(0, 5)) {
			const over = c.budget !== undefined && c.cost >= c.budget;
			const near = c.budget !== undefined && c.cost >= c.budget * 0.8;
			lines.push({
				left: [{ text: `#${c.channel || "jobs and reviews"}`, style: "id" }],
				right: [{ text: c.budget === undefined ? dollars(c.cost) : `${dollars(c.cost)} of ${dollars(c.budget)}`, style: over ? "bad" : near ? "warn" : "text" }],
			});
		}
	}
	return lines;
}

function noteLines(s: Snapshot): Line[] {
	const lines: Line[] = s.learning.notes.slice(-10).map((n) => ({
		left: [
			{ text: `[${n.id}] `, style: "id" },
			{ text: n.channelName === "" ? "(jobs) " : `#${n.channelName} `, style: "state" },
			{ text: n.note },
		],
		right: [{ text: ` ${age(s.now - n.createdAt)}`, style: "dim" }],
	}));
	if (s.learning.notes.length > 10) lines.unshift({ left: [{ text: `${s.learning.notes.length - 10} older not shown`, style: "dim" }] });
	return lines;
}

function scheduleLines(s: Snapshot): Line[] {
	return s.schedules.map((sc) => ({
		left: [
			{ text: `#${sc.id} `, style: "id" },
			{ text: `#${sc.channel} `, style: "state" },
			{ text: `${sc.when}: ${sc.task}` },
		],
		right: [{ text: sc.paused ? " paused" : sc.next === undefined ? " never" : ` next in ${age(sc.next - s.now)}`, style: sc.paused ? "warn" : "dim" }],
	}));
}

function reviewLines(s: Snapshot): Line[] {
	const latest = s.reviews.latest;
	if (latest.length === 0) return [{ left: [{ text: "· no labelled pull requests yet", style: "dim" }] }];
	return latest.map((r) => ({
		left: [
			{ text: r.posted ? "✓ " : "▶ ", style: r.posted ? "ok" : "state" },
			{ text: `${r.slug}#${r.number} `, style: "id" },
			{ text: r.sha.slice(0, 7), style: "dim" },
		],
		right: [{ text: r.posted ? "commented" : "reviewing", style: r.posted ? "dim" : "state" }],
	}));
}

/** Draw a framed panel at (x, y) and return the row after it. */
function panel(grid: Grid, x: number, y: number, w: number, title: string, lines: Line[], height = lines.length + 2): number {
	grid.box(x, y, w, height, title);
	lines.forEach((line, i) => drawLine(grid, x + 2, y + 1 + i, w - 4, line));
	return y + height;
}

function sideBySide(grid: Grid, y: number, width: number, half: number, left: [string, Line[]], right: [string, Line[]]): number {
	const height = Math.max(left[1].length, right[1].length) + 2;
	panel(grid, 0, y, half, left[0], left[1], height);
	panel(grid, half, y, width - half, right[0], right[1], height);
	return y + height;
}

function drawLine(grid: Grid, x: number, y: number, w: number, line: Line): void {
	if (line === "rule") return grid.rule(x, y, w);
	if ("meter" in line) {
		const label = line.meter.label.padEnd(12);
		grid.put(x, y, label, "dim");
		const meterWidth = Math.min(16, w - label.length - 12);
		grid.meter(x + label.length, y, meterWidth, line.meter.fraction, { warn: 0.6, bad: 0.4, lowIsBad: true });
		segments(grid, x + label.length + meterWidth, y, w - label.length - meterWidth, line.meter.after);
		return;
	}
	if ("spark" in line) {
		const label = line.spark.label.padEnd(12);
		grid.put(x, y, label, "dim");
		const sparkWidth = Math.min(30, w - label.length - 12);
		grid.spark(x + label.length, y, sparkWidth, line.spark.values);
		segments(grid, x + label.length + sparkWidth, y, w - label.length - sparkWidth, line.spark.after);
		return;
	}
	const rightText = (line.right ?? []).map((seg) => seg.text).join("");
	const leftWidth = w - (rightText.length === 0 ? 0 : [...rightText].length + 1);
	segments(grid, x, y, leftWidth, line.left);
	if (line.right !== undefined) segments(grid, x + w - [...rightText].length, y, [...rightText].length, line.right);
}

function segments(grid: Grid, x: number, y: number, w: number, segs: Seg[]): void {
	let used = 0;
	for (const seg of segs) {
		if (used >= w) return;
		used += grid.put(x + used, y, seg.text, seg.style ?? "text", w - used);
	}
}

export function duration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function age(ms: number): string {
	const minutes = Math.max(0, Math.floor(ms / 60_000));
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function clock(ms: number): string {
	const d = new Date(ms);
	return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

function dollars(amount: number): string {
	return `$${amount.toFixed(2)}`;
}

/** Which model is answering: the default and what it falls back to, and a line for each model failing now. */
function modelLines(s: Snapshot): Line[] {
	const m = s.models;
	if (m === undefined) return [];
	const down = new Set(m.outages.map((o) => o.model));
	const lines: Line[] = [
		{
			left: [
				{ text: "model        ", style: "dim" },
				{ text: down.has(m.primary) ? `${short(m.primary)} failing` : short(m.primary), style: down.has(m.primary) ? "warn" : "text" },
				{ text: m.fallbacks.length === 0 ? "" : `  · falls back to ${m.fallbacks.map(short).join(", ")}`, style: "dim" },
			],
		},
	];
	for (const o of m.outages) {
		const left = o.retryAt - s.now;
		lines.push({
			left:
				o.fallback === undefined
					? [
							{ text: "failing      ", style: "dim" },
							{ text: `${short(o.model)} since ${clock(o.since).slice(0, 5)}, and nothing to fall back to`, style: "bad" },
						]
					: [
							{ text: "fallback     ", style: "dim" },
							{ text: `${short(o.fallback)} since ${clock(o.since).slice(0, 5)}`, style: "warn" },
							{ text: ` (${short(o.model)} failing${o.error === undefined ? "" : `: ${o.error}`})`, style: "dim" },
						],
			right: [{ text: left < 60_000 ? "retrying now" : `retry in ${age(left)}`, style: "dim" }],
		});
	}
	return lines;
}

function capacityLines(c: NonNullable<Snapshot["capacity"]>, _now: number): Line[] {
	const used = (n: number, max: number) => (max <= 0 ? `${n}` : `${n} of ${max}`);
	const waitWords = { run: "requests waiting their turn", model: "model calls waiting for a slot", sandbox: "sandboxes waiting for room" } as Record<string, string>;
	const lines: Line[] = [
		{
			left: [
				{ text: "runs         ", style: "dim" },
				{ text: used(c.active, c.maxRuns), style: c.active >= c.maxRuns ? "warn" : "text" },
				{ text: c.queued > 0 ? `  · ${c.queued} waiting their turn` : "", style: "warn" },
			],
		},
		{
			left: [
				{ text: "model calls  ", style: "dim" },
				{ text: used(c.modelInFlight, c.modelMax), style: c.modelMax > 0 && c.modelInFlight >= c.modelMax ? "warn" : "text" },
				{ text: c.modelWaiting > 0 ? `  · ${c.modelWaiting} waiting` : "", style: "warn" },
			],
		},
		{
			left: [
				{ text: "sandboxes    ", style: "dim" },
				{ text: `${c.sandboxes} open` },
				{ text: c.sandboxWaiting > 0 ? `  · ${c.sandboxWaiting} waiting for room` : "", style: "warn" },
			],
		},
		{
			left: [
				{ text: "event loop   ", style: "dim" },
				{ text: `${c.loopLag.mean.toFixed(1)} ms mean, ${c.loopLag.p99.toFixed(1)} ms p99`, style: c.loopLag.p99 > 200 ? "warn" : "text" },
				{ text: c.progressWaiting > 0 ? `  · ${c.progressWaiting} progress edits paced` : "", style: "dim" },
			],
		},
	];
	for (const w of c.waits) {
		if (w.count === 0) continue;
		lines.push({ left: [{ text: "last day     ", style: "dim" }, { text: `${w.count} ${waitWords[w.kind] ?? w.kind}: half over ${Math.round(w.p50 / 1000)}s, slowest tenth over ${Math.round(w.p90 / 1000)}s` }] });
	}
	const start = c.firstToken;
	if (start !== undefined && start.count > 0) {
		lines.push({
			left: [
				{ text: "model start  ", style: "dim" },
				{ text: `${start.count} calls: half started answering within ${Math.round(start.p50 / 1000)}s, slowest tenth over ${Math.round(start.p90 / 1000)}s`, style: start.p90 >= 30_000 ? "warn" : "text" },
			],
		});
	}
	return lines;
}
