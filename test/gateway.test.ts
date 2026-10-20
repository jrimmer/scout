import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AssistantEntry, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { modelsFor } from "../src/gateway.ts";

/** Just enough of Anthropic's streaming Messages API to answer "hello". */
function sse(): string {
	const events: [string, unknown][] = [
		["message_start", { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello from the gateway" } }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }],
		["message_stop", { type: "message_stop" }],
	];
	return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

describe("model gateway", () => {
	it("sends model calls to the gateway, with its key and headers, under the usual model names", async () => {
		const seen: { path: string; key: string | undefined; team: string | undefined }[] = [];
		const server = createServer((req, res) => {
			seen.push({ path: new URL(req.url ?? "", "http://x").pathname, key: req.headers["x-api-key"] as string | undefined, team: req.headers["x-team"] as string | undefined });
			req.resume();
			req.on("end", () => {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(sse());
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;

		const models = modelsFor({ url: `http://127.0.0.1:${port}/anthropic`, key: "gw-key", headers: { "x-team": "checkout" } });
		const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
		try {
			const conversation = await harness.root(context, { agent: { model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } } });
			const settled = await (await conversation.submit({ type: "input", content: "hi" }, context)).wait(context);
			assert.equal(settled.status, "done");
			const answer =
				settled.status === "done" && settled.type === "input"
					? await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context)
					: undefined;
			assert.match(JSON.stringify(answer?.model), /hello from the gateway/);
			assert.deepEqual(seen, [{ path: "/anthropic/v1/messages", key: "gw-key", team: "checkout" }]);
		} finally {
			await harness.close(context);
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("serves models only the gateway knows as gateway/<name>, over OpenAI's chat completions", async () => {
		const seen: { path: string; model: string }[] = [];
		const server = createServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => (body += chunk));
			req.on("end", () => {
				seen.push({ path: new URL(req.url ?? "", "http://x").pathname, model: (JSON.parse(body) as { model: string }).model });
				const chunk = (delta: object, finish: string | null) =>
					`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(`${chunk({ role: "assistant", content: "hello from lunaroute" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;

		const models = modelsFor({ url: `http://127.0.0.1:${port}/v1`, models: ["lunaroute/deepseek-4.1-flash"] });
		const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
		try {
			const conversation = await harness.root(context, { agent: { model: { provider: "gateway", modelId: "lunaroute/deepseek-4.1-flash" } } });
			const settled = await (await conversation.submit({ type: "input", content: "hi" }, context)).wait(context);
			assert.equal(settled.status, "done", JSON.stringify(settled));
			const answer =
				settled.status === "done" && settled.type === "input"
					? await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context)
					: undefined;
			assert.match(JSON.stringify(answer?.model), /hello from lunaroute/);
			assert.deepEqual(seen, [{ path: "/v1/chat/completions", model: "lunaroute/deepseek-4.1-flash" }]);
		} finally {
			await harness.close(context);
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
