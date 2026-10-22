import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EvalTask, RunResult } from "./evals.ts";

/**
 * A small, slow benchmark of models on Scout's own work, modelled on the public ones: SWE-bench (real fixes replayed,
 * judged by the fix's own tests, unseen while working, and by whether the rest of the tests still pass), SWE-rebench
 * (tasks that change, so none gets learned), BFCL (well-formed tool calls). Each night every model runs the same
 * tasks, drawn from the pool (bench-cli.ts); only a summary of each run is kept, for the last `KEEP_RUNS` nights, so
 * the scores follow models and their providers as they change.
 *
 * Two charts come of it. What a model can do (capability) scores 0 to 100 on fixed scales, so a score means the same
 * from week to week. What it's like to work with through our gateway (operations: first tokens, speed, retries) is
 * raw measurements, charted relative to the other models: the best of them is the outer ring.
 */
export const KEEP_RUNS = 10;

/** One task's run, as kept: no transcript, no diff, just how it went. */
export type BenchRow = {
	model: string;
	/** The night's run, as a local date (YYYY-MM-DD). */
	run: string;
	task: string;
	kind: "change" | "locate";
	pass: boolean;
	ms: number;
	cost: number;
	toolCalls: number;
	badToolCalls: number;
	modelCalls: number;
	retries: number;
	inputTokens: number;
	outputTokens: number;
	/** The model answering, first tokens apart, in ms: for output speed. */
	modelMs: number;
	firstTokenP50: number;
	firstTokenP90: number;
	/** Why the run says nothing about the model (the provider was too slow, or its calls kept failing), if so. */
	unscored?: string;
	/** Whether a change broke the repository's other tests, when it changed something and the task checks. */
	regressed?: boolean;
};

/**
 * One spoke of a chart. Operations axes carry their measurement (`raw`, and which way is better): their `score` is
 * set relative to the other models' (`relate`), not on a fixed scale.
 */
export type Axis = { name: string; score: number; value: string; about: string; raw?: number; better?: "lower" | "higher" };

export type ModelScores = { model: string; runs: number; tasks: number; capability: Axis[]; operations: Axis[] };

