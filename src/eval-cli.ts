import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { loadConfig, useScoutsKey } from "./config.ts";
import { evalConfig, evalRepos, fakeCodeHost, guard, loadTasks, report, type RunResult, runTask, type Side } from "./evals.ts";
import { forgeFor } from "./forge.ts";
import { openScout } from "./scout.ts";
import { resolveSecrets } from "./secrets.ts";

/**
 * Run Scout's eval tasks (evals.ts) with a profile, and optionally a baseline, and print the comparison.
 *
 *     npm run eval -- --profile ../scout-profile --baseline /tmp/profile-main --tries 3
 *     npm run eval -- --model gateway/stronger-model --only median
 *     npm run eval -- --profile . --baseline /tmp/main --comment jrimmer/scout-profile#7
 *
 * Tasks are read from the candidate profile's `evals/` (or `--tasks <dir>`). Prints progress to stderr and the report
 * to stdout; exits 1 if any run with the candidate failed.
 */
const USAGE =
	"usage: npm run eval -- [--profile dir] [--baseline dir] [--tasks dir] [--model provider/model] [--tries 3] [--only text] [--max-runs 60] [--yes] [--comment owner/repo#N]";

function flags(argv: string[]): Map<string, string | true> {
	const out = new Map<string, string | true>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (!arg.startsWith("--")) throw new Error(`unexpected ${arg}\n${USAGE}`);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) out.set(arg.slice(2), true);
		else {
			out.set(arg.slice(2), next);
			i++;
		}
	}
	return out;
}

if (import.meta.main) {
	let args: Map<string, string | true>;
	try {
		args = flags(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(2);
	}
	const text = (key: string) => (typeof args.get(key) === "string" ? (args.get(key) as string) : undefined);
	// An eval never talks to Slack, so its tokens needn't resolve.
	delete process.env.SLACK_BOT_TOKEN;
	delete process.env.SLACK_APP_TOKEN;
	await resolveSecrets();
	const config = loadConfig();
	useScoutsKey(config.git.sshKey);

	const candidate = resolve(text("profile") ?? config.profileDir);
	const baseline = text("baseline") === undefined ? undefined : resolve(text("baseline")!);
	const only = text("only");
	const tasks = loadTasks(resolve(text("tasks") ?? join(candidate, "evals"))).filter((t) => only === undefined || t.name.includes(only));
	if (tasks.length === 0) {
		console.error(`no eval tasks in ${text("tasks") ?? join(candidate, "evals")}${only === undefined ? "" : ` matching "${only}"`}`);
		process.exit(2);
	}
	const model = text("model");
	const [provider, ...rest] = model?.split("/") ?? [];
	const modelId = rest.join("/");
	if (model !== undefined && (provider === undefined || modelId === "")) {
		console.error(`--model must be provider/model, e.g. gateway/${config.model.modelId}`);
		process.exit(2);
	}
	const tries = Number(text("tries") ?? 3);
	const sides: Side[] = baseline === undefined ? ["candidate"] : ["candidate", "baseline"];
	const estimate = guard({ tasks: tasks.length, tries, sides: sides.length }, Number(text("max-runs") ?? 60), args.get("yes") === true);
	console.error(estimate.say);
	if (!estimate.ok) process.exit(2);

	const work = mkdtempSync(join(tmpdir(), "scout-eval-"));
	const host = await fakeCodeHost();
	const results: RunResult[] = [];
	try {
		const { repos, nameOf } = await evalRepos(config, tasks, join(work, "repos"));
		for (const side of sides) {
			const profileDir = side === "candidate" ? candidate : baseline!;
			const instance = `eval${randomBytes(3).toString("hex")}`;
			const dataDir = join(work, side);
			const scout = await openScout({
				config: evalConfig(config, { repos, profileDir, apiUrl: host.apiUrl, dataDir, ...(model === undefined ? {} : { model: { provider: provider!, modelId } }) }),
				storage: new MemoryStorage(),
				dataDir,
				instance,
				context: BACKGROUND_CONTEXT,
				watchProfile: false,
				mcp: [],
			});
			try {
				for (const task of tasks) {
					for (let n = 1; n <= tries; n++) {
						const result = await runTask(scout, task, nameOf(task), side, BACKGROUND_CONTEXT);
						const t = result.timing;
						const parts = t === undefined ? "" : ` (first token ${Math.round(t.firstToken / 1000)}s, model ${Math.round(t.model / 1000)}s, first tool ${Math.round(t.firstTool / 1000)}s, tools ${Math.round(t.tools / 1000)}s, retries ${Math.round(t.retries / 1000)}s, ${result.steps} steps)`;
						console.error(`${side} ${task.name} #${n}: ${result.pass ? "pass" : `fail (${result.why})`}, $${result.cost.toFixed(2)}, ${Math.round(result.ms / 1000)}s${parts}`);
						results.push(result);
					}
				}
			} finally {
				await scout.close();
			}
		}
	} finally {
		await host.close();
		rmSync(work, { recursive: true, force: true });
	}

	const markdown = report(results, sides);
	console.log(markdown);
	const comment = text("comment");
	if (comment !== undefined) {
		const m = /^([^/#]+\/[^/#]+)#(\d+)$/.exec(comment);
		if (m === null) console.error(`--comment must be owner/repo#N; not posting`);
		else await forgeFor(config.codeHost).comment(m[1]!, Number(m[2]), `**Eval results**\n\n${markdown}`);
	}
	process.exit(results.some((r) => r.side === "candidate" && !r.pass) ? 1 : 0);
}
