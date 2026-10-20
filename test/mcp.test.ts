import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { z } from "zod";
import { ThreadDoc } from "../src/docs.ts";
import { Approvals, connectMcp, loadMcpConfig, mcpExtension, type Writes } from "../src/mcp.ts";

function warehouse() {
	const server = new McpServer({ name: "warehouse", version: "1" });
	server.registerTool(
		"query",
		{ description: "Run a read-only SQL query", inputSchema: { sql: z.string() }, annotations: { readOnlyHint: true } },
		async ({ sql }) =>
			sql.includes("DROP")
				? { content: [{ type: "text", text: "read-only" }], isError: true }
				: { content: [{ type: "text", text: `orders: 42 (${sql})` }] },
	);
	return server;
}

describe("MCP tools", () => {
	it("reads the server file, filling in secrets from the environment", () => {
		const path = join(mkdtempSync(join(tmpdir(), "scout-mcp-")), "mcp.json");
		writeFileSync(
			path,
			JSON.stringify({ servers: { warehouse: { command: "wh", env: { TOKEN: "${WH_TOKEN}" }, channels: ["data"] } } }),
		);
		assert.deepEqual(loadMcpConfig(path, { WH_TOKEN: "s3cret" }).servers.warehouse, {
			command: "wh",
			env: { TOKEN: "s3cret" },
			channels: ["data"],
		});
		assert.throws(() => loadMcpConfig(path, {}), /WH_TOKEN is not set/);
	});

	it("offers a server's tools to threads in its channels, and only there", async () => {
		const connections = await connectMcp({ servers: { warehouse: { command: "unused", channels: ["data"] } } }, () => {
			const [client, server] = InMemoryTransport.createLinkedPair();
			void warehouse().connect(server);
			return client;
		});
		const extension = await mcpExtension(connections);
		assert.deepEqual(extension.tools?.map((t) => t.name), ["mcp__warehouse__query"]);

		const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const registry = createRegistry();
		registry.install(extension);
		const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
		const ask = async (channelName: string, sql: string) => {
			let seen = "";
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("mcp__warehouse__query", { sql })], { stopReason: "toolUse" }),
				(transcript) => {
					seen = JSON.stringify(transcript);
					return fauxAssistantMessage("ok");
				},
			]);
			const conversation = await harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: { model: { provider: "faux", modelId: "m" } },
					init: async (tx, id) => {
						(await tx.doc(ThreadDoc, id)).channelName = channelName;
					},
				},
				context,
			);
			await (await conversation.submit({ type: "input", content: "how many orders?" }, context)).wait(context);
			return seen;
		};

		assert.match(await ask("data", "SELECT count(*) FROM orders"), /orders: 42 \(SELECT count\(\*\) FROM orders\)/);
		assert.match(await ask("data", "DROP TABLE orders"), /read-only/);
		assert.match(await ask("random", "SELECT 1"), /warehouse isn't available in #random\. It's set up for: #data\./);
		await harness.close(context);
		await Promise.all(connections.map((c) => c.client.close()));
	});

	it("keeps tools that change things out by default, asks for approval, or allows them, as configured", async () => {
		const dashboards = () => {
			const server = new McpServer({ name: "grafana", version: "1" });
			server.registerTool("read_rules", { description: "Read alert rules", annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: "rules" }] }));
			server.registerTool("write_rules", { description: "Write alert rules", annotations: { readOnlyHint: false, destructiveHint: true } }, async () => ({ content: [{ type: "text", text: "written" }] }));
			server.registerTool("unmarked", { description: "Says nothing about itself" }, async () => ({ content: [{ type: "text", text: "did it" }] }));
			return server;
		};
		const toolsFor = async (writes: Writes | undefined, approvals?: Approvals, refuse?: (user: string, server: string) => Promise<string | undefined>) => {
			const connections = await connectMcp({ servers: { grafana: { command: "unused", ...(writes === undefined ? {} : { writes }) } } }, () => {
				const [client, server] = InMemoryTransport.createLinkedPair();
				void dashboards().connect(server);
				return client;
			});
			return { extension: await mcpExtension(connections, approvals, refuse), connections };
		};
		const names = async (writes?: Writes) => {
			const { extension, connections } = await toolsFor(writes);
			await Promise.all(connections.map((c) => c.client.close()));
			return extension.tools?.map((t) => t.name.replace("mcp__grafana__", ""));
		};
		assert.deepEqual(await names(), ["read_rules"], "by default only what says it only reads");
		assert.deepEqual(await names("approve"), ["read_rules", "write_rules", "unmarked"]);
		assert.deepEqual(await names("allow"), ["read_rules", "write_rules", "unmarked"]);

		// With approval: the write waits until someone in the thread approves, for a while.
		const approvals = new Approvals();
		const { extension, connections } = await toolsFor("approve", approvals, async (user) => (user === "UANN" ? undefined : "changes to grafana need someone in admins."));
		const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const registry = createRegistry();
		registry.install(extension);
		const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "m" } } }, context);
		const write = async () => {
			let seen = "";
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("mcp__grafana__write_rules", {})], { stopReason: "toolUse" }),
				(transcript) => {
					seen = JSON.stringify(transcript.messages.at(-1));
					return fauxAssistantMessage("ok");
				},
			]);
			await (await conversation.submit({ type: "input", content: "raise the disk threshold" }, context)).wait(context);
			return seen;
		};
		assert.match(await write(), /needs a person's approval first/);
		approvals.grant(conversation.id, "UANN");
		assert.match(await write(), /written/);
		assert.match(await write(), /needs a person's approval first/, "an approval covers one change, not the next");
		approvals.grant(conversation.id, "UANN", Date.now() - 16 * 60 * 1000);
		assert.match(await write(), /needs a person's approval first/, "an approval runs out");
		approvals.grant(conversation.id, "UBOB");
		assert.match(await write(), /doesn't cover this: changes to grafana need someone in admins/, "only someone in an approving group counts");
		await harness.close(context);
		await Promise.all(connections.map((c) => c.client.close()));
	});
});
