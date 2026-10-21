import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MemoryNote } from "./memory.ts";
import type { PullRow } from "./pulls.ts";
import type { ThreadRow } from "./threads.ts";

/**
 * Each channel's week with Scout, posted in the channel on Monday: what it did there, what's still open, and what it
 * learned (the notes it kept, which people can still correct). From what Scout already records; no model call. A
 * channel with nothing to report gets nothing.
 */
export type WeekSources = {
	/** Threads started in the week, and Scout's work pull requests opened or decided in it. */
	threads: ThreadRow[];
	pulls: PullRow[];
	/** Scout's work pull requests still open now, whenever they were opened. */
	stillOpen: PullRow[];
	/** Notes Scout kept in the week, still in force. */
	notes: MemoryNote[];
	/** Threads that had a follow-up and still wait on people (recaps.ts), with a link to each and since when. */
	waiting?: { conversationId: number; link?: string; since: number }[];
	/** The channel (by name) a conversation is in. */
	channelOf: (conversationId: number) => Promise<string>;
	/** What models cost in a channel in the week, and its weekly budget if it has one. */
	spend: (channel: string) => { cost: number; budget?: number };
	/** Channels with a Scout canvas: their summary keeps to the week's numbers and points there for the rest. */
	canvased?: ReadonlySet<string>;
};

export async function channelWeeks(s: WeekSources, now: number): Promise<Map<string, string>> {
	type Waiting = { link?: string; since: number };
	type Week = { threads: number; opened: PullRow[]; merged: PullRow[]; closed: PullRow[]; open: PullRow[]; notes: MemoryNote[]; waiting: Waiting[] };
	const weeks = new Map<string, Week>();
	const week = (channel: string) => {
		let w = weeks.get(channel);
		if (w === undefined) {
			w = { threads: 0, opened: [], merged: [], closed: [], open: [], notes: [], waiting: [] };
			weeks.set(channel, w);
		}
		return w;
	};
	for (const t of s.threads) week(await s.channelOf(t.conversationId)).threads++;
	for (const p of s.pulls) {
		const w = week(await s.channelOf(p.conversationId));
		if (p.state === "merged") w.merged.push(p);
		else if (p.state === "closed") w.closed.push(p);
		else w.opened.push(p);
	}
	for (const p of s.stillOpen) week(await s.channelOf(p.conversationId)).open.push(p);
	for (const n of s.notes) week(n.channelName).notes.push(n);
	for (const t of s.waiting ?? []) week(await s.channelOf(t.conversationId)).waiting.push(t);

	const summaries = new Map<string, string>();
	for (const [channel, w] of weeks) {
		if (channel === "" || (w.threads === 0 && w.opened.length + w.merged.length + w.closed.length + w.notes.length + w.waiting.length === 0)) continue;
		const counts = [
			`${w.threads} thread${w.threads === 1 ? "" : "s"}`,
			...(w.merged.length > 0 ? [`${w.merged.length} pull request${w.merged.length === 1 ? "" : "s"} merged`] : []),
			...(w.closed.length > 0 ? [`${w.closed.length} closed without merging`] : []),
			...(w.opened.length > 0 ? [`${w.opened.length} opened and still in review`] : []),
		];
		const { cost, budget } = s.spend(channel);
		const lines = [`*Last week here:* ${counts.join(", ")}. Models cost $${cost.toFixed(2)}${budget === undefined ? "" : ` of $${budget}`}.`];
		if (s.canvased?.has(channel) === true) {
			// The canvas keeps what's open, who's waiting and what Scout noted, always current: no need to repeat it here.
			lines.push("What's still open, who's waiting on whom, and what I noted are in this channel's canvas, kept up to date.");
			summaries.set(channel, lines.join("\n"));
			continue;
		}
		if (w.open.length > 0) {
			lines.push(
				"*Still open:*",
				...w.open.map((p) => `• <${p.url}|${p.slug}#${p.number}> ${p.title} (opened ${days(now - p.openedAt)})`),
			);
		}
		if (w.waiting.length > 0) {
			// Each has had its own recap in its thread; here they're only listed.
			const quiet = (since: number) => {
				const d = Math.max(1, Math.floor((now - since) / (24 * 60 * 60 * 1000)));
				return `quiet for ${d} day${d === 1 ? "" : "s"}`;
			};
			lines.push("*Waiting on someone:*", ...w.waiting.map((t) => `• ${t.link === undefined ? "a thread" : `<${t.link}|a thread>`} (${quiet(t.since)})`));
		}
		if (w.notes.length > 0) {
			lines.push("*What I noted:*", ...w.notes.map((n) => `• [${n.id}] ${n.note}`), "If any of these are wrong, tell me to forget them.");
		}
		summaries.set(channel, lines.join("\n"));
	}
	return summaries;
}

