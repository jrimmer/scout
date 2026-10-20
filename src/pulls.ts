import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CodeHost } from "./codehost.ts";

/**
 * Every pull request Scout opens, and what became of it. River's headline number is its merge rate (36% → 77% in two
 * months, from people teaching it); this is how Scout knows its own, and how the nightly reflection learns which of
 * its proposals people accepted.
 */
export type PullKind = "work" | "profile";
export type PullState = "open" | "merged" | "closed";

export type PullRow = {
	url: string;
	number: number;
	slug: string;
	kind: PullKind;
	conversationId: number;
	title: string;
	openedAt: number;
	state: PullState;
	decidedAt?: number;
};

const DAY = 24 * 60 * 60 * 1000;
const RECHECK_MS = 30 * 60 * 1000;

export class Pulls {
	readonly #db: DatabaseSync;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.#db = new DatabaseSync(path, { timeout: 5000 });
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS pulls (
				url TEXT PRIMARY KEY,
				number INTEGER NOT NULL,
				slug TEXT NOT NULL,
				kind TEXT NOT NULL,
				conversation_id INTEGER NOT NULL,
				title TEXT NOT NULL,
				opened_at INTEGER NOT NULL,
				state TEXT NOT NULL DEFAULT 'open',
				decided_at INTEGER,
				checked_at INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS reports (week TEXT PRIMARY KEY, sent_at INTEGER NOT NULL, spent REAL);
			CREATE TABLE IF NOT EXISTS ci (
				url TEXT PRIMARY KEY,
				sha TEXT NOT NULL,
				outcome TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				since INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS reviews (
				slug TEXT NOT NULL,
				number INTEGER NOT NULL,
				sha TEXT NOT NULL,
				conversation_id INTEGER NOT NULL,
				submission_id INTEGER NOT NULL,
				posted_at INTEGER,
				PRIMARY KEY (slug, number, sha)
			);
		`);
	}

	/** Record a pull request Scout opened; reopening the same one (an update) keeps its first record. */
	opened(pull: Omit<PullRow, "state" | "decidedAt" | "openedAt">, now = Date.now()): void {
		this.#db
			.prepare(
				`INSERT OR IGNORE INTO pulls (url, number, slug, kind, conversation_id, title, opened_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(pull.url, pull.number, pull.slug, pull.kind, pull.conversationId, pull.title, now);
	}

	/** Scout's pull requests that are still open, as of the last check. */
	open(kind: PullKind): PullRow[] {
		return this.#db.prepare("SELECT * FROM pulls WHERE state = 'open' AND kind = ?").all(kind).map(toPull);
	}

	/** What CI said about a pull request's head (ci.ts): the commit, its outcome, and how many fixes Scout has tried. */
	ci(url: string): CiRow | undefined {
		const row = this.#db.prepare("SELECT * FROM ci WHERE url = ?").get(url) as
			| { sha: string; outcome: CiOutcome; attempts: number; since: number }
			| undefined;
		return row === undefined ? undefined : { sha: row.sha, outcome: row.outcome, attempts: row.attempts, since: row.since };
	}

	ciSaw(url: string, row: CiRow): void {
		this.#db
			.prepare("INSERT OR REPLACE INTO ci (url, sha, outcome, attempts, since) VALUES (?, ?, ?, ?, ?)")
			.run(url, row.sha, row.outcome, row.attempts, row.since);
	}

	get(url: string): PullRow | undefined {
		const row = this.#db.prepare("SELECT * FROM pulls WHERE url = ?").get(url);
		return row === undefined ? undefined : toPull(row);
	}

	recent(kind: PullKind, limit: number): PullRow[] {
		return this.#db
			.prepare("SELECT * FROM pulls WHERE kind = ? ORDER BY opened_at DESC LIMIT ?")
			.all(kind, limit)
			.map(toPull);
	}

	latest(limit: number): PullRow[] {
		return this.#db.prepare("SELECT * FROM pulls ORDER BY opened_at DESC LIMIT ?").all(limit).map(toPull);
	}

	latestReviews(limit: number): ReviewRow[] {
		return this.#db.prepare("SELECT * FROM reviews ORDER BY rowid DESC LIMIT ?").all(limit).map(toReview);
	}

	forConversation(conversationId: number): PullRow[] {
		return this.#db.prepare("SELECT * FROM pulls WHERE conversation_id = ?").all(conversationId).map(toPull);
	}

	/** Ask the code host about open pull requests not checked in the last half hour. Returns the ones newly decided. */
	async refresh(host: CodeHost, doFetch: typeof fetch = fetch, now = Date.now()): Promise<PullRow[]> {
		const due = this.#db
			.prepare("SELECT * FROM pulls WHERE state = 'open' AND checked_at < ?")
			.all(now - RECHECK_MS)
			.map(toPull);
		const decided: PullRow[] = [];
		for (const pull of due) {
			const state = await fetchState(host, pull, doFetch).catch((error: unknown) => {
				console.error(`checking ${pull.url} failed:`, error);
				return undefined;
			});
			if (state === undefined) continue;
			const decidedAt = state === "open" ? null : now;
			this.#db
				.prepare("UPDATE pulls SET state = ?, decided_at = ?, checked_at = ? WHERE url = ?")
				.run(state, decidedAt, now, pull.url);
			if (state !== "open") decided.push({ ...pull, state, decidedAt: now });
		}
		return decided;
	}

	/** Merge rate for work pull requests decided in [from, to): merged / (merged + closed). */
	rate(from: number, to: number, kind: PullKind = "work"): { merged: number; closed: number } {
		const row = this.#db
			.prepare(
				`SELECT
					SUM(CASE WHEN state = 'merged' THEN 1 ELSE 0 END) AS merged,
					SUM(CASE WHEN state = 'closed' THEN 1 ELSE 0 END) AS closed
				 FROM pulls WHERE kind = ? AND decided_at >= ? AND decided_at < ?`,
			)
			.get(kind, from, to) as { merged: number | null; closed: number | null };
		return { merged: row.merged ?? 0, closed: row.closed ?? 0 };
	}

	/** The weekly report, once per `week`; undefined when it was already sent. */
	/**
	 * The weekly report, once per `week`; undefined when it was already sent. `spentSoFar` is Scout's model spend since
	 * it started, in dollars; the report says how much of it was this week's.
	 */
	weeklyReport(week: string, now = Date.now(), spentSoFar?: number): string | undefined {
		const sent = this.#db.prepare("SELECT 1 FROM reports WHERE week = ?").get(week);
		if (sent !== undefined) return undefined;
		const last = this.#db.prepare("SELECT spent FROM reports WHERE spent IS NOT NULL ORDER BY week DESC LIMIT 2").all() as {
			spent: number;
		}[];
		this.#db.prepare("INSERT INTO reports (week, sent_at, spent) VALUES (?, ?, ?)").run(week, now, spentSoFar ?? null);
		const lines = [report(this, now)];
		if (spentSoFar !== undefined) {
			const thisWeek = spentSoFar - (last[0]?.spent ?? 0);
			const before = last.length === 2 ? last[0]!.spent - last[1]!.spent : undefined;
			lines.push(
				`Models cost ${dollars(thisWeek)}${last.length === 0 ? " so far" : ""}` +
					(before === undefined ? "." : ` (${dollars(before)} the week before).`),
			);
		}
		return lines.join(" ");
	}

	count(where: string, ...args: (string | number)[]): number {
		return Number((this.#db.prepare(`SELECT COUNT(*) AS n FROM pulls WHERE ${where}`).get(...args) as { n: number }).n);
	}

	/** Whether Scout has reviewed this pull request before, at any commit: once asked, it reviews each new push. */
	reviewedBefore(slug: string, number: number): boolean {
		return this.#db.prepare("SELECT 1 FROM reviews WHERE slug = ? AND number = ? LIMIT 1").get(slug, number) !== undefined;
	}

	/** Reviews of other people's pull requests (automation.ts), by the commit reviewed. */
	review(slug: string, number: number, sha: string): ReviewRow | undefined {
		const row = this.#db.prepare("SELECT * FROM reviews WHERE slug = ? AND number = ? AND sha = ?").get(slug, number, sha);
		return row === undefined ? undefined : toReview(row);
	}

	reviewStarted(row: Omit<ReviewRow, "postedAt">): void {
		this.#db
			.prepare("INSERT INTO reviews (slug, number, sha, conversation_id, submission_id) VALUES (?, ?, ?, ?, ?)")
			.run(row.slug, row.number, row.sha, row.conversationId, row.submissionId);
	}

	unpostedReviews(): ReviewRow[] {
		return this.#db.prepare("SELECT * FROM reviews WHERE posted_at IS NULL").all().map(toReview);
	}

	reviewPosted(row: Pick<ReviewRow, "slug" | "number" | "sha">, now = Date.now()): void {
		this.#db
			.prepare("UPDATE reviews SET posted_at = ? WHERE slug = ? AND number = ? AND sha = ?")
			.run(now, row.slug, row.number, row.sha);
	}

	close(): void {
		this.#db.close();
	}
}

/** `none`: no CI reported on the commit in a while, so the repository has none (or not for this branch). */
export type CiOutcome = "pending" | "success" | "failure" | "none";
export type CiRow = { sha: string; outcome: CiOutcome; attempts: number; since: number };

export type ReviewRow = {
	slug: string;
	number: number;
	sha: string;
	conversationId: number;
	submissionId: number;
	postedAt?: number;
};

function toReview(row: Record<string, unknown>): ReviewRow {
	return {
		slug: String(row.slug),
		number: Number(row.number),
		sha: String(row.sha),
		conversationId: Number(row.conversation_id),
		submissionId: Number(row.submission_id),
		...(row.posted_at === null || row.posted_at === undefined ? {} : { postedAt: Number(row.posted_at) }),
	};
}

const FEEDBACK_LIMIT = 3_000;

type Comment = { body?: string | null; user?: { login?: string } | null; path?: string; state?: string };

/**
 * What people said on a pull request: review summaries, line comments, and the discussion, without Scout's own. This
 * is the most specific feedback Scout gets, so the nightly reflection reads it.
 */
export async function feedbackOn(
	host: CodeHost,
	pull: Pick<PullRow, "slug" | "number">,
	self: string | undefined,
	doFetch: typeof fetch = fetch,
): Promise<string[]> {
	const get = async (path: string): Promise<Comment[]> => {
		const response = await doFetch(`${host.apiUrl}/repos/${pull.slug}${path}`, { headers: headersFor(host) });
		return response.ok ? ((await response.json()) as Comment[]) : [];
	};
	const [reviews, lineComments, discussion] = await Promise.all([
		get(`/pulls/${pull.number}/reviews`),
		get(`/pulls/${pull.number}/comments`),
		get(`/issues/${pull.number}/comments`),
	]);
	const lines: string[] = [];
	const add = (comment: Comment, where: string) => {
		const body = comment.body?.trim() ?? "";
		const who = comment.user?.login ?? "someone";
		if (body === "" || (self !== undefined && who === self) || body.startsWith("**Scout's review**")) return;
		lines.push(`${who}${where}: ${body.replace(/\s+/g, " ")}`);
	};
	for (const review of reviews) add(review, review.state ? ` (${review.state.toLowerCase().replace(/_/g, " ")})` : "");
	for (const comment of lineComments) add(comment, comment.path ? ` on ${comment.path}` : "");
	for (const comment of discussion) add(comment, "");
	let used = 0;
	return lines.filter((line) => (used += line.length) <= FEEDBACK_LIMIT);
}

/** The code host account a token belongs to: Scout's own, if it has one. */
export async function whoAmI(host: CodeHost, doFetch: typeof fetch = fetch): Promise<string | undefined> {
	const response = await doFetch(`${host.apiUrl}/user`, { headers: headersFor(host) }).catch(() => undefined);
	if (response === undefined || !response.ok) return undefined;
	return ((await response.json()) as { login?: string }).login;
}

function headersFor(host: CodeHost): Record<string, string> {
	return {
		accept: host.kind === "github" ? "application/vnd.github+json" : "application/json",
		authorization: host.kind === "github" ? `Bearer ${host.token}` : `token ${host.token}`,
	};
}

function report(pulls: Pulls, now: number): string {
	const week = pulls.rate(now - 7 * DAY, now);
	const before = pulls.rate(now - 14 * DAY, now - 7 * DAY);
	const opened = pulls.count("kind = 'work' AND opened_at >= ?", now - 7 * DAY);
	const open = pulls.count("kind = 'work' AND state = 'open'");
	const decided = week.merged + week.closed;
	const lines: string[] = [];
	if (opened === 0 && decided === 0) {
		lines.push("Quiet week: I didn't open or land any pull requests.");
	} else {
		lines.push(`Last week I opened ${opened} pull request${opened === 1 ? "" : "s"}.`);
		if (decided > 0) {
			const rate = Math.round((100 * week.merged) / decided);
			const previous = before.merged + before.closed;
			const trend =
				previous === 0 ? "" : `, ${compare(rate, Math.round((100 * before.merged) / previous))} the week before`;
			lines.push(`Of the ${decided} that were decided, ${week.merged} merged (${rate}%${trend}).`);
		}
		if (open > 0) lines.push(`${open} ${open === 1 ? "is" : "are"} still open.`);
	}
	const proposals = pulls.rate(now - 7 * DAY, now, "profile");
	if (proposals.merged + proposals.closed > 0) {
		lines.push(
			`People merged ${proposals.merged} of ${proposals.merged + proposals.closed} changes I proposed to how I work.`,
		);
	}
	return lines.join(" ");
}

function dollars(amount: number): string {
	return `$${amount.toFixed(2)}`;
}

function compare(now: number, before: number): string {
	if (now === before) return `the same as ${before}%`;
	return `${now > before ? "up" : "down"} from ${before}%`;
}

async function fetchState(host: CodeHost, pull: PullRow, doFetch: typeof fetch): Promise<PullState> {
	const response = await doFetch(`${host.apiUrl}/repos/${pull.slug}/pulls/${pull.number}`, { headers: headersFor(host) });
	if (!response.ok) throw new Error(`code host answered ${response.status}`);
	const body = (await response.json()) as { state: string; merged?: boolean };
	if (body.merged === true) return "merged";
	return body.state === "closed" ? "closed" : "open";
}

function toPull(row: Record<string, unknown>): PullRow {
	return {
		url: String(row.url),
		number: Number(row.number),
		slug: String(row.slug),
		kind: String(row.kind) as PullKind,
		conversationId: Number(row.conversation_id),
		title: String(row.title),
		openedAt: Number(row.opened_at),
		state: String(row.state) as PullState,
		...(row.decided_at === null || row.decided_at === undefined ? {} : { decidedAt: Number(row.decided_at) }),
	};
}

/** The Monday that starts `date`'s week, as `YYYY-MM-DD`: one report per week. */
export function weekOf(date: Date): string {
	const monday = new Date(date);
	monday.setDate(date.getDate() - ((date.getDay() + 6) % 7));
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
}
