import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { redact } from "./scan.ts";

/**
 * The session index (docs/session-index.md): what people and systems said and did around Scout's work, in one store
 * that sources write to and Scout's tools read from. A document is one thing said or done (a Slack message, a pull
 * request, a review comment); its id says where it came from (`source:kind:ref`), so putting it again is safe: the same
 * id and text is skipped, changed text replaces it. Text is redacted on the way in, and stored in chunks for full-text
 * search. Links join documents (a thread to the pull request it opened, a pull request to the one that fixed it).
 *
 * Nothing here knows about Slack or a code host; sources (and `bridge.ts`, for Slack, live) call `put`.
 */
export type Doc = {
	/** `source:kind:ref`, e.g. `slack:message:C1:1700000000.0001:1700000001.0002`. */
	id: string;
	source: string;
	kind: string;
	text: string;
	/** The Slack thread's key, when the document belongs to one. */
	thread?: string;
	conversationId?: number;
	channel?: string;
	repo?: string;
	/** A stable person id (a Slack user id), or `scout`. Documents without one are matched to a person by name later. */
	author?: string;
	authorName?: string;
	at?: number;
	title?: string;
	url?: string;
	parent?: string;
};

export type Link = { from: string; to: string; rel: string; at?: number; source: string };

export type Query = {
	text: string;
	/** A person id (see `people`). */
	person?: string;
	repo?: string;
	source?: string;
	kind?: string;
	since?: number;
	until?: number;
	/** A thread to leave out (the one asking). */
	excludeThread?: string;
	limit?: number;
};

/** The best match in a thread (or the document, when it isn't in one). */
export type Hit = {
	/** The thread's key, or the document's id when it has none. */
	key: string;
	id: string;
	conversationId: number;
	channelName: string;
	speaker: string;
	author: string;
	source: string;
	kind: string;
	at: number;
	url: string;
	snippet: string;
};

export type Person = { id: string; name: string };

/** Characters per chunk (about 800 tokens), and how much one chunk repeats of the one before it. */
const CHUNK = 3200;
const OVERLAP = 300;

/** Most text is one chunk; long text is cut where a paragraph, line or word ends, with some overlap. */
export function chunks(text: string): string[] {
	if (text.length <= CHUNK) return [text];
	const out: string[] = [];
	let start = 0;
	while (start < text.length) {
		let end = Math.min(start + CHUNK, text.length);
		if (end < text.length) {
			const cut = Math.max(text.lastIndexOf("\n\n", end), text.lastIndexOf("\n", end), text.lastIndexOf(" ", end));
			if (cut > start + CHUNK / 2) end = cut;
		}
		out.push(text.slice(start, end).trim());
		if (end >= text.length) break;
		start = Math.max(end - OVERLAP, start + 1);
	}
	return out.filter((c) => c !== "");
}

/** A tag for a value in `meta`: letters and digits only, so the tokenizer keeps it whole and two values never meet. */
function tag(prefix: string, value: string): string {
	return prefix + createHash("sha1").update(value).digest("hex").slice(0, 12);
}

