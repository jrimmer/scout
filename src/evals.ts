import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord";
import { AssistantEntry, type ConversationId, ProviderDoc, watchEvents } from "@earendil-works/pi-durable";
import type { Config, RepoConfig } from "./config.ts";
import { ThreadDoc } from "./docs.ts";
import type { Scout } from "./scout.ts";
import { copyIn } from "./workspaces.ts";

const run = promisify(execFile);

/**
 * Testing Scout's changes before they ship: a set of real tasks, each run in a fresh sandbox on its own copy of the
 * repository, with a way to tell whether it worked. Run with a proposed profile (or model) and with the current one,
 * a few times each, and compare: "Before: 7/10. After: 9/10. Better on: …". Nothing reaches the real code host or
 * Slack: each task works on a local copy, and pull requests go to a stand-in that only says yes.
 *
 * Tasks live in the profile repository under `evals/`, one JSON file each:
 *
 *     {
 *       "name": "fix-median-sorting",
 *       "repo": "playground",
 *       "ref": "<commit>",
 *       "request": "median sorts numbers as strings; fix it",
 *       "check": {
 *         "command": "python3 -m unittest",
 *         "expect": { "changed": ["tally/stats.py"], "unchanged": ["README.md"] },
 *         "rubric": "median sorts numerically and averages the middle pair on an even count"
 *       }
 *     }
 *
 * A task can also replay a real commit, as SWE-bench does: start from its parent, and judge the work by the commit's
 * own tests, put in place only after the work (`check.hidden`). Or ask where a bug is, without fixing it
 * (`kind: "locate"`): the failing test is there from the start (`given`), and the answer must name the file and
 * function the commit changed. A change can also name the repository's own tests (`check.suite`), to see whether it
 * broke anything that worked: SWE-bench's other half.
 */
export type Files = { ref: string; paths: string[] };

export type EvalTask = {
	name: string;
	repo: string;
	ref: string;
	request: string;
	/** "change" (the default): Scout does the work. "locate": Scout says where the bug is, and changes nothing. */
	kind?: "change" | "locate";
	/** Files from another commit, in place before the work starts: a failing test, say. */
	given?: Files;
	check: {
		command?: string;
		expect?: { changed?: string[]; unchanged?: string[] };
		rubric?: string;
		/** Files from another commit put in place after the work, before `command`: tests the work didn't see. */
		hidden?: Files;
		/** For "locate": the file, and the functions any one of which is right. */
		locate?: { file: string; functions: string[] };
		/**
		 * The repository's tests, run after a change that changed something, with the hidden files in place: whether the
		 * change broke what worked. It should leave out the hidden tests themselves (they're `command`'s, e.g. with
		 * `go test -skip`). Not part of passing; the benchmark scores it apart.
		 */
		suite?: string;
	};
};

/** What a "locate" task's answer must end with, appended to its request. */
export const LOCATE_FORMAT = "Don't change any files. End your answer with one line: `LOCATION: <file path> <function name>`.";

export type Side = "candidate" | "baseline";

/** What Scout measures as a run goes that the run's events don't show: set up by eval-cli's `openScout`. */
/** `waited`: all first-token waits so far, every session's, for telling a model's own time from a provider's. */
export type Measures = { selfReviews: Map<number, number>; modelStarts: Map<string, number[]>; waited: { ms: number } };

export function measures(): Measures & { selfReviewed: (id: number, ms: number) => void; modelStarted: (session: string, ms: number) => void } {
	const m: Measures = { selfReviews: new Map(), modelStarts: new Map(), waited: { ms: 0 } };
	return {
		...m,
		selfReviewed: (id, ms) => m.selfReviews.set(id, (m.selfReviews.get(id) ?? 0) + ms),
		modelStarted: (session, ms) => {
			const calls = m.modelStarts.get(session) ?? [];
			calls.push(ms);
			m.modelStarts.set(session, calls);
			m.waited.ms += ms;
		},
	};
}

/**
 * Where a run's time went: waiting on the model, in tools (the first call apart, since it makes the sandbox and the
 * clone), retrying the model, and checking afterwards (not part of `ms`).
 */
