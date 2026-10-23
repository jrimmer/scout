import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { Config } from "./config.ts";
import { ThreadDoc } from "./docs.ts";
import { type EvalTask, evalConfig, evalRepos, fakeCodeHost, loadTasks } from "./evals.ts";
import { openScout, type Scout } from "./scout.ts";
import { Mirror } from "./sandbox.ts";
import { copyIn } from "./workspaces.ts";

const run = promisify(execFile);

/**
 * Finding the benchmark's tasks (bench.ts) in the team's own work, as SWE-bench finds its own: fixes merged into a
 * repository's base branch that came with tests. A candidate is a commit whose subject says it fixes something, that
 * changes a few source files of one language and the tests that show it. It's kept only if, in a sandbox, its tests
 * fail on its parent (and not because they don't build: tests of something the fix adds would ask for what the request
 * can't say) and pass with the fix. Each makes a change task (the fix's tests hidden until after the work, its
 * description as the request) and, when it fixed one file, a locate task (its tests given; which functions it changed).
 *
 * Fixes that Scout's own pull requests made count the same, and so does a thread where someone corrected Scout, once
 * the corrected fix is merged.
 *
 * Tasks go to the tasks directory, which is private to the install: the repositories are, so nothing about a task is
 * shown anywhere else. What was tried is kept beside them in mined.jsonl, so no commit is tried twice. The nightly
 * benchmark tries a few new ones before it runs (bench-cli.ts); by hand, on Scout's host:
 *
 *     npm run bench:mine                          # up to 20 commits
 *     npm run bench:mine -- --max 50 --repo spoond
 */

/** What a language's fixes look like, and how its tests run. Only languages the team's repositories use. */
type Lang = {
	/** Git's own diff driver for the language, whose hunk headers name the function a change is in. */
	driver: string;
	source: RegExp;
	/** Test files, and what only tests use (fixtures, helpers): given or hidden with them. */
	test: RegExp;
	/** Test files proper, so a commit that only touched fixtures doesn't count. */
	tests: RegExp;
	/** The file that marks where its tests run from: a Go module, a Mix project. */
	root: string;
	/** A function's name in a declaration line or hunk header. */
	func: RegExp;
	/** A test's name in a test file's declaration line or hunk header. */
	testName: RegExp;
	/** Running some tests: from `root`, these files (relative to it), and these tests by name if any. */
	command: (files: string[], names: string[]) => string;
	/** The tests of the packages a fix changed, from `root`, if the language has a cheap way to run them. */
	suite?: (dirs: string[]) => string;
	/** Output that says the tests didn't build, rather than that they failed. */
	broken: RegExp;
};

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const LANGS: Record<string, Lang> = {
	go: {
		driver: "golang",
		source: /\.go$/,
		test: /_test\.go$|(^|\/)testdata\//,
		tests: /_test\.go$/,
		root: "go.mod",
		func: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
		testName: /^\s*func\s+(Test\w+)\s*\(/,
		command: (files, names) => {
			const dirs = [...new Set(files.map((f) => `./${posix.dirname(f)}`))];
			return `go test -count=1 ${names.length === 0 ? "" : `-run ${quote(`^(${names.join("|")})$`)} `}${dirs.map(quote).join(" ")}`;
		},
		suite: (dirs) => `go test -count=1 ${dirs.map((d) => quote(`./${d}`)).join(" ")}`,
		broken: /\[(build|setup) failed\]|^# \S+$|\bundefined: /m,
	},
	elixir: {
		driver: "elixir",
		source: /\.exs?$/,
		test: /_test\.exs$|(^|\/)test\//,
		tests: /_test\.exs$/,
		root: "mix.exs",
		func: /^\s*defp?\s+([a-z_][\w?!]*)/,
		testName: /^\s*test\s+"([^"]+)"/,
		command: (files) => `{ mix deps.get >/dev/null 2>&1 || true; }; MIX_ENV=test mix test ${files.map(quote).join(" ")}`,
		broken: /CompileError|UndefinedFunctionError|undefined function|is not available|could not compile/,
	},
};

/** Fixes too big to be a night's task (or to say where in one place) aren't candidates. */
const MAX_SOURCE_FILES = 4;
const MAX_SOURCE_LINES = 200;

