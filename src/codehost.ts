import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { CodeHostKind } from "./config.ts";
import type { ThreadPaths } from "./sandbox.ts";

const run = promisify(execFile);

export type CodeHostOptions = {
	dataDir: string;
	repo: { gitUrl: string; base: string; slug: string };
	codeHost: { kind: CodeHostKind; apiUrl: string; token: string };
	paths: (conversationId: number) => ThreadPaths;
	branch: (conversationId: number) => string;
	/** Link back to the Slack thread, for the pull request description. */
	threadLink: (conversationId: number) => Promise<string | undefined>;
	onPullRequest?: (conversationId: number, url: string) => void;
	fetch?: typeof fetch;
};

/**
 * Pushing and opening pull requests run on the host, with the host's credentials; the sandbox never sees them.
 *
 * The thread's repo is written by the agent, so the host never runs git inside it: its hooks and config are
 * untrusted. Instead the host-owned mirror fetches the branch from it (upload-pack is safe on untrusted repos) and
 * pushes from there.
 */
export function createCodeHostExtension(options: CodeHostOptions) {
	const doFetch = options.fetch ?? fetch;
	const mirror = join(options.dataDir, "mirror.git");

	const openPullRequest = defineTool({
		name: "open_pull_request",
		description:
			"Push this thread's branch and open a pull request (or update the open one). Commit your work with git first; " +
			"the working tree must be clean. Returns the pull request URL.",
		parameters: Type.Object({
			title: Type.String({ description: "Short, imperative title" }),
			body: Type.String({ description: "What changed and why, and how it was tested. Markdown." }),
		}),
		execute: async (args, api) => {
			const conversationId: number = api.conversationId;
			const paths = options.paths(conversationId);
			const branch = options.branch(conversationId);
			const { base, gitUrl } = options.repo;

			const dirty = await git(["-C", paths.repo, "status", "--porcelain"]);
			if (dirty !== "") throw new Error(`Uncommitted changes; commit them first:\n${dirty}`);
			await git(["-C", mirror, "fetch", "--quiet", "--no-tags", paths.repo, `+HEAD:refs/heads/${branch}`]);
			const ahead = await git(["-C", mirror, "rev-list", "--count", `refs/heads/${base}..refs/heads/${branch}`]);
			if (ahead === "0") throw new Error(`No commits on ${branch} beyond ${base} yet.`);
			await git(["-C", mirror, "push", "--quiet", "--force", gitUrl, `refs/heads/${branch}:refs/heads/${branch}`]);

			const link = await options.threadLink(conversationId);
			const body = link === undefined ? args.body : `${args.body}\n\n---\nWorked out in the open: ${link}`;
			const url = await createOrFindPull(options, doFetch, { title: args.title, body, head: branch, base });
			options.onPullRequest?.(conversationId, url);
			return { output: [{ type: "text", text: `Pull request: ${url} (${ahead} commit${ahead === "1" ? "" : "s"})` }] };
		},
	});

	return defineExtension({ name: "codehost", tools: [openPullRequest] });
}

type PullDraft = { title: string; body: string; head: string; base: string };

async function createOrFindPull(options: CodeHostOptions, doFetch: typeof fetch, pull: PullDraft): Promise<string> {
	const { kind, apiUrl, token } = options.codeHost;
	const headers = {
		"content-type": "application/json",
		accept: kind === "github" ? "application/vnd.github+json" : "application/json",
		authorization: kind === "github" ? `Bearer ${token}` : `token ${token}`,
	};
	const pulls = `${apiUrl}/repos/${options.repo.slug}/pulls`;
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
