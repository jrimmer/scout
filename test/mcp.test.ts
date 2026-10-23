import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
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
import { tempDir } from "./helpers.ts";

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
		const path = join(tempDir("scout-mcp-"), "mcp.json");
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

	it("keeps approvals across a restart: who approved, a change waiting, and the answer that asked", () => {
		const path = join(tempDir("scout-approvals-"), "scout.sqlite");
		const change = { server: "grafana", tool: "write_rules", args: { threshold: 90 } };
		const before = new Approvals(path);
		before.ask(1, change);
		before.answered(1, "100.1");
		before.grant(1, "UANN");
		before.ask(2, change);
		before.answered(2, "200.1");
		before.ask(3, change);
		before.close();

		const after = new Approvals(path);
		assert.equal(after.by(1, change), "UANN", "an approval given before the restart still lets the change go ahead");
		assert.equal(after.askedIn("200.1"), 2, "a 👍 on the answer that asked still approves");
		after.answered(3, "300.1");
		assert.equal(after.askedIn("300.1"), 3, "a run that asked before the restart and answered after it");
		after.use(1);
		assert.equal(after.by(1, change), undefined);
		after.close();
	});

	it("binds an approval to the change that was asked for and is waiting, until it's used or declined", () => {
		const approvals = new Approvals();
		const rules90 = { server: "grafana", tool: "write_rules", args: { rule: "disk", threshold: 90 } };
		const rules10 = { ...rules90, args: { rule: "disk", threshold: 10 } };
		assert.equal(approvals.grant(1, "UANN"), false, "nothing is waiting, so there's nothing to approve");
		approvals.ask(1, rules90);
		assert.equal(approvals.grant(1, "UANN"), false, "asked in the run going on, and not yet put to anyone");
		approvals.answered(1, "100.1");
		assert.equal(approvals.askedFor(1), "grafana");
		assert.equal(approvals.grant(1, "UANN"), true);
		assert.equal(approvals.by(1, { ...rules90, args: { threshold: 90, rule: "disk" } }), "UANN", "the same arguments, in another order");
		assert.equal(approvals.by(1, rules10), undefined, "other arguments");
		assert.equal(approvals.by(1, { ...rules90, tool: "delete_rules" }), undefined, "another tool");
		assert.equal(approvals.by(1, { ...rules90, server: "billing" }), undefined, "another server");
		// A later run (steered meanwhile) asks for something else: the approval stays with what was approved.
		approvals.ask(1, rules10);
		assert.equal(approvals.by(1, rules10), undefined);
		assert.equal(approvals.by(1, rules90), "UANN");
		approvals.use(1);
		assert.equal(approvals.by(1, rules90), undefined, "used once");

		// Declined: what waits and what was approved are both gone.
		approvals.ask(2, rules90);
		approvals.answered(2, "200.1");
		approvals.grant(2, "UANN");
		assert.equal(approvals.pending(2), true);
		approvals.decline(2);
		assert.equal(approvals.by(2, rules90), undefined);
		assert.equal(approvals.waiting(2), false);
		assert.equal(approvals.pending(2), false);
		assert.equal(approvals.askedIn("200.1"), undefined, "a 👍 on the answer no longer approves");
		approvals.close();
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

	it("takes credentials out of what a tool returns, and of its errors, before the model sees them", async () => {
		const token = `ghp_${"e".repeat(36)}`;
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
		const logs = () => {
			const server = new McpServer({ name: "ci", version: "1" });
			server.registerTool("job_log", { description: "A job's log", inputSchema: { failed: z.boolean() }, annotations: { readOnlyHint: true } }, async ({ failed }) =>
				failed
					? { content: [{ type: "text", text: `401 for token ${token}` }], isError: true }
					: { content: [{ type: "text", text: `step 1 ok\ncurl -H "Authorization: Bearer ${jwt}" https://api\nusing ${token}` }] },
			);
			return server;
		};
		const connections = await connectMcp({ servers: { ci: { command: "unused" } } }, () => {
			const [client, server] = InMemoryTransport.createLinkedPair();
			void logs().connect(server);
			return client;
		});
		const tool = (await mcpExtension(connections)).tools![0]!;
		const result = await tool.execute({ failed: false }, { conversationId: 1 } as never, context);
		const text = (result.output![0] as { text: string }).text;
		assert.match(text, /step 1 ok/);
		assert.match(text, /Authorization: Bearer \[redacted JWT\]/);
		assert.match(text, /using \[redacted GitHub token\]/);
		assert.doesNotMatch(text, /ghp_e|eyJhbGci/);
		await assert.rejects(tool.execute({ failed: true }, { conversationId: 1 } as never, context), (error: Error) => {
			assert.match(error.message, /401 for token \[redacted GitHub token\]/);
			return true;
		});
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
		approvals.answered(conversation.id, "200.1");
		assert.equal(approvals.askedIn("200.1"), conversation.id, "the answer after this is where a 👍 approves");
		approvals.answered(conversation.id, "200.2");
		assert.equal(approvals.askedIn("200.1"), undefined, "a later answer that didn't ask takes it back");
		assert.equal(approvals.askedIn("200.2"), undefined);
		assert.equal(approvals.grant(conversation.id, "UANN"), false, "nothing is waiting, so there's nothing to approve");
		assert.match(await write(), /needs a person's approval first/);
		approvals.answered(conversation.id, "200.3");
		assert.equal(approvals.grant(conversation.id, "UANN"), true);
		assert.match(await write(), /written/);
		assert.match(await write(), /needs a person's approval first/, "an approval covers one change, not the next");
		approvals.answered(conversation.id, "200.4");
		approvals.grant(conversation.id, "UANN", Date.now() - 16 * 60 * 1000);
		assert.match(await write(), /needs a person's approval first/, "an approval runs out");
		approvals.answered(conversation.id, "200.5");
		approvals.grant(conversation.id, "UBOB");
		assert.match(await write(), /doesn't cover this: changes to grafana need someone in admins/, "only someone in an approving group counts");
		await harness.close(context);
		await Promise.all(connections.map((c) => c.client.close()));
	});
});