export class History {
	readonly #db: DatabaseSync;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.#db = new DatabaseSync(path, { timeout: 5000 });
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS history_docs (
				id TEXT PRIMARY KEY,
				source TEXT NOT NULL,
				kind TEXT NOT NULL,
				thread TEXT,
				conversation_id INTEGER,
				channel TEXT NOT NULL DEFAULT '',
				repo TEXT,
				author TEXT,
				author_name TEXT NOT NULL DEFAULT '',
				at INTEGER NOT NULL,
				title TEXT NOT NULL DEFAULT '',
				url TEXT NOT NULL DEFAULT '',
				parent TEXT,
				hash TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS history_docs_thread ON history_docs (thread);
			CREATE INDEX IF NOT EXISTS history_docs_conversation ON history_docs (conversation_id, at);
			CREATE INDEX IF NOT EXISTS history_docs_author ON history_docs (author, at);
			CREATE INDEX IF NOT EXISTS history_docs_repo ON history_docs (repo, at);
			-- A document's text in chunks. The chunk's id is its row in the full-text table.
			CREATE TABLE IF NOT EXISTS history_chunks (
				id INTEGER PRIMARY KEY,
				doc TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS history_chunks_doc ON history_chunks (doc);
			-- \`meta\` holds tags for who, where and what (see tag), so a search narrows to a person or a repository inside the
			-- full-text query itself, instead of ranking every match and throwing most of them away.
			CREATE VIRTUAL TABLE IF NOT EXISTS history_text USING fts5(
				title, text, meta,
				tokenize = 'porter unicode61'
			);
			CREATE TABLE IF NOT EXISTS history_links (
				from_id TEXT NOT NULL,
				to_id TEXT NOT NULL,
				rel TEXT NOT NULL,
				at INTEGER NOT NULL,
				source TEXT NOT NULL,
				PRIMARY KEY (from_id, to_id, rel)
			);
			CREATE INDEX IF NOT EXISTS history_links_to ON history_links (to_id);
			-- Who people are: a Slack user id and the name it goes by now. A name seen before an id was known is matched here.
			CREATE TABLE IF NOT EXISTS history_people (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			);
			-- Where each source's crawl stopped (crawler.ts).
			CREATE TABLE IF NOT EXISTS history_cursors (
				source TEXT NOT NULL,
				scope TEXT NOT NULL DEFAULT '',
				value TEXT NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (source, scope)
			);
		`);
		this.#migrate();
	}

