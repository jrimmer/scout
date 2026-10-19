import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { CodeHostKind } from "./config.ts";
import { ReviewsDoc } from "./docs.ts";
import { diffOf, type Review } from "./review.ts";
import type { Mirror } from "./sandbox.ts";

const run = promisify(execFile);

export type CodeHost = { kind: CodeHostKind; apiUrl: string; token: string };

/** Where a conversation's pull request comes from and goes. */
export type PullTarget = {
	/**
	 * The clone the agent worked in: a directory on this host (the reflection's), or a sandbox that hands its commits
	 * out as a bundle (see workspaces.ts).
	 */
	source:
		| { kind: "dir"; dir: string }
		| { kind: "sandbox"; status: () => Promise<string>; exportBranch: () => Promise<string | undefined> };
	branch: string;
	base: string;
	/** `owner/name` on the code host. */
	slug: string;
	mirror: Mirror;
	/** Appended to the description: where the work was discussed. */
	link?: string;
};

export type OpenedPull = { url: string; number: number; slug: string; title: string };

export type CodeHostOptions = {
	/** Extension name; a conversation selects one code host extension. */
	name: string;
	codeHost: CodeHost;
	target: (conversationId: number, context: Context) => Promise<PullTarget>;
	/**
	 * Commit whatever is in the clone before pushing, for agents without a shell. Only safe when the agent cannot
	 * write under `.git` (`ConfinedEnv` with `protectGit`), since this runs git inside the clone on the host.
	 */
	commitAll?: boolean;
	onPullRequest?: (conversationId: number, pull: OpenedPull) => void;
	/** Refuse pull requests that change more lines than this; ask for smaller ones instead. */
	maxChangedLines?: number;
	/** Review each new commit before people are asked to (see review.ts). */
	selfReview?: (change: ProposedChange, api: ToolExecutionApi, context: Context) => Promise<Review>;
	fetch?: typeof fetch;
};

export type ProposedChange = { target: PullTarget; title: string; body: string; stat: string; diff: string; sha: string };

/**
 * Pushing and opening pull requests run on the host, with the host's credentials; the agent never sees them.
 *
 * The agent's clone is untrusted, its hooks and config included, so the host never pushes from it: the host-owned
 * mirror fetches the commits (from a bundle the sandbox made, or with upload-pack, which is safe on untrusted repos)
 * and pushes from there.
 */
