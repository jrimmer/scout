import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { History } from "./history.ts";
import type { ThreadRow, Threads } from "./threads.ts";

export function searchExtension(history: History, threads: Threads, link: (thread: ThreadRow) => Promise<string | undefined>) {
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
			const hits = history.search(args.query, {
				limit: Math.min(args.limit ?? 5, 20),
				...(current === undefined ? {} : { excludeThread: current.key }),
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
