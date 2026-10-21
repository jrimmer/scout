import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CodeHost } from "./codehost.ts";

/**
 * Work asked of Scout on the code host: an issue assigned to it, `@scout` in an issue, a pull request or a comment, and
 * what people say on Scout's own pull requests. Scout has no public address, so it reads its account's notifications
 * (Forgejo and GitHub both keep them) and, for each issue or pull request they point at, what's new there.
 *
 * The code host is behind `Forge`, so another one plugs in by implementing it; Forgejo and GitHub share one REST
 * implementation, since Forgejo's API follows GitHub's, with their differences in a `Dialect`.
 */

export type Issue = {
	slug: string;
	number: number;
	title: string;
	body: string;
	url: string;
	author: string;
	pull: boolean;
	state: string;
	assignees: string[];
	createdAt: number;
};

/** Something people said on an issue or pull request: a comment, or a review's summary. */
export type Remark = { id: string; author: string; body: string; at: number; url?: string; review?: string };

/** An unread notification: which issue or pull request something happened on. */
export type Notice = { id: string; slug: string; number: number };

export interface Forge {
	/** "Forgejo", "GitHub": for what Scout writes. */
	readonly name: string;
	/** Scout's own login. */
	me(): Promise<string>;
	unread(): Promise<Notice[]>;
	markRead(notice: Notice): Promise<void>;
	issue(slug: string, number: number): Promise<Issue>;
	/** Comments, and for a pull request its reviews, oldest first. */
	remarks(issue: Issue): Promise<Remark[]>;
	comment(slug: string, number: number, body: string): Promise<void>;
	/** A pull request's branch, when it's in the repository itself (not a fork). */
	headBranch(slug: string, number: number): Promise<string | undefined>;
}

/** Where Forgejo and GitHub differ. */
type Dialect = {
	name: string;
	headers(token: string): Record<string, string>;
	unreadPath: string;
	isIssue(subjectType: string): boolean;
};

const DIALECTS: Record<CodeHost["kind"], Dialect> = {
	forgejo: {
		name: "Forgejo",
		headers: (token) => ({ accept: "application/json", authorization: `token ${token}` }),
		unreadPath: "/notifications?status-types=unread&limit=50",
		isIssue: (type) => type === "Issue" || type === "Pull",
	},
	github: {
		name: "GitHub",
		headers: (token) => ({ accept: "application/vnd.github+json", authorization: `Bearer ${token}` }),
		unreadPath: "/notifications?per_page=50",
		isIssue: (type) => type === "Issue" || type === "PullRequest",
	},
};

export function forgeFor(host: CodeHost, doFetch: typeof fetch = fetch): Forge {
	return new RestForge(host, DIALECTS[host.kind], doFetch);
}

type User = { login?: string };
type ApiIssue = {
	number: number;
	title: string;
	body?: string | null;
	html_url: string;
	user?: User;
	state: string;
	assignees?: User[] | null;
	pull_request?: unknown;
	created_at: string;
};
type ApiComment = { id: number; body?: string | null; user?: User; created_at: string; html_url?: string };
type ApiReview = { id: number; body?: string | null; user?: User; state: string; submitted_at?: string; html_url?: string };

class RestForge implements Forge {
	readonly #host: CodeHost;
	readonly #dialect: Dialect;
	readonly #fetch: typeof fetch;
	#me: string | undefined;

	constructor(host: CodeHost, dialect: Dialect, doFetch: typeof fetch) {
		this.#host = host;
		this.#dialect = dialect;
		this.#fetch = doFetch;
	}

	get name(): string {
		return this.#dialect.name;
	}

	async me(): Promise<string> {
		this.#me ??= ((await this.#api("GET", "/user")) as User).login ?? "";
		return this.#me;
	}

