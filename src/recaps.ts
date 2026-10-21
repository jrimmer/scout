import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ThreadRow } from "./threads.ts";

/**
 * Following up on threads that stalled waiting on people. When Scout's answer ends by asking something and nobody
 * replies for a few days, the thread gets one recap from Scout: where it stands, what's left, who it's waiting on,
 * and the one question that would move it on. One thread at a time, in the thread, unlike the channel's weekly
 * summary (which lists these threads rather than summarizing them again). A thread with an open pull request is left
 * to that pull request's own reminders.
 */
export class Recaps {
	readonly #db: DatabaseSync;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.#db = new DatabaseSync(path, { timeout: 5000 });
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS thread_recaps (
				conversation_id INTEGER PRIMARY KEY,
				-- When Scout's answer asked people something.
				waiting_since INTEGER NOT NULL,
				-- When it followed up; until a person speaks again, it doesn't follow up twice.
				recapped_at INTEGER
			);
		`);
	}

	/** A run ended with `answer`: if it asks people something, the thread now waits on them. */
	answered(conversationId: number, answer: string | undefined, now = Date.now()): void {
		const row = this.#get(conversationId);
		// The recap's own answer asks too; the thread has had its follow-up until someone speaks.
		if (row?.recappedAt !== undefined) return;
		if (answer !== undefined && asksSomething(answer)) {
			this.#db.prepare("INSERT OR REPLACE INTO thread_recaps (conversation_id, waiting_since) VALUES (?, ?)").run(conversationId, now);
		} else {
			this.#db.prepare("DELETE FROM thread_recaps WHERE conversation_id = ?").run(conversationId);
		}
	}

	/**
	 * Threads that have waited on people for `waitMs` with nobody speaking since, haven't had their follow-up, and
	 * have no open pull request. Threads where someone has since spoken are let go.
	 */
	due(threadOf: (conversationId: number) => ThreadRow | undefined, hasOpenPull: (conversationId: number) => boolean, waitMs: number, now = Date.now()): number[] {
		if (waitMs <= 0) return [];
		const due: number[] = [];
		for (const row of this.#rows()) {
			if (!this.#stillWaiting(row.conversationId, threadOf)) continue;
			if (row.recappedAt === undefined && !hasOpenPull(row.conversationId) && now - row.waitingSince >= waitMs) due.push(row.conversationId);
		}
		return due;
	}

	recapped(conversationId: number, now = Date.now()): void {
		this.#db.prepare("UPDATE thread_recaps SET recapped_at = ? WHERE conversation_id = ?").run(now, conversationId);
	}

	/** Threads that had their follow-up and are still waiting on people, with since when: for the weekly summary. */
	waiting(threadOf: (conversationId: number) => ThreadRow | undefined): { conversationId: number; since: number }[] {
		return this.#rows()
			.filter((row) => row.recappedAt !== undefined && this.#stillWaiting(row.conversationId, threadOf))
			.map((row) => ({ conversationId: row.conversationId, since: row.waitingSince }));
	}

	/** Still waiting if Scout spoke last; otherwise someone answered, and the thread is let go. */
	#stillWaiting(conversationId: number, threadOf: (conversationId: number) => ThreadRow | undefined): boolean {
		const thread = threadOf(conversationId);
		if (thread !== undefined && thread.lastSpeaker === "scout") return true;
		this.#db.prepare("DELETE FROM thread_recaps WHERE conversation_id = ?").run(conversationId);
		return false;
	}

	#get(conversationId: number): { conversationId: number; waitingSince: number; recappedAt?: number } | undefined {
		return this.#rows().find((r) => r.conversationId === conversationId);
	}

	#rows(): { conversationId: number; waitingSince: number; recappedAt?: number }[] {
		return this.#db
			.prepare("SELECT * FROM thread_recaps")
			.all()
			.map((r) => ({
				conversationId: Number(r.conversation_id),
				waitingSince: Number(r.waiting_since),
				...(r.recapped_at === null ? {} : { recappedAt: Number(r.recapped_at) }),
			}));
	}

	close(): void {
		this.#db.close();
	}
}

/** Whether an answer ends by asking people something: a question in its last line. */
export function asksSomething(answer: string): boolean {
	const last = answer.trim().split("\n").filter((line) => line.trim() !== "").at(-1) ?? "";
	return /\?[*_)"'”’\s]*$|\?\s/.test(last);
}
