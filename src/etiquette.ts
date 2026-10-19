/**
 * When a message in a Scout thread should make Scout do something, and what.
 *
 * Scout follows whole threads, so people can redirect it without @-mentioning it. Its job is to stay out of the way
 * when people are talking to each other:
 *
 * - While Scout is working, everything said in the thread is context for that work: it steers the run.
 * - While idle, it answers when addressed: an @-mention, or a reply to Scout by the person it was answering.
 * - Anything else is recorded so Scout has the context next time, without a reply.
 */
export type Delivery = "input" | "steer" | "note";

export type ThreadMessage = {
	mentionsScout: boolean;
	/** Scout spoke last in the thread, answering the author of this message. */
	followsScout: boolean;
	/** Scout is in the middle of a run for this thread. */
	busy: boolean;
};

export function delivery(message: ThreadMessage): Delivery {
	if (message.busy) return "steer";
	if (message.mentionsScout || message.followsScout) return "input";
	return "note";
}
