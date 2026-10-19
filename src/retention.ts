import type { Audit } from "./audit.ts";
import type { Memory } from "./memory.ts";
import type { ThreadSearch } from "./search.ts";
import type { Threads } from "./threads.ts";
import type { Workspaces } from "./workspaces.ts";

/**
 * How long Scout keeps what threads leave behind (SCOUT_RETENTION_DAYS). Past it, a quiet thread's sandbox, files and
 * attachments are deleted, its words leave the search index, and notes that stopped applying are deleted. The audit
 * trail is kept.
 *
 * Not yet: transcripts in Pi Durable's storage, which has no way to delete a conversation. Until it does, they stay in
 * `pi.sqlite` (and its backups).
 */
export async function applyRetention(options: {
	days: number;
	threads: Threads;
	workspaces: Pick<Workspaces, "remove">;
	search: Pick<ThreadSearch, "forget">;
	memory: Pick<Memory, "purge">;
	audit?: Audit;
	now?: number;
}): Promise<{ threads: number; notes: number }> {
	const before = (options.now ?? Date.now()) - options.days * 24 * 60 * 60 * 1000;
	let threads = 0;
	for (const thread of options.threads.unpurgedBefore(before)) {
		await options.workspaces.remove(thread.conversationId);
		options.search.forget(thread.key);
		options.threads.purged(thread.key);
		threads++;
	}
	const notes = options.memory.purge(before);
	if (threads > 0 || notes > 0) {
		options.audit?.record("retention", { actor: "scout", detail: { days: options.days, threads, notes } });
	}
	return { threads, notes };
}
