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

/**
 * Something people said on an issue or pull request: a comment, a review's summary, or a comment on a line (with its
 * file and line, and its review's verdict).
 */
export type Remark = { id: string; author: string; body: string; at: number; url?: string; review?: string; path?: string; line?: number };

/** Where a pull request stands: open or not, whether it merges cleanly (unknown while the host works it out), its last activity, and the commits at its two ends. */
export type PullStatus = { open: boolean; merged: boolean; mergeable?: boolean; updatedAt: number; head: string; headRef: string; base: string; baseRef: string; reviewers: string[] };

/** An open pull request, as a list of them shows it: who's been asked to review it and hasn't yet. */
export type OpenPull = { number: number; title: string; url: string; author: string; draft: boolean; createdAt: number; reviewers: string[]; teams: string[] };

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
	/** Who last assigned the issue or pull request to `login`, from its history; undefined when it doesn't say. */
	assigner(slug: string, number: number, login: string): Promise<string | undefined>;
	/** Comments, and for a pull request its reviews and comments on lines, oldest first. */
	remarks(issue: Issue): Promise<Remark[]>;
	/** React 👀 to a comment (`comment:<id>`), or to the issue itself, to say Scout has picked it up. */
	acknowledge(slug: string, number: number, remarkId?: string): Promise<void>;
	comment(slug: string, number: number, body: string): Promise<void>;
	/** A pull request's branch, when it's in the repository itself (not a fork). */
	headBranch(slug: string, number: number): Promise<string | undefined>;
	/** Whether anyone can read the repository. When the code host won't say, assume so. */
	isPublic(slug: string): Promise<boolean>;
	pullStatus(slug: string, number: number): Promise<PullStatus>;
	/** CI's combined verdict on a commit; undefined when nothing reports CI for it. */
	ciState(slug: string, sha: string): Promise<"passing" | "failing" | "pending" | undefined>;
	closePull(slug: string, number: number): Promise<void>;
	/** The files a pull request changes. */
	pullFiles(slug: string, number: number): Promise<string[]>;
	/** Ask people (logins) and teams (`org/team`, or the team's name) to review a pull request. */
	requestReviewers(slug: string, number: number, who: { users: string[]; teams: string[] }): Promise<void>;
	openPulls(slug: string): Promise<OpenPull[]>;
	deleteBranch(slug: string, branch: string): Promise<void>;
}

/** Where Forgejo and GitHub differ. */
type Dialect = {
	name: string;
	headers(token: string): Record<string, string>;
	unreadPath: string;
	isIssue(subjectType: string): boolean;
	/** The path that deletes a branch. */
	branchPath(slug: string, branch: string): string;
	/** An issue's history, ending in `?…&` for the page. */
	assignmentsPath(slug: string, number: number): string;
	/** An entry of it that (un)assigns someone: who did it, to whom. */
	assignment(event: ApiEvent): { by: string; to: string; removed: boolean } | undefined;
	/** Comments on lines of a pull request, with their review's id. */
	lineComments(api: (path: string) => Promise<unknown>, slug: string, number: number, reviews: ApiReview[]): Promise<(ApiLineComment & { reviewId?: number })[]>;
};

type ApiLineComment = { id: number; body?: string | null; user?: User; created_at: string; html_url?: string; path?: string; line?: number | null; position?: number | null; pull_request_review_id?: number | null };

