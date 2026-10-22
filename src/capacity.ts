import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";

/**
 * Scout's capacity: how long people wait, for what, and what to tell them. Limits (on runs, model calls, sandboxes)
 * keep Scout from overrunning what it depends on; this keeps the waiting they cause from going unnoticed:
 *
 * - **A record** of waits by kind (a request waiting its turn, a model call waiting for a slot, a sandbox waiting for
 *   room) and of how long runs take, so Scout can say what to expect ("about 3–8 minutes") and only when it knows.
 * - **The board**: who's waiting on what right now, so each run's progress message can say so.
 * - **Trends**: when waiting becomes common or grows, Scout tells whoever runs it, with numbers and what would help.
 * - **The model's start**: how long each model call takes to start answering once it's sent (the gateway queueing, the
 *   model warming up). Scout can't shorten it, but it's often most of a run, so a slow spell gets said too.
 */
export type WaitKind = "run" | "model" | "sandbox";
export const WAIT_KINDS: readonly WaitKind[] = ["run", "model", "sandbox"];

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

export class Capacity {
	readonly #db: DatabaseSync;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.#db = new DatabaseSync(path, { timeout: 5000 });
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS capacity_waits (kind TEXT NOT NULL, at INTEGER NOT NULL, waited_ms INTEGER NOT NULL);
			CREATE INDEX IF NOT EXISTS capacity_waits_at ON capacity_waits (at);
			CREATE TABLE IF NOT EXISTS capacity_runs (at INTEGER NOT NULL, duration_ms INTEGER NOT NULL);
			CREATE INDEX IF NOT EXISTS capacity_runs_at ON capacity_runs (at);
			CREATE TABLE IF NOT EXISTS capacity_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS capacity_first_tokens (at INTEGER NOT NULL, ms INTEGER NOT NULL);
			CREATE INDEX IF NOT EXISTS capacity_first_tokens_at ON capacity_first_tokens (at);
		`);
	}

	/** Something waited `ms` before it could go ahead. Waits under a second aren't waits worth telling anyone about. */
	waited(kind: WaitKind, ms: number, now = Date.now()): void {
		if (ms < 1000) return;
		this.#db.prepare("INSERT INTO capacity_waits (kind, at, waited_ms) VALUES (?, ?, ?)").run(kind, now, Math.round(ms));
	}

	/** A run finished after `ms`. Measurements older than 30 days go: nothing here looks further back than two weeks. */
	ran(ms: number, now = Date.now()): void {
		this.#db.prepare("INSERT INTO capacity_runs (at, duration_ms) VALUES (?, ?)").run(now, Math.round(ms));
		this.#db.prepare("DELETE FROM capacity_runs WHERE at < ?").run(now - 30 * DAY);
		this.#db.prepare("DELETE FROM capacity_waits WHERE at < ?").run(now - 30 * DAY);
		this.#db.prepare("DELETE FROM capacity_first_tokens WHERE at < ?").run(now - 30 * DAY);
	}

	/** A model call started answering `ms` after it was sent (its wait for a slot not included). */
	firstToken(ms: number, now = Date.now()): void {
		this.#db.prepare("INSERT INTO capacity_first_tokens (at, ms) VALUES (?, ?)").run(now, Math.round(ms));
	}

	/** How long model calls took to start answering, from the last `since` ms (the median and slow end). */
	firstTokens(since: number, now = Date.now()): { count: number; p50: number; p90: number } {
		return this.#firstTokensIn(now - since, now + 1);
	}

	#firstTokensIn(from: number, to: number): { count: number; p50: number; p90: number } {
		const rows = (this.#db.prepare("SELECT ms FROM capacity_first_tokens WHERE at >= ? AND at < ?").all(from, to) as { ms: number }[]).map((r) => r.ms).sort((a, b) => a - b);
		return { count: rows.length, p50: rows.length === 0 ? 0 : quantile(rows, 0.5), p90: rows.length === 0 ? 0 : quantile(rows, 0.9) };
	}

	/** Recent run durations, the latest 50 of the last week, shortest first. */
	#recentRuns(now: number): number[] {
		return (this.#db.prepare("SELECT duration_ms FROM capacity_runs WHERE at >= ? ORDER BY at DESC LIMIT 50").all(now - 7 * DAY) as { duration_ms: number }[])
			.map((r) => r.duration_ms)
			.sort((a, b) => a - b);
	}

	/**
	 * What to expect when `position`th in line for one of `slots` slots: a range from how long recent runs took (the
	 * quicker and slower quartiles, since the runs ahead are already part way through). Undefined until there are a
	 * few runs to go on: no guess is better than a wrong one.
	 */
	eta(position: number, slots: number, now = Date.now()): { low: number; high: number } | undefined {
		const runs = this.#recentRuns(now);
		if (runs.length < 3 || slots <= 0) return undefined;
		const rounds = Math.max(1, position / slots);
		return { low: quantile(runs, 0.25) * rounds * 0.5, high: quantile(runs, 0.75) * rounds };
	}

	/** How long waits of a kind took lately (the median and slow end), from the last `since` ms. */
	waits(kind: WaitKind, since: number, now = Date.now()): { count: number; p50: number; p90: number } {
		const rows = (this.#db.prepare("SELECT waited_ms FROM capacity_waits WHERE kind = ? AND at >= ?").all(kind, now - since) as { waited_ms: number }[])
			.map((r) => r.waited_ms)
			.sort((a, b) => a - b);
		return { count: rows.length, p50: rows.length === 0 ? 0 : quantile(rows, 0.5), p90: rows.length === 0 ? 0 : quantile(rows, 0.9) };
	}

	/** Runs finished in a window, as the measure of how much work there was. */
	#runCount(from: number, to: number): number {
		return Number((this.#db.prepare("SELECT COUNT(*) AS n FROM capacity_runs WHERE at >= ? AND at <= ?").get(from, to) as { n: number }).n);
	}

	#waitsOver(kind: WaitKind, minMs: number, from: number, to: number): number {
		return Number((this.#db.prepare("SELECT COUNT(*) AS n FROM capacity_waits WHERE kind = ? AND waited_ms >= ? AND at >= ? AND at <= ?").get(kind, minMs, from, to) as { n: number }).n);
	}

	/**
	 * What's worth telling whoever runs Scout about waiting, if anything, at most once a day: when a meaningful share of
	 * requests waited over a minute for their turn in the last day, when model calls or sandboxes kept people waiting,
	 * when the model was slow to start answering, or when waits grew a lot on the week before. With the numbers, and
	 * what would help.
	 */
	notice(settings: { maxRuns: number; maxModelCalls: number }, now = Date.now()): string | undefined {
		const day = new Date(now).toISOString().slice(0, 10);
		const told = this.#db.prepare("SELECT value FROM capacity_meta WHERE key = 'noticed'").get() as { value: string } | undefined;
		if (told?.value === day) return undefined;
		const runs = this.#runCount(now - DAY, now);
		const findings: string[] = [];
		const help: string[] = [];
		const queued = this.#waitsOver("run", MINUTE, now - DAY, now);
		if (queued >= 3 && queued / Math.max(1, runs) >= 0.2) {
			const w = this.waits("run", DAY, now);
			findings.push(`${queued} of ${Math.max(runs, queued)} requests in the last day waited over a minute for their turn (half waited over ${minutes(w.p50)}, the slowest tenth over ${minutes(w.p90)})`);
			help.push(`raise SCOUT_MAX_RUNS (it's ${settings.maxRuns}) if the model gateway and sandboxes have room`);
		}
		const model = this.waits("model", DAY, now);
		if (model.count >= 10 && model.p90 >= 30_000) {
			findings.push(`model calls waited for a slot ${model.count} times (the slowest tenth over ${minutes(model.p90)})`);
			help.push(`raise SCOUT_MAX_MODEL_CALLS (it's ${settings.maxModelCalls}) if the model gateway can take more, or give the gateway more capacity`);
		}
		const sandbox = this.waits("sandbox", DAY, now);
		if (sandbox.count >= 3) {
			findings.push(`${sandbox.count} sandboxes waited for room on the sandbox host (half over ${minutes(sandbox.p50)})`);
			help.push("a larger share for Scout on spoond, or fewer runs at once");
		}
		const start = this.firstTokens(DAY, now);
		const startBefore = this.#firstTokensIn(now - 8 * DAY, now - DAY);
		const slowStart = start.p90 >= 30_000 || (startBefore.count >= 20 && start.p50 >= 2 * startBefore.p50 && start.p50 >= 10_000);
		if (start.count >= 20 && slowStart) {
			const before = startBefore.count >= 20 ? `, against ${minutes(startBefore.p50)} the week before` : "";
			findings.push(`the model was slow to start answering: half of its ${start.count} calls in the last day took over ${minutes(start.p50)} before the first word${before}, the slowest tenth over ${minutes(start.p90)}`);
			help.push("that's the model gateway or its provider, not Scout: check the gateway's queue and the provider's status, or try a model that starts sooner (SCOUT_MODEL)");
		}
		const thisWeek = this.waits("run", 7 * DAY, now);
		const lastWeek = this.#waitsIn("run", now - 14 * DAY, now - 7 * DAY);
		if (findings.length === 0 && thisWeek.count >= 10 && lastWeek.count >= 5 && thisWeek.p50 >= 2 * lastWeek.p50 && thisWeek.p50 >= MINUTE) {
			findings.push(`waits for a turn have doubled on last week (half over ${minutes(thisWeek.p50)}, from ${minutes(lastWeek.p50)})`);
			help.push(`raise SCOUT_MAX_RUNS (it's ${settings.maxRuns}), or look at what's keeping runs long`);
		}
		if (findings.length === 0) return undefined;
		this.#db.prepare("INSERT OR REPLACE INTO capacity_meta (key, value) VALUES ('noticed', ?)").run(day);
		return [
			"Heads up: people have been waiting on me more than they should.",
			...findings.map((f) => `• ${f}`),
			`What would help: ${help.join("; ")}.`,
		].join("\n");
	}

	#waitsIn(kind: WaitKind, from: number, to: number): { count: number; p50: number } {
		const rows = (this.#db.prepare("SELECT waited_ms FROM capacity_waits WHERE kind = ? AND at >= ? AND at < ?").all(kind, from, to) as { waited_ms: number }[])
			.map((r) => r.waited_ms)
			.sort((a, b) => a - b);
		return { count: rows.length, p50: rows.length === 0 ? 0 : quantile(rows, 0.5) };
	}

	/** One line about waiting over the last week, for the Monday report and the nightly reflection; undefined if none. */
	weekLine(now = Date.now()): string | undefined {
		const parts = WAIT_KINDS.flatMap((kind) => {
			const w = this.waits(kind, 7 * DAY, now);
			if (w.count === 0) return [];
			const what = kind === "run" ? "requests waited for their turn" : kind === "model" ? "model calls waited for a slot" : "sandboxes waited for room";
			return [`${w.count} ${what} (half over ${minutes(w.p50)}, the slowest tenth over ${minutes(w.p90)})`];
		});
		const start = this.firstTokens(7 * DAY, now);
		if (start.count > 0) parts.push(`the model took ${minutes(start.p50)} to start answering, half the time (the slowest tenth over ${minutes(start.p90)})`);
		return parts.length === 0 ? undefined : `Waiting last week: ${parts.join("; ")}.`;
	}

	close(): void {
		this.#db.close();
	}
}

