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
	/** Facts about the document that aren't its words (a pull request's state, a review's verdict). Part of what makes it "changed". */
	meta?: Record<string, string | number | boolean>;
};

export type Link = { from: string; to: string; rel: string; at?: number; source: string };

/** What a thread's link to its pull requests is anchored on: threads aren't documents, so this stands for one. */
export const threadRef = (key: string): string => `thread:${key}`;

/** How long a merged change has to go without being fixed or reverted before it counts as having held. */
export const HELD_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

export type PullOutcome = {
	id: string;
	url: string;
	title: string;
	state: "open" | "merged" | "closed";
	/** `merged` is merged too recently to say; `held` went `HELD_AFTER_MS` without a fix or a revert. */
	verdict: "open" | "closed" | "merged" | "held" | "fixed" | "reverted";
	/** The pull request that reverted or fixed it. */
	by?: string;
	/** Later pull requests that say they build on it. */
	builtOn: number;
};

/** What became of the work a thread did, from its pull requests and what followed them. Worst first when there are several. */
export type Outcome = { thread: string; verdict: "none" | PullOutcome["verdict"]; pulls: PullOutcome[] };

/** A whole thread, or pull request with what was said on it, in order and clipped to a budget. */
export type Transcript = {
	key: string;
	title: string;
	channel: string;
	repo: string;
	url: string;
	at: number;
	entries: { at: number; speaker: string; kind: string; url: string; text: string }[];
	/** Entries left out of the middle to stay in the budget. */
	omitted: number;
};

/** What a repository's recent work looks like. Counts only: it doesn't judge. */
export type Activity = {
	threads: number;
	people: number;
	pulls: { opened: number; merged: number; closed: number; open: number; byScout: number };
	/** Merged pull requests nobody asked changes of, and those somebody did. */
	mergedFirstTime: number;
	mergedAfterChanges: number;
	/** Reviews asking for changes, on the pull requests opened in the period. */
	changeRequests: number;
	issues: { opened: number; closed: number };
	/** What became of the threads' pull requests (`History.outcome`), by verdict. */
	outcomes: Record<string, number>;
};

const WORST: Outcome["verdict"][] = ["reverted", "fixed", "closed", "open", "merged", "held", "none"];

