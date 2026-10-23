import { createHash } from "node:crypto";
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
 * offers them, but each call waits for a person in the thread to reply "approve" (one approval for that exact call,
 * within 15 minutes); `writes: "allow"` offers every tool as it is, for a trusted server that doesn't mark its tools.
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

/** A change a tool would make: the server and tool it goes to, and its arguments. */
export type Change = { server: string; tool: string; args: unknown };

/** What an approval is bound to: server, tool, and a hash of the arguments (keys sorted, so their order doesn't matter). */
export function changeKey(change: Change): string {
	const canonical = (value: unknown): unknown =>
		Array.isArray(value)
			? value.map(canonical)
			: value !== null && typeof value === "object"
				? Object.fromEntries(
						Object.keys(value)
							.sort()
							.map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
					)
				: value;
	const hash = createHash("sha256")
		.update(JSON.stringify(canonical(change.args ?? {})))
		.digest("hex");
	return `${change.server}/${change.tool}/${hash}`;
}

const serverOf = (key: string | null | undefined) => (key === null || key === undefined ? undefined : key.slice(0, key.indexOf("/")));

/**
 * Approvals, kept in Scout's database so a restart loses none. A tool call that needs one records the change it would
 * make (`ask`); when the run ends, that change is what waits in its answer (`answered`), where a 👍 approves. An
 * approval is given only while a change waits, and only for that change: the same server, tool and arguments, so a
 * run steered in between can't spend it on something else. Using it ends it, and so do 15 minutes and a Decline.
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
		const columns = () => (this.#db.prepare("PRAGMA table_info(approvals)").all() as { name: string }[]).map((c) => c.name);
		// The server alone, from before approvals were bound to the change; no longer read.
		if (!columns().includes("asked_for")) this.#db.exec("ALTER TABLE approvals ADD COLUMN asked_for TEXT");
		if (!columns().includes("waiting_for")) {
			// The change asked for in the run going on now, the one waiting in its answer, and the one approved (changeKey).
			// What was asked or approved before these were kept isn't bound to a change, so it's dropped: Scout asks again.
			this.#db.exec(`
				ALTER TABLE approvals ADD COLUMN asking TEXT;
				ALTER TABLE approvals ADD COLUMN waiting_for TEXT;
				ALTER TABLE approvals ADD COLUMN given_for TEXT;
				UPDATE approvals SET asked = 0, asked_in = NULL, given_by = NULL, given_until = NULL;
			`);
		}
	}

	/** This change waited for approval in the run going on now: the answer Scout gives next is where people approve it. */
	ask(conversationId: number, change: Change): void {
		this.#db
			.prepare("INSERT INTO approvals (conversation_id, asked, asking) VALUES (?, 1, ?) ON CONFLICT DO UPDATE SET asked = 1, asking = excluded.asking")
			.run(conversationId, changeKey(change));
	}

	/** The server whose change is waiting for approval (or approved and not yet made), if any. */
	askedFor(conversationId: number): string | undefined {
		const row = this.#db.prepare("SELECT waiting_for, given_for FROM approvals WHERE conversation_id = ?").get(conversationId) as
			| { waiting_for: string | null; given_for: string | null }
			| undefined;
		return serverOf(row?.waiting_for) ?? serverOf(row?.given_for);
	}

	/** A run ended with its answer in message `ts`: that's where a 👍 approves if the run asked, else nowhere. */
	answered(conversationId: number, ts: string | undefined): void {
		this.#db
			.prepare(
				`UPDATE approvals SET asked_in = CASE WHEN asked = 1 THEN ? END, waiting_for = CASE WHEN asked = 1 THEN asking END,
				 asking = NULL, asked = 0 WHERE conversation_id = ?`,
			)
			.run(ts ?? null, conversationId);
	}

	/** Whether the conversation's latest answer asked for approval of a change. */
	waiting(conversationId: number): boolean {
		return this.#db.prepare("SELECT 1 FROM approvals WHERE conversation_id = ? AND asked_in IS NOT NULL AND waiting_for IS NOT NULL").get(conversationId) !== undefined;
	}

	/** The conversation whose answer in message `ts` asked for approval, if one did. */
	askedIn(ts: string): number | undefined {
		const row = this.#db.prepare("SELECT conversation_id FROM approvals WHERE asked_in = ? AND waiting_for IS NOT NULL").get(ts) as { conversation_id: number } | undefined;
		return row?.conversation_id;
	}

	/** `by` approves the change waiting in this conversation, and only that one; false when nothing is waiting. */
	grant(conversationId: number, by: string, now = Date.now(), forMs = 15 * 60 * 1000): boolean {
		const done = this.#db
			.prepare(
				`UPDATE approvals SET given_by = ?, given_until = ?, given_for = waiting_for
				 WHERE conversation_id = ? AND asked_in IS NOT NULL AND waiting_for IS NOT NULL`,
			)
			.run(by, now + forMs, conversationId);
		return done.changes > 0;
	}

	/** Who approved exactly this change, while it lasts and hasn't been used. */
	by(conversationId: number, change: Change, now = Date.now()): string | undefined {
		const row = this.#db
			.prepare("SELECT given_by FROM approvals WHERE conversation_id = ? AND given_until > ? AND given_for = ?")
			.get(conversationId, now, changeKey(change)) as { given_by: string } | undefined;
		return row?.given_by;
	}

	/** Who approved this conversation's change, whatever it is, while it lasts and hasn't been used. */
	approver(conversationId: number, now = Date.now()): string | undefined {
		const row = this.#db
			.prepare("SELECT given_by FROM approvals WHERE conversation_id = ? AND given_until > ? AND given_for IS NOT NULL")
			.get(conversationId, now) as { given_by: string } | undefined;
		return row?.given_by;
	}

	/** Whether a change waits for a decision here, or was approved and not yet made: what a Decline can stop. */
	pending(conversationId: number, now = Date.now()): boolean {
		return this.waiting(conversationId) || this.approver(conversationId, now) !== undefined;
	}

	/** An approval covers one change: using it ends it (and the wait for that change), so the next needs its own. */
	use(conversationId: number): void {
		this.#db
			.prepare(
				`UPDATE approvals SET given_by = NULL, given_until = NULL, given_for = NULL,
				 asked_in = CASE WHEN waiting_for = given_for THEN NULL ELSE asked_in END,
				 waiting_for = CASE WHEN waiting_for = given_for THEN NULL ELSE waiting_for END
				 WHERE conversation_id = ?`,
			)
			.run(conversationId);
	}

	/** Declined: nothing waits any more, and an approval given but not yet used is taken back. */
	decline(conversationId: number): void {
		this.#db
			.prepare("UPDATE approvals SET given_by = NULL, given_until = NULL, given_for = NULL, asked_in = NULL, waiting_for = NULL WHERE conversation_id = ?")
			.run(conversationId);
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
						if (gated) {
							// An approval covers exactly the call it was asked for: this server, this tool, these arguments.
							const change = { server: connection.name, tool: tool.name, args };
							const approver = approvals?.by(api.conversationId, change);
							if (approver === undefined) {
								approvals?.ask(api.conversationId, change);
								throw new Error(
									`${tool.name} changes ${connection.name}, so it needs a person's approval first. Say exactly what you'll change and why, ask the people in this thread to reply "approve" or react 👍 to your answer, and once someone has, call it again with the same arguments. An approval covers this one call as you asked for it, for 15 minutes; a different call, or each further change, needs its own.`,
								);
							}
							const refused = await refuseApprover?.(approver, connection.name);
							if (refused !== undefined) {
								// Not theirs to give: it's spent, and the change waits for someone who may.
								approvals?.use(api.conversationId);
								approvals?.ask(api.conversationId, change);
								throw new Error(`The approval doesn't cover this: ${refused} Ask someone who may to reply "approve" or react 👍.`);
							}
							approvals?.use(api.conversationId);
						}
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
