import { createHash } from "node:crypto";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { Source } from "./crawler.ts";
import type { Doc } from "./history.ts";
import { clip, summarizeArgs, textOf } from "./reflect.ts";
import type { ThreadRow, Threads } from "./threads.ts";

/**
 * Slack threads, from what Scout kept of them (Pi Durable's conversations): the messages people sent, Scout's replies,
 * and what Scout ran (`tool` documents: the call and the start of its result). bridge.ts writes the same documents
 * live, with the same ids, so a thread seen both ways is stored once; this fills what was missed and what came before
 * the index. A cursor is the newest thread activity read.
 */

/** A reply's id comes from its words, so the live write and the crawl agree on it. */
export function answerId(key: string, text: string): string {
	return `slack:answer:${key}:${createHash("sha1").update(text.trim()).digest("hex").slice(0, 12)}`;
}

/** Slack's `1700000000.000100` as milliseconds. */
function tsMs(ts: string): number | undefined {
	const ms = Math.round(Number(ts) * 1000);
	return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** How much of a tool's result is kept: enough to see what it did and how it went. */
const RESULT = 300;

export function threadDocs(thread: Pick<ThreadRow, "key" | "conversationId">, channel: string, entries: readonly EntryRecord[]): Doc[] {
	const { key, conversationId } = thread;
	const base = { source: "slack", thread: key, conversationId, channel };
	const results = new Map<string, { text: string; error: boolean }>();
	for (const entry of entries) {
		const message = entry.model?.[0] as { role?: string; toolCallId?: string; content?: unknown; isError?: boolean } | undefined;
		if (entry.kind === "pi.tool-result" && message?.toolCallId !== undefined) results.set(message.toolCallId, { text: textOf(message.content), error: message.isError === true });
	}
	const docs: Doc[] = [];
	for (const entry of entries) {
		if (entry.kind === "slack.message") {
			const data = entry.data as { user?: string; name?: string; text?: string; ts?: string } | undefined;
			if (data?.ts === undefined || data.text === undefined) continue;
			const at = tsMs(data.ts);
			docs.push({
				...base,
				id: `slack:message:${key}:${data.ts}`,
				kind: "message",
				...(data.user === undefined ? {} : { author: data.user }),
				authorName: data.name ?? "",
				...(at === undefined ? {} : { at }),
				text: data.text,
			});
		} else if (entry.kind === "pi.assistant") {
			const message = entry.model?.[0] as { content?: unknown; timestamp?: number } | undefined;
			if (!Array.isArray(message?.content)) continue;
			const at = typeof message.timestamp === "number" ? message.timestamp : undefined;
			const text = textOf(message.content);
			if (text !== "") docs.push({ ...base, id: answerId(key, text), kind: "message", author: "scout", authorName: "Scout", ...(at === undefined ? {} : { at }), text });
			for (const block of message.content as { type?: string; id?: string; name?: string; arguments?: Record<string, unknown> }[]) {
				if (block.type !== "toolCall" || block.id === undefined || block.name === undefined) continue;
				const result = results.get(block.id);
				const call = `${block.name} ${summarizeArgs(block.arguments ?? {})}`.trim();
				docs.push({
					...base,
					id: `slack:tool:${key}:${block.id}`,
					kind: "tool",
					author: "scout",
					authorName: "Scout",
					...(at === undefined ? {} : { at }),
					text: result === undefined ? call : `${call}\n${result.error ? "failed: " : "→ "}${clip(result.text, RESULT)}`,
				});
			}
		}
	}
	return docs;
}

export function slackSource(options: {
	threads: Pick<Threads, "crawlable" | "isPurged">;
	/** A thread's channel and entries; undefined when its conversation is gone. */
	read: (thread: ThreadRow) => Promise<{ channel: string; entries: readonly EntryRecord[] } | undefined>;
	/** Threads per page (default 20). */
	pageSize?: number;
}): Source {
	const size = options.pageSize ?? 20;
	return {
		name: "slack",
		async *crawl(_scope, cursor) {
			const rows = options.threads.crawlable(cursor === undefined ? 0 : Number(cursor));
			for (let i = 0; i < rows.length; i += size) {
				const batch = rows.slice(i, i + size);
				const docs: Doc[] = [];
				for (const thread of batch) {
					// One conversation that won't read (a damaged one) mustn't hold up every thread after it.
					const read = await options.read(thread).catch((error: unknown) => {
						console.error(`indexing ${thread.key} for search: couldn't read its conversation:`, error);
						return undefined;
					});
					// Retention may have cleared the thread while it was being read: leave it cleared.
					if (read !== undefined && !options.threads.isPurged(thread.key)) docs.push(...threadDocs(thread, read.channel, read.entries));
				}
				yield { docs, cursor: String(batch[batch.length - 1]!.lastActivity) };
			}
		},
	};
}
