import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ThreadRow, Threads } from "./threads.ts";

/**
 * "The next person who has the same question does not have to ask it." Everything said in Scout's threads is public,
 * so Scout can search it and point people at the thread where something was worked out before.
 */
export type SearchHit = { key: string; conversationId: number; channelName: string; speaker: string; snippet: string };

export class ThreadSearch {
	readonly #db: DatabaseSync;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.#db = new DatabaseSync(path);
		this.#db.exec(`
			CREATE VIRTUAL TABLE IF NOT EXISTS thread_text USING fts5(
				key UNINDEXED, conversation_id UNINDEXED, channel_name UNINDEXED, speaker UNINDEXED, at UNINDEXED, text,
				tokenize = 'porter unicode61'
			);
		`);
	}

	add(entry: { key: string; conversationId: number; channelName: string; speaker: string; text: string }, at = Date.now()): void {
		if (entry.text.trim() === "") return;
		this.#db
			.prepare("INSERT INTO thread_text (key, conversation_id, channel_name, speaker, at, text) VALUES (?, ?, ?, ?, ?, ?)")
			.run(entry.key, entry.conversationId, entry.channelName, entry.speaker, at, entry.text);
	}

	/** Best matches, one per thread; all words must match, or failing that, any. */
	search(query: string, options: { limit?: number; excludeKey?: string } = {}): SearchHit[] {
		const words = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
		if (words.length === 0) return [];
		const quoted = words.map((w) => `"${w}"`);
		for (const match of [quoted.join(" "), quoted.join(" OR ")]) {
			const rows = this.#db
				.prepare(
					`SELECT key, conversation_id, channel_name, speaker,
						snippet(thread_text, 5, '*', '*', '…', 24) AS snippet
					 FROM thread_text WHERE thread_text MATCH ? ORDER BY rank LIMIT 50`,
				)
				.all(match) as Record<string, unknown>[];
			const seen = new Set<string>();
			const hits: SearchHit[] = [];
			for (const row of rows) {
				const key = String(row.key);
				if (key === options.excludeKey || seen.has(key)) continue;
				seen.add(key);
				hits.push({
					key,
					conversationId: Number(row.conversation_id),
					channelName: String(row.channel_name),
					speaker: String(row.speaker),
					snippet: String(row.snippet),
				});
				if (hits.length >= (options.limit ?? 5)) break;
			}
			if (hits.length > 0) return hits;
		}
		return [];
	}

	close(): void {
		this.#db.close();
	}
}

export function searchExtension(search: ThreadSearch, threads: Threads, link: (thread: ThreadRow) => Promise<string | undefined>) {
	const searchThreads = defineTool({
		name: "search_threads",
		description:
			"Search earlier Scout threads in public channels: what people asked, and what was found or decided. Use it " +
			"when something may have come up before, and link the thread when it helps.",
		parameters: Type.Object({
			query: Type.String({ description: "Words to look for" }),
			limit: Type.Optional(Type.Number({ description: "At most this many threads (default 5)" })),
		}),
		replay: "safe",
		execute: async (args, api) => {
			const current = threads.byConversation(api.conversationId);
			const hits = search.search(args.query, {
				limit: Math.min(args.limit ?? 5, 20),
				...(current === undefined ? {} : { excludeKey: current.key }),
			});
			if (hits.length === 0) return { output: [{ type: "text", text: "No earlier threads match." }] };
			const lines: string[] = [];
			for (const hit of hits) {
				const thread = threads.get(hit.key);
				const url = thread === undefined ? undefined : await link(thread);
				lines.push(`- #${hit.channelName}${url === undefined ? "" : ` ${url}`}\n  ${hit.speaker}: ${hit.snippet}`);
			}
			return { output: [{ type: "text", text: lines.join("\n") }] };
		},
	});
	return defineExtension({ name: "search", tools: [searchThreads] });
}