const DIALECTS: Record<CodeHost["kind"], Dialect> = {
	forgejo: {
		name: "Forgejo",
		headers: (token) => ({ accept: "application/json", authorization: `token ${token}` }),
		unreadPath: "/notifications?status-types=unread&limit=50",
		isIssue: (type) => type === "Issue" || type === "Pull",
		branchPath: (slug, branch) => `/repos/${slug}/branches/${encodeURIComponent(branch)}`,
		assignmentsPath: (slug, number) => `/repos/${slug}/issues/${number}/timeline?limit=50&`,
		assignment: (e) =>
			e.type === "assignees" && e.user?.login !== undefined && e.assignee?.login !== undefined ? { by: e.user.login, to: e.assignee.login, removed: e.removed_assignee === true } : undefined,
		// Forgejo keeps them under each review, with the new file's line as `position`.
		lineComments: async (api, slug, number, reviews) => {
			const all = [];
			for (const r of reviews) {
				if ((r.comments_count ?? 0) === 0) continue;
				const comments = (await api(`/repos/${slug}/pulls/${number}/reviews/${r.id}/comments`)) as ApiLineComment[];
				all.push(...comments.map((c) => ({ ...c, line: c.line ?? c.position ?? null, reviewId: r.id })));
			}
			return all;
		},
	},
	github: {
		name: "GitHub",
		headers: (token) => ({ accept: "application/vnd.github+json", authorization: `Bearer ${token}` }),
		unreadPath: "/notifications?per_page=50",
		isIssue: (type) => type === "Issue" || type === "PullRequest",
		branchPath: (slug, branch) => `/repos/${slug}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
		assignmentsPath: (slug, number) => `/repos/${slug}/issues/${number}/events?per_page=100&`,
		assignment: (e) =>
			(e.event === "assigned" || e.event === "unassigned") && e.actor?.login !== undefined && e.assignee?.login !== undefined
				? { by: e.actor.login, to: e.assignee.login, removed: e.event === "unassigned" }
				: undefined,
		lineComments: async (api, slug, number) =>
			((await api(`/repos/${slug}/pulls/${number}/comments?per_page=100`)) as ApiLineComment[]).map((c) => ({
				...c,
				...(c.pull_request_review_id == null ? {} : { reviewId: c.pull_request_review_id }),
			})),
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
type ApiReview = { id: number; body?: string | null; user?: User; state: string; submitted_at?: string; html_url?: string; comments_count?: number };
/** An entry in an issue's history: GitHub's events (`event`, `actor`) or Forgejo's timeline (`type`, `user`). */
type ApiEvent = { event?: string; type?: string; actor?: User | null; user?: User | null; assignee?: User | null; removed_assignee?: boolean };

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

	async assigner(slug: string, number: number, login: string): Promise<string | undefined> {
		let by: string | undefined;
		// The history, oldest first, a page at a time: the last time it was assigned to `login` is who asked.
		for (let page = 1; page <= 10; page++) {
			const events = (await this.#api("GET", `${this.#dialect.assignmentsPath(slug, number)}page=${page}`)) as ApiEvent[] | undefined;
			if (!Array.isArray(events) || events.length === 0) break;
			for (const e of events) {
				const assigned = this.#dialect.assignment(e);
				if (assigned !== undefined && assigned.to.toLowerCase() === login.toLowerCase()) by = assigned.removed ? undefined : assigned.by;
			}
		}
		return by;
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
			const verdicts = new Map<number, string>();
			for (const r of reviews) {
				if (r.submitted_at === undefined || r.state === "PENDING") continue;
				verdicts.set(r.id, r.state);
				remarks.push({
					id: `review:${r.id}`,
					author: r.user?.login ?? "",
					body: r.body ?? "",
					at: Date.parse(r.submitted_at),
					review: r.state,
					...(r.html_url ? { url: r.html_url } : {}),
				});
			}
			for (const c of await this.#dialect.lineComments((path) => this.#api("GET", path), issue.slug, issue.number, reviews)) {
				const verdict = c.reviewId === undefined ? undefined : verdicts.get(c.reviewId);
				remarks.push({
					id: `line:${c.id}`,
					author: c.user?.login ?? "",
					body: c.body ?? "",
					at: Date.parse(c.created_at),
					...(verdict === undefined ? {} : { review: verdict }),
					...(c.path ? { path: c.path } : {}),
					...(c.line == null ? {} : { line: c.line }),
					...(c.html_url ? { url: c.html_url } : {}),
				});
			}
		}
		return remarks.sort((a, b) => a.at - b.at);
	}

	async acknowledge(slug: string, number: number, remarkId?: string): Promise<void> {
		const comment = /^comment:(\d+)$/.exec(remarkId ?? "");
		// Reviews and comments on lines: nowhere both hosts let you react.
		if (remarkId !== undefined && comment === null) return;
		const path = comment === null ? `/repos/${slug}/issues/${number}/reactions` : `/repos/${slug}/issues/comments/${comment[1]}/reactions`;
		await this.#api("POST", path, { content: "eyes" });
	}

	async comment(slug: string, number: number, body: string): Promise<void> {
		await this.#api("POST", `/repos/${slug}/issues/${number}/comments`, { body });
	}

	async headBranch(slug: string, number: number): Promise<string | undefined> {
		const pull = (await this.#api("GET", `/repos/${slug}/pulls/${number}`)) as { head?: { ref?: string; repo?: { full_name?: string } | null } };
		return pull.head?.repo?.full_name?.toLowerCase() === slug.toLowerCase() ? pull.head.ref : undefined;
	}

	async pullStatus(slug: string, number: number): Promise<PullStatus> {
		const p = (await this.#api("GET", `/repos/${slug}/pulls/${number}`)) as {
			state: string;
			mergeable?: boolean | null;
			merged?: boolean;
			requested_reviewers?: User[] | null;
			updated_at: string;
			head: { sha: string; ref: string };
			base: { sha: string; ref: string };
		};
		return {
			open: p.state === "open",
			merged: p.merged === true,
			reviewers: (p.requested_reviewers ?? []).flatMap((r) => (r.login === undefined ? [] : [r.login])),
			...(typeof p.mergeable === "boolean" ? { mergeable: p.mergeable } : {}),
			updatedAt: Date.parse(p.updated_at),
			head: p.head.sha,
			headRef: p.head.ref,
			base: p.base.sha,
			baseRef: p.base.ref,
		};
	}

	async ciState(slug: string, sha: string): Promise<"passing" | "failing" | "pending" | undefined> {
		const status = (await this.#api("GET", `/repos/${slug}/commits/${sha}/status`)) as { state?: string; total_count?: number };
		if ((status.total_count ?? 0) === 0) return undefined;
		return status.state === "success" ? "passing" : status.state === "pending" ? "pending" : "failing";
	}

	async closePull(slug: string, number: number): Promise<void> {
		await this.#api("PATCH", `/repos/${slug}/pulls/${number}`, { state: "closed" });
	}

	async pullFiles(slug: string, number: number): Promise<string[]> {
		const files = (await this.#api("GET", `/repos/${slug}/pulls/${number}/files?limit=100&per_page=100`)) as { filename: string }[];
		return files.map((f) => f.filename);
	}

	async requestReviewers(slug: string, number: number, who: { users: string[]; teams: string[] }): Promise<void> {
		if (who.users.length + who.teams.length === 0) return;
		await this.#api("POST", `/repos/${slug}/pulls/${number}/requested_reviewers`, { reviewers: who.users, team_reviewers: who.teams });
	}

	async openPulls(slug: string): Promise<OpenPull[]> {
		const pulls = (await this.#api("GET", `/repos/${slug}/pulls?state=open&limit=50&per_page=50`)) as {
			number: number;
			title: string;
			html_url: string;
			user?: User;
			draft?: boolean;
			created_at: string;
			requested_reviewers?: User[] | null;
			requested_teams?: { name?: string; slug?: string }[] | null;
		}[];
		return pulls.map((p) => ({
			number: p.number,
			title: p.title,
			url: p.html_url,
			author: p.user?.login ?? "",
			draft: p.draft === true,
			createdAt: Date.parse(p.created_at),
			reviewers: (p.requested_reviewers ?? []).flatMap((r) => (r.login === undefined ? [] : [r.login])),
			teams: (p.requested_teams ?? []).flatMap((t) => (t.slug ?? t.name ?? "") || []),
		}));
	}

	async deleteBranch(slug: string, branch: string): Promise<void> {
		await this.#api("DELETE", this.#dialect.branchPath(slug, branch));
	}

	async isPublic(slug: string): Promise<boolean> {
		const repo = (await this.#api("GET", `/repos/${slug}`).catch(() => undefined)) as { private?: boolean } | undefined;
		return repo?.private !== true;
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
	/**
	 * Who asked; the last of them when several did (or who spoke last, for context alone). Each addressed remark's
	 * asker (`askerOf`) is someone to check, not just this one.
	 */
	by: string;
	/** What was said, oldest first: each remark, or the issue itself when that's what asked. */
	said: Said[];
	/** Why it's Scout's: assigned, mentioned, or a remark on a pull request Scout opened. */
	why: "assigned" | "mentioned" | "own pull request";
	/**
	 * Whether anything in it asks Scout for something: a mention, an assignment, or a review asking for changes on its
	 * pull request. Otherwise it's context for the thread, like a reply in Slack that isn't addressed to Scout.
	 */
	request: boolean;
};

/**
 * `asker` is who asks with it when that isn't its author: whoever assigned the issue to Scout (empty when the code
 * host didn't say). Everyone who asks must be someone who may ask, not only the last of them.
 */
export type Said = { id?: string; author: string; body: string; url?: string; review?: string; path?: string; line?: number; addressed: boolean; asker?: string };

/** Who asks with a remark: its asker when it has one (an assignment's), else its author. */
export function askerOf(said: Said): string {
	return said.asker ?? said.author;
}

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
			CREATE TABLE IF NOT EXISTS forge_askers (thread_key TEXT NOT NULL, login TEXT NOT NULL, PRIMARY KEY (thread_key, login));
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
		const said: Said[] = [];
		let why: Ask["why"] | undefined;
		const take = (key: string, entry: Said, reason?: Ask["why"]) => {
			if (this.#handled(key)) return;
			this.#handle(key);
			said.push(entry);
			// A mention or an assignment says more about what's wanted than "a comment on your pull request".
			if (reason !== undefined && (why === undefined || why === "own pull request")) why = reason;
		};

		const fresh = issue.createdAt >= since && issue.author.toLowerCase() !== me;
		const opening = { author: issue.author, body: `${issue.title}\n\n${issue.body}`.trim(), url: issue.url, addressed: true };
		const assignedKey = `assigned:${issue.slug}#${issue.number}`;
		if (issue.assignees.some((a) => a.toLowerCase() === me)) {
			// An assignment asks on behalf of whoever assigned it, not the issue's author: an outsider's issue a maintainer
			// assigned is the maintainer's request, and a maintainer's issue an outsider assigned isn't.
			const asker = this.#handled(assignedKey) ? "" : ((await this.#forge.assigner(issue.slug, issue.number, me).catch(() => undefined)) ?? "");
			take(assignedKey, { ...opening, asker }, "assigned");
		}
		else if (fresh && mentions(`${issue.title}\n${issue.body}`)) take(`opened:${issue.slug}#${issue.number}`, opening, "mentioned");
		for (const remark of await this.#forge.remarks(issue)) {
			if (remark.at < since || remark.author.toLowerCase() === me) continue;
			// Scout's own review comments, posted as a person would see them, aren't requests.
			if (remark.body.startsWith("**Scout's review**")) continue;
			const entry = {
				id: remark.id,
				author: remark.author,
				body: remark.body,
				...(remark.url === undefined ? {} : { url: remark.url }),
				...(remark.review === undefined ? {} : { review: remark.review }),
				...(remark.path === undefined ? {} : { path: remark.path }),
				...(remark.line === undefined ? {} : { line: remark.line }),
			};
			if (mentions(remark.body)) take(remark.id, { ...entry, addressed: true }, "mentioned");
			// On its own pull request: a review asking for changes (and its comments on lines) is for Scout; anything
			// else people say there is context, as a reply in Slack that isn't addressed to Scout would be.
			else if (ours && /CHANGES/.test(remark.review ?? "")) take(remark.id, { ...entry, addressed: true }, "own pull request");
			else if (ours && remark.body.trim() !== "") take(remark.id, { ...entry, addressed: false }, "own pull request");
			else this.#handle(remark.id);
		}
		if (said.length === 0 || why === undefined) return;
		const asking = said.filter((s) => s.addressed);
		const last = asking.at(-1);
		await this.#handlers.ask({ issue, by: last === undefined ? said.at(-1)!.author : askerOf(last), said, why, request: asking.length > 0 });
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

	/** `login` asked for work in the Slack thread `threadKey` from the code host (before its run starts). */
	asked(threadKey: string, login: string): void {
		this.#db.prepare("INSERT OR IGNORE INTO forge_askers (thread_key, login) VALUES (?, ?)").run(threadKey, login);
	}

	/** Everyone who has asked in a thread from the code host: what the thread reads, each of them may. */
	askers(threadKey: string): string[] {
		return this.#db.prepare("SELECT login FROM forge_askers WHERE thread_key = ? ORDER BY login").all(threadKey).map((r) => String(r.login));
	}

	threadStarted(slug: string, number: number, conversationId: number): void {
		this.#db.prepare("INSERT OR REPLACE INTO forge_threads (slug, number, conversation_id) VALUES (?, ?, ?)").run(slug, number, conversationId);
	}

	/** The conversation's next answer goes back to this issue or pull request, as a comment. */
	replyTo(conversationId: number, slug: string, number: number): void {
		this.#db.prepare("INSERT OR REPLACE INTO forge_replies (conversation_id, slug, number) VALUES (?, ?, ?)").run(conversationId, slug, number);
	}

	/**
	 * A run's answer: if someone asked on the code host, it goes back there too. In full on a private repository; on a
	 * public one only a pointer (the thread, and any pull request it opened), since the answer can draw on anything said
	 * in Slack, which isn't for everyone.
	 */
	async answered(conversationId: number, answer: string | undefined, link: string | undefined): Promise<void> {
		const row = this.#db.prepare("SELECT slug, number FROM forge_replies WHERE conversation_id = ?").get(conversationId) as { slug: string; number: number } | undefined;
		if (row === undefined || answer === undefined) return;
		this.#db.prepare("DELETE FROM forge_replies WHERE conversation_id = ?").run(conversationId);
		if (!(await this.#forge.isPublic(row.slug))) {
			await this.#forge.comment(row.slug, row.number, `${answer}${link === undefined ? "" : `\n\n---\nFrom the thread: ${link}`}`);
			return;
		}
		const pulls = [...new Set(answer.match(/https?:\/\/\S+?\/pulls?\/\d+/g) ?? [])];
		const lines = [
			link === undefined ? "I've answered in Slack." : `I've answered in the Slack thread: ${link}`,
			...(pulls.length === 0 ? [] : [`Pull request${pulls.length === 1 ? "" : "s"}: ${pulls.join(", ")}`]),
		];
		await this.#forge.comment(row.slug, row.number, lines.join("\n\n"));
	}

	close(): void {
		this.#db.close();
	}
}
