import { getJson, serve, setting, type Tool } from "./serve.ts";

/**
 * Gatus, read-only: what's up and what's failing now, and one endpoint's recent checks.
 *
 *     GATUS_URL=http://status.example:8080 node mcp/gatus.ts
 */

type Check = {
	status?: number;
	success: boolean;
	timestamp: string;
	duration: number;
	errors?: string[];
	conditionResults?: { condition: string; success: boolean }[];
};
type Endpoint = { key: string; name: string; group?: string; results: Check[] };

function describe(check: Check): string {
	const failed = (check.conditionResults ?? []).filter((c) => !c.success).map((c) => c.condition);
	return [
		check.success ? "up" : "DOWN",
		check.status === undefined || check.status === 0 ? undefined : `HTTP ${check.status}`,
		`${Math.round(check.duration / 1e6)} ms`,
		failed.length > 0 ? `failed: ${failed.join(", ")}` : undefined,
		check.errors && check.errors.length > 0 ? `errors: ${check.errors.join("; ")}` : undefined,
	]
		.filter(Boolean)
		.join(" · ");
}

export function gatusTools(url: string, fetch: typeof globalThis.fetch = globalThis.fetch): Tool[] {
	return [
		{
			name: "status_overview",
			description: "Every monitored endpoint's latest check, failing ones first. Use the key with endpoint_history.",
			inputSchema: { type: "object", properties: { failing_only: { type: "boolean", description: "Only endpoints whose latest check failed" } } },
			async run(args) {
				const endpoints = (await getJson(fetch, `${url}/api/v1/endpoints/statuses?page=1&pageSize=1`)) as Endpoint[];
				const rows = endpoints
					.map((e) => ({ e, last: e.results.at(-1) }))
					.filter(({ last }) => args.failing_only !== true || (last !== undefined && !last.success))
					.sort((a, b) => Number(a.last?.success ?? true) - Number(b.last?.success ?? true));
				if (rows.length === 0) return args.failing_only === true ? `All ${endpoints.length} endpoints are up.` : "No endpoints.";
				const down = endpoints.filter((e) => e.results.at(-1)?.success === false).length;
				return [
					`${endpoints.length} endpoints, ${down} failing.`,
					...rows.map(({ e, last }) => `${e.group ? `${e.group} / ` : ""}${e.name} [${e.key}]: ${last === undefined ? "no checks yet" : `${describe(last)} at ${last.timestamp}`}`),
				].join("\n");
			},
		},
		{
			name: "endpoint_history",
			description: "One endpoint's recent checks, newest last, to see when it started failing and how.",
			inputSchema: {
				type: "object",
				properties: { key: { type: "string", description: "The endpoint's key, from status_overview" }, limit: { type: "number", description: "How many checks (default 20, at most 100)" } },
				required: ["key"],
			},
			async run(args) {
				if (typeof args.key !== "string" || args.key === "") throw new Error("key is required");
				const limit = Math.min(100, Number(args.limit ?? 20) || 20);
				const endpoint = (await getJson(fetch, `${url}/api/v1/endpoints/${encodeURIComponent(args.key)}/statuses?page=1&pageSize=${limit}`)) as Endpoint;
				if (endpoint.results.length === 0) return `${endpoint.name}: no checks yet.`;
				return [`${endpoint.group ? `${endpoint.group} / ` : ""}${endpoint.name}:`, ...endpoint.results.map((c) => `${c.timestamp}  ${describe(c)}`)].join("\n");
			},
		},
	];
}

if (import.meta.main) await serve("gatus", gatusTools(setting("GATUS_URL").replace(/\/$/, "")));