function quantile(sorted: readonly number[], q: number): number {
	const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
	return sorted[i]!;
}

/** A wait in words people read: "40 seconds", "3 minutes". */
export function minutes(ms: number): string {
	if (ms < MINUTE) return `${Math.max(1, Math.round(ms / 1000))} seconds`;
	const m = Math.round(ms / MINUTE);
	return `${m} minute${m === 1 ? "" : "s"}`;
}

/** An ETA range in words: "about 2–6 minutes", "a minute or two", "under a minute". */
export function aboutHowLong(range: { low: number; high: number }): string {
	const low = Math.max(0, Math.round(range.low / MINUTE));
	const high = Math.max(1, Math.round(range.high / MINUTE));
	if (high <= 1) return "under a minute";
	if (high <= 2) return "a minute or two";
	return `about ${Math.max(1, low)}–${high} minutes`;
}

/** Who's waiting on what right now, by a key (a session for model calls, a sandbox key), and since when. */
export class WaitBoard {
	readonly #waits = new Map<string, number>();

	start(kind: WaitKind, key: string, now = Date.now()): void {
		if (!this.#waits.has(`${kind}:${key}`)) this.#waits.set(`${kind}:${key}`, now);
	}

	/** It's going ahead: how long it waited. */
	end(kind: WaitKind, key: string, now = Date.now()): number {
		const since = this.#waits.get(`${kind}:${key}`);
		this.#waits.delete(`${kind}:${key}`);
		return since === undefined ? 0 : now - since;
	}

	since(kind: WaitKind, key: string): number | undefined {
		return this.#waits.get(`${kind}:${key}`);
	}

	count(kind: WaitKind): number {
		return [...this.#waits.keys()].filter((k) => k.startsWith(`${kind}:`)).length;
	}
}

/**
 * At most `max` model calls in flight at once, the rest waiting their turn in order, so a busy moment queues instead
 * of overrunning the model gateway. Each call is known by its provider session (one per conversation, from Pi
 * Durable), so a run can say it's waiting and how many calls are ahead of it. `max` 0 means no limit.
 */
export class ModelLimiter {
	readonly max: number;
	readonly #queue: { session: string; go: () => void }[] = [];
	#inFlight = 0;
	readonly #onWaited: (ms: number) => void;
	readonly #board: WaitBoard | undefined;

	constructor(options: { max: number; onWaited?: (ms: number) => void; board?: WaitBoard }) {
		this.max = options.max;
		this.#onWaited = options.onWaited ?? (() => {});
		this.#board = options.board;
	}

	get inFlight(): number {
		return this.#inFlight;
	}

	get waiting(): number {
		return this.#queue.length;
	}

	/** Where a session's waiting call is in line (1 = next), or undefined when it isn't waiting. */
	position(session: string): number | undefined {
		const i = this.#queue.findIndex((q) => q.session === session);
		return i < 0 ? undefined : i + 1;
	}

	/** Wait for a slot (or until `signal` aborts, so a stopped run doesn't hold its place); returns the release. */
	async acquire(session: string, signal?: AbortSignal): Promise<() => void> {
		if (this.max > 0 && this.#inFlight >= this.max) {
			const queued = Date.now();
			this.#board?.start("model", session, queued);
			let stopped = false;
			await new Promise<void>((resolve) => {
				const entry = { session, go: resolve };
				this.#queue.push(entry);
				signal?.addEventListener(
					"abort",
					() => {
						const i = this.#queue.indexOf(entry);
						if (i >= 0) this.#queue.splice(i, 1);
						stopped = true;
						resolve();
					},
					{ once: true },
				);
			});
			this.#board?.end("model", session);
			// Stopped while waiting: it goes without a slot, and its call ends at once on the aborted signal.
			if (stopped) return () => {};
			this.#onWaited(Date.now() - queued);
		}
		this.#inFlight++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#inFlight--;
			this.#queue.shift()?.go();
		};
	}
}

/** Where a model call went: its own model, or a fallback; `probe` when it's the one call trying a failing model again. */
export type Route = { to: string; probe: boolean };

/** A model whose calls are going elsewhere, for the dashboard: since when, to which model, and why. */
export type ModelOutage = { model: string; fallback?: string; since: number; retryAt: number; failures: number; error?: string };

type BreakerState = {
	/** Failed calls in a row, and the latest one's error. */
	failures: number;
	error?: string;
	/** Failing: its calls go to a fallback until `retryAt`, when one call (the probe) tries it again. */
	open?: { retryAt: number; probing: boolean };
	/** When this outage started, and when it last answered again (not yet steady enough to say it's back). */
	downSince?: number;
	closedAt?: number;
	/** The home channel was told it's down, and not yet that it's back. */
	told: boolean;
};

/** A model that answered again is only said to be back after answering this long without failing again. */
const STEADY_MS = 10 * MINUTE;

/**
 * A circuit breaker per model, for a gateway or provider that stops answering. After `after` failed calls in a row
 * (an error, not a stop or a context too long), the model's calls go to the first of `fallbacks` that's answering,
 * with the same context and options. After `forMs`, one call tries the model again: an answer closes the breaker, a
 * failure opens it for another `forMs`. Pi's own retries each come through here, so a run that hit the failures
 * carries on with the fallback instead of failing.
 *
 * Whoever runs Scout hears once when a model goes down and once when it's back (`say`), and "back" waits until it
 * has answered steadily for a while, so a model that flaps doesn't fill the channel.
 */
export class ModelBreakers {
	readonly fallbacks: readonly string[];
	readonly #after: number;
	readonly #forMs: number;
	readonly #say: (text: string) => void;
	readonly #now: () => number;
	readonly #states = new Map<string, BreakerState>();
	/** Provider sessions whose calls went to a fallback in the current outage, and from which model to which. */
	readonly #routed = new Map<string, { from: string; to: string }>();

