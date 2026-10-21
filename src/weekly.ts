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
