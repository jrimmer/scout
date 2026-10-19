import type { Context } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	type DocumentReader,
	defineExtension,
	GenerationTask,
	hook,
	ToolTask,
} from "@earendil-works/pi-durable";
import { ThreadDoc } from "./docs.ts";

/**
 * One place that sees everything every conversation does (threads, jobs, reviews, reflections): each model response
 * and each tool call. Telemetry, the audit trail, spend and limits are observers of it. It runs as Pi Durable hooks,
 * so it covers conversations whatever started them.
 */
export type Where = { conversationId: number; channel: string };
export type ToolCallEvent = Where & { callId: string; name: string; args: Record<string, unknown>; nested: boolean };

export interface Observer {
	requestStarted?(event: Where & { taskId: string }): void;
	responded?(event: Where & { taskId: string; message: AssistantMessage }): void;
	/** Return a reason to refuse the call; the model is told the reason. */
	toolStarted?(event: ToolCallEvent): string | undefined | Promise<string | undefined>;
	toolEnded?(event: ToolCallEvent & { isError: boolean }): void;
	/** The run answered (or stopped answering); the next request starts a new run. */
	runEnded?(event: Where): void;
}

export function observeExtension(observers: readonly Observer[], onBlocked?: (event: ToolCallEvent, reason: string) => void) {
	const channels = new Map<number, string>();
	const where = async (read: DocumentReader, conversationId: ConversationId, context: Context): Promise<Where> => {
		let channel = channels.get(conversationId);
		if (channel === undefined) {
			channel = (await read.snapshot(ThreadDoc, conversationId, context))?.channelName ?? "";
			channels.set(conversationId, channel);
		}
		return { conversationId, channel };
	};
	const each = (fn: (o: Observer) => void) => {
		for (const observer of observers) {
			try {
				fn(observer);
			} catch (error) {
				console.error("observer failed:", error);
			}
		}
	};
	const toolEvent = async (call: { id: string; name: string; arguments: Record<string, unknown>; parent?: unknown }, api: { conversationId: ConversationId } & DocumentReader, context: Context): Promise<ToolCallEvent> => ({
		...(await where(api, api.conversationId, context)),
		callId: call.id,
		name: call.name,
		args: call.arguments,
		nested: call.parent !== undefined,
	});

	return defineExtension({
		name: "observe",
		hooks: [
			hook(GenerationTask, {
				beforeRequest: async (_request, api, context) => {
					const w = await where(api, api.conversationId, context);
					each((o) => o.requestStarted?.({ ...w, taskId: String(api.taskId) }));
					return undefined;
				},
				afterResponse: async (message, api, context) => {
					const w = await where(api, api.conversationId, context);
					each((o) => o.responded?.({ ...w, taskId: String(api.taskId), message }));
				},
				onYield: async (_answer, api, context) => {
					const w = await where(api, api.conversationId, context);
					each((o) => o.runEnded?.(w));
					return undefined;
				},
			}),
			hook(ToolTask, {
				beforeTool: async (call, api, context) => {
					const event = await toolEvent(call, api, context);
					for (const observer of observers) {
						const reason = await observer.toolStarted?.(event);
						if (reason !== undefined) {
							onBlocked?.(event, reason);
							return { block: reason };
						}
					}
					return undefined;
				},
				afterTool: async (call, result, api, context) => {
					const event = await toolEvent(call, api, context);
					each((o) => o.toolEnded?.({ ...event, isError: result.isError === true }));
					return undefined;
				},
			}),
		],
	});
}
