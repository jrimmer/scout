import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Mirror } from "./sandbox.ts";

const run = promisify(execFile);

/**
 * Reading across every repository Scout works in, not just the one its thread has checked out: "where else do we call
 * this?", "how does the API side do it?". Answered from the bare mirrors Scout already keeps on the host, with
 * `git grep` and `git show` on each repository's base branch: exact, always as fresh as the last fetch, and nothing
 * new to run or keep in sync. Read-only, and only the repositories Scout is set up for.
 *
 * A real code index (Zoekt, Sourcegraph, embeddings) becomes worth it with very large repositories, where `git grep`
 * gets slow, or for questions by meaning rather than by text; until then this is enough.
 */
export type SearchableRepo = { name: string; base: string; mirror: Pick<Mirror, "path" | "refresh"> };

/** At most this many matching lines in one answer, and this much of one file. */
const MAX_MATCHES = 150;
const MAX_LINES_PER_FILE = 20;
const MAX_FILE_LINES = 400;
const MAX_BYTES = 40_000;
/** How stale a mirror may be before a search fetches first. */
const FRESH_MS = 5 * 60 * 1000;

export type Match = { repo: string; path: string; line: number; text: string };

/** Lines matching `query` in the repositories' base branches, `repo:path:line: text`, and whether there were more. */
export async function searchCode(
	repos: readonly SearchableRepo[],
	query: { pattern: string; regex?: boolean; ignoreCase?: boolean; path?: string },
): Promise<{ matches: Match[]; truncated: boolean }> {
	const matches: Match[] = [];
	let truncated = false;
	for (const repo of repos) {
		const args = ["-C", repo.mirror.path, "grep", "-n", "-I", `--max-count=${MAX_LINES_PER_FILE}`, query.regex === true ? "-E" : "-F"];
		if (query.ignoreCase === true) args.push("-i");
		args.push("-e", query.pattern, `refs/heads/${repo.base}`);
		if (query.path !== undefined && query.path !== "") args.push("--", `:(glob)${query.path}`);
		const out = await run("git", args, { maxBuffer: 16 * 1024 * 1024 }).then(
			(r) => r.stdout,
			// git grep exits 1 when nothing matches; that's an answer, not a failure.
			(error: { code?: number; stdout?: string }) => {
				if (error.code === 1) return "";
				throw error;
			},
		);
		const prefix = `refs/heads/${repo.base}:`;
		for (const line of out.split("\n")) {
			if (line === "") continue;
			const rest = line.startsWith(prefix) ? line.slice(prefix.length) : line;
			const m = /^(.*?):(\d+):(.*)$/.exec(rest);
			if (m === null) continue;
			if (matches.length >= MAX_MATCHES) {
				truncated = true;
				break;
			}
			matches.push({ repo: repo.name, path: m[1]!, line: Number(m[2]), text: m[3]!.slice(0, 300) });
		}
		if (truncated) break;
	}
	return { matches, truncated };
}

/** A file from a repository's base branch, numbered, `from` to `to` (1-based), capped. */
export async function readCode(repo: SearchableRepo, path: string, from = 1, to?: number): Promise<{ text: string; lines: number; truncated: boolean }> {
	const { stdout } = await run("git", ["-C", repo.mirror.path, "show", `refs/heads/${repo.base}:${path.replace(/^\/+/, "")}`], { maxBuffer: 32 * 1024 * 1024 }).catch(() => {
		throw new Error(`There's no ${path} on ${repo.name}'s ${repo.base} branch.`);
	});
	const all = stdout.split("\n");
	if (all.at(-1) === "") all.pop();
	const start = Math.max(1, from);
	const end = Math.min(all.length, to ?? start + MAX_FILE_LINES - 1, start + MAX_FILE_LINES - 1);
	let text = "";
	let truncated = end < (to ?? all.length);
	for (let i = start; i <= end; i++) {
		const line = `${i}\t${all[i - 1]}\n`;
		if (text.length + line.length > MAX_BYTES) {
			truncated = true;
			break;
		}
		text += line;
	}
	return { text, lines: all.length, truncated };
}

/**
 * `search_code` and `read_code`, over the repositories `repos(conversationId)` lists for the conversation calling
 * (fetched first when a mirror is stale): only the ones its requester may ask for work in, so a thread can't read a
 * repository the person asking couldn't.
 */
export function codeSearchExtension(repos: (conversationId: number) => SearchableRepo[] | Promise<SearchableRepo[]>) {
	const fetchedAt = new Map<string, number>();
	const fresh = async (list: SearchableRepo[]) => {
		const now = Date.now();
		await Promise.all(
			list.map(async (r) => {
				if (now - (fetchedAt.get(r.name) ?? 0) < FRESH_MS) return;
				await r.mirror.refresh();
				fetchedAt.set(r.name, Date.now());
			}),
		);
		return list;
	};
	const pick = async (conversationId: number, name?: string) => {
		const all = await repos(conversationId);
		if (name === undefined || name === "") return all;
		const found = all.filter((r) => r.name.toLowerCase() === name.toLowerCase());
		if (found.length === 0) throw new Error(`I can't read a repository called ${name} from this thread. These I can: ${all.map((r) => r.name).join(", ")}.`);
		return found;
	};

	const search = defineTool({
		name: "search_code",
		description:
			"Search the code of every repository you work in (or one of them), on each one's main branch, not just the " +
			"repository checked out in your sandbox. For questions like where else something is used or how another " +
			"repository does it. Read-only. Results are `repo:path:line: text`.",
		parameters: Type.Object({
			pattern: Type.String({ description: "Text to find; a regular expression (extended) when regex is true" }),
			regex: Type.Optional(Type.Boolean()),
			ignore_case: Type.Optional(Type.Boolean()),
			repo: Type.Optional(Type.String({ description: "Only this repository, by name" })),
			path: Type.Optional(Type.String({ description: "Only paths matching this glob, e.g. 'src/**/*.ts'" })),
		}),
		execute: async (args, api) => {
			const list = await fresh(await pick(api.conversationId, args.repo));
			const { matches, truncated } = await searchCode(list, {
				pattern: args.pattern,
				...(args.regex === undefined ? {} : { regex: args.regex }),
				...(args.ignore_case === undefined ? {} : { ignoreCase: args.ignore_case }),
				...(args.path === undefined ? {} : { path: args.path }),
			});
			const text =
				matches.length === 0
					? `No matches in ${list.map((r) => r.name).join(", ")}.`
					: [...matches.map((m) => `${m.repo}:${m.path}:${m.line}: ${m.text}`), ...(truncated ? [`(more matches not shown; narrow it with repo or path)`] : [])].join("\n");
			return { output: [{ type: "text", text }] };
		},
	});

	const read = defineTool({
		name: "read_code",
		description: "Read a file from the main branch of any repository you work in, with line numbers. Read-only.",
		parameters: Type.Object({
			repo: Type.String({ description: "The repository's name" }),
			path: Type.String(),
			from: Type.Optional(Type.Number({ description: "First line, 1-based" })),
			to: Type.Optional(Type.Number({ description: "Last line" })),
		}),
		execute: async (args, api) => {
			const [repo] = await fresh(await pick(api.conversationId, args.repo));
			const { text, lines, truncated } = await readCode(repo!, args.path, args.from, args.to);
			return { output: [{ type: "text", text: `${repo!.name}:${args.path} (${lines} lines)\n${text}${truncated ? "(cut off here; ask for a later range with from and to)" : ""}` }] };
		},
	});

	return defineExtension({ name: "code-search", tools: [search, read] });
}
