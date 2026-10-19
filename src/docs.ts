import { defineDoc } from "@earendil-works/pi-durable";

/** Documents Scout keeps on its conversations, next to the transcript. */

/** Which Slack thread a conversation is. Written when the thread's conversation is created. */
export const ThreadDoc = defineDoc<{ channel: string; channelName: string; threadTs: string }>({
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