export class BenchStore {
	readonly #db: DatabaseSync;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.#db = new DatabaseSync(path, { timeout: 5000 });
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS bench (
				model TEXT NOT NULL,
				run TEXT NOT NULL,
				task TEXT NOT NULL,
				row TEXT NOT NULL,
				PRIMARY KEY (model, run, task)
			);
		`);
	}

	/** A run's rows; then only the model's last `keep` runs stay. */
	record(rows: readonly BenchRow[], keep = KEEP_RUNS): void {
		const put = this.#db.prepare("INSERT OR REPLACE INTO bench (model, run, task, row) VALUES (?, ?, ?, ?)");
		for (const row of rows) put.run(row.model, row.run, row.task, JSON.stringify(row));
		for (const model of new Set(rows.map((r) => r.model))) {
			this.#db
				.prepare("DELETE FROM bench WHERE model = ? AND run NOT IN (SELECT DISTINCT run FROM bench WHERE model = ? ORDER BY run DESC LIMIT ?)")
				.run(model, model, keep);
		}
	}

	rows(model?: string): BenchRow[] {
		const all = model === undefined ? this.#db.prepare("SELECT row FROM bench ORDER BY run, model, task").all() : this.#db.prepare("SELECT row FROM bench WHERE model = ? ORDER BY run, task").all(model);
		return all.map((r) => JSON.parse((r as { row: string }).row) as BenchRow);
	}

	/** The latest run's date, if any. */
	lastRun(): string | undefined {
		const row = this.#db.prepare("SELECT MAX(run) AS run FROM bench").get() as { run: string | null };
		return row.run ?? undefined;
	}

	/** Each model's scores, best first by capability. */
	scores(): ModelScores[] {
		const models = [...new Set(this.rows().map((r) => r.model))];
		return relate(models.map((m) => score(m, this.rows(m)))).sort((a, b) => total(b.capability) - total(a.capability));
	}

	/** When each task last ran, for any model: tonight's tasks are the ones run longest ago (bench-cli.ts). */
	lastRuns(): Map<string, string> {
		const rows = this.#db.prepare("SELECT task, MAX(run) AS run FROM bench GROUP BY task").all() as { task: string; run: string }[];
		return new Map(rows.map((r) => [r.task, r.run]));
	}

	close(): void {
		this.#db.close();
	}
}

const total = (axes: readonly Axis[]) => axes.reduce((sum, a) => sum + a.score, 0);

/**
 * Operations scores relative to each other: on each axis the best model's measurement is 100, and the rest are their
 * share of it (for times, the best time over theirs). A model with nothing measured on an axis scores 0 there.
 */
export function relate(models: ModelScores[]): ModelScores[] {
	const axes = models[0]?.operations.length ?? 0;
	for (let i = 0; i < axes; i++) {
		const measured = models.map((m) => m.operations[i]!).filter((a) => (a.raw ?? 0) > 0);
		const best = measured.length === 0 ? 0 : measured[0]!.better === "lower" ? Math.min(...measured.map((a) => a.raw!)) : Math.max(...measured.map((a) => a.raw!));
		for (const m of models) {
			const a = m.operations[i]!;
			a.score = !((a.raw ?? 0) > 0) || best === 0 ? 0 : Math.round(100 * (a.better === "lower" ? best / a.raw! : a.raw! / best));
		}
	}
	return models;
}

/** A run's result as kept for the benchmark. */
export function benchRow(model: string, run: string, task: EvalTask, result: RunResult): BenchRow {
	const u = result.usage;
	const firsts = [...(u?.firstTokens ?? [])].sort((a, b) => a - b);
	return {
		model,
		run,
		task: task.name,
		kind: task.kind ?? "change",
		pass: result.pass,
		ms: result.ms,
		cost: result.cost,
		toolCalls: u?.toolCalls ?? 0,
		badToolCalls: u?.badToolCalls ?? 0,
		modelCalls: u?.modelCalls ?? 0,
		retries: u?.retries ?? 0,
		inputTokens: u?.inputTokens ?? 0,
		outputTokens: u?.outputTokens ?? 0,
		modelMs: result.timing?.model ?? 0,
		firstTokenP50: quantile(firsts, 0.5),
		firstTokenP90: quantile(firsts, 0.9),
		...(result.unscored === undefined ? {} : { unscored: result.unscored }),
		...(result.regressed === undefined ? {} : { regressed: result.regressed }),
	};
}

/** The value at `q` of sorted numbers (0 for none). */
export function quantile(sorted: readonly number[], q: number): number {
	if (sorted.length === 0) return 0;
	const at = (sorted.length - 1) * q;
	const low = Math.floor(at);
	return sorted[low]! + (sorted[Math.ceil(at)]! - sorted[low]!) * (at - low);
}

const median = (values: readonly number[]) => quantile([...values].sort((a, b) => a - b), 0.5);

/**
 * 0 to 100 on a log scale between `best` (100) and `worst` (0), for things that span orders of magnitude: seconds,
 * dollars, tokens per second. Works either way round (`best` below or above `worst`).
 */
export function logScale(value: number, best: number, worst: number): number {
	if (!(value > 0)) return best < worst ? 100 : 0;
	const t = Math.log(value / worst) / Math.log(best / worst);
	return Math.round(Math.max(0, Math.min(1, t)) * 100);
}

const pct = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 100));
const secs = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : ms < 120_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 60_000).toFixed(1)}m`);

/**
 * One model's scores over its kept runs. What it can do counts only runs that say something about the model: a task
 * the provider cut short (too slow, or failing calls) shows under working with it instead.
 */
