import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineExtension, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { ThreadDoc } from "./docs.ts";
import { redact } from "./scan.ts";

/**
 * Tools beyond code: the data warehouse, production traces, CI, whatever a team has an MCP server for. River reads
 * the warehouse and traces the same way it reads code.
 *
 * MCP servers run on the host with the host's credentials, never in a thread's sandbox: Aquifer's credentials proxy,
 * and the same rule as `open_pull_request`. The agent sees tools; the tokens stay here. A server can be limited to the
 * channels whose teams should have it.
 *
 * Changes go through code by default: a server's tools that don't say they're read-only (MCP's `readOnlyHint`) aren't
 * offered, so a team keeps what Scout may change in a repository and reviews it as a pull request. `writes: "approve"`
 * offers them, but each call waits for a person in the thread to reply "approve" (one approval, one change, within 15
 * minutes); `writes: "allow"`
 * offers every tool as it is, for a trusted server that doesn't mark its tools.
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
	/** Tools that change things: `off` (default) leaves them out, `approve` asks a person first, `allow` doesn't. */
	writes?: Writes;
};

export type Writes = "off" | "approve" | "allow";

/**
 * Approvals, kept in Scout's database so a restart loses none: who approved a change in which thread (until it's used
 * or 15 minutes pass), whether a change is waiting for one, and which of Scout's answers asked, where a 👍 approves.
 */
export class Approvals {
	readonly #db: DatabaseSync;

	constructor(path = ":memory:") {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.#db = new DatabaseSync(path, { timeout: 5000 });
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS approvals (
				conversation_id INTEGER PRIMARY KEY,
				-- A change waited for approval in the run going on now.
				asked INTEGER NOT NULL DEFAULT 0,
				-- The answer that asked: a 👍 on it approves.
				asked_in TEXT,
				given_by TEXT,
				given_until INTEGER
			);
		`);
		// Which server's change is waiting, so an Approve button can check the right approvers (added after 1.0's first data).
		const columns = this.#db.prepare("PRAGMA table_info(approvals)").all() as { name: string }[];
		if (!columns.some((c) => c.name === "asked_for")) this.#db.exec("ALTER TABLE approvals ADD COLUMN asked_for TEXT");
	}

	/** A change to `server` in this thread waited for approval: the answer Scout gives next is where people can react 👍. */
	ask(conversationId: number, server?: string): void {
		this.#db
			.prepare("INSERT INTO approvals (conversation_id, asked, asked_for) VALUES (?, 1, ?) ON CONFLICT DO UPDATE SET asked = 1, asked_for = excluded.asked_for")
			.run(conversationId, server ?? null);
	}

	/** The server whose change the conversation's latest request for approval is for, if known. */
	askedFor(conversationId: number): string | undefined {
		const row = this.#db.prepare("SELECT asked_for FROM approvals WHERE conversation_id = ?").get(conversationId) as { asked_for: string | null } | undefined;
		return row?.asked_for ?? undefined;
	}

	/** A run ended with its answer in message `ts`: that's where a 👍 approves if the run asked, else nowhere. */
	answered(conversationId: number, ts: string | undefined): void {
		this.#db
			.prepare("UPDATE approvals SET asked_in = CASE WHEN asked = 1 THEN ? END, asked = 0 WHERE conversation_id = ?")
			.run(ts ?? null, conversationId);
	}

	/** Whether the conversation's latest answer asked for approval of a change. */
	waiting(conversationId: number): boolean {
		return this.#db.prepare("SELECT 1 FROM approvals WHERE conversation_id = ? AND asked_in IS NOT NULL").get(conversationId) !== undefined;
	}

	/** The conversation whose answer in message `ts` asked for approval, if one did. */
	askedIn(ts: string): number | undefined {
		const row = this.#db.prepare("SELECT conversation_id FROM approvals WHERE asked_in = ?").get(ts) as { conversation_id: number } | undefined;
		return row?.conversation_id;
	}

	grant(conversationId: number, by: string, now = Date.now(), forMs = 15 * 60 * 1000): void {
		this.#db
			.prepare(
				`INSERT INTO approvals (conversation_id, given_by, given_until) VALUES (?, ?, ?)
				 ON CONFLICT DO UPDATE SET given_by = excluded.given_by, given_until = excluded.given_until`,
			)
			.run(conversationId, by, now + forMs);
	}

	/** Who approved, while it lasts and hasn't been used. */
	by(conversationId: number, now = Date.now()): string | undefined {
		const row = this.#db
			.prepare("SELECT given_by FROM approvals WHERE conversation_id = ? AND given_until > ?")
			.get(conversationId, now) as { given_by: string } | undefined;
		return row?.given_by;
	}

	/** An approval covers one change: using it ends it, so the next change needs its own. */
	use(conversationId: number): void {
		this.#db.prepare("UPDATE approvals SET given_by = NULL, given_until = NULL WHERE conversation_id = ?").run(conversationId);
	}

	close(): void {
		this.#db.close();
	}
}

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
		if (server.writes !== undefined && !["off", "approve", "allow"].includes(server.writes)) {
			throw new Error(`${path}: server ${name}'s writes must be off, approve or allow`);
		}
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

export type McpConnection = { name: string; client: Client; channels?: string[]; writes?: Writes };

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
			connections.push({
				name,
				client,
				...(server.channels === undefined ? {} : { channels: server.channels }),
				...(server.writes === undefined ? {} : { writes: server.writes }),
			});
		} catch (error) {
			console.error(`MCP server ${name} is unavailable:`, error);
		}
	}
	return connections;
}

/** Every connected server's tools as Scout tools, named `mcp__<server>__<tool>`, as its `writes` allows. */
export async function mcpExtension(
	connections: readonly McpConnection[],
	approvals?: Approvals,
	/** Why this approver's approval doesn't cover changes to `server`, if it doesn't (their groups, directory.ts). */
	refuseApprover?: (user: string, server: string) => Promise<string | undefined>,
) {
	const tools: ToolRegistration[] = [];
	for (const connection of connections) {
		const listed = await connection.client.listTools();
		const writes = connection.writes ?? "off";
		for (const tool of listed.tools) {
			const readOnly = tool.annotations?.readOnlyHint === true;
			if (!readOnly && writes === "off") continue;
			const gated = !readOnly && writes === "approve";
			tools.push(
				defineTool({
					name: `mcp__${connection.name}__${tool.name}`,
					description: `${tool.description ?? tool.name} (from ${connection.name}${gated ? "; it changes things, so a person in the thread has to approve first" : ""})`,
					parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
					execute: async (args, api, context) => {
						const approver = gated ? approvals?.by(api.conversationId) : undefined;
						if (gated && approver === undefined) {
							approvals?.ask(api.conversationId, connection.name);
							throw new Error(
								`${tool.name} changes ${connection.name}, so it needs a person's approval first. Say exactly what you'll change and why, ask the people in this thread to reply "approve" or react 👍 to your answer, and call it again once someone has. An approval covers this one change, for 15 minutes; each further change needs its own.`,
							);
						}
						const refused = approver === undefined ? undefined : await refuseApprover?.(approver, connection.name);
						if (refused !== undefined) throw new Error(`The approval doesn't cover this: ${refused} Ask someone who may to reply "approve" or react 👍.`);
						if (gated) approvals?.use(api.conversationId);
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
						// A read tool can hand back a token (a log line, a row): the model never sees one.
						const text = redact(
							content
								.map((block) => (block.type === "text" ? (block.text ?? "") : `[${block.type}${block.mimeType ? ` ${block.mimeType}` : ""}]`))
								.join("\n"),
						);
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
