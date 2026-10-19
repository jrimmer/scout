import { defineDoc } from "@earendil-works/pi-durable";

/** Documents Scout keeps on its conversations, next to the transcript. */

/** Which Slack thread a conversation is. Written when the thread's conversation is created. */
export const ThreadDoc = defineDoc<{ channel: string; channelName: string; threadTs: string; repo?: string }>({
	kind: "scout.thread",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ channel: "", channelName: "", threadTs: "" }),
});

/** Marks a conversation as a reflection, and where its clone of the profile lives. */
export const ReflectionDoc = defineDoc<{ day: string; root: string }>({
	kind: "scout.reflection",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ day: "", root: "" }),
});

/**
 * Marks a reviewer conversation, and the workspace it reads: a thread's sandbox (`sandbox`, that conversation's id), or
 * a checkout on this host (`root` and `cwd`).
 */
export const ReviewDoc = defineDoc<{ root: string; cwd: string; sandbox?: number }>({
	kind: "scout.review",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ root: "", cwd: "" }),
});

/** Self-reviews a thread has had, by the commit they reviewed, so a change is reviewed once. */
export const ReviewsDoc = defineDoc<{ verdicts: Record<string, "approve" | "changes"> }>({
	kind: "scout.reviews",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ verdicts: {} }),
});