	/** Models are `provider/modelId`. */
	constructor(options: { fallbacks: readonly string[]; after: number; forMs: number; say?: (text: string) => void; now?: () => number }) {
		this.fallbacks = options.fallbacks;
		this.#after = options.after;
		this.#forMs = options.forMs;
		this.#say = options.say ?? (() => {});
		this.#now = options.now ?? Date.now;
	}

	/** Where a call for `model` from provider session `session` goes now. */
	route(model: string, session: string): Route {
		if (this.#ready(model)) {
			this.#routed.delete(session);
			return this.#take(model);
		}
		const fallback = this.fallbacks.find((f) => f !== model && this.#ready(f));
		// Nothing else is answering either: keep trying its own model.
		if (fallback === undefined) return { to: model, probe: false };
		this.#routed.set(session, { from: model, to: fallback });
		return this.#take(fallback);
	}

	/** How a routed call ended: answered, failed (with its error), or neither (stopped, or its context was too long). */
	settle(route: Route, outcome: "ok" | "failed" | "neither", error?: string): void {
		const now = this.#now();
		const model = route.to;
		const state = this.#state(model);
		if (route.probe && state.open !== undefined) state.open.probing = false;
		if (outcome === "neither") return;
		if (outcome === "ok") {
			state.failures = 0;
			delete state.error;
			if (state.open !== undefined) {
				delete state.open;
				state.closedAt = now;
				for (const [session, r] of this.#routed) if (r.from === model) this.#routed.delete(session);
			}
			if (state.closedAt !== undefined && now - state.closedAt >= STEADY_MS) {
				if (state.told) this.#say(`${short(model)} is answering again, so I'm back on it. It was out for about ${minutes(state.closedAt - (state.downSince ?? state.closedAt))}.`);
				state.told = false;
				delete state.closedAt;
				delete state.downSince;
			}
			return;
		}
		state.failures++;
		if (error !== undefined) state.error = error;
		if (state.open !== undefined) {
			// The probe failed: give it another while.
			if (route.probe) state.open.retryAt = now + this.#forMs;
			return;
		}
		if (state.failures < this.#after) return;
		// It came back and stayed up a while, though no answer since has said so: this is a new outage.
		if (state.closedAt !== undefined && now - state.closedAt >= STEADY_MS) {
			state.told = false;
			delete state.downSince;
		}
		state.open = { retryAt: now + this.#forMs, probing: false };
		state.downSince ??= now;
		delete state.closedAt;
		if (state.told) return;
		state.told = true;
		const fallback = this.fallbacks.find((f) => f !== model && this.#ready(f));
		const why = `${short(model)} has failed ${state.failures} calls in a row${state.error === undefined ? "" : ` (${gist(state.error)})`}`;
		const minutesFor = Math.round(this.#forMs / MINUTE);
		this.#say(
			fallback === undefined
				? `Heads up: ${why}, and none of my fallback models are answering either. I'll keep trying.`
				: `Heads up: ${why}, so I'm using ${short(fallback)} for now. I'll try ${short(model)} again every ${minutesFor} minute${minutesFor === 1 ? "" : "s"}.`,
		);
	}

	/** What a thread says when its calls went to a fallback in this outage, by its provider session; else nothing. */
	notice(session: string): string | undefined {
		const routed = this.#routed.get(session);
		return routed === undefined ? undefined : `${short(routed.from)} isn't answering, so I'm using ${short(routed.to)} for now.`;
	}

	/** Models whose calls are going elsewhere now, for the dashboard. */
	outages(): ModelOutage[] {
		return [...this.#states].flatMap(([model, state]) => {
			if (state.open === undefined) return [];
			const fallback = this.fallbacks.find((f) => f !== model && this.#ready(f));
			return [
				{
					model,
					...(fallback === undefined ? {} : { fallback }),
					since: state.downSince ?? 0,
					retryAt: state.open.retryAt,
					failures: state.failures,
					...(state.error === undefined ? {} : { error: gist(state.error) }),
				},
			];
		});
	}

	/** Closed, or open with its time up and no call trying it yet. */
	#ready(model: string): boolean {
		const open = this.#states.get(model)?.open;
		return open === undefined || (!open.probing && this.#now() >= open.retryAt);
	}

	#take(model: string): Route {
		const open = this.#states.get(model)?.open;
		if (open === undefined) return { to: model, probe: false };
		open.probing = true;
		return { to: model, probe: true };
	}

	#state(model: string): BreakerState {
		let state = this.#states.get(model);
		if (state === undefined) {
			state = { failures: 0, told: false };
			this.#states.set(model, state);
		}
		return state;
	}
}

/** A model as people say it: `deepseek-4.1-flash` for `gateway/lunaroute/deepseek-4.1-flash`. */
export function short(model: string): string {
	return model.split("/").pop() ?? model;
}

/** An error in a few words: the gateway's own message when it sent JSON. */
function gist(error: string): string {
	const text = error.match(/"message"\s*:\s*"([^"]+)"/)?.[1] ?? error;
	return text.length <= 160 ? text : `${text.slice(0, 159)}…`;
}

/** How a call ended, for its breaker: a stop or a context too long says nothing about whether the model is up. */
function outcomeOf(message: AssistantMessage, signal: AbortSignal | undefined): "ok" | "failed" | "neither" {
	if (signal?.aborted === true || message.stopReason === "aborted" || message.stopReason === "deferred") return "neither";
	if (message.stopReason !== "error") return "ok";
	return isContextOverflow(message) ? "neither" : "failed";
}

/**
 * The same models, with every streamed call taking its turn through the limiter. Everything else passes straight
 * through. A call is held before it starts, so the provider never sees more than the limit at once. Each call also
 * reports how long, once sent, it took to start answering: the first thing it says, not the provider's "started",
 * which arrives with the response's headers. With `breakers`, a call for a failing model goes to a fallback; its
 * answer is the fallback's own, so it's priced and recorded as the model that answered.
 */
export function limitModels(models: Models, limiter: ModelLimiter, onFirstToken: (ms: number, session: string) => void = () => {}, breakers?: ModelBreakers): Models {
	const limited = (model: Parameters<Models["streamSimple"]>[0], context: Parameters<Models["streamSimple"]>[1], options?: Parameters<Models["streamSimple"]>[2]) => {
		const out = createAssistantMessageEventStream();
		void (async () => {
			const session = options?.sessionId ?? "unknown";
			const release = await limiter.acquire(session, options?.signal);
			try {
				const route = breakers?.route(`${model.provider}/${model.id}`, session);
				const [provider = "", ...id] = route?.to.split("/") ?? [];
				const used = route === undefined || route.to === `${model.provider}/${model.id}` ? model : (models.getModel(provider, id.join("/")) ?? model);
				let message: AssistantMessage;
				let ending: AssistantMessageEvent | undefined;
				try {
					const sent = Date.now();
					let started = false;
					const inner = models.streamSimple(used, context, options);
					for await (const event of inner) {
						if (!started && event.type !== "start" && event.type !== "error") {
							started = true;
							onFirstToken(Date.now() - sent, session);
						}
						// The last event ends the call for whoever waits on it: held until the breaker has heard how it went.
						if (event.type === "done" || event.type === "error") ending = event;
						else out.push(event);
					}
					message = await inner.result();
				} catch (error) {
					message = failure(used, error);
				}
				// Before Pi hears how it ended, so its retry already goes where the breaker now says.
				if (route !== undefined) breakers!.settle(route, outcomeOf(message, options?.signal), message.errorMessage);
				if (ending !== undefined) out.push(ending);
				out.end(message);
			} finally {
				release();
			}
		})();
		return out;
	};
	return new Proxy(models, {
		get(target, property) {
			if (property === "streamSimple") return limited;
			if (property === "completeSimple") return (...args: Parameters<Models["streamSimple"]>) => limited(...args).result();
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** A call that threw instead of ending: as the error message Pi would have got from the provider. */
function failure(model: { api: string; provider: string; id: string }, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	} as AssistantMessage;
}

/** Event-loop lag over the last interval, in milliseconds (mean and the slow end): how busy Scout's one process is. */
export function eventLoopLag(): () => { mean: number; p99: number } {
	const histogram = monitorEventLoopDelay({ resolution: 20 });
	histogram.enable();
	let last = { mean: 0, p99: 0 };
	const timer = setInterval(() => {
		last = { mean: histogram.mean / 1e6, p99: histogram.percentile(99) / 1e6 };
		histogram.reset();
	}, 60_000);
	timer.unref();
	return () => (histogram.count > 0 ? { mean: histogram.mean / 1e6, p99: histogram.percentile(99) / 1e6 } : last);
}
