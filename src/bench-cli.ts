import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { BenchStore, benchRow } from "./bench.ts";
import { loadConfig, useScoutsKey } from "./config.ts";
import { evalConfig, evalRepos, fakeCodeHost, loadTasks, measures, runTask } from "./evals.ts";
import { localDay } from "./reflect.ts";
import { openScout } from "./scout.ts";
import { resolveSecrets } from "./secrets.ts";

/**
 * One night of the benchmark (bench.ts): every model in SCOUT_BENCH_MODELS runs each task in the bench directory once,
 * the way an eval runs (evals.ts: its own sandbox, a local copy of the repository, a stand-in code host), and a
 * summary of each run goes into the data directory's bench.sqlite. Scout starts it nightly; by hand:
 *
 *     npm run bench                  # every model, every task
 *     npm run bench -- --only ci     # tasks whose name has "ci" in it
 */

/**
 * As public benchmarks do, tasks have a time limit: 30 minutes of the model's own time (a task that needs more fails),
 * not counting time spent waiting for the provider's first tokens, and 90 minutes in all, so a slow provider can't
 * stretch a night into the day. A task stopped by that, or whose calls kept failing, isn't scored as the model's.
 */
const TASK_LIMIT_MS = 30 * 60_000;
const TASK_WALL_MS = 90 * 60_000;

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
	const tasks = loadTasks(config.bench.tasksDir).filter((t) => only === undefined || t.name.includes(only));
	if (tasks.length === 0) {
		console.error(`no benchmark tasks in ${config.bench.tasksDir}${only === undefined ? "" : ` matching "${only}"`}`);
		process.exit(2);
	}
	const night = localDay(new Date());
	const store = new BenchStore(join(config.dataDir, "bench.sqlite"));
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
