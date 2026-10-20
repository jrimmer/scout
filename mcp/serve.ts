import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * Scout's own small MCP servers (CI logs, status pages): read-only tools over a service's HTTP API, run by Scout on its
 * host like any other MCP server (see src/mcp.ts and docs/operations.md). Each tool answers with text for the model.
 */
export type Tool = {
	name: string;
	description: string;
	inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
	run(args: Record<string, unknown>): Promise<string>;
};

export async function serve(name: string, tools: readonly Tool[]): Promise<void> {
	const server = new Server({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		// Every tool here only reads, and says so (Scout offers tools that change things only when configured to).
		tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } })),
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const tool = tools.find((t) => t.name === request.params.name);
		if (tool === undefined) return { isError: true, content: [{ type: "text", text: `No tool named ${request.params.name}.` }] };
		try {
			return { content: [{ type: "text", text: await tool.run(request.params.arguments ?? {}) }] };
		} catch (error) {
			return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
		}
	});
	await server.connect(new StdioServerTransport());
}

/** A required setting from the environment, or exit saying which. */
export function setting(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === "") {
		console.error(`${name} is not set`);
		process.exit(2);
	}
	return value;
}

export async function getJson(fetch: typeof globalThis.fetch, url: string, headers: Record<string, string> = {}): Promise<unknown> {
	const response = await fetch(url, { headers: { accept: "application/json", ...headers } });
	if (!response.ok) throw new Error(`${new URL(url).pathname} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
	return response.json();
}