	async unread(): Promise<Notice[]> {
		const threads = (await this.#api("GET", this.#dialect.unreadPath)) as { id: number | string; repository?: { full_name?: string }; subject?: { type?: string; url?: string } }[];
		return threads.flatMap((t) => {
			const number = Number(t.subject?.url?.split("/").pop());
			const slug = t.repository?.full_name;
			if (!this.#dialect.isIssue(t.subject?.type ?? "") || slug === undefined || !Number.isInteger(number)) {
				return [{ id: String(t.id), slug: "", number: 0 }];
			}
			return [{ id: String(t.id), slug, number }];
		});
	}

	async markRead(notice: Notice): Promise<void> {
		await this.#api("PATCH", `/notifications/threads/${notice.id}`);
	}

	async issue(slug: string, number: number): Promise<Issue> {
		const i = (await this.#api("GET", `/repos/${slug}/issues/${number}`)) as ApiIssue;
		return {
			slug,
			number: i.number,
			title: i.title,
			body: i.body ?? "",
			url: i.html_url,
			author: i.user?.login ?? "",
			pull: i.pull_request !== undefined && i.pull_request !== null,
			state: i.state,
			assignees: (i.assignees ?? []).flatMap((a) => (a.login === undefined ? [] : [a.login])),
			createdAt: Date.parse(i.created_at),
		};
	}

	async remarks(issue: Issue): Promise<Remark[]> {
		const comments = (await this.#api("GET", `/repos/${issue.slug}/issues/${issue.number}/comments?limit=50&per_page=50`)) as ApiComment[];
		const remarks: Remark[] = comments.map((c) => ({
			id: `comment:${c.id}`,
			author: c.user?.login ?? "",
			body: c.body ?? "",
			at: Date.parse(c.created_at),
			...(c.html_url ? { url: c.html_url } : {}),
		}));
		if (issue.pull) {
			const reviews = (await this.#api("GET", `/repos/${issue.slug}/pulls/${issue.number}/reviews`)) as ApiReview[];
			for (const r of reviews) {
				if (r.submitted_at === undefined || r.state === "PENDING") continue;
				remarks.push({
					id: `review:${r.id}`,
					author: r.user?.login ?? "",
					body: r.body ?? "",
					at: Date.parse(r.submitted_at),
					review: r.state,
					...(r.html_url ? { url: r.html_url } : {}),
				});
			}
		}
		return remarks.sort((a, b) => a.at - b.at);
	}

	async comment(slug: string, number: number, body: string): Promise<void> {
		await this.#api("POST", `/repos/${slug}/issues/${number}/comments`, { body });
	}

	async headBranch(slug: string, number: number): Promise<string | undefined> {
		const pull = (await this.#api("GET", `/repos/${slug}/pulls/${number}`)) as { head?: { ref?: string; repo?: { full_name?: string } | null } };
		return pull.head?.repo?.full_name?.toLowerCase() === slug.toLowerCase() ? pull.head.ref : undefined;
	}

	async #api(method: string, path: string, body?: unknown): Promise<unknown> {
		const response = await this.#fetch(`${this.#host.apiUrl}${path}`, {
			method,
			headers: { ...this.#dialect.headers(this.#host.token), ...(body === undefined ? {} : { "content-type": "application/json" }) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!response.ok) throw new Error(`${this.#dialect.name} answered ${response.status} for ${method} ${path}`);
		return response.status === 204 || response.status === 205 ? undefined : response.json().catch(() => undefined);
	}
}

/**
 * One request from the code host, ready for a thread: who asked, on what, and what they said (several remarks on the
 * same issue since the last look come as one).
 */
export type Ask = {
	issue: Issue;
	/** Who asked; the last of them when several did. */
	by: string;
	/** What they said, oldest first: each remark, or the issue itself when that's what asked. */
	said: { author: string; body: string; url?: string; review?: string }[];
	/** Why it's Scout's: assigned, mentioned, or a remark on a pull request Scout opened. */
	why: "assigned" | "mentioned" | "own pull request";
};

export type InboxHandlers = {
	/** Is this one of Scout's own pull requests (it opened it)? */
	ownPull(issue: Issue): boolean;
	ask(ask: Ask): Promise<void>;
};

/**
 * Reads the notifications and turns what's new into asks. Remembers what it has handled, and ignores everything from
 * before it was first switched on, so old history never becomes new work.
 */
export class Inbox {
	readonly #db: DatabaseSync;
	readonly #forge: Forge;
	readonly #handlers: InboxHandlers;
	#polling = false;

	constructor(options: { path: string; forge: Forge; handlers: InboxHandlers; now?: number }) {
		if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true });
		this.#db = new DatabaseSync(options.path, { timeout: 5000 });
		this.#forge = options.forge;
		this.#handlers = options.handlers;
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS forge_handled (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS forge_threads (
				slug TEXT NOT NULL,
				number INTEGER NOT NULL,
				conversation_id INTEGER NOT NULL,
				PRIMARY KEY (slug, number)
			);
			CREATE TABLE IF NOT EXISTS forge_replies (
				conversation_id INTEGER PRIMARY KEY,
				slug TEXT NOT NULL,
				number INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS forge_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		`);
		this.#db.prepare("INSERT OR IGNORE INTO forge_meta (key, value) VALUES ('since', ?)").run(String(options.now ?? Date.now()));
	}

	get #since(): number {
		return Number((this.#db.prepare("SELECT value FROM forge_meta WHERE key = 'since'").get() as { value: string }).value);
	}

	async poll(): Promise<void> {
		if (this.#polling) return;
		this.#polling = true;
		try {
			const me = (await this.#forge.me()).toLowerCase();
			const seen = new Set<string>();
			for (const notice of await this.#forge.unread()) {
				const key = `${notice.slug}#${notice.number}`;
				if (notice.slug !== "" && !seen.has(key)) {
					seen.add(key);
					await this.#look(notice, me);
				}
				await this.#forge.markRead(notice);
			}
		} finally {
			this.#polling = false;
		}
	}

	async #look(notice: Notice, me: string): Promise<void> {
		const issue = await this.#forge.issue(notice.slug, notice.number);
		const since = this.#since;
		const mentions = (text: string) => new RegExp(`(^|[^\\w@/.-])@${me.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(text);
		const ours = this.#handlers.ownPull(issue);
		const said: Ask["said"] = [];
		let why: Ask["why"] | undefined;
		let by = "";
		const take = (key: string, reason: Ask["why"], who: string, entry: Ask["said"][number]) => {
			if (this.#handled(key)) return;
			this.#handle(key);
			said.push(entry);
			by = who;
			// A mention or an assignment says more about what's wanted than "a comment on your pull request".
			if (why === undefined || why === "own pull request") why = reason;
		};

		const fresh = issue.createdAt >= since && issue.author.toLowerCase() !== me;
		if (issue.assignees.some((a) => a.toLowerCase() === me)) {
			take(`assigned:${issue.slug}#${issue.number}`, "assigned", issue.author, { author: issue.author, body: `${issue.title}\n\n${issue.body}`.trim(), url: issue.url });
		} else if (fresh && mentions(`${issue.title}\n${issue.body}`)) {
			take(`opened:${issue.slug}#${issue.number}`, "mentioned", issue.author, { author: issue.author, body: `${issue.title}\n\n${issue.body}`.trim(), url: issue.url });
		}
		for (const remark of await this.#forge.remarks(issue)) {
			if (remark.at < since || remark.author.toLowerCase() === me) continue;
			// Scout's own review comments, posted as a person would see them, aren't requests.
			if (remark.body.startsWith("**Scout's review**")) continue;
			const entry = { author: remark.author, body: remark.body, ...(remark.url === undefined ? {} : { url: remark.url }), ...(remark.review === undefined ? {} : { review: remark.review }) };
			if (mentions(remark.body)) take(remark.id, "mentioned", remark.author, entry);
			// On its own pull request, anything with words in it, or a request for changes; a bare approval needs nothing.
			else if (ours && (remark.body.trim() !== "" || /CHANGES/.test(remark.review ?? ""))) take(remark.id, "own pull request", remark.author, entry);
			else this.#handle(remark.id);
		}
		if (why !== undefined) await this.#handlers.ask({ issue, by, said, why });
	}

	#handled(key: string): boolean {
		return this.#db.prepare("SELECT 1 FROM forge_handled WHERE key = ?").get(key) !== undefined;
	}

	#handle(key: string): void {
		this.#db.prepare("INSERT OR IGNORE INTO forge_handled (key, at) VALUES (?, ?)").run(key, Date.now());
	}

