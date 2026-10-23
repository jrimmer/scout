import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { AssistantEntry, type ConversationId, type SubmissionId } from "@earendil-works/pi-durable";
import type { CodeHost } from "./codehost.ts";
import type { Config, RepoConfig } from "./config.ts";
import { ReviewDoc, ThreadDoc } from "./docs.ts";
import type { Admission } from "./limits.ts";
import type { ReviewRow } from "./pulls.ts";
import { diffOf, type PullReview, parsePullReview } from "./review.ts";
import type { Scout } from "./scout.ts";

/**
 * Pull request review, asked like a person: request a review from Scout's code host account and it reviews the pull
 * request with its own profile (`reviewer.md`), then again at each new push until the pull request closes. Aquifer runs
 * review this way, as a profile on the same session model as River.
 *
 * The answer becomes a real review (approve, request changes, or comment) with comments on the lines the diff shows.
 * `onReview` then tells the repository's channel, where people can ask Scout about it in public.
 *
 * Scout polls instead of taking webhooks, because it has no public address (Socket Mode). Each review is a durable
 * conversation like any other, so a restart picks up where it left off and the review is posted once.
 */
type OpenPull = {
	number: number;
	title: string;
	body: string | null;
	html_url: string;
	user?: { login?: string };
	requested_reviewers?: { login?: string }[] | null;
	head: { sha: string; ref: string; repo?: { full_name?: string } | null };
	base: { ref: string };
};

/** A review Scout posted, for the repository's channel. */
export type PostedReview = {
	repo: string;
	slug: string;
	number: number;
	sha: string;
	title: string;
	url: string;
	author?: string;
	/** The pull request's branch, when it's in the repository itself (not a fork's), so its thread can work on it. */
	head?: string;
	conversationId: number;
	review: PullReview;
};

export class PullReviewer {
	readonly #scout: Scout;
	readonly #config: Config;
	readonly #context: Context;
	readonly #fetch: typeof fetch;
	readonly #onReview: ((posted: PostedReview) => Promise<void>) | undefined;
	readonly #waiting = new Set<string>();
	/** Reviews this poll started, until it's waiting on them too: so each counts against the run limits for the next. */
	readonly #starting = new Set<string>();
	readonly #admit: ((channel: string) => Promise<Admission>) | undefined;
	/** Reviews a budget turned down, said once in the log: the next poll asks again. */
	readonly #held = new Set<string>();
	#self: string | undefined;
	#polling = false;

	/**
	 * `admit`: may a review start now, as a run in the repository's channel? Budgets and concurrency (limits.ts), like any
	 * request there; not now, it waits for a later poll.
	 */
	constructor(options: { scout: Scout; config: Config; context: Context; fetch?: typeof fetch; onReview?: (posted: PostedReview) => Promise<void>; admit?: (channel: string) => Promise<Admission> }) {
		this.#scout = options.scout;
		this.#config = options.config;
		this.#context = options.context;
		this.#fetch = options.fetch ?? fetch;
		this.#onReview = options.onReview;
		this.#admit = options.admit;
	}