export type Timing = {
	/**
	 * Model calls from being sent to their first token (the gateway queueing, the model starting up), timed on the
	 * stream itself. The self-review's calls are in `selfReview`.
	 */
	firstToken: number;
	/** The answer arriving, start to end. */
	model: number;
	/** Tool time, the first call and the self-reviews apart. */
	tools: number;
	firstTool: number;
	/** Pull requests' self-reviews: model runs of their own, inside `open_pull_request`. */
	selfReview: number;
	retries: number;
	check: number;
	/** Tool time by tool name (the first call included, the self-reviews not). */
	byTool: Record<string, { calls: number; ms: number }>;
};

/** What a run used, for the benchmark (bench.ts): tool calls and the malformed ones, model calls, tokens, retries. */
export type Usage = {
	toolCalls: number;
	/** Calls with arguments that didn't fit the tool, or to a tool that doesn't exist. */
	badToolCalls: number;
	modelCalls: number;
	retries: number;
	inputTokens: number;
	outputTokens: number;
	/** Each model call's time to its first token, in ms. */
	firstTokens: number[];
};

/**
 * `unscored`: why a run says nothing about the model, so the benchmark leaves it out of what the model can do: the
 * provider kept it waiting past the wall-clock limit, or its calls kept failing. `regressed`: whether a change broke the
 * repository's tests (`check.suite`), when there was a change to run them on.
 */
export type RunResult = { task: string; side: Side; pass: boolean; why: string; cost: number; ms: number; steps: number; timing?: Timing; usage?: Usage; unscored?: string; regressed?: boolean };

/** The tasks in `dir` (`*.json`), checked; a file that isn't a task is an error that names it. */
export function loadTasks(dir: string): EvalTask[] {
	if (!existsSync(dir)) return [];
	const tasks: EvalTask[] = [];
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
		} catch (error) {
			throw new Error(`${file}: not valid JSON (${error instanceof Error ? error.message : error})`);
		}
		tasks.push(parseTask(raw, file));
	}
	const names = new Set<string>();
	for (const task of tasks) {
		if (names.has(task.name)) throw new Error(`two tasks are named ${task.name}`);
		names.add(task.name);
	}
	return tasks;
}

export function parseTask(raw: unknown, file: string): EvalTask {
	const t = raw as Record<string, unknown>;
	const text = (key: string) => {
		const value = t?.[key];
		if (typeof value !== "string" || value.trim() === "") throw new Error(`${file}: "${key}" must be a non-empty string`);
		return value.trim();
	};
	const check = (t?.check ?? {}) as Record<string, unknown>;
	const expect = (check.expect ?? {}) as Record<string, unknown>;
	const list = (value: unknown, key: string) => {
		if (value === undefined) return undefined;
		if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new Error(`${file}: "check.expect.${key}" must be a list of paths`);
		return value as string[];
	};
	const changed = list(expect.changed, "changed");
	const unchanged = list(expect.unchanged, "unchanged");
	const files = (value: unknown, key: string): Files | undefined => {
		if (value === undefined) return undefined;
		const f = value as { ref?: unknown; paths?: unknown };
		if (typeof f.ref !== "string" || !HASH.test(f.ref)) throw new Error(`${file}: "${key}.ref" must be a commit hash`);
		if (!Array.isArray(f.paths) || f.paths.length === 0 || f.paths.some((p) => typeof p !== "string" || p === "")) throw new Error(`${file}: "${key}.paths" must be a list of paths`);
		return { ref: f.ref, paths: f.paths as string[] };
	};
	const kind = t?.kind ?? "change";
	if (kind !== "change" && kind !== "locate") throw new Error(`${file}: "kind" must be "change" or "locate"`);
	const given = files(t?.given, "given");
	const hidden = files(check.hidden, "check.hidden");
	const where = check.locate as { file?: unknown; functions?: unknown } | undefined;
	if (where !== undefined && (typeof where.file !== "string" || !Array.isArray(where.functions) || where.functions.length === 0 || where.functions.some((f) => typeof f !== "string"))) {
		throw new Error(`${file}: "check.locate" needs a "file" and a list of "functions"`);
	}
	const parsed: EvalTask = {
		name: text("name"),
		repo: text("repo"),
		ref: text("ref"),
		request: text("request"),
		...(kind === "locate" ? { kind } : {}),
		...(given === undefined ? {} : { given }),
		check: {
			...(typeof check.command === "string" && check.command.trim() !== "" ? { command: check.command } : {}),
			...(changed === undefined && unchanged === undefined ? {} : { expect: { ...(changed === undefined ? {} : { changed }), ...(unchanged === undefined ? {} : { unchanged }) } }),
			...(typeof check.rubric === "string" && check.rubric.trim() !== "" ? { rubric: check.rubric } : {}),
			...(hidden === undefined ? {} : { hidden }),
			...(where === undefined ? {} : { locate: { file: where.file as string, functions: where.functions as string[] } }),
			...(typeof check.suite === "string" && check.suite.trim() !== "" ? { suite: check.suite } : {}),
		},
	};
	if (parsed.check.command === undefined && parsed.check.expect === undefined && parsed.check.rubric === undefined && parsed.check.locate === undefined) {
		throw new Error(`${file}: needs a check: a "command", an "expect", a "rubric", or a "locate"`);
	}
	if (kind === "locate" && parsed.check.locate === undefined) throw new Error(`${file}: a "locate" task needs "check.locate"`);
	if (!HASH.test(parsed.ref)) throw new Error(`${file}: "ref" must be a commit hash`);
	return parsed;
}

