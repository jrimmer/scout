import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Host-side bookkeeping: which Slack thread is which conversation, and per-thread stats (Shopify keeps the same
 * thing as `river_sessions`). Transcripts themselves live in Pi Durable's storage, not here.
 */
export type ThreadRow = {
	key: string;
	conversationId: number;
	channel: string;
	threadTs: string;
	startedBy: string;
	createdAt: number;
	lastActivity: number;
	/** Who spoke last in the thread: `scout`, or a Slack user ID. */
	lastSpeaker: string;
	/** Whose message Scout last took up as work. */
	lastAsker: string;
	runs: number;
	/** `lastActivity` as of the last nightly reflection that read this thread. */
	reflectedActivity: number;
};

export function threadKey(channel: string, threadTs: string): string {
	return `${channel}:${threadTs}`;
}

export class Threads {
	readonly #db: DatabaseSync;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.#db = new DatabaseSync(path);
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS threads (
				key TEXT PRIMARY KEY,
				conversation_id INTEGER NOT NULL UNIQUE,
				channel TEXT NOT NULL,
				thread_ts TEXT NOT NULL,
				started_by TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				last_activity INTEGER NOT NULL,
				last_speaker TEXT NOT NULL,
				last_asker TEXT NOT NULL,
				runs INTEGER NOT NULL DEFAULT 0,
				reflected_activity INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS reflections (
				day TEXT PRIMARY KEY,
				conversation_id INTEGER NOT NULL,
				threads TEXT NOT NULL
			);
		`);
	}

	get(key: string): ThreadRow | undefined {
		const row = this.#db.prepare("SELECT * FROM threads WHERE key = ?").get(key);
		return row === undefined ? undefined : toThread(row);
	}

	byConversation(conversationId: number): ThreadRow | undefined {
		const row = this.#db.prepare("SELECT * FROM threads WHERE conversation_id = ?").get(conversationId);
		return row === undefined ? undefined : toThread(row);
	}

	activeSince(since: number): ThreadRow[] {
		return this.#db.prepare("SELECT * FROM threads WHERE last_activity >= ?").all(since).map(toThread);
	}

	insert(row: Pick<ThreadRow, "key" | "conversationId" | "channel" | "threadTs" | "startedBy">, now = Date.now()): void {
		this.#db
			.prepare(
				`INSERT INTO threads (key, conversation_id, channel, thread_ts, started_by, created_at, last_activity, last_speaker, last_asker)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(row.key, row.conversationId, row.channel, row.threadTs, row.startedBy, now, now, row.startedBy, row.startedBy);
	}

	spoke(key: string, speaker: string, now = Date.now()): void {
		this.#db.prepare("UPDATE threads SET last_speaker = ?, last_activity = ? WHERE key = ?").run(speaker, now, key);
	}

	asked(key: string, user: string): void {
		this.#db.prepare("UPDATE threads SET last_asker = ? WHERE key = ?").run(user, key);
	}

	ranOnce(conversationId: number): void {
		this.#db.prepare("UPDATE threads SET runs = runs + 1 WHERE conversation_id = ?").run(conversationId);
	}

	/** Threads with activity no reflection has read yet. */
	unreflected(): ThreadRow[] {
		return this.#db.prepare("SELECT * FROM threads WHERE last_activity > reflected_activity").all().map(toThread);
	}

	reflection(day: string): { conversationId: number; threads: string[] } | undefined {
		const row = this.#db.prepare("SELECT * FROM reflections WHERE day = ?").get(day);
		if (row === undefined) return undefined;
		return { conversationId: Number(row.conversation_id), threads: JSON.parse(String(row.threads)) as string[] };
	}

	/** Record a day's reflection and mark what it read, in one transaction. */
	reflected(day: string, conversationId: number, read: readonly ThreadRow[]): void {
		this.#db.exec("BEGIN");
		try {
			this.#db
				.prepare("INSERT INTO reflections (day, conversation_id, threads) VALUES (?, ?, ?)")
				.run(day, conversationId, JSON.stringify(read.map((t) => t.key)));
			const mark = this.#db.prepare("UPDATE threads SET reflected_activity = ? WHERE key = ?");
			for (const thread of read) mark.run(thread.lastActivity, thread.key);
			this.#db.exec("COMMIT");
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	close(): void {
		this.#db.close();
	}
}

function toThread(row: Record<string, unknown>): ThreadRow {
	return {
		key: String(row.key),
		conversationId: Number(row.conversation_id),
		channel: String(row.channel),
		threadTs: String(row.thread_ts),
		startedBy: String(row.started_by),
		createdAt: Number(row.created_at),
		lastActivity: Number(row.last_activity),
		lastSpeaker: String(row.last_speaker),
		lastAsker: String(row.last_asker),
		runs: Number(row.runs),
		reflectedActivity: Number(row.reflected_activity),
	};
}