export function createCodeHostExtension(options: CodeHostOptions) {
	const doFetch = options.fetch ?? fetch;

	const openPullRequest = defineTool({
		name: "open_pull_request",
		description: options.commitAll
			? "Commit your file changes, push them, and open a pull request (or update the open one). Returns its URL."
			: "Push this thread's branch and open a pull request (or update the open one). Commit your work with git " +
				"first; the working tree must be clean. Returns the pull request URL.",
		parameters: Type.Object({
			title: Type.String({ description: "Short, imperative title" }),
			body: Type.String({ description: "What changed and why, and how it was tested. Markdown." }),
		}),
		execute: async (args, api, context) => {
			const conversationId: number = api.conversationId;
			const target = await options.target(conversationId, context);
			const { source, branch, base, mirror } = target;

			if (options.commitAll && source.kind === "dir") await commitEverything(source.dir, args.title);
			const dirty = source.kind === "dir" ? await git(["-C", source.dir, "status", "--porcelain"]) : await source.status();
			if (dirty !== "") throw new Error(`Uncommitted changes; commit them first:\n${dirty}`);
			await mirror.refresh();
			if (source.kind === "dir") {
				await git(["-C", mirror.path, "fetch", "--quiet", "--no-tags", source.dir, `+HEAD:refs/heads/${branch}`]);
			} else {
				const bundle = await source.exportBranch();
				if (bundle === undefined) throw new Error(`No commits on ${branch} beyond ${base} yet.`);
				try {
					await git(["-C", mirror.path, "fetch", "--quiet", "--no-tags", bundle, `+HEAD:refs/heads/${branch}`]);
				} finally {
					await rm(dirname(bundle), { recursive: true, force: true });
				}
			}
			const ahead = await git(["-C", mirror.path, "rev-list", "--count", `refs/heads/${base}..refs/heads/${branch}`]);
			if (ahead === "0") throw new Error(`No changes on ${branch} beyond ${base} yet.`);

			const { stat, diff, lines } = await diffOf(mirror.path, `refs/heads/${base}`, `refs/heads/${branch}`);
			const max = options.maxChangedLines;
			if (max !== undefined && lines > max) {
				throw new Error(
					`This change touches ${lines} lines; the most I'll put in one pull request is ${max}. Split it into ` +
						"smaller pull requests that each make sense alone, or ask whoever runs Scout to raise SCOUT_PR_MAX_LINES.",
				);
			}
			let reviewNote = "";
			if (options.selfReview !== undefined) {
				const sha = await git(["-C", mirror.path, "rev-parse", `refs/heads/${branch}`]);
				const earlier = (await api.snapshot(ReviewsDoc, api.conversationId, context))?.verdicts[sha];
				if (earlier === undefined) {
					const review = await options.selfReview({ target, title: args.title, body: args.body, stat, diff, sha }, api, context);
					await api.commit(async (tx) => {
						(await tx.doc(ReviewsDoc, api.conversationId)).verdicts[sha] = review.verdict;
					}, context);
					if (review.verdict === "changes") {
						throw new Error(
							`My self-review found problems:\n\n${review.text}\n\nFix them, commit, and call open_pull_request ` +
								"again. If you disagree with a point, say why in the description and call it again without changes.",
						);
					}
					reviewNote = review.text;
				} else if (earlier === "changes") {
					reviewNote = "Opened over my own self-review's objections; the description says why.";
				}
			}

			await git(["-C", mirror.path, "push", "--quiet", "--force", mirror.gitUrl, `refs/heads/${branch}:refs/heads/${branch}`]);

			const reviewed =
				reviewNote === "" ? "" : `\n\n<details><summary>Scout's self-review</summary>\n\n${reviewNote}\n\n</details>`;
			const link = target.link === undefined ? "" : `\n\n---\nWorked out in the open: ${target.link}`;
			const body = `${args.body}${reviewed}${link}`;
			const { url, number } = await createOrFindPull(options.codeHost, target.slug, doFetch, {
				title: args.title,
				body,
				head: branch,
				base,
			});
			options.onPullRequest?.(conversationId, { url, number, slug: target.slug, title: args.title });
			return { output: [{ type: "text", text: `Pull request: ${url} (${ahead} commit${ahead === "1" ? "" : "s"})` }] };
		},
	});

	return defineExtension({ name: options.name, tools: [openPullRequest] });
}

/** Hooks are off for good measure; the agent could not have written them anyway (see `commitAll`). */
async function commitEverything(dir: string, message: string): Promise<void> {
	const safe = ["-C", dir, "-c", "core.hooksPath=/dev/null"];
	await git([...safe, "add", "--all"]);
	if ((await git([...safe, "status", "--porcelain"])) !== "") await git([...safe, "commit", "--quiet", "-m", message]);
}

type PullDraft = { title: string; body: string; head: string; base: string };

type Created = { url: string; number: number };

async function createOrFindPull(host: CodeHost, slug: string, doFetch: typeof fetch, pull: PullDraft): Promise<Created> {
	const headers = {
		"content-type": "application/json",
		accept: host.kind === "github" ? "application/vnd.github+json" : "application/json",
		authorization: host.kind === "github" ? `Bearer ${host.token}` : `token ${host.token}`,
	};
	const pulls = `${host.apiUrl}/repos/${slug}/pulls`;
	const created = await doFetch(pulls, { method: "POST", headers, body: JSON.stringify(pull) });
	if (created.ok) {
		const body = (await created.json()) as { html_url: string; number: number };
		return { url: body.html_url, number: body.number };
	}

	// Already open for this branch: the push above updated it.
	if (created.status === 409 || created.status === 422) {
		const open = await doFetch(`${pulls}?state=open&per_page=100&limit=50`, { headers });
		if (open.ok) {
			const existing = ((await open.json()) as { html_url: string; number: number; head: { ref: string } }[]).find(
				(candidate) => candidate.head.ref === pull.head,
			);
			if (existing !== undefined) return { url: existing.html_url, number: existing.number };
		}
	}
	throw new Error(`Code host refused the pull request (${created.status}): ${(await created.text()).slice(0, 500)}`);
}

async function git(args: string[]): Promise<string> {
	const { stdout } = await run("git", args, { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
	return stdout.trim();
}