const HASH = /^[0-9a-f]{7,40}$/i;

/**
 * Whether a "locate" answer named the right place: its last `LOCATION: <file> <function>` line, the file as the task
 * has it (a leading `./` aside), and one of its functions (`Class.method` and `Class#method` count as `method`).
 */
export function located(answer: string, want: { file: string; functions: string[] }): { pass: boolean; why: string } {
	const lines = [...answer.matchAll(/LOCATION:\s*`?([^\s`]+)`?\s+`?([^\s`(]+)/gi)];
	const last = lines.at(-1);
	if (last === undefined) return { pass: false, why: "the answer has no LOCATION line" };
	const file = last[1]!.replace(/^\.\//, "");
	const name = last[2]!.split(/[.#]/).pop()!;
	if (file !== want.file) return { pass: false, why: `named ${file}, not ${want.file}` };
	if (!want.functions.includes(name)) return { pass: false, why: `named ${name} in ${file}, not ${want.functions.join(" or ")}` };
	return { pass: true, why: "passed" };
}

/**
 * How many runs a set costs, and whether to start: past `maxRuns` it needs `yes`. Each run is a whole task with the
 * model, so this is the line between a quick check and a surprise bill.
 */
export function guard(runs: { tasks: number; tries: number; sides: number }, maxRuns: number, yes: boolean): { runs: number; ok: boolean; say: string } {
	const total = runs.tasks * runs.tries * runs.sides;
	const say = `${runs.tasks} task${runs.tasks === 1 ? "" : "s"} × ${runs.tries} tr${runs.tries === 1 ? "y" : "ies"} × ${runs.sides} side${runs.sides === 1 ? "" : "s"} = ${total} run${total === 1 ? "" : "s"}`;
	if (total > maxRuns && !yes) return { runs: total, ok: false, say: `${say}, more than --max-runs ${maxRuns}. Add --yes to go ahead, or narrow it with --only or --tries.` };
	return { runs: total, ok: true, say };
}

/** The comparison, as Markdown: passes per task for each side, average cost and time, totals, and what changed. */
export function report(results: readonly RunResult[], sides: readonly Side[]): string {
	const tasks = [...new Set(results.map((r) => r.task))];
	const of = (task: string, side: Side) => results.filter((r) => r.task === task && r.side === side);
	const passes = (rs: readonly RunResult[]) => rs.filter((r) => r.pass).length;
	const avg = (rs: readonly RunResult[], f: (r: RunResult) => number) => (rs.length === 0 ? 0 : rs.reduce((n, r) => n + f(r), 0) / rs.length);
	const money = (n: number) => `$${n.toFixed(2)}`;
	const time = (ms: number) => {
		const s = Math.round(ms / 1000);
		return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}`;
	};
	const label = (side: Side) => (side === "candidate" ? "With the change" : "Before");
	const ordered: Side[] = sides.includes("baseline") ? ["baseline", "candidate"] : ["candidate"];
	const head = `| Task | ${ordered.map((s) => `${label(s)} | Cost | Time`).join(" | ")} |`;
	const rule = `|---|${ordered.map(() => "---|---|---").join("|")}|`;
	const rows = tasks.map((task) => {
		const cells = ordered.map((side) => {
			const rs = of(task, side);
			return `${passes(rs)}/${rs.length} | ${money(avg(rs, (r) => r.cost))} | ${time(avg(rs, (r) => r.ms))}`;
		});
		return `| ${task} | ${cells.join(" | ")} |`;
	});
	const totals = ordered.map((side) => {
		const rs = results.filter((r) => r.side === side);
		return `${passes(rs)}/${rs.length} | ${money(rs.reduce((n, r) => n + r.cost, 0))} | ${time(avg(rs, (r) => r.ms))}`;
	});
	const lines = [head, rule, ...rows, `| **All** | ${totals.join(" | ")} |`];
	if (ordered.length === 2) {
		const rate = (task: string, side: Side) => {
			const rs = of(task, side);
			return rs.length === 0 ? 0 : passes(rs) / rs.length;
		};
		const better = tasks.filter((t) => rate(t, "candidate") > rate(t, "baseline"));
		const worse = tasks.filter((t) => rate(t, "candidate") < rate(t, "baseline"));
		lines.push("", `Better on: ${better.length === 0 ? "nothing" : better.join(", ")}. Worse on: ${worse.length === 0 ? "nothing" : worse.join(", ")}.`);
	}
	const timed = results.filter((r) => r.timing !== undefined);
	if (timed.length > 0) {
		const part = (f: (t: Timing) => number) => avg(timed, (r) => f(r.timing!));
		const total = avg(timed, (r) => r.ms);
		const firstToken = part((t) => t.firstToken);
		const model = part((t) => t.model);
		const first = part((t) => t.firstTool);
		const tools = part((t) => t.tools);
		const review = part((t) => t.selfReview ?? 0);
		const retries = part((t) => t.retries);
		const other = Math.max(0, total - firstToken - model - first - tools - review - retries);
		const byTool = new Map<string, { calls: number; ms: number }>();
		for (const r of timed) for (const [name, t] of Object.entries(r.timing!.byTool)) {
			const sum = byTool.get(name) ?? { calls: 0, ms: 0 };
			sum.calls += t.calls;
			sum.ms += t.ms;
			byTool.set(name, sum);
		}
		const toolLine = [...byTool].sort((a, b) => b[1].ms - a[1].ms).map(([name, t]) => `${name} ${t.calls}× ${time(t.ms / t.calls)} each`).join(", ");
		const share = (ms: number) => (total === 0 ? "" : ` (${Math.round((ms / total) * 100)}%)`);
		lines.push(
			"",
			`Where a run's ${time(total)} went, on average: waiting for the model's first token ${time(firstToken)}${share(firstToken)}, the model answering ${time(model)}${share(model)}, the first tool call (making the sandbox and the clone) ${time(first)}${share(first)}, other tools ${time(tools)}${share(tools)}, self-reviewing pull requests ${time(review)}${share(review)}, retrying the model ${time(retries)}${share(retries)}, the rest ${time(other)}${share(other)}. Checking afterwards took ${time(part((t) => t.check))} more. ${Math.round(avg(timed, (r) => r.steps))} steps on average.`,
			...(toolLine === "" ? [] : ["", `Tools: ${toolLine}.`]),
		);
	}
	const failures = results.filter((r) => !r.pass);
	if (failures.length > 0) {
		lines.push("", "<details><summary>Why runs failed</summary>", "", ...failures.map((r) => `- ${r.task} (${label(r.side).toLowerCase()}): ${r.why}`), "", "</details>");
	}
	return lines.join("\n");
}

/**
 * A copy of the repository at each task's commit, on a branch of its own, as a configured repository named
 * `<repo>@<commit>`: what the run clones, and where its pull request goes, so nothing leaves this host. Made from
 * Scout's mirror when there is one (fast, offline), else from the repository itself. A task's `given` files are a
 * commit on top, so the run starts with them. `fileAt` reads a file at any commit of a task's copy.
 */
export async function evalRepos(
	config: Config,
	tasks: readonly EvalTask[],
	dir: string,
): Promise<{ repos: RepoConfig[]; nameOf: (task: EvalTask) => string; fileAt: (task: EvalTask, ref: string, path: string) => Promise<Buffer> }> {
	mkdirSync(dir, { recursive: true });
	const repos = new Map<string, RepoConfig>();
	const copies = new Map<string, string>();
	const nameOf = (task: EvalTask) => `${task.repo}@${task.ref.slice(0, 12)}${task.given === undefined ? "" : `+${task.given.ref.slice(0, 12)}`}`;
	for (const task of tasks) {
		const name = nameOf(task);
		if (repos.has(name)) continue;
		const real = config.repos.find((r) => r.name === task.repo);
		if (real === undefined) throw new Error(`${task.name}: no repository named ${task.repo}; configured: ${config.repos.map((r) => r.name).join(", ")}`);
		const mirror = join(config.dataDir, "mirrors", `${real.name}.git`);
		const copy = join(dir, `${name.replace(/[^\w.-]/g, "-")}.git`);
		if (!existsSync(copy)) {
			await run("git", ["clone", "--quiet", "--bare", "--no-tags", existsSync(mirror) ? mirror : real.gitUrl, copy]);
			await run("git", ["-C", copy, "branch", "--force", "scout-eval", await withGiven(copy, task)]);
		}
		copies.set(name, copy);
		repos.set(name, { ...real, name, gitUrl: copy, base: "scout-eval" });
	}
	const fileAt = async (task: EvalTask, ref: string, path: string) => {
		const { stdout } = await run("git", ["-C", copies.get(nameOf(task))!, "show", `${ref}:${path}`], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
		return stdout;
	};
	return { repos: [...repos.values()], nameOf, fileAt };
}

/** The commit a task's run starts from: its `ref`, or a commit on it adding the `given` files as they are at theirs. */
async function withGiven(copy: string, task: EvalTask): Promise<string> {
	if (task.given === undefined) return task.ref;
	const index = join(copy, "scout-eval-index");
	const env = { ...process.env, GIT_INDEX_FILE: index };
	await run("git", ["-C", copy, "read-tree", task.ref], { env });
	for (const path of task.given.paths) {
		const { stdout: blob } = await run("git", ["-C", copy, "rev-parse", `${task.given.ref}:${path}`]);
		await run("git", ["-C", copy, "update-index", "--add", "--cacheinfo", `100644,${blob.trim()},${path}`], { env });
	}
	const { stdout: tree } = await run("git", ["-C", copy, "write-tree"], { env });
	const ident = { ...process.env, GIT_AUTHOR_NAME: "eval", GIT_AUTHOR_EMAIL: "eval@invalid", GIT_COMMITTER_NAME: "eval", GIT_COMMITTER_EMAIL: "eval@invalid" };
	const { stdout: commit } = await run("git", ["-C", copy, "commit-tree", tree.trim(), "-p", task.ref, "-m", "Files the task starts with"], { env: ident });
	return commit.trim();
}

/** A stand-in code host that agrees to open any pull request, so a run can finish without reaching the real one. */
export async function fakeCodeHost(): Promise<{ apiUrl: string; close: () => Promise<void> }> {
	let number = 0;
	const server: Server = createServer((req, res) => {
		res.setHeader("content-type", "application/json");
		const path = new URL(req.url ?? "/", "http://eval").pathname;
		const pulls = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(path);
		if (pulls && req.method === "POST") {
			number++;
			res.writeHead(201).end(JSON.stringify({ html_url: `http://eval.invalid/${pulls[1]}/pulls/${number}`, number }));
			return;
		}
		if (req.method === "GET") {
			res.writeHead(200).end(path === "/user" ? JSON.stringify({ login: "scout" }) : "[]");
			return;
		}
		res.writeHead(200).end("{}");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	return {
		apiUrl: `http://127.0.0.1:${port}`,
		close: () => {
			server.closeAllConnections();
			return new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

/**
 * The configuration a side runs with: Scout's own, but working on the tasks' local copies, against the stand-in
 * code host, with `profileDir` as its profile (and no profile repository to pull), no MCP servers, and its own data.
 * No fallback models either: a run measures its own model, failing or not.
 */
export function evalConfig(base: Config, options: { repos: RepoConfig[]; profileDir: string; apiUrl: string; dataDir: string; model?: { provider: string; modelId: string } }): Config {
	const { mcpFile: _mcp, profileRepo: _profile, fallback: _fallback, ...rest } = base;
	return {
		...rest,
		dataDir: options.dataDir,
		profileDir: options.profileDir,
		repos: options.repos,
		repo: options.repos[0] ?? base.repo,
		codeHost: { ...base.codeHost, apiUrl: options.apiUrl, token: "eval" },
		...(options.model === undefined ? {} : { model: options.model }),
	};
}

/**
 * One run of one task: a new conversation in the task's repository, the request, then the checks in its sandbox
 * before the sandbox goes. Pass means every check the task names passed. `fileAt` (from `evalRepos`) supplies a
 * task's hidden files. Past `limitMs` of the model's own time (waits for first tokens, with `measured`, and retries
 * aside) the run is stopped and fails; past `wallMs` in all, it's stopped and left unscored, as the provider's doing.
 */
export async function runTask(
	scout: Scout,
	task: EvalTask,
	repoName: string,
	side: Side,
	context: Context,
	measured?: Measures,
	options: { fileAt?: (task: EvalTask, ref: string, path: string) => Promise<Uint8Array>; limitMs?: number; wallMs?: number } = {},
): Promise<RunResult> {
	const { fileAt, limitMs, wallMs } = options;
	let unscored: string | undefined;
	let regressed: boolean | undefined;
	let failedCall: string | undefined;
	const started = Date.now();
	const conversation = await scout.harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: scout.workAgent,
			init: async (tx, id) => {
				(await tx.doc(ThreadDoc, id)).repo = repoName;
			},
		},
		context,
	);
	const events = await watchEvents(scout.harness, conversation.id as ConversationId, context);
	let answer = "";
	let steps = 0;
	const usage: Usage = { toolCalls: 0, badToolCalls: 0, modelCalls: 0, retries: 0, inputTokens: 0, outputTokens: 0, firstTokens: [] };
	const timing: Timing = { firstToken: 0, model: 0, tools: 0, firstTool: 0, selfReview: 0, retries: 0, check: 0, byTool: {} };
	let modelFrom: number | undefined;
	let retryFrom: number | undefined;
	const toolFrom = new Map<string, { at: number; first: boolean; name: string }>();
	events.start(async (batch) => {
		const now = Date.now();
		for (const event of batch) {
			// Times are when the events arrive, which is close enough to see where minutes go.
			if (event.type === "message_start") modelFrom ??= now;
			if (event.type === "message_end" && modelFrom !== undefined) {
				timing.model += now - modelFrom;
				modelFrom = undefined;
			}
			if (event.type === "auto_retry_start") {
				usage.retries++;
				retryFrom ??= now;
			}
			if (event.type === "auto_retry_end" && retryFrom !== undefined) {
				timing.retries += now - retryFrom;
				retryFrom = undefined;
			}
			if (event.type === "tool_execution_start" && event.parentToolCallId === undefined) toolFrom.set(event.toolCallId, { at: now, first: steps === 0, name: event.toolName });
			if (event.type === "tool_execution_end" && event.parentToolCallId === undefined) {
				usage.toolCalls++;
				const diagnostics = (event.entry?.data as { diagnostics?: { code?: string }[] } | undefined)?.diagnostics ?? [];
				if (diagnostics.some((d) => d.code === "invalid_arguments" || d.code === "tool_unavailable")) usage.badToolCalls++;
				const from = toolFrom.get(event.toolCallId);
				if (from !== undefined) {
					const t = (timing.byTool[from.name] ??= { calls: 0, ms: 0 });
					t.calls++;
					t.ms += now - from.at;
					if (from.first) timing.firstTool += now - from.at;
					else timing.tools += now - from.at;
					toolFrom.delete(event.toolCallId);
				}
			}
			if (event.type === "tool_execution_start" && event.parentToolCallId === undefined) steps++;
			if (event.type === "message_end") {
				const message = event.entry.model?.[0];
				const stop = message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
				failedCall = stop?.role === "assistant" && stop.stopReason === "error" ? (stop.errorMessage ?? "no reason given").slice(0, 200) : undefined;
				if (message?.role === "assistant") {
					const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
					if (text !== "") answer = text;
				}
			}
		}
	});
	const why: string[] = [];
	let pass = true;
	let ran: number | undefined;
	try {
		const request = task.kind === "locate" ? `${task.request}\n\n${LOCATE_FORMAT}` : task.request;
		let stopped: string | undefined;
		const waitedBefore = measured?.waited.ms ?? 0;
		const watch =
			limitMs === undefined && wallMs === undefined
				? undefined
				: setInterval(() => {
						const elapsed = Date.now() - started;
						// The provider's time isn't the model's: waits for first tokens, and retrying its failed calls.
						const retrying = timing.retries + (retryFrom === undefined ? 0 : Date.now() - retryFrom);
						const own = elapsed - ((measured?.waited.ms ?? 0) - waitedBefore) - retrying;
						if (wallMs !== undefined && elapsed > wallMs) stopped = `the provider kept it waiting: not done within ${Math.round(wallMs / 60_000)} minutes`;
						else if (limitMs !== undefined && own > limitMs) stopped = `the model's own time passed ${Math.round(limitMs / 60_000)} minutes (waiting on the provider aside)`;
						if (stopped !== undefined) {
							clearInterval(watch);
							void conversation.abort(context).catch(() => {});
						}
					}, Math.min(5_000, limitMs ?? 5_000, wallMs ?? 5_000) / 5);
		const settled = await (await conversation.submit({ type: "input", content: request }, context)).wait(context).finally(() => clearInterval(watch));
		ran = Date.now();
		if (stopped !== undefined) {
			pass = false;
			why.push(stopped);
			if (stopped.startsWith("the provider")) unscored = stopped;
		} else if (settled.status !== "done" || failedCall !== undefined) {
			pass = false;
			why.push(failedCall === undefined ? `the run didn't finish (${settled.status})` : `the model's calls kept failing: ${failedCall}`);
			if (failedCall !== undefined) unscored = `the model's calls kept failing`;
		}
		const env = await scout.workspaces.env(conversation.id);
		const sh = async (command: string, timeout = 600) => {
			let output = "";
			const result = await env.exec(command, { onOutput: (t) => (output += t), timeout }, context);
			return { code: result.ok ? result.value.exitCode : 1, output: result.ok ? output : `${output}${String(result.error)}` };
		};
		const changed = task.check.suite !== undefined && (await sh(`git diff --name-only ${task.ref}; git ls-files --others --exclude-standard`, 60)).output.trim() !== "";
		// The hidden tests go in before the suite too: a fix can change or delete tests that held the old behaviour, so
		// their old versions would fail a right answer. The suite leaves the hidden tests themselves to `command`.
		if (task.check.hidden !== undefined) {
			if (fileAt === undefined) throw new Error("a task with hidden files needs fileAt");
			const root = (await sh("pwd", 30)).output.trim();
			for (const path of task.check.hidden.paths) await copyIn(env, `${root}/${path}`, await fileAt(task, task.check.hidden.ref, path));
		}
		if (changed) {
			const { code, output } = await sh(task.check.suite!, 900);
			regressed = code !== 0;
			if (regressed) why.push(`the change broke the repository's tests: ${output.trim().split("\n").slice(-3).join(" ").slice(0, 300)}`);
		}
		if (task.check.command !== undefined) {
			const { code, output } = await sh(task.check.command);
			if (code !== 0) {
				pass = false;
				why.push(`\`${task.check.command}\` exited ${code}: ${output.trim().split("\n").slice(-3).join(" ").slice(0, 300)}`);
			}
		}
		if (task.check.expect !== undefined) {
			const { output } = await sh(`git diff --name-only ${task.ref}; git ls-files --others --exclude-standard`, 60);
			const touched = new Set(output.split("\n").map((l) => l.trim()).filter(Boolean));
			for (const path of task.check.expect.changed ?? []) {
				if (!touched.has(path)) {
					pass = false;
					why.push(`${path} should have changed and didn't`);
				}
			}
			for (const path of task.check.expect.unchanged ?? []) {
				if (touched.has(path)) {
					pass = false;
					why.push(`${path} changed and shouldn't have`);
				}
			}
		}
		if (task.check.locate !== undefined) {
			const verdict = located(answer, task.check.locate);
			if (!verdict.pass) {
				pass = false;
				why.push(verdict.why);
			}
		}
		if (task.check.rubric !== undefined) {
			const { output: diff } = await sh(`git diff ${task.ref}`, 60);
			const verdict = await judge(scout, task, answer, diff, context);
			if (!verdict.pass) {
				pass = false;
				why.push(`rubric: ${verdict.why}`);
			}
		}
	} catch (error) {
		pass = false;
		why.push(`the run broke: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		await events.stop();
		await scout.workspaces.remove(conversation.id).catch(() => {});
	}
	const ended = Date.now();
	const checked = typeof ran === "number" ? ended - ran : 0;
	timing.check = checked;
	if (measured !== undefined) {
		const session = (await scout.harness.snapshot(ProviderDoc, conversation.id as ConversationId, context).catch(() => undefined))?.sessionId;
		usage.firstTokens = session === undefined ? [] : (measured.modelStarts.get(session) ?? []);
		timing.firstToken = usage.firstTokens.reduce((sum, ms) => sum + ms, 0);
		// The self-review runs inside open_pull_request: its time comes out of that tool's, to be shown apart.
		timing.selfReview = measured.selfReviews.get(conversation.id) ?? 0;
		const pull = timing.byTool.open_pull_request;
		if (pull !== undefined) pull.ms = Math.max(0, pull.ms - timing.selfReview);
		timing.tools = Math.max(0, timing.tools - timing.selfReview);
	}
	const spent = scout.spend.spentOn(conversation.id, 0);
	usage.modelCalls = spent.calls;
	usage.inputTokens = spent.input;
	usage.outputTokens = spent.output;
	// A run that never reached a model (one that isn't set up, say) says nothing about the model.
	if (!pass && unscored === undefined && spent.calls === 0 && steps === 0) unscored = "no model call was made";
	return { task: task.name, side, pass, why: why.join("; ") || "passed", cost: spent.cost, ms: ended - started - checked, steps, timing, usage, ...(unscored === undefined ? {} : { unscored }), ...(regressed === undefined ? {} : { regressed }) };
}

/** Did the work meet the task's rubric? A model call with no tools: PASS or FAIL, and one line why. */
async function judge(scout: Scout, task: EvalTask, answer: string, diff: string, context: Context): Promise<{ pass: boolean; why: string }> {
	const conversation = await scout.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: scout.workAgent.model!, extensions: [] } }, context);
	const prompt = [
		"You are checking whether a piece of work meets an expectation. Judge only against the expectation.",
		`The request: ${task.request}`,
		`The expectation: ${task.check.rubric}`,
		`The answer given:\n${answer.slice(0, 4_000) || "(none)"}`,
		`The change made (a diff):\n${diff.slice(0, 20_000) || "(no change)"}`,
		"Reply with PASS or FAIL on the first line, then one line saying why.",
	].join("\n\n");
	// Pi asks for a workspace for every conversation that runs, so the judge gets a sandbox it doesn't use: it goes after.
	const settled = await (await conversation.submit({ type: "input", content: prompt }, context))
		.wait(context)
		.finally(() => scout.workspaces.remove(conversation.id).catch(() => {}));
	if (settled.status !== "done" || settled.type !== "input") return { pass: false, why: "the judge didn't answer" };
	const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	const text = (entry?.model?.[0] as { content?: { type: string; text?: string }[] } | undefined)?.content?.flatMap((b) => (b.type === "text" && b.text !== undefined ? [b.text] : [])).join("\n").trim() ?? "";
	const [first = "", ...rest] = text.split("\n");
	return { pass: /^\W*PASS\b/i.test(first), why: (rest.join(" ").trim() || first).slice(0, 300) };
}
