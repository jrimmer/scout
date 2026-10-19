import { randomBytes } from "node:crypto";
import type { Observer, ToolCallEvent, Where } from "./observe.ts";
import type { Pricing } from "./pricing.ts";

/**
 * Telemetry an organization's monitoring can use, without a telemetry SDK:
 * - traces, as OTLP/HTTP JSON: a span per run, with child spans for each model call and tool call;
 * - counters for Prometheus (`/metrics` on the dashboard listener), next to the dashboard's own numbers.
 */
type Attribute = { key: string; value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean } };
type Span = {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: number;
	startTimeUnixNano: string;
	endTimeUnixNano?: string;
	attributes: Attribute[];
	status?: { code: number };
};

const nanos = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`;
const id = (bytes: number) => randomBytes(bytes).toString("hex");
const attr = (key: string, value: string | number | boolean): Attribute => ({
	key,
	value: typeof value === "string" ? { stringValue: value } : typeof value === "boolean" ? { boolValue: value } : Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value },
});

/** Spans for runs, model calls and tool calls, exported in batches to an OTLP/HTTP endpoint (`…/v1/traces`). */
export class Tracer implements Observer {
	readonly #endpoint: string;
	readonly #headers: Record<string, string>;
	readonly #pricing: Pricing;
	readonly #fetch: typeof fetch;
	readonly #runs = new Map<number, Span>();
	readonly #open = new Map<string, Span>();
	#done: Span[] = [];
	readonly #timer: ReturnType<typeof setInterval>;

	constructor(options: { endpoint: string; headers?: Record<string, string>; pricing: Pricing; fetch?: typeof fetch; intervalMs?: number }) {
		this.#endpoint = options.endpoint;
		this.#headers = options.headers ?? {};
		this.#pricing = options.pricing;
		this.#fetch = options.fetch ?? fetch;
		this.#timer = setInterval(() => void this.flush(), options.intervalMs ?? 5000);
		this.#timer.unref();
	}

	#run(w: Where): Span {
		let run = this.#runs.get(w.conversationId);
		if (run === undefined) {
			run = {
				traceId: id(16),
				spanId: id(8),
				name: "scout.run",
				kind: 1,
				startTimeUnixNano: nanos(Date.now()),
				attributes: [attr("scout.conversation", w.conversationId), attr("scout.channel", w.channel)],
			};
			this.#runs.set(w.conversationId, run);
		}
		return run;
	}

	#child(w: Where, key: string, name: string, attributes: Attribute[]): void {
		const run = this.#run(w);
		this.#open.set(key, { traceId: run.traceId, spanId: id(8), parentSpanId: run.spanId, name, kind: 3, startTimeUnixNano: nanos(Date.now()), attributes: [...run.attributes, ...attributes] });
	}

	#end(key: string, attributes: Attribute[], error: boolean): void {
		const span = this.#open.get(key);
		if (span === undefined) return;
		this.#open.delete(key);
		this.#done.push({ ...span, endTimeUnixNano: nanos(Date.now()), attributes: [...span.attributes, ...attributes], status: { code: error ? 2 : 1 } });
	}

	requestStarted(e: Where & { taskId: string }): void {
		this.#child(e, `request:${e.taskId}`, "scout.model_call", []);
	}

	responded(e: Where & { taskId: string; message: import("@earendil-works/pi-ai").AssistantMessage }): void {
		const m = e.message;
		this.#end(
			`request:${e.taskId}`,
			[
				attr("gen_ai.system", m.provider),
				attr("gen_ai.request.model", m.model),
				attr("gen_ai.usage.input_tokens", m.usage?.input ?? 0),
				attr("gen_ai.usage.output_tokens", m.usage?.output ?? 0),
				attr("scout.cost_usd", this.#pricing.cost(m)),
				attr("gen_ai.response.finish_reason", m.stopReason),
			],
			m.stopReason === "error",
		);
	}

	toolStarted(e: ToolCallEvent): undefined {
		this.#child(e, `tool:${e.callId}`, `scout.tool ${e.name}`, [attr("scout.tool", e.name), attr("scout.tool.nested", e.nested)]);
		return undefined;
	}

	toolEnded(e: ToolCallEvent & { isError: boolean }): void {
		this.#end(`tool:${e.callId}`, [], e.isError);
	}

	runEnded(w: Where): void {
		const run = this.#runs.get(w.conversationId);
		if (run === undefined) return;
		this.#runs.delete(w.conversationId);
		this.#done.push({ ...run, endTimeUnixNano: nanos(Date.now()), status: { code: 1 } });
	}

	/** Send what's finished. Failures are logged and dropped: telemetry never gets in the way of work. */
	async flush(): Promise<void> {
		if (this.#done.length === 0) return;
		const spans = this.#done;
		this.#done = [];
		const body = {
			resourceSpans: [
				{
					resource: { attributes: [attr("service.name", "scout")] },
					scopeSpans: [{ scope: { name: "scout" }, spans }],
				},
			],
		};
		try {
			const response = await this.#fetch(this.#endpoint, {
				method: "POST",
				headers: { "content-type": "application/json", ...this.#headers },
				body: JSON.stringify(body),
			});
			if (!response.ok) console.error(`telemetry export: ${response.status}`);
		} catch (error) {
			console.error("telemetry export failed:", error);
		}
	}

	close(): Promise<void> {
		clearInterval(this.#timer);
		return this.flush();
	}
}

/** Counters since start, for Prometheus. */
export class Counters implements Observer {
	readonly #pricing: Pricing;
	readonly requests = new Map<string, number>();
	readonly tokens = new Map<string, number>();
	readonly cost = new Map<string, number>();
	readonly tools = new Map<string, number>();
	runs = 0;

	constructor(pricing: Pricing) {
		this.#pricing = pricing;
	}

	responded(e: Where & { message: import("@earendil-works/pi-ai").AssistantMessage }): void {
		const model = `${e.message.provider}/${e.message.model}`;
		add(this.requests, labels({ model, outcome: e.message.stopReason === "error" ? "error" : "ok" }));
		add(this.tokens, labels({ model, kind: "input" }), e.message.usage?.input ?? 0);
		add(this.tokens, labels({ model, kind: "output" }), e.message.usage?.output ?? 0);
		add(this.cost, labels({ model }), this.#pricing.cost(e.message));
	}

	toolEnded(e: ToolCallEvent & { isError: boolean }): void {
		add(this.tools, labels({ tool: e.name, outcome: e.isError ? "error" : "ok" }));
	}

	runEnded(): void {
		this.runs++;
	}

	/** The counters, plus gauges the caller already knows (from the dashboard's snapshot), in Prometheus text. */
	prometheus(gauges: Record<string, { help: string; value: number }>): string {
		const out: string[] = [];
		const counter = (name: string, help: string, series: Map<string, number> | number) => {
			out.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
			if (typeof series === "number") out.push(`${name} ${series}`);
			else for (const [l, v] of series) out.push(`${name}{${l}} ${v}`);
		};
		counter("scout_model_requests_total", "Model responses, by model and outcome.", this.requests);
		counter("scout_model_tokens_total", "Tokens, by model and kind.", this.tokens);
		counter("scout_model_cost_dollars_total", "Model spend in dollars, by model.", this.cost);
		counter("scout_tool_calls_total", "Tool calls, by tool and outcome.", this.tools);
		counter("scout_runs_total", "Runs that finished.", this.runs);
		for (const [name, g] of Object.entries(gauges)) out.push(`# HELP ${name} ${g.help}`, `# TYPE ${name} gauge`, `${name} ${g.value}`);
		return `${out.join("\n")}\n`;
	}
}

function labels(values: Record<string, string>): string {
	return Object.entries(values)
		.map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, "_")}"`)
		.join(",");
}

function add(map: Map<string, number>, key: string, by = 1): void {
	map.set(key, (map.get(key) ?? 0) + by);
}
