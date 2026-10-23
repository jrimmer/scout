import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Audit } from "./audit.ts";
import { ThreadDoc } from "./docs.ts";

/**
 * Recurring work ("every Monday at 9, check for dependency updates"), public like everything else Scout does: a
 * schedule belongs to a channel, anyone who may ask for work there can see, change, pause or remove it, and each run
 * is a new thread in that channel saying which schedule started it. Times are cron (minute, hour, day of month, month,
 * day of week) in the host's local time, the same clock as the nightly reflection.
 */
export type Schedule = {
	id: number;
	channel: string;
	cron: string;
	/** The time in words, as Scout read it back ("every Monday at 9:00"). */
	when: string;
	task: string;
	/**
	 * Who set it up (a Slack user ID), and who last changed it. Its runs are its owner's requests: whoever last changed
	 * it, or else set it up. "scout" (nobody had asked in the thread) owns nothing, so such a schedule pauses (service.ts).
	 */
	createdBy: string;
	changedBy?: string;
	paused: boolean;
	lastRun?: number;
};

/** How long after its time a schedule still runs, if Scout was down at the minute it was due. */
const CATCH_UP_MS = 10 * 60 * 1000;
const MINUTE = 60 * 1000;

export class Schedules {
	readonly #db: DatabaseSync;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.#db = new DatabaseSync(path, { timeout: 5000 });
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS schedules (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				channel TEXT NOT NULL,
				cron TEXT NOT NULL,
				"when" TEXT NOT NULL,
				task TEXT NOT NULL,
				created_by TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				changed_by TEXT,
				paused INTEGER NOT NULL DEFAULT 0,
				last_run INTEGER,
				removed_at INTEGER
			);
		`);
	}

	add(s: { channel: string; cron: string; when: string; task: string; by: string }, now = Date.now()): Schedule {
		parseCron(s.cron);
		const { lastInsertRowid } = this.#db
			.prepare(`INSERT INTO schedules (channel, cron, "when", task, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
			.run(s.channel, s.cron.trim(), s.when, s.task, s.by, now);
		return this.get(Number(lastInsertRowid))!;
	}

	get(id: number): Schedule | undefined {
		const row = this.#db.prepare("SELECT * FROM schedules WHERE id = ? AND removed_at IS NULL").get(id);
		return row === undefined ? undefined : toSchedule(row);
	}

	forChannel(channel: string): Schedule[] {
		return this.#db.prepare("SELECT * FROM schedules WHERE channel = ? AND removed_at IS NULL ORDER BY id").all(channel).map(toSchedule);
	}

	all(): Schedule[] {
		return this.#db.prepare("SELECT * FROM schedules WHERE removed_at IS NULL ORDER BY channel, id").all().map(toSchedule);
	}

	change(id: number, change: { cron?: string; when?: string; task?: string; paused?: boolean }, by: string): Schedule | undefined {
		if (change.cron !== undefined) parseCron(change.cron);
		const current = this.get(id);
		if (current === undefined) return undefined;
		this.#db
			.prepare(`UPDATE schedules SET cron = ?, "when" = ?, task = ?, paused = ?, changed_by = ? WHERE id = ?`)
			.run(change.cron?.trim() ?? current.cron, change.when ?? current.when, change.task ?? current.task, (change.paused ?? current.paused) ? 1 : 0, by, id);
		return this.get(id);
	}

	/** Paused by Scout itself (its owner may no longer ask for it): who owns it doesn't change until someone resumes it. */
	pause(id: number): void {
		this.#db.prepare("UPDATE schedules SET paused = 1 WHERE id = ?").run(id);
	}

	remove(id: number, by: string, now = Date.now()): boolean {
		return this.#db.prepare("UPDATE schedules SET removed_at = ?, changed_by = ? WHERE id = ? AND removed_at IS NULL").run(now, by, id).changes > 0;
	}

	/** Schedules whose time came in the last few minutes and that haven't run for it yet. */
	due(now = Date.now()): Schedule[] {
		return this.all().filter((s) => {
			if (s.paused) return false;
			const at = lastTime(parseCron(s.cron), now, CATCH_UP_MS);
			return at !== undefined && (s.lastRun === undefined || s.lastRun < at);
		});
	}

	ran(id: number, now = Date.now()): void {
		this.#db.prepare("UPDATE schedules SET last_run = ? WHERE id = ?").run(now, id);
	}

	close(): void {
		this.#db.close();
	}
}

