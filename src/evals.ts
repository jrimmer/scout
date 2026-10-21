import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord";
import { AssistantEntry, type ConversationId, watchEvents } from "@earendil-works/pi-durable";
import type { Config, RepoConfig } from "./config.ts";
import { ThreadDoc } from "./docs.ts";
import type { Scout } from "./scout.ts";

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
 */
export type EvalTask = {
	name: string;
	repo: string;
	ref: string;
	request: string;
	check: { command?: string; expect?: { changed?: string[]; unchanged?: string[] }; rubric?: string };
};

export type Side = "candidate" | "baseline";

/**
 * Where a run's time went: waiting on the model, in tools (the first call apart, since it makes the sandbox and the
 * clone), retrying the model, and checking afterwards (not part of `ms`).
 */
export type Timing = { model: number; tools: number; firstTool: number; retries: number; check: number };

export type RunResult = { task: string; side: Side; pass: boolean; why: string; cost: number; ms: number; steps: number; timing?: Timing };

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
	const parsed: EvalTask = {
		name: text("name"),
		repo: text("repo"),
		ref: text("ref"),
		request: text("request"),
		check: {
			...(typeof check.command === "string" && check.command.trim() !== "" ? { command: check.command } : {}),
			...(changed === undefined && unchanged === undefined ? {} : { expect: { ...(changed === undefined ? {} : { changed }), ...(unchanged === undefined ? {} : { unchanged }) } }),
			...(typeof check.rubric === "string" && check.rubric.trim() !== "" ? { rubric: check.rubric } : {}),
		},
	};
	if (parsed.check.command === undefined && parsed.check.expect === undefined && parsed.check.rubric === undefined) {
		throw new Error(`${file}: needs a check: a "command", an "expect", or a "rubric"`);
	}
	if (!/^[0-9a-f]{7,40}$/i.test(parsed.ref)) throw new Error(`${file}: "ref" must be a commit hash`);
	return parsed;
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
		const model = part((t) => t.model);
		const first = part((t) => t.firstTool);
		const tools = part((t) => t.tools);
		const retries = part((t) => t.retries);
		const other = Math.max(0, total - model - first - tools - retries);
		const share = (ms: number) => (total === 0 ? "" : ` (${Math.round((ms / total) * 100)}%)`);
		lines.push(
			"",
			`Where a run's ${time(total)} went, on average: the model ${time(model)}${share(model)}, the first tool call (making the sandbox and the clone) ${time(first)}${share(first)}, other tools ${time(tools)}${share(tools)}, retrying the model ${time(retries)}${share(retries)}, the rest ${time(other)}${share(other)}. Checking afterwards took ${time(part((t) => t.check))} more. ${Math.round(avg(timed, (r) => r.steps))} steps on average.`,
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
 * Scout's mirror when there is one (fast, offline), else from the repository itself.
 */
export async function evalRepos(config: Config, tasks: readonly EvalTask[], dir: string): Promise<{ repos: RepoConfig[]; nameOf: (task: EvalTask) => string }> {
	mkdirSync(dir, { recursive: true });
	const repos = new Map<string, RepoConfig>();
	const nameOf = (task: EvalTask) => `${task.repo}@${task.ref.slice(0, 12)}`;
	for (const task of tasks) {
		const name = nameOf(task);
		if (repos.has(name)) continue;
		const real = config.repos.find((r) => r.name === task.repo);
		if (real === undefined) throw new Error(`${task.name}: no repository named ${task.repo}; configured: ${config.repos.map((r) => r.name).join(", ")}`);
		const mirror = join(config.dataDir, "mirrors", `${real.name}.git`);
		const copy = join(dir, `${name.replace(/[^\w.-]/g, "-")}.git`);
		if (!existsSync(copy)) {
			await run("git", ["clone", "--quiet", "--bare", "--no-tags", existsSync(mirror) ? mirror : real.gitUrl, copy]);
			await run("git", ["-C", copy, "branch", "--force", "scout-eval", task.ref]);
		}
		repos.set(name, { ...real, name, gitUrl: copy, base: "scout-eval" });
	}
	return { repos: [...repos.values()], nameOf };
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
 */
export function evalConfig(base: Config, options: { repos: RepoConfig[]; profileDir: string; apiUrl: string; dataDir: string; model?: { provider: string; modelId: string } }): Config {
	const { mcpFile: _mcp, profileRepo: _profile, ...rest } = base;
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
 * before the sandbox goes. Pass means every check the task names passed.
 */
export async function runTask(scout: Scout, task: EvalTask, repoName: string, side: Side, context: Context): Promise<RunResult> {
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
	const timing: Timing = { model: 0, tools: 0, firstTool: 0, retries: 0, check: 0 };
	let modelFrom: number | undefined;
	let retryFrom: number | undefined;
	const toolFrom = new Map<string, { at: number; first: boolean }>();
	events.start(async (batch) => {
		const now = Date.now();
		for (const event of batch) {
			// Times are when the events arrive, which is close enough to see where minutes go.
			if (event.type === "message_start") modelFrom ??= now;
			if (event.type === "message_end" && modelFrom !== undefined) {
				timing.model += now - modelFrom;
				modelFrom = undefined;
			}
			if (event.type === "auto_retry_start") retryFrom ??= now;
			if (event.type === "auto_retry_end" && retryFrom !== undefined) {
				timing.retries += now - retryFrom;
				retryFrom = undefined;
			}
			if (event.type === "tool_execution_start" && event.parentToolCallId === undefined) toolFrom.set(event.toolCallId, { at: now, first: steps === 0 });
			if (event.type === "tool_execution_end" && event.parentToolCallId === undefined) {
				const from = toolFrom.get(event.toolCallId);
				if (from !== undefined) {
					if (from.first) timing.firstTool += now - from.at;
					else timing.tools += now - from.at;
					toolFrom.delete(event.toolCallId);
				}
			}
			if (event.type === "tool_execution_start" && event.parentToolCallId === undefined) steps++;
			if (event.type === "message_end") {
				const message = event.entry.model?.[0];
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
		const settled = await (await conversation.submit({ type: "input", content: task.request }, context)).wait(context);
		ran = Date.now();
		if (settled.status !== "done") {
			pass = false;
			why.push(`the run didn't finish (${settled.status})`);
		}
		const env = await scout.workspaces.env(conversation.id);
		const sh = async (command: string, timeout = 600) => {
			let output = "";
			const result = await env.exec(command, { onOutput: (t) => (output += t), timeout }, context);
			return { code: result.ok ? result.value.exitCode : 1, output: result.ok ? output : `${output}${String(result.error)}` };
		};
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
	return { task: task.name, side, pass, why: why.join("; ") || "passed", cost: scout.spend.spentOn(conversation.id, 0).cost, ms: ended - started - checked, steps, timing };
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
	const settled = await (await conversation.submit({ type: "input", content: prompt }, context)).wait(context);
	if (settled.status !== "done" || settled.type !== "input") return { pass: false, why: "the judge didn't answer" };
	const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	const text = (entry?.model?.[0] as { content?: { type: string; text?: string }[] } | undefined)?.content?.flatMap((b) => (b.type === "text" && b.text !== undefined ? [b.text] : [])).join("\n").trim() ?? "";
	const [first = "", ...rest] = text.split("\n");
	return { pass: /^\W*PASS\b/i.test(first), why: (rest.join(" ").trim() || first).slice(0, 300) };
}
