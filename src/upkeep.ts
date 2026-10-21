import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Forge, OpenPull, PullStatus } from "./forge.ts";
import type { PullRow } from "./pulls.ts";

/**
 * Looking after Scout's own open pull requests between people's visits, like a tidy colleague would:
 *
 * - **Mergeable.** When the base moves and a pull request no longer merges cleanly, its thread is asked to bring it
 *   up to date (rebase, resolve, test, push) or say why it can't; at most `MAX_TRIES` times per pull request, then a
 *   person is asked.
 * - **Not left to rot.** After `pingAfterMs` with no activity (on the code host or in its thread), Scout asks whoever
 *   wanted it whether it's still wanted; `closeAfterMs` later, still quiet, it closes it with a note. Reopening, or
 *   any activity, starts the clock again.
 */
export const MAX_TRIES = 2;
/** Scout's own nudge touches the pull request too; activity this soon after it isn't someone answering. */
const OWN_ECHO_MS = 5 * 60 * 1000;

export type UpkeepHandlers = {
	/** Ask the thread to bring its pull request up to date with its base. `attempt` counts from 1. */
	conflict(pull: PullRow, status: PullStatus, attempt: number): Promise<void>;
	/** Still conflicting after `MAX_TRIES`: ask a person. */
	conflictStuck(pull: PullRow, status: PullStatus): Promise<void>;
	/** Quiet for `quietMs`: ask whoever wanted it if it's still wanted; it closes after `closeAfterMs`. */
	nudge(pull: PullRow, quietMs: number, closeAfterMs: number): Promise<void>;
	/** Still quiet after the nudge: close it and say why. */
	close(pull: PullRow, quietMs: number): Promise<void>;
	/** When its thread last had activity, in Slack. */
	threadActivity(pull: PullRow): number | undefined;
};

export class PullUpkeep {
	readonly #db: DatabaseSync;
	readonly #forge: Forge;
	readonly #handlers: UpkeepHandlers;
	readonly #pingAfterMs: number;
	readonly #closeAfterMs: number;
	#polling = false;

