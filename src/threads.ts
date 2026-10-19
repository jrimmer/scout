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
	pullRequests: string[];
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
				pull_requests TEXT NOT NULL DEFAULT '[]'
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

	addPullRequest(conversationId: number, url: string): void {
		const thread = this.byConversation(conversationId);
		if (thread === undefined || thread.pullRequests.includes(url)) return;
		this.#db
			.prepare("UPDATE threads SET pull_requests = ? WHERE conversation_id = ?")
			.run(JSON.stringify([...thread.pullRequests, url]), conversationId);
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
		pullRequests: JSON.parse(String(row.pull_requests)) as string[],
	};
}