	/** The repositories (slugs) of the reviews under way, one entry each: runs, for the run limits. */
	reviewing(): string[] {
		return [...new Set([...this.#starting, ...this.#waiting])].map((key) => key.slice(0, key.indexOf("#")));
	}

	/** Start reviews that were asked for (or new commits on pull requests already reviewed), and post finished ones. */
	async poll(): Promise<void> {
		if (this.#polling) return;
		this.#polling = true;
		try {
			this.#self ??= ((await this.#api("GET", "/user")) as { login: string }).login;
			for (const repo of this.#config.repos) {
				const open = (await this.#api("GET", `/repos/${repo.slug}/pulls?state=open&per_page=50&limit=50`)) as OpenPull[];
				for (const pull of open) {
					// Scout's own pull requests had their review before people were asked.
					if (pull.user?.login === this.#self) continue;
					const asked = (pull.requested_reviewers ?? []).some((r) => r.login === this.#self);
					if (!asked && !this.#scout.pulls.reviewedBefore(repo.slug, pull.number)) continue;
					if (this.#scout.pulls.review(repo.slug, pull.number, pull.head.sha) !== undefined) continue;
					await this.#start(repo, pull).catch((error: unknown) => console.error(`couldn't start reviewing ${pull.html_url}:`, error));
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
			this.#starting.clear();
			this.#polling = false;
		}
	}

	async #start(repo: RepoConfig, pull: OpenPull): Promise<void> {
		const { harness, workspaces, pulls } = this.#scout;
		const { slug } = repo;
		// A review is a run in the repository's channel: its budget and the run limits apply, and its spend counts there.
		const channel = this.#scout.channelOf(repo.name)?.name ?? "";
		const admission = (await this.#admit?.(channel)) ?? { ok: true };
		const key = `${slug}#${pull.number}@${pull.head.sha}`;
		if (!admission.ok) {
			if (admission.wait !== true && !this.#held.has(key)) console.log(`not reviewing ${pull.html_url} yet: ${admission.reason}`);
			this.#held.add(key);
			return;
		}
		this.#held.delete(key);
		const mirror = workspaces.mirrorFor(repo.name);
		await mirror.refresh();
		const root = join(this.#config.dataDir, "reviews", `${slug.replace("/", "-")}-${pull.number}-${pull.head.sha.slice(0, 12)}`);
		const cwd = join(root, "repo");
		await mirror.checkout(cwd, pull.head.sha);
		const { stat, diff } = await diffOf(mirror.path, `refs/heads/${pull.base.ref}`, pull.head.sha);

		const conversation = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: this.#scout.pullReviewerAgent,
				init: async (tx, id) => {
					const doc = await tx.doc(ReviewDoc, id);
					doc.root = root;
					doc.cwd = cwd;
					// Where its spend counts (observe.ts reads the channel from here).
					const thread = await tx.doc(ThreadDoc, id);
					thread.channelName = channel;
					thread.repo = repo.name;
				},
			},
			this.#context,
		);
		const team = this.#scout.channelOf(repo.name)?.instructions;
		const prompt = [
			`# ${pull.title}`,
			`Pull request ${pull.html_url} by ${pull.user?.login ?? "someone"}, from ${pull.head.ref} into ${pull.base.ref}, at ${pull.head.sha.slice(0, 7)}. The checkout in front of you is its head.`,
			pull.body ?? "",
			...(team === undefined ? [] : [`What this repository's team wants Scout to know:\n\n${team}`]),
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
		this.#starting.add(key);
		console.log(`reviewing ${pull.html_url} at ${pull.head.sha.slice(0, 7)}`);
	}

	async #finish(row: ReviewRow): Promise<void> {
		const { harness, pulls, workspaces } = this.#scout;
		const submission = await harness.submission(row.submissionId as SubmissionId, this.#context);
		if (submission === undefined) throw new Error("its submission is gone");
		const settled = await submission.wait(this.#context);
		let text = "COMMENT\nI couldn't finish reviewing this one.";
		if (settled.status === "done" && settled.type === "input") {
			const conversation = await harness.conversation(row.conversationId as ConversationId, this.#context);
			const answer = await conversation?.commit((tx) => tx.entry(AssistantEntry, settled.answer), this.#context);
			const content = answer?.model?.[0]?.content ?? [];
			text =
				(typeof content === "string" ? content : content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")) || text;
		}
		const repo = this.#config.repos.find((r) => r.slug === row.slug);
		const pull = (await this.#api("GET", `/repos/${row.slug}/pulls/${row.number}`)) as OpenPull;
		// The lines a comment may sit on are the diff's; the mirror still has both ends from when the review started.
		const diff = repo === undefined ? "" : (await diffOf(workspaces.mirrorFor(repo.name).path, `refs/heads/${pull.base.ref}`, row.sha)).diff;
		const review = parsePullReview(text, diff);
		const channel = repo === undefined ? undefined : this.#scout.channelOf(repo.name)?.name;
		await this.#post(row, review, channel);
		pulls.reviewPosted(row);
		this.#scout.audit.record("review_posted", {
			actor: "scout",
			conversationId: row.conversationId,
			detail: { pull: `${row.slug}#${row.number}`, sha: row.sha, verdict: review.verdict, comments: review.comments.length },
		});
		if (repo !== undefined && this.#onReview !== undefined) {
			await this.#onReview({
				repo: repo.name,
				slug: row.slug,
				number: row.number,
				sha: row.sha,
				title: pull.title,
				url: pull.html_url,
				...(pull.user?.login === undefined ? {} : { author: pull.user.login }),
				...(pull.head.repo?.full_name === row.slug ? { head: pull.head.ref } : {}),
				conversationId: row.conversationId,
				review,
			});
		}
	}

	/** As a review, with comments on lines; if the code host refuses those, with them in the body; else as a comment. */
	async #post(row: ReviewRow, review: PullReview, channel: string | undefined): Promise<void> {
		const github = this.#config.codeHost.kind === "github";
		const footer = `_Reviewed at \`${row.sha.slice(0, 7)}\`${channel === undefined ? "" : `; ask me about it in #${channel}`}. I review each new push until this closes._`;
		const body = (comments: PullReview["comments"]) =>
			[review.body || (review.verdict === "approve" ? "Looks good to me." : ""), ...comments.map((c) => `**${c.path}:${c.line}**: ${c.body}`), footer]
				.filter(Boolean)
				.join("\n\n");
		const event = { approve: github ? "APPROVE" : "APPROVED", changes: "REQUEST_CHANGES", comment: "COMMENT" }[review.verdict];
		const lineComments = review.comments.map((c) =>
			github ? { path: c.path, line: c.line, side: "RIGHT", body: c.body } : { path: c.path, new_position: c.line, old_position: 0, body: c.body },
		);
		const reviews = `/repos/${row.slug}/pulls/${row.number}/reviews`;
		const attempts = [
			() => this.#api("POST", reviews, { body: body([]), commit_id: row.sha, event, comments: lineComments }),
			() => this.#api("POST", reviews, { body: body(review.comments), commit_id: row.sha, event }),
			() => this.#api("POST", `/repos/${row.slug}/issues/${row.number}/comments`, { body: `**Scout's review**\n\n${body(review.comments)}` }),
		];
		for (const [i, attempt] of attempts.entries()) {
			try {
				await attempt();
				return;
			} catch (error) {
				if (i === attempts.length - 1) throw error;
				console.error(`posting the review of ${row.slug}#${row.number} another way:`, error instanceof Error ? error.message : error);
			}
		}
	}

	async #api(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
		const host: CodeHost = this.#config.codeHost;
		const response = await this.#fetch(`${host.apiUrl}${path}`, {
			method,
			headers: {
				"content-type": "application/json",
				accept: host.kind === "github" ? "application/vnd.github+json" : "application/json",
				authorization: host.kind === "github" ? `Bearer ${host.token}` : `token ${host.token}`,
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!response.ok) throw new Error(`code host answered ${response.status} for ${path}: ${(await response.text()).slice(0, 200)}`);
		return response.json();
	}
}