	/** `pingAfterMs` 0 leaves stale pull requests alone. */
	constructor(options: { path: string; forge: Forge; handlers: UpkeepHandlers; pingAfterMs: number; closeAfterMs: number }) {
		if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true });
		this.#db = new DatabaseSync(options.path, { timeout: 5000 });
		this.#forge = options.forge;
		this.#handlers = options.handlers;
		this.#pingAfterMs = options.pingAfterMs;
		this.#closeAfterMs = options.closeAfterMs;
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS pull_upkeep (
				url TEXT PRIMARY KEY,
				-- The head and base commits Scout last asked about, and how many times it has.
				conflict TEXT,
				tries INTEGER NOT NULL DEFAULT 0,
				nudged_at INTEGER,
				-- Its last activity before the nudge, which Scout's own nudge would otherwise hide.
				quiet_since INTEGER
			);
		`);
	}

	async poll(open: readonly PullRow[], now = Date.now()): Promise<void> {
		if (this.#polling) return;
		this.#polling = true;
		try {
			for (const pull of open) {
				const status = await this.#forge.pullStatus(pull.slug, pull.number);
				if (!status.open) continue;
				await this.#mergeable(pull, status);
				if (this.#pingAfterMs > 0) await this.#tidy(pull, status, now);
			}
		} finally {
			this.#polling = false;
		}
	}

	async #mergeable(pull: PullRow, status: PullStatus): Promise<void> {
		const row = this.#row(pull.url);
		// Merging cleanly again ends the episode: a later conflict gets its own tries.
		if (status.mergeable === true && row.tries > 0) this.#db.prepare("UPDATE pull_upkeep SET conflict = NULL, tries = 0 WHERE url = ?").run(pull.url);
		if (status.mergeable !== false) return;
		const key = `${status.head}:${status.base}`;
		if (row.conflict === key) return;
		this.#db.prepare("INSERT INTO pull_upkeep (url, conflict, tries) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET conflict = excluded.conflict, tries = excluded.tries").run(pull.url, key, Math.min(row.tries + 1, MAX_TRIES + 1));
		if (row.tries >= MAX_TRIES) {
			// Asked once more than it may try: say so once, for this pair of commits.
			if (row.tries === MAX_TRIES) await this.#handlers.conflictStuck(pull, status);
			return;
		}
		await this.#handlers.conflict(pull, status, row.tries + 1);
	}

	async #tidy(pull: PullRow, status: PullStatus, now: number): Promise<void> {
		const row = this.#row(pull.url);
		const lastActivity = Math.max(status.updatedAt, this.#handlers.threadActivity(pull) ?? 0, pull.openedAt);
		if (row.nudgedAt !== undefined) {
			if (lastActivity > row.nudgedAt + OWN_ECHO_MS) {
				// Someone answered, pushed or commented: the clock starts again.
				this.#db.prepare("UPDATE pull_upkeep SET nudged_at = NULL WHERE url = ?").run(pull.url);
				return;
			}
			if (now - row.nudgedAt >= this.#closeAfterMs) {
				await this.#handlers.close(pull, now - (row.quietSince ?? lastActivity));
				this.#db.prepare("UPDATE pull_upkeep SET nudged_at = NULL WHERE url = ?").run(pull.url);
			}
			return;
		}
		if (now - lastActivity < this.#pingAfterMs) return;
		await this.#handlers.nudge(pull, now - lastActivity, this.#closeAfterMs);
		this.#db
			.prepare("INSERT INTO pull_upkeep (url, nudged_at, quiet_since) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET nudged_at = excluded.nudged_at, quiet_since = excluded.quiet_since")
			.run(pull.url, now, lastActivity);
	}

	#row(url: string): { conflict?: string; tries: number; nudgedAt?: number; quietSince?: number } {
		const row = this.#db.prepare("SELECT conflict, tries, nudged_at, quiet_since FROM pull_upkeep WHERE url = ?").get(url) as
			| { conflict: string | null; tries: number; nudged_at: number | null; quiet_since: number | null }
			| undefined;
		if (row === undefined) return { tries: 0 };
		return {
			...(row.conflict === null ? {} : { conflict: row.conflict }),
			tries: row.tries,
			...(row.nudged_at === null ? {} : { nudgedAt: row.nudged_at }),
			...(row.quiet_since === null ? {} : { quietSince: row.quiet_since }),
		};
	}

	close(): void {
		this.#db.close();
	}
}

/**
 * Pull requests in a channel's repositories that have waited on a review for `waitMs` or more, any author's: a gentle
 * reminder to the people asked to review them, once a day at most per channel, so nothing sits unnoticed. Drafts
 * aren't waiting on anyone.
 */
export class ReviewNudges {
	readonly #db: DatabaseSync;
	readonly #forge: Forge;
	readonly #waitMs: number;

	constructor(options: { path: string; forge: Forge; waitMs: number }) {
		if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true });
		this.#db = new DatabaseSync(options.path, { timeout: 5000 });
		this.#forge = options.forge;
		this.#waitMs = options.waitMs;
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS review_nudges (channel TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY (channel, day));
		`);
	}

	/**
	 * Each channel not yet reminded `day`, with what's waiting in its repositories. Claims the day for a channel only
	 * when something is waiting, so a pull request that crosses the line later that day still gets mentioned tomorrow.
	 */
	async waiting(repos: readonly { slug: string; channel: string }[], day: string, now = Date.now()): Promise<Map<string, (OpenPull & { slug: string })[]>> {
		const byChannel = new Map<string, (OpenPull & { slug: string })[]>();
		if (this.#waitMs <= 0) return byChannel;
		for (const { slug, channel } of repos) {
			if (this.#db.prepare("SELECT 1 FROM review_nudges WHERE channel = ? AND day = ?").get(channel, day) !== undefined) continue;
			for (const pull of await this.#forge.openPulls(slug)) {
				if (pull.draft || pull.reviewers.length + pull.teams.length === 0 || now - pull.createdAt < this.#waitMs) continue;
				byChannel.set(channel, [...(byChannel.get(channel) ?? []), { ...pull, slug }]);
			}
		}
		for (const channel of byChannel.keys()) this.#db.prepare("INSERT OR IGNORE INTO review_nudges (channel, day) VALUES (?, ?)").run(channel, day);
		return byChannel;
	}

	close(): void {
		this.#db.close();
	}
}