export function score(model: string, all: readonly BenchRow[]): ModelScores {
	const runs = new Set(all.map((r) => r.run)).size;
	const rows = all.filter((r) => r.unscored === undefined);
	const lost = all.length - rows.length;
	const change = rows.filter((r) => r.kind === "change");
	const locate = rows.filter((r) => r.kind === "locate");
	const passed = rows.filter((r) => r.pass);
	const tasks = new Set(rows.map((r) => r.task)).size;
	const checked = rows.filter((r) => r.regressed !== undefined);
	const kept = checked.filter((r) => r.regressed === false).length;
	const toolCalls = rows.reduce((n, r) => n + r.toolCalls, 0);
	const badCalls = rows.reduce((n, r) => n + r.badToolCalls, 0);
	const cost = rows.reduce((n, r) => n + r.cost, 0);
	const perSolved = passed.length === 0 ? Number.POSITIVE_INFINITY : cost / passed.length;
	// Working with it counts every run: a provider's bad night is what this side is for.
	const calls = all.reduce((n, r) => n + r.modelCalls, 0);
	const retries = all.reduce((n, r) => n + r.retries, 0);
	const output = all.reduce((n, r) => n + r.outputTokens, 0);
	const answering = all.reduce((n, r) => n + r.modelMs, 0);
	const speed = answering === 0 ? 0 : output / (answering / 1000);
	const timed = all.filter((r) => r.modelCalls > 0);
	const p50 = median(timed.map((r) => r.firstTokenP50));
	const p90 = median(timed.map((r) => r.firstTokenP90));
	const taskTime = median(all.map((r) => r.ms));
	return {
		model,
		runs,
		tasks,
		capability: [
			{ name: "Coding", score: pct(change.filter((r) => r.pass).length, change.length), value: `${change.filter((r) => r.pass).length}/${change.length}`, about: "Real fixes from Scout's history, judged by the fix's own tests, which the model doesn't see" },
			{ name: "Reasoning (finding bugs)", score: pct(locate.filter((r) => r.pass).length, locate.length), value: `${locate.filter((r) => r.pass).length}/${locate.length}`, about: "Given a failing test, name the file and function the real fix changed" },
			{ name: "Tool use", score: toolCalls === 0 ? 0 : 100 - pct(badCalls, toolCalls), value: `${badCalls} bad of ${toolCalls}`, about: "Tool calls with arguments that fit the tool, to tools that exist" },
			{ name: "No regressions", score: pct(kept, checked.length), value: checked.length === 0 ? "no change to check yet" : `${kept}/${checked.length} changes`, about: "Changes that left the repository's other tests passing, as SWE-bench checks" },
			{ name: "Cost efficiency", score: Number.isFinite(perSolved) ? logScale(perSolved, 0.01, 2) : 0, value: Number.isFinite(perSolved) ? `$${perSolved.toFixed(3)} a solved task` : "nothing solved", about: "List-price cost per solved task: $0.01 or less is 100, $2 or more is 0" },
		],
		operations: [
			{ name: "First token", score: 0, raw: p50, better: "lower", value: secs(p50), about: "Median time to a model call's first token" },
			{ name: "Slow first tokens", score: 0, raw: p90, better: "lower", value: secs(p90), about: "The 90th percentile of the same" },
			{ name: "Output speed", score: 0, raw: speed, better: "higher", value: `${Math.round(speed)} tokens/s`, about: "Tokens a second once answering" },
			{ name: "Task time", score: 0, raw: taskTime, better: "lower", value: secs(taskTime), about: "Median time for a whole task" },
			{ name: "Call success", score: 0, raw: calls + retries === 0 ? 0 : calls / (calls + retries), better: "higher", value: `${retries} retried of ${calls + retries} calls`, about: "Model calls that worked the first time" },
			{ name: "Tasks not lost", score: 0, raw: all.length === 0 ? 0 : (all.length - lost) / all.length, better: "higher", value: `${lost} lost of ${all.length} tasks`, about: "Tasks the provider didn't cut short: 90 minutes in all, or calls that kept failing. Lost ones aren't scored as the model's" },
		],
	};
}