function days(ms: number): string {
	const d = Math.floor(ms / (24 * 60 * 60 * 1000));
	return d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
}

/** Which channels have had which week's summary, so a restart never posts one twice. */
export class WeeklySummaries {
	readonly #db: DatabaseSync;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.#db = new DatabaseSync(path, { timeout: 5000 });
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS weekly_summaries (week TEXT NOT NULL, channel TEXT NOT NULL, sent_at INTEGER NOT NULL, PRIMARY KEY (week, channel));
		`);
	}

	/** Record that `channel` gets `week`'s summary; false if it already has. */
	claim(week: string, channel: string, now = Date.now()): boolean {
		return this.#db.prepare("INSERT OR IGNORE INTO weekly_summaries (week, channel, sent_at) VALUES (?, ?, ?)").run(week, channel, now).changes > 0;
	}

	close(): void {
		this.#db.close();
	}
}

/** What a channel's Scout canvas shows, always current. */
export type CanvasData = {
	channel: string;
	open: PullRow[];
	waiting: { link?: string; since: number }[];
	schedules: { id: number; when: string; task: string; createdBy: string; paused: boolean }[];
	notes: MemoryNote[];
	/** The list of Scout's work, if there is one. */
	listUrl?: string;
	now: number;
};

/** The canvas, in the Markdown Slack canvases take: `![](@U123)` mentions a person. */
export function channelCanvas(d: CanvasData): string {
	const when = new Date(d.now).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
	const section = (title: string, lines: string[], empty: string) => [`## ${title}`, ...(lines.length === 0 ? [empty] : lines)];
	const dayCount = (since: number) => {
		const n = Math.max(0, Math.floor((d.now - since) / (24 * 60 * 60 * 1000)));
		return n === 0 ? "today" : `${n} day${n === 1 ? "" : "s"}`;
	};
	return [
		`# Scout in #${d.channel}`,
		`_Updated ${when}. I keep this up to date; ask me in the channel to change anything here._`,
		...section("Open pull requests", d.open.map((p) => `- [${p.slug}#${p.number} ${p.title}](${p.url}), open ${dayCount(p.openedAt)}`), "None right now."),
		...section("Waiting on someone", d.waiting.map((t) => `- ${t.link === undefined ? "A thread" : `[A thread](${t.link})`}, quiet for ${dayCount(t.since)}`), "Nothing's waiting."),
		...section(
			"Schedules",
			d.schedules.map((s) => `- #${s.id}: ${s.when}, ${s.task}${s.paused ? " (paused)" : ""}. Set up by ![](@${s.createdBy}).`),
			"None. Ask me for recurring work (\"every Monday at 9, …\") and it shows up here.",
		),
		...section("Notes I kept", d.notes.map((n) => `- [${n.id}] ${n.note}`), "None yet."),
		...(d.notes.length === 0 ? [] : ["_If one of these is wrong, tell me to forget it._"]),
		...(d.listUrl === undefined ? [] : ["", `All of Scout's work, sortable and filterable: [Scout's work](${d.listUrl})`]),
	].join("\n");
}

/** Which channel has which canvas, and when it was last refreshed. */
export class ChannelCanvases {
	readonly #db: DatabaseSync;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.#db = new DatabaseSync(path, { timeout: 5000 });
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS channel_canvases (channel TEXT PRIMARY KEY, canvas_id TEXT NOT NULL, updated_at INTEGER NOT NULL);
		`);
	}

	get(channel: string): { canvasId: string; updatedAt: number } | undefined {
		const row = this.#db.prepare("SELECT canvas_id, updated_at FROM channel_canvases WHERE channel = ?").get(channel) as { canvas_id: string; updated_at: number } | undefined;
		return row === undefined ? undefined : { canvasId: row.canvas_id, updatedAt: row.updated_at };
	}

	saved(channel: string, canvasId: string, now = Date.now()): void {
		this.#db.prepare("INSERT OR REPLACE INTO channel_canvases (channel, canvas_id, updated_at) VALUES (?, ?, ?)").run(channel, canvasId, now);
	}

	/** Channels (by name) that have one. */
	channels(): Set<string> {
		return new Set(this.#db.prepare("SELECT channel FROM channel_canvases").all().map((r) => String(r.channel)));
	}

	close(): void {
		this.#db.close();
	}
}
