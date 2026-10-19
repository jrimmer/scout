import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { CodeHostKind } from "./config.ts";
import type { Mirror } from "./sandbox.ts";

const run = promisify(execFile);

export type CodeHost = { kind: CodeHostKind; apiUrl: string; token: string };

/** Where a conversation's pull request goes. */
export type PullTarget = {
	/** The clone the agent worked in. */
	dir: string;
	branch: string;
	base: string;
	/** `owner/name` on the code host. */
	slug: string;
	mirror: Mirror;
	/** Appended to the description: where the work was discussed. */
	link?: string;
};

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
	onPullRequest?: (conversationId: number, url: string) => void;
	fetch?: typeof fetch;
};

/**
 * Pushing and opening pull requests run on the host, with the host's credentials; the agent never sees them.
 *
 * A thread's clone is written by the agent, so the host does not push from it: its hooks and config are untrusted.
 * Instead the host-owned mirror fetches the branch from it (upload-pack is safe on untrusted repos) and pushes from
 * there.
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
			const { dir, branch, base, mirror } = target;

			if (options.commitAll) await commitEverything(dir, args.title);
			const dirty = await git(["-C", dir, "status", "--porcelain"]);
			if (dirty !== "") throw new Error(`Uncommitted changes; commit them first:\n${dirty}`);
			await mirror.refresh();
			await git(["-C", mirror.path, "fetch", "--quiet", "--no-tags", dir, `+HEAD:refs/heads/${branch}`]);
			const ahead = await git(["-C", mirror.path, "rev-list", "--count", `refs/heads/${base}..refs/heads/${branch}`]);
			if (ahead === "0") throw new Error(`No changes on ${branch} beyond ${base} yet.`);
			await git(["-C", mirror.path, "push", "--quiet", "--force", mirror.gitUrl, `refs/heads/${branch}:refs/heads/${branch}`]);

			const body = target.link === undefined ? args.body : `${args.body}\n\n---\nWorked out in the open: ${target.link}`;
			const url = await createOrFindPull(options.codeHost, target.slug, doFetch, { title: args.title, body, head: branch, base });
			options.onPullRequest?.(conversationId, url);
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

async function createOrFindPull(host: CodeHost, slug: string, doFetch: typeof fetch, pull: PullDraft): Promise<string> {
	const headers = {
		"content-type": "application/json",
		accept: host.kind === "github" ? "application/vnd.github+json" : "application/json",
		authorization: host.kind === "github" ? `Bearer ${host.token}` : `token ${host.token}`,
	};
	const pulls = `${host.apiUrl}/repos/${slug}/pulls`;
	const created = await doFetch(pulls, { method: "POST", headers, body: JSON.stringify(pull) });
	if (created.ok) return ((await created.json()) as { html_url: string }).html_url;

	// Already open for this branch: the push above updated it.
	if (created.status === 409 || created.status === 422) {
		const open = await doFetch(`${pulls}?state=open&per_page=100&limit=50`, { headers });
		if (open.ok) {
			const existing = ((await open.json()) as { html_url: string; head: { ref: string } }[]).find(
				(candidate) => candidate.head.ref === pull.head,
			);
			if (existing !== undefined) return existing.html_url;
		}
	}
	throw new Error(`Code host refused the pull request (${created.status}): ${(await created.text()).slice(0, 500)}`);
}

async function git(args: string[]): Promise<string> {
	const { stdout } = await run("git", args, { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
	return stdout.trim();
}