export type Query = {
	text: string;
	/** A person id (see `people`). */
	person?: string;
	/** A repository's pull requests and issues; with `channels`, those and what was said in them, as one set. */
	repo?: string;
	channels?: string[];
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
	/** The repository of a code host document. */
	repo: string;
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
				hash TEXT NOT NULL,
				meta TEXT NOT NULL DEFAULT '{}'
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
			-- Ids that are one person under different names: a code host login is the Slack user with that login.
			CREATE TABLE IF NOT EXISTS history_aliases (
				alias TEXT PRIMARY KEY,
				person TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS history_aliases_person ON history_aliases (person);
			-- Where each source's crawl stopped (crawler.ts).
			CREATE TABLE IF NOT EXISTS history_cursors (
				source TEXT NOT NULL,
				scope TEXT NOT NULL DEFAULT '',
				value TEXT NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (source, scope)
			);
		`);
		if (!(this.#db.prepare("PRAGMA table_info(history_docs)").all() as { name: string }[]).some((c) => c.name === "meta")) {
			this.#db.exec("ALTER TABLE history_docs ADD COLUMN meta TEXT NOT NULL DEFAULT '{}'");
		}
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
		this.#db.exec("BEGIN IMMEDIATE");
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
			// A crawl reads whole conversations, so what the migration kept of the same threads is now there properly.
			for (const thread of new Set(page.docs.flatMap((d) => (d.source === "slack" && d.thread !== undefined && !d.id.includes(":earlier-") ? [d.thread] : [])))) {
				this.#dropText(`doc IN (SELECT id FROM history_docs WHERE thread = ? AND id LIKE 'slack:message:%:earlier-%')`, thread);
				this.#db.prepare("DELETE FROM history_docs WHERE thread = ? AND id LIKE 'slack:message:%:earlier-%'").run(thread);
			}
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
		const facts = doc.meta === undefined ? "{}" : JSON.stringify(doc.meta);
		// Everything a document says about itself, so a write that knew more (a channel, an author) replaces one that knew less.
		const hash = createHash("sha256")
			.update([title, text, facts, doc.channel ?? "", doc.author ?? "", doc.authorName ?? "", doc.repo ?? "", doc.parent ?? "", doc.url ?? "", String(doc.at ?? "")].join("\0"))
			.digest("hex");
		const current = this.#db.prepare("SELECT hash FROM history_docs WHERE id = ?").get(doc.id) as { hash: string } | undefined;
		if (current?.hash === hash) return false;
		if (current !== undefined) this.#dropText(`doc = ?`, doc.id);
		this.#db
			.prepare(
				`INSERT OR REPLACE INTO history_docs
				 (id, source, kind, thread, conversation_id, channel, repo, author, author_name, at, title, url, parent, hash, meta)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
				facts,
			);
		const addChunk = this.#db.prepare("INSERT INTO history_chunks (doc) VALUES (?)");
		const addText = this.#db.prepare("INSERT INTO history_text (rowid, title, text, meta) VALUES (?, ?, ?, ?)");
		const meta = [doc.author === undefined ? "" : tag("p", doc.author), doc.repo === undefined ? "" : tag("r", doc.repo), doc.channel === undefined || doc.channel === "" ? "" : tag("c", doc.channel), tag("s", doc.source), tag("k", doc.kind)].join(" ");
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
		// An id that is an alias of someone is that someone, so only the someone is listed, found by either.
		return (
			this.#db
				.prepare(
					`SELECT id, name FROM history_people p
					 WHERE NOT EXISTS (SELECT 1 FROM history_aliases a WHERE a.alias = p.id)
					   AND (id = ? OR name LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM history_aliases a WHERE a.person = p.id AND a.alias LIKE ? ESCAPE '\\'))
					 ORDER BY name LIMIT 20`,
				)
				.all(name.trim(), like, like) as Person[]
		).map((p) => ({ id: String(p.id), name: String(p.name) }));
	}

	/** Everyone the index knows, an alias counted once, as the person it stands for. */
	everyone(): Person[] {
		return (this.#db.prepare("SELECT id, name FROM history_people p WHERE NOT EXISTS (SELECT 1 FROM history_aliases a WHERE a.alias = p.id) ORDER BY name").all() as Person[]).map((p) => ({ id: String(p.id), name: String(p.name) }));
	}

	/** `alias` (an id from another source, like `forge:mjones`) is the same person as `person`: what either wrote is theirs. */
	alias(alias: string, person: string): void {
		if (alias === person) return;
		this.#db.prepare("INSERT OR REPLACE INTO history_aliases (alias, person) VALUES (?, ?)").run(alias, person);
	}

	/** The ids a person has written under: their own and their aliases'. */
	#ids(person: string): string[] {
		const canonical = (this.#db.prepare("SELECT person FROM history_aliases WHERE alias = ?").get(person) as { person: string } | undefined)?.person ?? person;
		const aliases = this.#db.prepare("SELECT alias FROM history_aliases WHERE person = ?").all(canonical) as { alias: string }[];
		return [canonical, ...aliases.map((a) => a.alias)];
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
		// Each filter is a group of tags of which one must be there.
		const tags = [
			(q.person === undefined ? [] : this.#ids(q.person)).map((v) => tag("p", v)),
			[...(q.repo === undefined ? [] : [tag("r", q.repo)]), ...(q.channels ?? []).map((c) => tag("c", c))],
			q.source === undefined ? [] : [tag("s", q.source)],
			q.kind === undefined ? [] : [tag("k", q.kind)],
		]
			.flatMap((group) => (group.length === 0 ? [] : [` AND meta : (${group.join(" OR ")})`]))
			.join("");
		// What the agent ran is there to ask about (kind "tool"), but it would drown ordinary results.
		const without = q.kind === undefined ? ` NOT meta : ${tag("k", "tool")}` : "";
		const sql = `SELECT d.id, d.thread, d.parent, d.conversation_id, d.channel, d.repo, d.author, d.author_name, d.source, d.kind, d.at, d.url,
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
				const key = String(row.thread ?? row.parent ?? row.id);
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
					repo: String(row.repo ?? ""),
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

	/** What became of a thread's pull requests, from the links the code host's crawl recorded. */
	outcome(thread: string, now = Date.now()): Outcome {
		const pulls = this.#db
			.prepare(`SELECT d.id, d.url, d.title, d.meta FROM history_links l JOIN history_docs d ON d.id = l.to_id WHERE l.from_id = ? AND l.rel = 'opened' ORDER BY d.at, d.id`)
			.all(threadRef(thread)) as { id: string; url: string; title: string; meta: string }[];
		const by = this.#db.prepare(
			`SELECT l.from_id FROM history_links l JOIN history_docs f ON f.id = l.from_id
			 WHERE l.to_id = ? AND l.rel = ? AND f.kind = 'pull' AND f.id <> l.to_id AND json_extract(f.meta, '$.state') = 'merged' ORDER BY f.at LIMIT 1`,
		);
		const builtOn = this.#db.prepare(`SELECT COUNT(DISTINCT from_id) AS n FROM history_links WHERE to_id = ? AND rel = 'builds_on'`);
		const outcomes = pulls.map((row): PullOutcome => {
			const facts = JSON.parse(row.meta) as { state?: string; mergedAt?: number };
			const state = facts.state === "merged" || facts.state === "closed" ? facts.state : "open";
			const reverted = (by.get(row.id, "reverts") as { from_id: string } | undefined)?.from_id;
			const fixed = (by.get(row.id, "closes") as { from_id: string } | undefined)?.from_id;
			const verdict: PullOutcome["verdict"] =
				state !== "merged" ? state : reverted !== undefined ? "reverted" : fixed !== undefined ? "fixed" : now - (facts.mergedAt ?? now) >= HELD_AFTER_MS ? "held" : "merged";
			const other = state === "merged" ? (reverted ?? fixed) : undefined;
			return {
				id: row.id,
				url: row.url,
				title: row.title,
				state,
				verdict,
				...(other === undefined || verdict === "held" ? {} : { by: other }),
				builtOn: Number((builtOn.get(row.id) as { n: number }).n),
			};
		});
		const verdict = WORST.find((v) => v === "none" || outcomes.some((o) => o.verdict === v)) ?? "none";
		return { thread, verdict, pulls: outcomes };
	}

	/** A thread, or a pull request or issue, as it unfolded: what each person said, oldest first, within `budget` characters. */
	read(key: string, options: { budget: number; tools?: boolean }): Transcript | undefined {
		const rows = this.#db
			.prepare(
				`SELECT d.id, d.kind, d.at, d.author_name, d.channel, d.repo, d.url, d.title, d.thread,
				   (SELECT t.text FROM history_chunks c JOIN history_text t ON t.rowid = c.id WHERE c.doc = d.id ORDER BY c.id LIMIT 1) AS text
				 FROM history_docs d WHERE (d.thread = ? OR d.id = ? OR d.parent = ?) ${options.tools === true ? "" : "AND d.kind <> 'tool'"}
				 ORDER BY d.at, d.rowid`,
			)
			.all(key, key, key) as Record<string, unknown>[];
		if (rows.length === 0) return undefined;
		const PER_ENTRY = Math.max(200, Math.min(1200, Math.floor(options.budget / 4)));
		const all = rows.map((r) => ({
			at: Number(r.at),
			speaker: String(r.author_name),
			kind: String(r.kind),
			url: String(r.url),
			text: (r.title ? `${String(r.title)}\n` : "") + clip(String(r.text ?? ""), PER_ENTRY),
		}));
		// Over budget: keep the start and the end, which are the request and what came of it, and drop the middle.
		let entries = all;
		let omitted = 0;
		const size = (list: typeof all) => list.reduce((n, e) => n + e.text.length + e.speaker.length + 20, 0);
		if (size(all) > options.budget) {
			const head: typeof all = [];
			const tail: typeof all = [];
			let used = 0;
			for (let lo = 0, hi = all.length - 1; lo <= hi; ) {
				const next = head.length <= tail.length ? all[lo]! : all[hi]!;
				used += next.text.length + next.speaker.length + 20;
				if (used > options.budget && head.length + tail.length > 0) break;
				if (head.length <= tail.length) (head.push(next), lo++);
				else (tail.unshift(next), hi--);
			}
			entries = [...head, ...tail];
			omitted = all.length - entries.length;
		}
		const first = rows[0]!;
		const pull = rows.find((r) => r.id === key) ?? first;
		return {
			key,
			title: String(pull.title || String(first.text ?? "").slice(0, 80)),
			channel: String(first.channel),
			repo: String(pull.repo ?? ""),
			url: String(pull.url),
			at: Number(first.at),
			entries,
			omitted,
		};
	}

	/** The threads, pull requests and issues someone took part in, most recently active first. */
	threads(query: { person?: string; repo?: string; channels?: string[]; since?: number; until?: number; limit?: number }): { key: string; at: number; channel: string; repo: string }[] {
		const where: string[] = ["d.kind <> 'tool'"];
		const args: (string | number)[] = [];
		if (query.person !== undefined) {
			const ids = this.#ids(query.person);
			where.push(`d.author IN (${ids.map(() => "?").join(", ")})`);
			args.push(...ids);
		}
		if (query.repo !== undefined || (query.channels ?? []).length > 0) {
			const channels = query.channels ?? [];
			where.push(`(${[...(query.repo === undefined ? [] : ["d.repo = ?"]), ...(channels.length === 0 ? [] : [`d.channel IN (${channels.map(() => "?").join(", ")})`])].join(" OR ")})`);
			if (query.repo !== undefined) args.push(query.repo);
			args.push(...channels);
		}
		if (query.since !== undefined) (where.push("d.at >= ?"), args.push(query.since));
		if (query.until !== undefined) (where.push("d.at <= ?"), args.push(query.until));
		const rows = this.#db
			.prepare(
				`SELECT COALESCE(d.thread, d.parent, d.id) AS key, MAX(d.at) AS at, MAX(d.channel) AS channel, COALESCE(MAX(d.repo), '') AS repo
				 FROM history_docs d WHERE ${where.join(" AND ")} GROUP BY key ORDER BY at DESC LIMIT ?`,
			)
			.all(...args, query.limit ?? 10) as Record<string, unknown>[];
		return rows.map((r) => ({ key: String(r.key), at: Number(r.at), channel: String(r.channel), repo: String(r.repo) }));
	}

	/** Counts of what happened around a repository (its slug) and the channels it works in, between two times. */
	activity(query: { repo: string; channels: string[]; since: number; until: number }): Activity {
		const { repo, since, until } = query;
		const channels = query.channels.length === 0 ? ["\0"] : query.channels;
		const marks = channels.map(() => "?").join(", ");
		const one = (sql: string, ...args: (string | number)[]) => Number((this.#db.prepare(sql).get(...args) as { n: number }).n);
		const threadsSql = `FROM history_docs WHERE source = 'slack' AND thread IS NOT NULL AND channel IN (${marks}) AND at BETWEEN ? AND ?`;
		const pulls = this.#db
			.prepare(`SELECT COALESCE(json_extract(meta, '$.state'), 'open') AS state, author = 'scout' AS scout, COUNT(*) AS n FROM history_docs WHERE kind = 'pull' AND repo = ? AND at BETWEEN ? AND ? GROUP BY state, scout`)
			.all(repo, since, until) as { state: string; scout: number; n: number }[];
		const count = (state: string) => pulls.filter((p) => p.state === state).reduce((n, p) => n + p.n, 0);
		const changed = `EXISTS (SELECT 1 FROM history_docs r WHERE r.parent = p.id AND r.kind = 'review' AND json_extract(r.meta, '$.review') = 'changes')`;
		const merged = (extra: string) => one(`SELECT COUNT(*) AS n FROM history_docs p WHERE p.kind = 'pull' AND p.repo = ? AND p.at BETWEEN ? AND ? AND json_extract(p.meta, '$.state') = 'merged' AND ${extra}`, repo, since, until);
		const outcomes: Record<string, number> = {};
		const threadKeys = this.#db
			.prepare(`SELECT DISTINCT l.from_id AS key FROM history_links l JOIN history_docs p ON p.id = l.to_id WHERE l.rel = 'opened' AND p.repo = ? AND p.at BETWEEN ? AND ? LIMIT 300`)
			.all(repo, since, until) as { key: string }[];
		for (const { key } of threadKeys) {
			const verdict = this.outcome(key.replace(/^thread:/, ""), until).verdict;
			outcomes[verdict] = (outcomes[verdict] ?? 0) + 1;
		}
		return {
			threads: one(`SELECT COUNT(DISTINCT thread) AS n ${threadsSql}`, ...channels, since, until),
			people: one(
				`SELECT COUNT(DISTINCT COALESCE((SELECT person FROM history_aliases WHERE alias = author), author)) AS n FROM history_docs WHERE author IS NOT NULL AND author <> 'scout' AND at BETWEEN ? AND ? AND (repo = ? OR channel IN (${marks}))`,
				since,
				until,
				repo,
				...channels,
			),
			pulls: { opened: pulls.reduce((n, p) => n + p.n, 0), merged: count("merged"), closed: count("closed"), open: count("open"), byScout: pulls.filter((p) => p.scout === 1).reduce((n, p) => n + p.n, 0) },
			mergedFirstTime: merged(`NOT ${changed}`),
			mergedAfterChanges: merged(changed),
			changeRequests: one(
				`SELECT COUNT(*) AS n FROM history_docs r JOIN history_docs p ON p.id = r.parent WHERE r.kind = 'review' AND json_extract(r.meta, '$.review') = 'changes' AND p.repo = ? AND p.at BETWEEN ? AND ?`,
				repo,
				since,
				until,
			),
			issues: {
				opened: one(`SELECT COUNT(*) AS n FROM history_docs WHERE kind = 'issue' AND repo = ? AND at BETWEEN ? AND ?`, repo, since, until),
				closed: one(`SELECT COUNT(*) AS n FROM history_docs WHERE kind = 'issue' AND repo = ? AND json_extract(meta, '$.state') = 'closed' AND at BETWEEN ? AND ?`, repo, since, until),
			},
			outcomes,
		};
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
			this.#db.prepare("DELETE FROM history_links WHERE from_id = ?").run(threadRef(thread));
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

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
