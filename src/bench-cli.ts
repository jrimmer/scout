import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { BenchStore, benchRow } from "./bench.ts";
import { loadConfig, useScoutsKey } from "./config.ts";
import { type EvalTask, evalConfig, evalRepos, fakeCodeHost, loadTasks, measures, runTask } from "./evals.ts";
import { localDay } from "./reflect.ts";
import { openScout } from "./scout.ts";
import { resolveSecrets } from "./secrets.ts";

/**
 * One night of the benchmark (bench.ts): every model in SCOUT_BENCH_MODELS runs tonight's tasks from the bench
 * directory once (`tonight`: the same for every model), the way an eval runs (evals.ts: its own sandbox, a local copy of the repository, a stand-in code host), and a
 * summary of each run goes into the data directory's bench.sqlite. Scout starts it nightly; by hand:
 *
 *     npm run bench                  # every model, tonight's tasks
 *     npm run bench -- --only ci     # every task whose name has "ci" in it
 */

/**
 * As public benchmarks do, tasks have a time limit: 30 minutes of the model's own time (a task that needs more fails),
 * not counting time spent waiting for the provider's first tokens or retrying its failed calls, and 90 minutes in all,
 * so a slow provider can't stretch a night into the day. A task stopped by that, whose calls kept failing, or that
 * never reached the model, isn't scored as the model's.
 */
const TASK_LIMIT_MS = 30 * 60_000;
const TASK_WALL_MS = 90 * 60_000;

/** Tasks a night, by kind: enough to tell models apart, few enough that the slowest finishes by morning. */
const PER_NIGHT = { change: 3, locate: 4 } as const;

/**
 * Tonight's tasks: of each kind, the ones run longest ago (never run first), so the pool comes round in turn and no
 * task is learned by being there every night, as SWE-rebench keeps its tasks fresh. Ties go by a shuffle seeded with
 * the night.
 */
export function tonight(tasks: readonly EvalTask[], night: string, lastRuns: ReadonlyMap<string, string>, perNight: { change: number; locate: number } = PER_NIGHT): EvalTask[] {
	const shuffle = (name: string) => createHash("sha256").update(`${night}:${name}`).digest("hex");
	const order = (a: EvalTask, b: EvalTask) => (lastRuns.get(a.name) ?? "").localeCompare(lastRuns.get(b.name) ?? "") || shuffle(a.name).localeCompare(shuffle(b.name));
	const of = (kind: "change" | "locate") => tasks.filter((t) => (t.kind ?? "change") === kind).sort(order).slice(0, perNight[kind]);
	return [...of("change"), ...of("locate")];
}

if (import.meta.main) {
	const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
	// A benchmark never talks to Slack, so its tokens needn't resolve.
	delete process.env.SLACK_BOT_TOKEN;
	delete process.env.SLACK_APP_TOKEN;
	await resolveSecrets();
	const config = loadConfig();
	if (config.bench === undefined) {
		console.error("the benchmark is off: set SCOUT_BENCH_MODELS to the models to compare, like gateway/a,gateway/b");
		process.exit(2);
	}
	useScoutsKey(config.git.sshKey);
	const pool = loadTasks(config.bench.tasksDir).filter((t) => only === undefined || t.name.includes(only));
	if (pool.length === 0) {
		console.error(`no benchmark tasks in ${config.bench.tasksDir}${only === undefined ? "" : ` matching "${only}"`}`);
		process.exit(2);
	}
	const night = localDay(new Date());
	const store = new BenchStore(join(config.dataDir, "bench.sqlite"));
	// Tonight's draw is made before anything runs, so every model gets the same tasks.
	const tasks = only === undefined ? tonight(pool, night, store.lastRuns()) : pool;
	console.log(`bench: tonight's tasks: ${tasks.map((t) => t.name).join(", ")}`);
	const work = mkdtempSync(join(tmpdir(), "scout-bench-"));
	const host = await fakeCodeHost();
	let current: Awaited<ReturnType<typeof openScout>> | undefined;
	// Scout stops this run when it stops itself: leave no sandbox or copies behind. Stopping can bring the signal twice
	// (from systemd and from Scout), and the second mustn't cut the clean-up short.
	let stopping = false;
	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		process.on(signal, async () => {
			if (stopping) return;
			stopping = true;
			console.log(`bench: stopped (${signal}); what finished is kept`);
			await current?.workspaces.removeAll().catch(() => {});
			rmSync(work, { recursive: true, force: true });
			process.exit(1);
		});
	}
	try {
		const { repos, nameOf, fileAt } = await evalRepos(config, tasks, join(work, "repos"));
		for (const model of config.bench.models) {
			const name = `${model.provider}/${model.modelId}`;
			const dataDir = join(work, name.replace(/[^\w.-]/g, "-"));
			const measured = measures();
			const scout = (current = await openScout({
				config: evalConfig(config, { repos, profileDir: config.profileDir, apiUrl: host.apiUrl, dataDir, model }),
				storage: new MemoryStorage(),
				dataDir,
				instance: `bench${randomBytes(3).toString("hex")}`,
				context: BACKGROUND_CONTEXT,
				watchProfile: false,
				mcp: [],
				selfReviewed: measured.selfReviewed,
				modelStarted: measured.modelStarted,
			}));
			try {
				for (const task of tasks) {
					const result = await runTask(scout, task, nameOf(task), "candidate", BACKGROUND_CONTEXT, measured, { fileAt, limitMs: TASK_LIMIT_MS, wallMs: TASK_WALL_MS });
					console.log(`bench ${name} ${task.name}: ${result.pass ? "pass" : `fail (${result.why.slice(0, 300)})`}, $${result.cost.toFixed(3)}, ${Math.round(result.ms / 1000)}s, ${result.steps} steps`);
					// Kept as each task ends: what finished counts, even if the rest of the night doesn't.
					store.record([benchRow(name, night, task, result)]);
				}
			} finally {
				await scout.close();
			}
		}
	} finally {
		await host.close();
		store.close();
		rmSync(work, { recursive: true, force: true });
	}
	process.exit(0);
}