	/** The conversation an issue's thread is in, once it has one. */
	threadOf(slug: string, number: number): number | undefined {
		const row = this.#db.prepare("SELECT conversation_id FROM forge_threads WHERE slug = ? AND number = ?").get(slug, number) as { conversation_id: number } | undefined;
		return row?.conversation_id;
	}

	threadStarted(slug: string, number: number, conversationId: number): void {
		this.#db.prepare("INSERT OR REPLACE INTO forge_threads (slug, number, conversation_id) VALUES (?, ?, ?)").run(slug, number, conversationId);
	}

	/** The conversation's next answer goes back to this issue or pull request, as a comment. */
	replyTo(conversationId: number, slug: string, number: number): void {
		this.#db.prepare("INSERT OR REPLACE INTO forge_replies (conversation_id, slug, number) VALUES (?, ?, ?)").run(conversationId, slug, number);
	}

	/** A run's answer: if someone asked on the code host, it goes back there too. */
	async answered(conversationId: number, answer: string | undefined, link: string | undefined): Promise<void> {
		const row = this.#db.prepare("SELECT slug, number FROM forge_replies WHERE conversation_id = ?").get(conversationId) as { slug: string; number: number } | undefined;
		if (row === undefined || answer === undefined) return;
		this.#db.prepare("DELETE FROM forge_replies WHERE conversation_id = ?").run(conversationId);
		await this.#forge.comment(row.slug, row.number, `${answer}${link === undefined ? "" : `\n\n---\nFrom the thread: ${link}`}`);
	}

	close(): void {
		this.#db.close();
	}
}