	/** Scout 1's search table (one row per message, speaker by name): into documents, once, then gone. */
	#migrate(): void {
		const old = this.#db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'thread_text'").get();
		if (old === undefined) return;
		const rows = this.#db
			.prepare("SELECT rowid, key, conversation_id, channel_name, speaker, CAST(at AS INTEGER) AS at, text FROM thread_text ORDER BY rowid")
			.all() as { rowid: number; key: string; conversation_id: number; channel_name: string; speaker: string; at: number; text: string }[];
		this.#transaction(() => {
			for (const r of rows) {
				const scout = r.speaker === "Scout";
				this.#store({
					id: `slack:message:${r.key}:earlier-${r.rowid}`,
					source: "slack",
					kind: "message",
					thread: r.key,
					conversationId: Number(r.conversation_id),
					channel: String(r.channel_name),
					...(scout ? { author: "scout" } : {}),
					authorName: String(r.speaker),
					at: Number(r.at),
					text: String(r.text),
				});
			}
			this.#db.exec("DROP TABLE thread_text");
		});
	}

	#transaction<T>(work: () => T): T {
		this.#db.exec("BEGIN");
		try {
			const result = work();
			this.#db.exec("COMMIT");
			return result;
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	/** Stores a document, or leaves it be if it's there unchanged. True when something was written. */
	put(doc: Doc, now = Date.now()): boolean {
		if (doc.text.trim() === "" && (doc.title ?? "").trim() === "") return false;
		return this.#transaction(() => this.#store(doc, now));
	}

	/** A crawl's page: its documents, its links, and where the crawl got to, all or nothing. How many documents were written. */
	commit(source: string, scope: string, page: { docs: Doc[]; links?: Link[]; cursor: string }, now = Date.now()): number {
		return this.#transaction(() => {
			let written = 0;
			for (const doc of page.docs) if ((doc.text.trim() !== "" || (doc.title ?? "").trim() !== "") && this.#store(doc, now)) written++;
			for (const link of page.links ?? []) this.link(link, now);
			this.setCursor(source, page.cursor, scope, now);
			return written;
		});
	}

	/** A page of documents in one transaction (a crawl's page). How many were written. */
	putAll(docs: Doc[], now = Date.now()): number {
		return this.#transaction(() => docs.filter((d) => d.text.trim() !== "" || (d.title ?? "").trim() !== "").reduce((n, d) => n + (this.#store(d, now) ? 1 : 0), 0));
	}

	#store(doc: Doc, now = Date.now()): boolean {
		const text = redact(doc.text);
		const title = redact(doc.title ?? "");
		const hash = createHash("sha256").update(title).update("\0").update(text).digest("hex");
		const current = this.#db.prepare("SELECT hash FROM history_docs WHERE id = ?").get(doc.id) as { hash: string } | undefined;
		if (current?.hash === hash) return false;
		if (current !== undefined) this.#dropText(`doc = ?`, doc.id);
		this.#db
			.prepare(
				`INSERT OR REPLACE INTO history_docs
				 (id, source, kind, thread, conversation_id, channel, repo, author, author_name, at, title, url, parent, hash)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				doc.id,
				doc.source,
				doc.kind,
				doc.thread ?? null,
				doc.conversationId ?? null,
				doc.channel ?? "",
				doc.repo ?? null,
				doc.author ?? null,
				doc.authorName ?? "",
				doc.at ?? now,
				title,
				doc.url ?? "",
				doc.parent ?? null,
				hash,
			);
		const addChunk = this.#db.prepare("INSERT INTO history_chunks (doc) VALUES (?)");
		const addText = this.#db.prepare("INSERT INTO history_text (rowid, title, text, meta) VALUES (?, ?, ?, ?)");
		const meta = [doc.author === undefined ? "" : tag("p", doc.author), doc.repo === undefined ? "" : tag("r", doc.repo), tag("s", doc.source), tag("k", doc.kind)].join(" ");
		chunks(text).forEach((chunk, seq) => addText.run(addChunk.run(doc.id).lastInsertRowid, seq === 0 ? title : "", chunk, meta));
		if (doc.author !== undefined && doc.author !== "scout" && doc.authorName !== undefined && doc.authorName !== "") this.#person(doc.author, doc.authorName, now);
		return true;
	}

	/** Removes the chunks (and their words) of the documents this `where` picks out of `history_chunks`' `doc`. */
	#dropText(where: string, ...args: string[]): void {
		this.#db.prepare(`DELETE FROM history_text WHERE rowid IN (SELECT id FROM history_chunks WHERE ${where})`).run(...args);
		this.#db.prepare(`DELETE FROM history_chunks WHERE ${where}`).run(...args);
	}

	/** Records who an id is; documents that only had that name now belong to the id. */
	#person(id: string, name: string, now: number): void {
		const known = this.#db.prepare("SELECT name FROM history_people WHERE id = ?").get(id) as { name: string } | undefined;
		if (known?.name === name) return;
		this.#db.prepare("INSERT OR REPLACE INTO history_people (id, name, updated_at) VALUES (?, ?, ?)").run(id, name, now);
		this.#db
			.prepare(
				`UPDATE history_text SET meta = meta || ' ' || ? WHERE rowid IN
				 (SELECT c.id FROM history_chunks c JOIN history_docs d ON d.id = c.doc WHERE d.author IS NULL AND d.author_name = ?)`,
			)
			.run(tag("p", id), name);
		this.#db.prepare("UPDATE history_docs SET author = ? WHERE author IS NULL AND author_name = ?").run(id, name);
	}

	link(link: Link, now = Date.now()): void {
		this.#db
			.prepare("INSERT OR REPLACE INTO history_links (from_id, to_id, rel, at, source) VALUES (?, ?, ?, ?, ?)")
			.run(link.from, link.to, link.rel, link.at ?? now, link.source);
	}

	/** People whose name has these words in it, or whose id this is. */
	people(name: string): Person[] {
		const like = `%${name.trim().replace(/[\\%_]/g, "\\$&")}%`;
		return (this.#db.prepare("SELECT id, name FROM history_people WHERE id = ? OR name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 20").all(name.trim(), like) as Person[]).map((p) => ({ id: String(p.id), name: String(p.name) }));
	}

	/** Best matches, one per thread; all words must match, or failing that, any. */
	search(query: string | Query, options: Omit<Query, "text"> = {}): Hit[] {
		const q: Query = typeof query === "string" ? { text: query, ...options } : { ...query, ...options };
		const words = q.text.match(/[\p{L}\p{N}_]+/gu) ?? [];
		if (words.length === 0) return [];
		const quoted = words.map((w) => `"${w}"`);
		const where: string[] = [];
		const args: (string | number)[] = [];
		const filter = (clause: string, value: string | number | undefined) => {
			if (value === undefined) return;
			where.push(clause);
			args.push(value);
		};
		filter("d.at >= ?", q.since);
		filter("d.at <= ?", q.until);
		filter("COALESCE(d.thread, '') <> ?", q.excludeThread);
		const tags = [
			["p", q.person],
			["r", q.repo],
			["s", q.source],
			["k", q.kind],
		].flatMap(([prefix, value]) => (value === undefined ? [] : [` AND meta : ${tag(prefix!, value)}`])).join("");
		// What the agent ran is there to ask about (kind "tool"), but it would drown ordinary results.
		const without = q.kind === undefined ? ` NOT meta : ${tag("k", "tool")}` : "";
		const sql = `SELECT d.id, d.thread, d.conversation_id, d.channel, d.author, d.author_name, d.source, d.kind, d.at, d.url,
				snippet(history_text, 1, '*', '*', '…', 24) AS snippet
			 FROM history_text JOIN history_chunks c ON c.id = history_text.rowid JOIN history_docs d ON d.id = c.doc
			 WHERE history_text MATCH ? ${where.map((w) => `AND ${w}`).join(" ")}
			 ORDER BY bm25(history_text, 2.0, 1.0, 0.0) LIMIT 200`;
		const limit = q.limit ?? 5;
		for (const words of [quoted.join(" "), quoted.join(" OR ")]) {
			const rows = this.#db.prepare(sql).all(`({title text} : (${words})${tags})${without}`, ...args) as Record<string, unknown>[];
			const seen = new Set<string>();
			const hits: Hit[] = [];
			for (const row of rows) {
				const key = String(row.thread ?? row.id);
				if (seen.has(key)) continue;
				seen.add(key);
				hits.push({
					key,
					id: String(row.id),
					conversationId: Number(row.conversation_id ?? 0),
					channelName: String(row.channel),
					speaker: String(row.author_name),
					author: String(row.author ?? ""),
					source: String(row.source),
					kind: String(row.kind),
					at: Number(row.at),
					url: String(row.url),
					snippet: String(row.snippet),
				});
				if (hits.length >= limit) break;
			}
			if (hits.length > 0) return hits;
		}
		return [];
	}

	/** The first thing said in a conversation's thread (what it was started with), and where. */
	first(conversationId: number): { channelName: string; text: string } | undefined {
		const row = this.#db
			.prepare(
				`SELECT d.channel, t.text FROM history_docs d
				 JOIN history_chunks c ON c.id = (SELECT MIN(id) FROM history_chunks WHERE doc = d.id)
				 JOIN history_text t ON t.rowid = c.id
				 WHERE d.conversation_id = ? ORDER BY d.at, d.rowid LIMIT 1`,
			)
			.get(conversationId) as Record<string, unknown> | undefined;
		return row === undefined ? undefined : { channelName: String(row.channel), text: String(row.text) };
	}

	/** Drop a thread's documents and what links to or from them (retention). */
	forget(thread: string): void {
		this.#transaction(() => {
			const ids = "(SELECT id FROM history_docs WHERE thread = ?)";
			this.#dropText(`doc IN ${ids}`, thread);
			this.#db.prepare(`DELETE FROM history_links WHERE from_id IN ${ids} OR to_id IN ${ids}`).run(thread, thread);
			this.#db.prepare("DELETE FROM history_docs WHERE thread = ?").run(thread);
		});
	}

	cursor(source: string, scope = ""): string | undefined {
		const row = this.#db.prepare("SELECT value FROM history_cursors WHERE source = ? AND scope = ?").get(source, scope) as { value: string } | undefined;
		return row?.value;
	}

	setCursor(source: string, value: string, scope = "", now = Date.now()): void {
		this.#db.prepare("INSERT OR REPLACE INTO history_cursors (source, scope, value, updated_at) VALUES (?, ?, ?, ?)").run(source, scope, value, now);
	}

	/** Counts and the newest document per source, for the dashboard and doctor. */
	stats(): { source: string; documents: number; newest: number }[] {
		return (this.#db.prepare("SELECT source, COUNT(*) AS n, MAX(at) AS newest FROM history_docs GROUP BY source ORDER BY source").all() as Record<string, unknown>[]).map((r) => ({
			source: String(r.source),
			documents: Number(r.n),
			newest: Number(r.newest),
		}));
	}

	close(): void {
		this.#db.close();
	}
}
