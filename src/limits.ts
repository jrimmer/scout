import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Observer, ToolCallEvent, Where } from "./observe.ts";
import type { Pricing } from "./pricing.ts";

/**
 * Budgets and limits, simply. One local file, owned by whoever runs Scout (not the profile, which Scout itself
 * proposes changes to):
 *
 *     {
 *       "weekly": { "total": 500, "perChannel": 50, "channels": { "data-team": 200 } },
 *       "perRun": { "maxToolCalls": 150, "maxCost": 10 },
 *       "concurrency": { "total": 8, "perChannel": 2 }
 *     }
 *
 * Weekly budgets are dollars per calendar week (from Monday), from the spend ledger. A new request in a channel over
 * its budget is declined; over a concurrency limit, it waits its turn. Per-run limits stop a single request that
 * runs away, with a message that tells Scout to summarize and ask before going on.
 */
export type LimitsConfig = {
	weekly?: { total?: number; perChannel?: number; channels?: Record<string, number> };
	perRun?: { maxToolCalls?: number; maxCost?: number };
	concurrency?: { total?: number; perChannel?: number };
};

export type Admission = { ok: true } | { ok: false; reason: string; wait?: boolean };

export function loadLimits(path: string | undefined): LimitsConfig {
	return path === undefined ? {} : (JSON.parse(readFileSync(path, "utf8")) as LimitsConfig);
}

/** Every model response's cost, by conversation and channel. */
export class SpendLedger implements Observer {
	readonly #db: DatabaseSync;
	readonly #pricing: Pricing;

	constructor(path: string, pricing: Pricing) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.#db = new DatabaseSync(path, { timeout: 5000 });
		this.#pricing = pricing;
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS spend (
				at INTEGER NOT NULL,
				conversation_id INTEGER NOT NULL,
				channel TEXT NOT NULL,
				model TEXT NOT NULL,
				input INTEGER NOT NULL,
				output INTEGER NOT NULL,
				cost REAL NOT NULL
			);
			CREATE INDEX IF NOT EXISTS spend_at ON spend (at);
		`);
	}

	responded(e: Where & { message: AssistantMessage }, now = Date.now()): void {
		this.#db
			.prepare("INSERT INTO spend (at, conversation_id, channel, model, input, output, cost) VALUES (?, ?, ?, ?, ?, ?, ?)")
			.run(now, e.conversationId, e.channel, `${e.message.provider}/${e.message.model}`, e.message.usage?.input ?? 0, e.message.usage?.output ?? 0, this.#pricing.cost(e.message));
	}

	/** Dollars spent since `since`, in one channel or everywhere. */
	spent(since: number, channel?: string): number {
		const row = this.#db
			.prepare("SELECT COALESCE(SUM(cost), 0) AS total FROM spend WHERE at >= ? AND (? IS NULL OR channel = ?)")
			.get(since, channel ?? null, channel ?? null) as { total: number };
		return row.total;
	}

	/** Spend by model since `since`. */
	byModel(since: number): Record<string, number> {
		return Object.fromEntries(
			this.#db
				.prepare("SELECT model, SUM(cost) AS cost FROM spend WHERE at >= ? GROUP BY model")
				.all(since)
				.map((r) => [String(r.model), Number(r.cost)]),
		);
	}

	/** This week's spend by channel, largest first. */
	byChannel(since: number): { channel: string; cost: number }[] {
		return this.#db
			.prepare("SELECT channel, SUM(cost) AS cost FROM spend WHERE at >= ? GROUP BY channel ORDER BY cost DESC")
			.all(since)
			.map((r) => ({ channel: String(r.channel), cost: Number(r.cost) }));
	}

	close(): void {
		this.#db.close();
	}
}

export class Limits implements Observer {
	readonly config: LimitsConfig;
	readonly #ledger: SpendLedger;
	readonly #pricing: Pricing;
	readonly #runs = new Map<number, { tools: number; cost: number }>();

	constructor(config: LimitsConfig, ledger: SpendLedger, pricing: Pricing) {
		this.config = config;
		this.#ledger = ledger;
		this.#pricing = pricing;
	}

	/** The week's budget for a channel, if it has one. */
	budgetFor(channel: string): number | undefined {
		return this.config.weekly?.channels?.[channel] ?? this.config.weekly?.perChannel;
	}

	/** May a new request start in `channel`, with these runs already going? */
	admit(channel: string, working: readonly { channel: string }[], now = Date.now()): Admission {
		const week = weekStart(new Date(now));
		const total = this.config.weekly?.total;
		if (total !== undefined && this.#ledger.spent(week) >= total) {
			return { ok: false, reason: `I've used this week's budget for all of Scout ($${total}). It resets on Monday; whoever runs me can raise it.` };
		}
		const budget = this.budgetFor(channel);
		if (budget !== undefined && this.#ledger.spent(week, channel) >= budget) {
			return { ok: false, reason: `This channel has used its $${budget} of Scout for the week. It resets on Monday; whoever runs me can raise it.` };
		}
		const { total: maxTotal, perChannel } = this.config.concurrency ?? {};
		if (maxTotal !== undefined && working.length >= maxTotal) {
			return { ok: false, wait: true, reason: `I'm working on ${working.length} things already. I'll start on this as soon as one finishes.` };
		}
		const here = working.filter((w) => w.channel === channel).length;
		if (perChannel !== undefined && here >= perChannel) {
			return { ok: false, wait: true, reason: `I'm already working on ${here} thing${here === 1 ? "" : "s"} in this channel. I'll start on this as soon as one finishes.` };
		}
		return { ok: true };
	}

	responded(e: Where & { message: AssistantMessage }): void {
		this.#run(e.conversationId).cost += this.#pricing.cost(e.message);
	}

	toolStarted(e: ToolCallEvent): string | undefined {
		if (e.nested) return undefined;
		const run = this.#run(e.conversationId);
		run.tools++;
		const { maxToolCalls, maxCost } = this.config.perRun ?? {};
		const stop = "Stop here: say what you've done and what's left, and ask whether to keep going.";
		if (maxToolCalls !== undefined && run.tools > maxToolCalls) return `This request has used its ${maxToolCalls} tool calls. ${stop}`;
		if (maxCost !== undefined && run.cost >= maxCost) return `This request has cost $${run.cost.toFixed(2)}, its limit is $${maxCost}. ${stop}`;
		return undefined;
	}

	runEnded(w: Where): void {
		this.#runs.delete(w.conversationId);
	}

	#run(conversationId: number): { tools: number; cost: number } {
		let run = this.#runs.get(conversationId);
		if (run === undefined) {
			run = { tools: 0, cost: 0 };
			this.#runs.set(conversationId, run);
		}
		return run;
	}
}

/** Monday 00:00, local time, of `date`'s week. */
export function weekStart(date: Date): number {
	const monday = new Date(date);
	monday.setHours(0, 0, 0, 0);
	monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
	return monday.getTime();
}