function toSchedule(row: Record<string, unknown>): Schedule {
	return {
		id: Number(row.id),
		channel: String(row.channel),
		cron: String(row.cron),
		when: String(row.when),
		task: String(row.task),
		createdBy: String(row.created_by),
		...(row.changed_by === null ? {} : { changedBy: String(row.changed_by) }),
		paused: row.paused === 1,
		...(row.last_run === null ? {} : { lastRun: Number(row.last_run) }),
	};
}

type Cron = { minute: Set<number>; hour: Set<number>; day: Set<number>; month: Set<number>; weekday: Set<number>; anyDay: boolean; anyWeekday: boolean };

const FIELDS = [
	{ name: "minute", min: 0, max: 59 },
	{ name: "hour", min: 0, max: 23 },
	{ name: "day of month", min: 1, max: 31 },
	{ name: "month", min: 1, max: 12 },
	{ name: "day of week", min: 0, max: 7 },
] as const;

/** Five fields of numbers, `*`, ranges `a-b`, lists `a,b` and steps `*\/n` or `a-b/n`; Sunday is 0 or 7. */
export function parseCron(expr: string): Cron {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) throw new Error(`"${expr}" isn't a schedule: it needs five fields (minute hour day-of-month month day-of-week).`);
	const sets = parts.map((part, i) => {
		const { name, min, max } = FIELDS[i]!;
		const values = new Set<number>();
		for (const item of part.split(",")) {
			const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
			if (m === null) throw new Error(`"${item}" isn't a valid ${name}.`);
			const from = m[1] === "*" ? min : Number(m[2]);
			const to = m[1] === "*" ? max : m[3] === undefined ? (m[4] === undefined ? from : max) : Number(m[3]);
			const step = m[4] === undefined ? 1 : Number(m[4]);
			if (from < min || to > max || from > to || step < 1) throw new Error(`"${item}" is out of range for ${name} (${min}-${max}).`);
			for (let v = from; v <= to; v += step) values.add(name === "day of week" && v === 7 ? 0 : v);
		}
		return values;
	});
	return { minute: sets[0]!, hour: sets[1]!, day: sets[2]!, month: sets[3]!, weekday: sets[4]!, anyDay: parts[2] === "*", anyWeekday: parts[4] === "*" };
}

function matches(cron: Cron, date: Date): boolean {
	if (!cron.minute.has(date.getMinutes()) || !cron.hour.has(date.getHours()) || !cron.month.has(date.getMonth() + 1)) return false;
	const day = cron.day.has(date.getDate());
	const weekday = cron.weekday.has(date.getDay());
	// As cron has it: with both restricted, either one will do.
	if (cron.anyDay || cron.anyWeekday) return day && weekday;
	return day || weekday;
}

/** The latest time at or before `now`, within `window`, that the schedule names. */
function lastTime(cron: Cron, now: number, window: number): number | undefined {
	const start = Math.floor(now / MINUTE) * MINUTE;
	for (let t = start; t > now - window; t -= MINUTE) if (matches(cron, new Date(t))) return t;
	return undefined;
}

/** The next time after `now` that the schedule names, within a year. */
export function nextTime(expr: string, now = Date.now()): number | undefined {
	const cron = parseCron(expr);
	const start = Math.floor(now / MINUTE) * MINUTE + MINUTE;
	for (let t = start; t < now + 366 * 24 * 60 * MINUTE; t += MINUTE) {
		const date = new Date(t);
		// Skip whole hours and days that can't match, so a yearly schedule doesn't take half a million steps.
		if (!cron.month.has(date.getMonth() + 1) || !cron.hour.has(date.getHours())) {
			t += (59 - date.getMinutes()) * MINUTE;
			continue;
		}
		if (matches(cron, date)) return t;
	}
	return undefined;
}

/**
 * The tools a thread uses to manage its channel's schedules. `askerOf` says who asked for the change (the latest
 * request in the thread), so the audit trail and the schedule record people, not Scout.
 */
