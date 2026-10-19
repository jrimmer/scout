import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { AssistantEntry, type ConversationId, type SubmissionId } from "@earendil-works/pi-durable";
import type { CodeHost } from "./codehost.ts";
import type { Config, RepoConfig } from "./config.ts";
import { ReviewDoc } from "./docs.ts";
import type { ReviewRow } from "./pulls.ts";
import { diffOf } from "./review.ts";
import type { Scout } from "./scout.ts";

/**
 * Automation mode: work that starts from the code host instead of a person in Slack. Aquifer runs pull request review
 * this way, on the same session model as River. Here: any open pull request with the review label gets a review from
 * Scout as a comment, once per commit.
 *
 * Scout polls instead of taking webhooks, because it has no public address (Socket Mode). The review is a durable
 * conversation like any other, so a restart picks up where it left off and the comment is posted once.
 */
type OpenPull = {
	number: number;
	title: string;
	body: string | null;
	html_url: string;
	user?: { login?: string };
	labels?: { name: string }[];
	head: { sha: string; ref: string };
	base: { ref: string };
};

export class PullReviewer {
	readonly #scout: Scout;
	readonly #config: Config;
	readonly #label: string;
	readonly #context: Context;
	readonly #fetch: typeof fetch;
	readonly #waiting = new Set<string>();
	#polling = false;

	constructor(options: { scout: Scout; config: Config; label: string; context: Context; fetch?: typeof fetch }) {
		this.#scout = options.scout;
		this.#config = options.config;
		this.#label = options.label;
		this.#context = options.context;
		this.#fetch = options.fetch ?? fetch;
	}

	/** Start reviews for newly labelled pull requests or new commits, and post the ones that finished. */
	async poll(): Promise<void> {
		if (this.#polling) return;
		this.#polling = true;
		try {
			for (const repo of this.#config.repos) {
				const open = (await this.#api(`/repos/${repo.slug}/pulls?state=open&per_page=50&limit=50`)) as OpenPull[];
				for (const pull of open) {
					if (!(pull.labels ?? []).some((label) => label.name === this.#label)) continue;
					if (this.#scout.pulls.review(repo.slug, pull.number, pull.head.sha) !== undefined) continue;
					await this.#start(repo, pull).catch((error: unknown) =>
						console.error(`couldn't start reviewing ${pull.html_url}:`, error),
					);
				}
			}
			for (const review of this.#scout.pulls.unpostedReviews()) {
				const key = `${review.slug}#${review.number}@${review.sha}`;
				if (this.#waiting.has(key)) continue;
				this.#waiting.add(key);
				void this.#finish(review)
					.catch((error: unknown) => console.error(`review of ${key} failed:`, error))
					.finally(() => this.#waiting.delete(key));
			}
		} finally {
			this.#polling = false;
		}
	}

	async #start(repo: RepoConfig, pull: OpenPull): Promise<void> {
		const { harness, workspaces, pulls } = this.#scout;
		const { slug } = repo;
		const mirror = workspaces.mirrorFor(repo.name);
		await mirror.refresh();
		const root = join(this.#config.dataDir, "reviews", `${slug.replace("/", "-")}-${pull.number}-${pull.head.sha.slice(0, 12)}`);
		const cwd = join(root, "repo");
		await mirror.checkout(cwd, pull.head.sha);
		const { stat, diff } = await diffOf(mirror.path, `refs/heads/${pull.base.ref}`, pull.head.sha);

		const conversation = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: this.#scout.reviewerAgent,
				init: async (tx, id) => {
					const doc = await tx.doc(ReviewDoc, id);
					doc.root = root;
					doc.cwd = cwd;
				},
			},
			this.#context,
		);
		const prompt = [
			`# ${pull.title}`,
			`Pull request ${pull.html_url} by ${pull.user?.login ?? "someone"}, into ${pull.base.ref}.`,
			pull.body ?? "",
			"```",
			stat,
			"```",
			"```diff",
			diff,
			"```",
		].join("\n\n");
		const submission = await conversation.submit(
			{ type: "input", content: prompt, requestId: `pr-review:${slug}#${pull.number}@${pull.head.sha}` },
			this.#context,
		);
		pulls.reviewStarted({ slug, number: pull.number, sha: pull.head.sha, conversationId: conversation.id, submissionId: submission.id });
		console.log(`reviewing ${pull.html_url} at ${pull.head.sha.slice(0, 7)}`);
	}

	async #finish(review: ReviewRow): Promise<void> {
		const { harness, pulls } = this.#scout;
		const submission = await harness.submission(review.submissionId as SubmissionId, this.#context);
		if (submission === undefined) throw new Error("its submission is gone");
		const settled = await submission.wait(this.#context);
		let text = "I couldn't finish reviewing this one.";
		if (settled.status === "done" && settled.type === "input") {
			const conversation = await harness.conversation(review.conversationId as ConversationId, this.#context);
			const answer = await conversation?.commit((tx) => tx.entry(AssistantEntry, settled.answer), this.#context);
			const content = answer?.model?.[0]?.content ?? [];
			text =
				typeof content === "string"
					? content
					: content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n") || text;
		}
		await this.#api(`/repos/${review.slug}/issues/${review.number}/comments`, {
			body: `**Scout's review** of \`${review.sha.slice(0, 7)}\` (asked for with the \`${this.#label}\` label)\n\n${text}`,
		});
		pulls.reviewPosted(review);
	}

	async #api(path: string, body?: unknown): Promise<unknown> {
		const host: CodeHost = this.#config.codeHost;
		const response = await this.#fetch(`${host.apiUrl}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				"content-type": "application/json",
				accept: host.kind === "github" ? "application/vnd.github+json" : "application/json",
				authorization: host.kind === "github" ? `Bearer ${host.token}` : `token ${host.token}`,
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!response.ok) throw new Error(`code host answered ${response.status} for ${path}`);
		return response.json();
	}
}
