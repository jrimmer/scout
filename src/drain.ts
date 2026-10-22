import type { Context } from "@earendil-works/chord";
import { type Harness, ProviderDoc, ToolTask } from "@earendil-works/pi-durable";
import type { ModelLimiter } from "./capacity.ts";

/** How a drain went. */
export type Drained = {
	/** Whether it got to a moment with nothing in flight; false when `maxMs` ran out with something still going. */
	idle: boolean;
	ms: number;
	/** What was still in flight when it stopped waiting. */
	modelCalls: number;
	toolCalls: number;
};

/**
 * Draining for a restart, so a deploy needs nobody to wait for a quiet moment. No new model call starts (each waits in
 * the limiter, as it would for a slot); the model calls and tool calls running now finish; and once nothing has been
 * in flight for a moment, Scout can close. Closing writes every unfinished run back as pending (Pi Durable), and the
 * next process carries each on from the step it stopped at, so what a drain waits for is the current step, not whole
 * threads. Requests that arrive meanwhile are stored as usual, and run after the restart.
 *
 * A tool that waits on model calls of its own (a pull request's self-review, approaches) would never finish if those
 * were held too, so calls in conversations a running tool owns go ahead.
 */
export async function drain(options: {
	harness: Harness;
	limiter: ModelLimiter;
	context: Context;
	maxMs: number;
	/** How long nothing must be in flight: a model call's tool calls are stored a moment after it answers. */
	settleMs?: number;
	pollMs?: number;
}): Promise<Drained> {
	const { harness, limiter, context, maxMs } = options;
	const settleMs = options.settleMs ?? 2_000;
	const started = Date.now();
	let goAhead = new Set<string>();
	limiter.drain((session) => goAhead.has(session));
	const graph = await harness.taskGraph(context);
	try {
		let quietSince: number | undefined;
		for (;;) {
			// Tool calls running, and ones of a model call's round that haven't started yet: both are the current step.
			const tools = Object.values(graph.value.tasks).filter(
				(t) => t.kind === ToolTask.definition.name && (t.state.status === "running" || (t.state.status === "pending" && t.blocked === undefined)),
			);
			const sessions = new Set<string>();
			for (const id of tools.flatMap((t) => t.conversations)) {
				const provider = await harness.snapshot(ProviderDoc, id, context).catch(() => undefined);
				if (provider !== undefined) sessions.add(provider.sessionId);
			}
			goAhead = sessions;
			limiter.recheck();
			const now = Date.now();
			const busy = limiter.inFlight > 0 || tools.length > 0;
			quietSince = busy ? undefined : (quietSince ?? now);
			const done = { ms: now - started, modelCalls: limiter.inFlight, toolCalls: tools.length };
			if (quietSince !== undefined && now - quietSince >= settleMs) return { idle: true, ...done };
			if (now - started >= maxMs) return { idle: !busy, ...done };
			await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 250));
		}
	} finally {
		graph.dispose();
	}
}