export function schedulesExtension(schedules: Schedules, askerOf: (conversationId: number) => string, audit?: Audit) {
	const channelOf = async (api: { snapshot: (doc: typeof ThreadDoc, id: ConversationId, context: never) => Promise<{ channelName: string } | undefined> }, id: ConversationId, context: unknown) =>
		(await api.snapshot(ThreadDoc, id, context as never))?.channelName ?? "";
	const describe = (s: Schedule) => {
		const next = s.paused ? undefined : nextTime(s.cron);
		return `#${s.id}: ${s.when} (\`${s.cron}\`): ${s.task.replace(/[.\s]+$/, "")}. Set up by <@${s.createdBy}>${s.changedBy === undefined ? "" : `, last changed by <@${s.changedBy}>`}. ${s.paused ? "Paused." : `Next: ${next === undefined ? "never" : new Date(next).toString()}.`}`;
	};

	const schedule = defineTool({
		name: "schedule",
		description:
			"Set up recurring work in this channel, when someone asks for it ('every Monday at 9, check for dependency " +
			"updates'). Each run starts a new thread here with the task as its request. Schedules are public: anyone in the " +
			"channel can list, change or remove them. Say back when it will run, in words, so people can check you read it right.",
		parameters: Type.Object({
			cron: Type.String({ description: "Five-field cron in the host's local time: minute hour day-of-month month day-of-week, e.g. '0 9 * * 1'" }),
			when: Type.String({ description: "The same time in words, e.g. 'every Monday at 9:00'" }),
			task: Type.String({ description: "What to do each time, written as a request to yourself, complete enough to act on alone" }),
		}),
		execute: async (args, api, context) => {
			const channel = await channelOf(api as never, api.conversationId, context);
			if (channel === "") throw new Error("Schedules belong to a channel; this conversation isn't in one.");
			const by = askerOf(api.conversationId);
			const added = schedules.add({ channel, cron: args.cron, when: args.when, task: args.task, by });
			audit?.record("schedule_added", { actor: by, conversationId: api.conversationId, channel, detail: { id: added.id, cron: added.cron, task: added.task } });
			return { output: [{ type: "text", text: `Scheduled ${describe(added)}` }] };
		},
	});

	const list = defineTool({
		name: "schedules",
		description: "List this channel's schedules: when each runs, what it does, who set it up, and when it runs next.",
		parameters: Type.Object({}),
		execute: async (_args, api, context) => {
			const here = schedules.forChannel(await channelOf(api as never, api.conversationId, context));
			return { output: [{ type: "text", text: here.length === 0 ? "No schedules in this channel." : here.map(describe).join("\n") }] };
		},
	});

	const change = defineTool({
		name: "change_schedule",
		description: "Change, pause or resume one of this channel's schedules, when someone asks. Leave out what stays the same.",
		parameters: Type.Object({
			id: Type.Number(),
			cron: Type.Optional(Type.String()),
			when: Type.Optional(Type.String({ description: "The new time in words; required with cron" })),
			task: Type.Optional(Type.String()),
			paused: Type.Optional(Type.Boolean()),
		}),
		execute: async (args, api, context) => {
			const channel = await channelOf(api as never, api.conversationId, context);
			const current = schedules.get(args.id);
			if (current === undefined || current.channel !== channel) throw new Error(`There's no schedule #${args.id} in this channel.`);
			if (args.cron !== undefined && args.when === undefined) throw new Error("Say the new time in words too (when).");
			const by = askerOf(api.conversationId);
			const changed = schedules.change(args.id, { ...(args.cron === undefined ? {} : { cron: args.cron }), ...(args.when === undefined ? {} : { when: args.when }), ...(args.task === undefined ? {} : { task: args.task }), ...(args.paused === undefined ? {} : { paused: args.paused }) }, by)!;
			audit?.record("schedule_changed", { actor: by, conversationId: api.conversationId, channel, detail: { id: args.id, cron: changed.cron, task: changed.task, paused: changed.paused } });
			return { output: [{ type: "text", text: `Changed ${describe(changed)}` }] };
		},
	});

	const remove = defineTool({
		name: "unschedule",
		description: "Remove one of this channel's schedules, when someone asks.",
		parameters: Type.Object({ id: Type.Number() }),
		execute: async (args, api, context) => {
			const channel = await channelOf(api as never, api.conversationId, context);
			const current = schedules.get(args.id);
			if (current === undefined || current.channel !== channel) throw new Error(`There's no schedule #${args.id} in this channel.`);
			const by = askerOf(api.conversationId);
			schedules.remove(args.id, by);
			audit?.record("schedule_removed", { actor: by, conversationId: api.conversationId, channel, detail: { id: args.id, task: current.task } });
			return { output: [{ type: "text", text: `Removed schedule #${args.id} (${current.when}: ${current.task}).` }] };
		},
	});

	return defineExtension({ name: "schedules", tools: [schedule, list, change, remove] });
}