/** One commit as a candidate: what it changed, sorted into the language's sources and tests. */
export type Candidate = {
	repo: string;
	commit: string;
	parent: string;
	subject: string;
	body: string;
	lang: string;
	/** Source files changed, not deleted. */
	sources: string[];
	/** Test-side files the fix left in place: given or hidden. */
	tests: string[];
	/** Everything else the fix changed: paths and whether it deleted them, to put the fix in place. */
	changes: { path: string; deleted: boolean }[];
	/** Each source file's changed functions; each test file's changed tests. */
	functions: Record<string, string[]>;
	testNames: Record<string, string[]>;
};

const git = async (dir: string, args: string[]) => (await run("git", ["-C", dir, ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout;

/** A fix, by its subject: `fix: …`, `fix(scope): …`, `bugfix …`, or a merged pull request titled so. */
export function fixSubject(subject: string): string | undefined {
	const title = /^Merge pull request '(.+)' \(#\d+\)/.exec(subject)?.[1] ?? subject;
	return /^(fix|bug)/i.test(title) && !/^revert/i.test(title) ? title : undefined;
}

/** Commits on `base` that fix something, newest first, as `[commit, subject]`. */
export async function fixes(mirror: string, base: string): Promise<{ commit: string; subject: string }[]> {
	const out = await git(mirror, ["log", "--first-parent", "--format=%H%x09%s", base]);
	return out.split("\n").flatMap((line) => {
		const [commit = "", subject = ""] = line.split("\t");
		const title = fixSubject(subject);
		return commit === "" || title === undefined ? [] : [{ commit, subject: title }];
	});
}

/** A commit read as a candidate, or why it isn't one. */
export async function candidate(mirror: string, repo: string, commit: string, subject: string): Promise<Candidate | string> {
	const parent = (await git(mirror, ["rev-parse", `${commit}^1`])).trim();
	const body = (await git(mirror, ["log", "-1", "--format=%b", commit])).trim();
	const status = (await git(mirror, ["diff", "--no-renames", "--name-status", parent, commit])).trim().split("\n").filter(Boolean);
	const files = status.map((line) => ({ path: line.split("\t").at(-1)!, deleted: line.startsWith("D") }));
	const isSource = (l: Lang, path: string) => l.source.test(path) && !l.test.test(path);
	const langs = Object.keys(LANGS).filter((name) => files.some((f) => isSource(LANGS[name]!, f.path)));
	if (langs.length === 0) return "no source files of a language the miner knows";
	if (langs.length > 1) return "more than one language";
	const lang = langs[0]!;
	const l = LANGS[lang]!;
	const sources = files.filter((f) => isSource(l, f.path));
	const tests = files.filter((f) => l.test.test(f.path) && !f.deleted).map((f) => f.path);
	if (!tests.some((t) => l.tests.test(t))) return "no tests came with it";
	if (sources.length > MAX_SOURCE_FILES) return `${sources.length} source files changed`;
	if (/(_gen|\.pb)\.go$/.test(sources.map((s) => s.path).join("\n"))) return "generated code";
	const numstat = await git(mirror, ["diff", "--no-renames", "--numstat", parent, commit, "--", ...sources.map((s) => s.path)]);
	const lines = numstat.split("\n").reduce((n, row) => n + row.split("\t").slice(0, 2).reduce((m, x) => m + (Number(x) || 0), 0), 0);
	if (lines > MAX_SOURCE_LINES) return `${lines} source lines changed`;
	// Hunks of no context, so each header names the function its change is in.
	const attributes = join(mkdtempSync(join(tmpdir(), "scout-mine-")), "attributes");
	writeFileSync(attributes, `*.go diff=golang\n*.ex diff=elixir\n*.exs diff=elixir\n`);
	const names = async (path: string, pattern: RegExp) => {
		const diff = await git(mirror, ["-c", `core.attributesFile=${attributes}`, "diff", "--no-renames", "-U0", parent, commit, "--", path]);
		const found = new Set<string>();
		for (const line of diff.split("\n")) {
			const text = line.startsWith("@@") ? line.replace(/^@@[^@]*@@/, "") : /^[+-](?![+-]{2} )/.test(line) ? line.slice(1) : undefined;
			const name = text === undefined ? undefined : pattern.exec(text)?.[1];
			if (name !== undefined) found.add(name);
		}
		return [...found];
	};
	try {
		const functions: Record<string, string[]> = {};
		for (const s of sources) if (!s.deleted) functions[s.path] = await names(s.path, l.func);
		const testNames: Record<string, string[]> = {};
		for (const t of tests.filter((t) => l.tests.test(t))) testNames[t] = await names(t, l.testName);
		return {
			repo,
			commit,
			parent,
			subject,
			body,
			lang,
			sources: sources.filter((s) => !s.deleted).map((s) => s.path),
			tests,
			changes: files.filter((f) => !l.test.test(f.path)),
			functions,
			testNames,
		};
	} finally {
		rmSync(dirname(attributes), { recursive: true, force: true });
	}
}

/** What a fix was for, from its subject: the conventional prefix and scope gone, as a sentence. */
export function described(subject: string): string {
	const text = subject.replace(/^(fix|bugfix|bug)(\([^)]*\))?!?:?\s*/i, "").trim();
	return text === "" ? "" : `${text[0]!.toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`;
}

/** A commit body as a request: trailers, attributions and sign-offs left out. */
export function bodyText(body: string): string {
	return body
		.split("\n")
		.filter((line) => !/^(LR-[A-Z]+|Co-Authored-By|Signed-off-by|Reviewed-by|Refs|Closes|Fixes):/i.test(line.trim()) && !/Generated with/i.test(line))
		.join("\n")
		.trim();
}

/** The commands that check a candidate: its tests, run from each test file's project root. */
async function commands(mirror: string, c: Candidate): Promise<{ command: string; suite?: string }> {
	const l = LANGS[c.lang]!;
	const tracked = new Set((await git(mirror, ["ls-tree", "-r", "--name-only", c.commit])).split("\n"));
	const rootOf = (path: string) => {
		for (let dir = posix.dirname(path); ; dir = posix.dirname(dir)) {
			if (tracked.has(dir === "." ? l.root : `${dir}/${l.root}`)) return dir;
			if (dir === ".") return ".";
		}
	};
	const within = (root: string, path: string) => (root === "." ? path : posix.relative(root, path));
	const group = (paths: string[]) => {
		const by = new Map<string, string[]>();
		for (const p of paths) by.set(rootOf(p), [...(by.get(rootOf(p)) ?? []), p]);
		return [...by];
	};
	const at = (root: string, command: string) => (root === "." ? command : `(cd ${quote(root)} && ${command})`);
	const tests = Object.keys(c.testNames);
	const command = group(tests)
		.map(([root, files]) => at(root, l.command(files.map((f) => within(root, f)), files.flatMap((f) => c.testNames[f] ?? []))))
		.join(" && ");
	const suite =
		l.suite === undefined
			? undefined
			: group(c.sources)
					.map(([root, files]) => at(root, l.suite!([...new Set(files.map((f) => posix.dirname(within(root, f))))])))
					.join(" && ");
	return { command, ...(suite === undefined ? {} : { suite }) };
}

/** The tasks a candidate makes, unchecked: a change, and a locate when the fix was in one file's functions. */
export async function draft(mirror: string, c: Candidate): Promise<EvalTask[]> {
	const { command, suite } = await commands(mirror, c);
	const id = `${c.repo}-${c.commit.slice(0, 10)}`;
	const body = bodyText(c.body);
	const change: EvalTask = {
		name: `${id}-change`,
		repo: c.repo,
		ref: c.parent,
		request: [described(c.subject), body].filter(Boolean).join("\n\n"),
		check: { hidden: { ref: c.commit, paths: c.tests }, command, ...(suite === undefined ? {} : { suite }) },
	};
	const tasks = [change];
	const [file] = c.sources;
	const functions = file === undefined ? [] : (c.functions[file] ?? []);
	if (c.sources.length === 1 && functions.length > 0) {
		const named = Object.entries(c.testNames).flatMap(([f, names]) => names.map((n) => `"${n}" (${f})`));
		const failing = named.length === 0 ? `The tests in ${Object.keys(c.testNames).join(", ")} fail.` : `${named.length === 1 ? "The test" : "The tests"} ${named.join(", ")} ${named.length === 1 ? "fails" : "fail"}.`;
		// What the fix was for helps, unless it gives the answer away.
		const what = described(c.subject);
		const base = posix.basename(file!).replace(/\.[^.]+$/, "");
		const gives = [base, ...functions].some((w) => new RegExp(`\\b${w.replace(/[^\w]/g, "\\$&")}\\b`, "i").test(what));
		tasks.push({
			name: `${id}-locate`,
			kind: "locate",
			repo: c.repo,
			ref: c.parent,
			given: { ref: c.commit, paths: c.tests },
			request: `${failing}${gives || what === "" ? "" : ` They were written for this fix: "${what.replace(/\.$/, "")}".`} Where does that need fixing?`,
			check: { locate: { file: file!, functions } },
		});
	}
	return tasks;
}

/**
 * Whether a candidate's tests fail before the fix (and not for want of building) and pass with it, in a sandbox of the
 * repository at the fix's parent with its tests put in, as a change task's are after the work; and whether the packages it changed pass their tests with it,
 * so a later change breaking them means something. `scout` must have the candidate's repository at that commit, under
 * `repoName` (evalRepos).
 */
export async function validate(
	scout: Scout,
	c: Candidate,
	task: EvalTask,
	repoName: string,
	fileAt: (task: EvalTask, ref: string, path: string) => Promise<Uint8Array>,
	context: Context = BACKGROUND_CONTEXT,
): Promise<{ ok: true; suite: boolean } | { ok: false; why: string }> {
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
	try {
		const env = await scout.workspaces.env(conversation.id);
		const sh = async (command: string, timeout = 900) => {
			let output = "";
			const result = await env.exec(command, { onOutput: (t) => (output += t), timeout }, context);
			return { code: result.ok ? result.value.exitCode : 1, output: result.ok ? output : `${output}${String(result.error)}` };
		};
		const { command, suite } = task.check;
		const root = (await sh("pwd", 30)).output.trim();
		for (const path of c.tests) await copyIn(env, `${root}/${path}`, await fileAt(task, c.commit, path));
		const before = await sh(command!);
		if (before.code === 0) return { ok: false, why: "its tests pass without the fix" };
		if (LANGS[c.lang]!.broken.test(before.output)) return { ok: false, why: "its tests don't build without the fix" };
		for (const change of c.changes) {
			if (change.deleted) await sh(`rm -f ${quote(change.path)}`, 30);
			else await copyIn(env, `${root}/${change.path}`, await fileAt(task, c.commit, change.path));
		}
		const after = await sh(command!);
		if (after.code !== 0) return { ok: false, why: "its tests fail with the fix too" };
		return { ok: true, suite: suite !== undefined && (await sh(suite)).code === 0 };
	} finally {
		await scout.workspaces.remove(conversation.id).catch(() => {});
	}
}

/** What was tried, one line each: never tried again. */
type Tried = { repo: string; commit: string; at: string; tasks?: string[]; why?: string };

function tried(dir: string): Set<string> {
	const path = join(dir, "mined.jsonl");
	if (!existsSync(path)) return new Set();
	return new Set(
		readFileSync(path, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => (JSON.parse(line) as Tried).commit),
	);
}

/**
 * Up to `max` new candidates from `repos` (SCOUT_BENCH_REPOS; else every configured repository), taken in turn from
 * each repository, newest first; each checked in a sandbox, and its tasks written to the tasks directory if it holds.
 * Returns the tasks added. `opened` hears of each Scout it opens for a check, and copies go under `work`, so a stop can clear both.
 */
export async function mine(config: Config, options: { max: number; repos?: string[]; log?: (line: string) => void; work?: string; opened?: (scout: Scout | undefined) => void }): Promise<string[]> {
	const log = options.log ?? console.log;
	const bench = config.bench;
	if (bench === undefined) throw new Error("the benchmark is off: set SCOUT_BENCH_MODELS");
	const dir = bench.tasksDir;
	mkdirSync(dir, { recursive: true });
	const names = options.repos ?? bench.repos ?? config.repos.map((r) => r.name);
	const done = tried(dir);
	const queues: { repo: string; mirror: string; commits: { commit: string; subject: string }[] }[] = [];
	for (const name of names) {
		const repo = config.repos.find((r) => r.name === name);
		if (repo === undefined) throw new Error(`no repository named ${name}; configured: ${config.repos.map((r) => r.name).join(", ")}`);
		const mirror = new Mirror(join(config.dataDir, "mirrors", `${repo.name}.git`), repo.gitUrl);
		// Scout may be fetching it too; what's there already will do.
		await mirror.refresh().catch((error) => log(`bench mine: couldn't fetch ${repo.name} (${error instanceof Error ? error.message.split("\n")[0] : error}); using what's there`));
		if (!existsSync(mirror.path)) continue;
		const commits = (await fixes(mirror.path, repo.base)).filter((f) => !done.has(f.commit));
		queues.push({ repo: repo.name, mirror: mirror.path, commits });
	}
	const record = (t: Tried) => appendFileSync(join(dir, "mined.jsonl"), `${JSON.stringify(t)}\n`);
	const existing = new Set(loadTasks(dir).map((t) => t.name));
	const added: string[] = [];
	const work = mkdtempSync(join(options.work ?? tmpdir(), "scout-mine-"));
	const host = await fakeCodeHost();
	let scout: Scout | undefined;
	try {
		let checked = 0;
		while (checked < options.max && queues.some((q) => q.commits.length > 0)) {
			for (const q of queues) {
				if (checked >= options.max) break;
				const next = q.commits.shift();
				if (next === undefined) continue;
				const at = new Date().toISOString();
				const c = await candidate(q.mirror, q.repo, next.commit, next.subject);
				if (typeof c === "string") {
					record({ repo: q.repo, commit: next.commit, at, why: c });
					continue;
				}
				checked++;
				const tasks = (await draft(q.mirror, c)).filter((t) => !existing.has(t.name));
				const [change] = tasks;
				if (change === undefined) continue;
				const { repos, nameOf, fileAt } = await evalRepos(config, [change], join(work, "repos"));
				const dataDir = join(work, `data-${checked}`);
				scout = await openScout({
					config: evalConfig(config, { repos, profileDir: config.profileDir, apiUrl: host.apiUrl, dataDir }),
					storage: new MemoryStorage(),
					dataDir,
					instance: `mine${randomBytes(3).toString("hex")}`,
					context: BACKGROUND_CONTEXT,
					watchProfile: false,
					mcp: [],
				});
				options.opened?.(scout);
				const verdict = await validate(scout, c, change, nameOf(change), fileAt).catch((error) => ({ ok: false as const, why: `the check broke: ${error instanceof Error ? error.message.split("\n")[0] : error}` }));
				await scout.close();
				scout = undefined;
				options.opened?.(undefined);
				if (!verdict.ok) {
					record({ repo: q.repo, commit: c.commit, at, why: verdict.why });
					log(`bench mine: ${q.repo} ${c.commit.slice(0, 10)}: no (${verdict.why})`);
					continue;
				}
				// A suite that fails with the fix already would blame a later change for it.
				if (!verdict.suite) delete change.check.suite;
				for (const task of tasks) writeFileSync(join(dir, `${task.name}.json`), `${JSON.stringify(task, null, "\t")}\n`);
				record({ repo: q.repo, commit: c.commit, at, tasks: tasks.map((t) => t.name) });
				added.push(...tasks.map((t) => t.name));
				log(`bench mine: ${q.repo} ${c.commit.slice(0, 10)}: ${tasks.length} task${tasks.length === 1 ? "" : "s"}`);
			}
		}
	} finally {
		await scout?.close().catch(() => {});
		await host.close();
		rmSync(work, { recursive: true, force: true });
	}
	return added;
}

if (import.meta.main) {
	const { loadConfig, useScoutsKey } = await import("./config.ts");
	const { resolveSecrets } = await import("./secrets.ts");
	const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
	delete process.env.SLACK_BOT_TOKEN;
	delete process.env.SLACK_APP_TOKEN;
	await resolveSecrets();
	const config = loadConfig();
	useScoutsKey(config.git.sshKey);
	const max = Number(arg("--max") ?? 20);
	const repo = arg("--repo");
	const added = await mine(config, { max, ...(repo === undefined ? {} : { repos: [repo] }) });
	console.log(`bench mine: ${added.length} task${added.length === 1 ? "" : "s"} added to ${config.bench!.tasksDir}`);
	process.exit(0);
}
