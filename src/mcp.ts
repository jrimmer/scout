import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineExtension, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { ThreadDoc } from "./docs.ts";

/**
 * Tools beyond code: the data warehouse, production traces, CI, whatever a team has an MCP server for. River reads
 * the warehouse and traces the same way it reads code.
 *
 * MCP servers run on the host with the host's credentials, never in a thread's sandbox: Aquifer's credentials proxy,
 * and the same rule as `open_pull_request`. The agent sees tools; the tokens stay here. A server can be limited to the
 * channels whose teams should have it.
 *
 * `SCOUT_MCP_FILE` lists the servers. `${NAME}` in `env` and `headers` is read from Scout's environment:
 *
 *     { "servers": {
 *         "warehouse": { "command": "warehouse-mcp", "args": ["--read-only"], "env": { "TOKEN": "${WAREHOUSE_TOKEN}" },
 *                        "channels": ["data-team", "checkout"] },
 *         "traces": { "url": "https://traces.internal/mcp", "headers": { "authorization": "Bearer ${TRACES_TOKEN}" } } } }
 */
export type McpServerConfig = {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	/** Only threads in these channels get this server's tools; absent, every thread does. */
	channels?: string[];
};

export type McpConfig = { servers: Record<string, McpServerConfig> };

/** Longest tool result Scout passes on to the model. */
const OUTPUT_LIMIT = 50_000;

export function loadMcpConfig(path: string, env: NodeJS.ProcessEnv = process.env): McpConfig {
	const raw = JSON.parse(readFileSync(path, "utf8")) as McpConfig;
	const expand = (values: Record<string, string> | undefined) =>
		values === undefined
			? undefined
			: Object.fromEntries(
					Object.entries(values).map(([key, value]) => [
						key,
						value.replace(/\$\{(\w+)\}/g, (_, name: string) => {
							const found = env[name];
							if (found === undefined) throw new Error(`${path}: ${name} is not set`);
							return found;
						}),
					]),
				);
	const servers: Record<string, McpServerConfig> = {};
	for (const [name, server] of Object.entries(raw.servers ?? {})) {
		if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`${path}: server name ${name} must be letters, digits, - or _`);
		if ((server.command === undefined) === (server.url === undefined)) {
			throw new Error(`${path}: server ${name} needs either command or url`);
		}
		const serverEnv = expand(server.env);
		const headers = expand(server.headers);
		servers[name] = { ...server, ...(serverEnv === undefined ? {} : { env: serverEnv }), ...(headers === undefined ? {} : { headers }) };
	}
	return { servers };
}

function transportFor(server: McpServerConfig): Transport {
	if (server.url !== undefined) {
		return new StreamableHTTPClientTransport(new URL(server.url), {
			requestInit: { headers: server.headers ?? {} },
		});
	}
	// Only what the server is given: the host's environment, secrets included, is not passed on.
	return new StdioClientTransport({
		command: server.command!,
		args: server.args ?? [],
		env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...server.env },
		stderr: "inherit",
	});
}

export type McpConnection = { name: string; client: Client; channels?: string[] };

/** Connect to every configured server; one that fails is reported and left out. */
export async function connectMcp(
	config: McpConfig,
	transport: (name: string, server: McpServerConfig) => Transport = (_name, server) => transportFor(server),
): Promise<McpConnection[]> {
	const connections: McpConnection[] = [];
	for (const [name, server] of Object.entries(config.servers)) {
		const client = new Client({ name: "scout", version: "0.1.0" });
		try {
			await client.connect(transport(name, server));
			connections.push({ name, client, ...(server.channels === undefined ? {} : { channels: server.channels }) });
		} catch (error) {
			console.error(`MCP server ${name} is unavailable:`, error);
		}
	}
	return connections;
}

/** Every connected server's tools as Scout tools, named `mcp__<server>__<tool>`. */
export async function mcpExtension(connections: readonly McpConnection[]) {
	const tools: ToolRegistration[] = [];
	for (const connection of connections) {
		const listed = await connection.client.listTools();
		for (const tool of listed.tools) {
			tools.push(
				defineTool({
					name: `mcp__${connection.name}__${tool.name}`,
					description: `${tool.description ?? tool.name} (from ${connection.name})`,
					parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
					execute: async (args, api, context) => {
						if (connection.channels !== undefined) {
							const channel = (await api.snapshot(ThreadDoc, api.conversationId as ConversationId, context))?.channelName ?? "";
							if (!connection.channels.includes(channel)) {
								throw new Error(`${connection.name} isn't available in #${channel}. It's set up for: ${connection.channels.map((c) => `#${c}`).join(", ")}.`);
							}
						}
						const result = await connection.client.callTool(
							{ name: tool.name, arguments: args },
							undefined,
							context.abortSignal === undefined ? {} : { signal: context.abortSignal },
						);
						const content = (result.content ?? []) as { type: string; text?: string; data?: string; mimeType?: string }[];
						const text = content
							.map((block) => (block.type === "text" ? (block.text ?? "") : `[${block.type}${block.mimeType ? ` ${block.mimeType}` : ""}]`))
							.join("\n");
						const clipped = text.length <= OUTPUT_LIMIT ? text : `${text.slice(0, OUTPUT_LIMIT)}\n(… cut at ${OUTPUT_LIMIT} characters)`;
						if (result.isError === true) throw new Error(clipped || `${tool.name} failed`);
						return { output: [{ type: "text", text: clipped }] };
					},
				}),
			);
		}
	}
	return defineExtension({ name: "mcp", tools });
}

export async function closeMcp(connections: readonly McpConnection[]): Promise<void> {
	await Promise.all(connections.map((c) => c.client.close().catch(() => {})));
}
