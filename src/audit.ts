import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Observer, ToolCallEvent } from "./observe.ts";
import { redact } from "./scan.ts";

/**
 * The record an organization needs besides the public threads: who asked for what, what ran, which pull requests
 * opened and merged, which notes were kept and forgotten, what was refused. Append-only (the database refuses updates
 * and deletes), outlives transcript retention, and exports as JSON lines (`npm run audit`).
 *
 * Tool calls are recorded by name and arguments, never output; anything that looks like a credential is redacted.
 */
export type AuditKind =
	| "request"
	| "stop"
	| "tool"
	| "blocked"
	| "refused"
	| "pull_opened"
	| "pull_decided"
	| "alert"
	| "approved"
	| "note_kept"
	| "note_forgotten"
	| "reflection"
	| "review_posted"
	| "retention"
	| "schedule_added"
	| "schedule_changed"
	| "schedule_removed"
	| "schedule_ran";

export type AuditRecord = {
	id: number;
	at: number;
	kind: AuditKind;
	actor: string;
	conversationId?: number;
	channel?: string;
	detail: Record<string, unknown>;
};

const ARG_LIMIT = 300;

export class Audit implements Observer {
	readonly #db: DatabaseSync;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.#db = new DatabaseSync(path, { timeout: 5000 });
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS audit (
				id INTEGER PRIMARY KEY,
				at INTEGER NOT NULL,
				kind TEXT NOT NULL,
				actor TEXT NOT NULL,
				conversation_id INTEGER,
				channel TEXT,
				detail TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS audit_at ON audit (at);
			CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'the audit trail is append-only'); END;
			CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'the audit trail is append-only'); END;
		`);
	}

	record(kind: AuditKind, entry: { actor: string; conversationId?: number; channel?: string; detail?: Record<string, unknown> }, now = Date.now()): void {
		this.#db
			.prepare("INSERT INTO audit (at, kind, actor, conversation_id, channel, detail) VALUES (?, ?, ?, ?, ?, ?)")
			.run(now, kind, entry.actor, entry.conversationId ?? null, entry.channel ?? null, redact(JSON.stringify(entry.detail ?? {})));
	}

	toolStarted(e: ToolCallEvent): undefined {
		this.record("tool", { actor: "scout", conversationId: e.conversationId, channel: e.channel, detail: { tool: e.name, args: summarize(e.args), ...(e.nested ? { nested: true } : {}) } });
		return undefined;
	}

	list(options: { since?: number; until?: number; kind?: string } = {}): AuditRecord[] {
		return this.#db
			.prepare(
				`SELECT * FROM audit WHERE at >= ? AND at < ? AND (? IS NULL OR kind = ?) ORDER BY id`,
			)
			.all(options.since ?? 0, options.until ?? Number.MAX_SAFE_INTEGER, options.kind ?? null, options.kind ?? null)
			.map((row) => ({
				id: Number(row.id),
				at: Number(row.at),
				kind: String(row.kind) as AuditKind,
				actor: String(row.actor),
				...(row.conversation_id === null ? {} : { conversationId: Number(row.conversation_id) }),
				...(row.channel === null ? {} : { channel: String(row.channel) }),
				detail: JSON.parse(String(row.detail)) as Record<string, unknown>,
			}));
	}

	close(): void {
		this.#db.close();
	}
}

/** Arguments as the audit keeps them: strings cut short, so a written file's content isn't copied in whole. */
function summarize(args: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		if (typeof value === "string") out[key] = value.length > ARG_LIMIT ? `${value.slice(0, ARG_LIMIT)}… (${value.length} characters)` : value;
		else if (typeof value === "number" || typeof value === "boolean" || value === null) out[key] = value;
		else out[key] = `(${Array.isArray(value) ? "list" : "object"})`;
	}
	return out;
}

if (import.meta.main) {
	// npm run audit -- [--since 2026-10-01] [--until 2026-11-01] [--kind tool] [--data data]
	const args = process.argv.slice(2);
	const flag = (name: string) => {
		const i = args.indexOf(`--${name}`);
		return i === -1 ? undefined : args[i + 1];
	};
	const day = (value: string | undefined) => (value === undefined ? undefined : Date.parse(value));
	const audit = new Audit(`${flag("data") ?? process.env.SCOUT_DATA_DIR ?? "data"}/scout.sqlite`);
	const since = day(flag("since"));
	const until = day(flag("until"));
	const kind = flag("kind");
	for (const record of audit.list({ ...(since === undefined ? {} : { since }), ...(until === undefined ? {} : { until }), ...(kind === undefined ? {} : { kind }) })) {
		process.stdout.write(`${JSON.stringify({ ...record, at: new Date(record.at).toISOString() })}\n`);
	}
	audit.close();
}
