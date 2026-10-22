import { randomBytes } from "node:crypto";
import type { SpanAttributes, SpanLink, SpanOptions, SpanStatus, TelemetryCarrier, TelemetryContext, TelemetryPropagation, TelemetrySpan } from "@earendil-works/pi-telemetry";
import type { Observer, ToolCallEvent, Where } from "./observe.ts";
import type { Pricing } from "./pricing.ts";

/**
 * Telemetry an organization's monitoring can use, without a telemetry SDK:
 * - traces, as OTLP/HTTP JSON: a span per run, with child spans for each model call and tool call, and Pi Durable's own
 *   spans (submissions, task phases, model requests) through the same exporter (`PiTelemetry`);
 * - counters for Prometheus (`/metrics` on the dashboard listener), next to the dashboard's own numbers.
 */
type Value = { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean };
type Attribute = { key: string; value: Value & { arrayValue?: { values: Value[] } } };
type Span = {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: number;
	/** OTLP span flags: whether the parent is known to be remote (0x100 says it is known, 0x200 that it is). */
	flags?: number;
	startTimeUnixNano: string;
	endTimeUnixNano?: string;
	attributes: Attribute[];
	events?: { timeUnixNano: string; name: string; attributes: Attribute[] }[];
	links?: { traceId: string; spanId: string; attributes: Attribute[] }[];
	status?: { code: number; message?: string };
};

const nanos = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`;
const id = (bytes: number) => randomBytes(bytes).toString("hex");
const scalar = (value: string | number | boolean): Value =>
	typeof value === "string" ? { stringValue: value } : typeof value === "boolean" ? { boolValue: value } : Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
const attr = (key: string, value: string | number | boolean | readonly (string | number | boolean)[]): Attribute => ({
	key,
	value: typeof value === "object" ? { arrayValue: { values: value.map(scalar) } } : scalar(value),
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
	#pi = false;
	readonly #cost = new Map<number, number>();
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

	/**
	 * Pi Durable's telemetry context, exporting through this tracer. From here on Pi's `pi.ai.request` span stands for a
	 * model call (it also has retries and the time to the first chunk), so `scout.model_call` is no longer emitted; what
	 * Pi doesn't know, Scout's spend by its own price list, moves to the run span as `scout.cost_usd`.
	 */
	piTelemetry(): TelemetryContext {
		this.#pi = true;
		return new PiTelemetry((span) => this.#done.push(span));
	}

	requestStarted(e: Where & { taskId: string }): void {
		if (this.#pi) return;
		this.#child(e, `request:${e.taskId}`, "scout.model_call", []);
	}

	responded(e: Where & { taskId: string; message: import("@earendil-works/pi-ai").AssistantMessage }): void {
		const m = e.message;
		if (this.#pi) {
			this.#cost.set(e.conversationId, (this.#cost.get(e.conversationId) ?? 0) + this.#pricing.cost(m));
			this.#run(e);
			return;
		}
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
		const cost = this.#cost.get(w.conversationId);
		this.#cost.delete(w.conversationId);
		const attributes = cost === undefined ? run.attributes : [...run.attributes, attr("scout.cost_usd", cost)];
		this.#done.push({ ...run, attributes, endTimeUnixNano: nanos(Date.now()), status: { code: 1 } });
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

/** W3C `traceparent`: the carrier Pi stores with a submission or task, so a later phase continues the same trace. */
const traceparent = (traceId: string, spanId: string): TelemetryCarrier => ({ traceparent: `00-${traceId}-${spanId}-01` });

/** Where spans can start: the root, or a parent from a carrier. A span is the same with its own ids. */
class Parent implements TelemetryContext {
	readonly propagation: TelemetryPropagation | undefined;
	readonly finish: (span: Span) => void;
	readonly traceId: string | undefined;
	readonly spanId: string | undefined;
	/** After the span settled, calls on it are accepted and ignored. It stays linkable, but spans started from it are `phantom`. */
	inert = false;
	phantom = false;
	/** An extracted parent, which may be another process's span. */
	readonly remote: boolean;

	constructor(finish: (span: Span) => void, propagation: TelemetryPropagation | undefined, parent?: { traceId: string; spanId: string }, remote = false) {
		this.remote = remote;
		this.finish = finish;
		this.propagation = propagation;
		this.traceId = parent?.traceId;
		this.spanId = parent?.spanId;
	}

	carrier(): TelemetryCarrier | undefined {
		return this.phantom || this.traceId === undefined || this.spanId === undefined ? undefined : traceparent(this.traceId, this.spanId);
	}

	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		const span = new PiSpan(options, this);
		let result: T | Promise<T>;
		try {
			result = callback(span);
		} catch (error) {
			span.settle({ error });
			return Promise.reject(error);
		}
		return Promise.resolve(result).then(
			(value) => (span.settle(), value),
			(error) => {
				span.settle({ error });
				throw error;
			},
		);
	}
}

class PiSpan extends Parent implements TelemetrySpan {
	readonly #span: Span;
	readonly #attributes = new Map<string, Attribute>();
	#status: SpanStatus | undefined;

	constructor(options: SpanOptions, parent: Parent) {
		super(parent.finish, parent.propagation, { traceId: parent.traceId ?? id(16), spanId: id(8) });
		this.inert = this.phantom = parent.inert;
		this.#span = { traceId: this.traceId!, spanId: this.spanId!, name: options.name, kind: 1, startTimeUnixNano: nanos(Date.now()), attributes: [] };
		if (parent.spanId !== undefined && parent.traceId !== undefined) {
			this.#span.parentSpanId = parent.spanId;
			this.#span.flags = parent.remote ? 0x300 : 0x100;
		}
		this.setAttributes(options.attributes ?? {});
		for (const link of options.links ?? []) this.addLink(link);
	}

	addLink(link: SpanLink): void {
		const [, traceId, spanId] = (link.context instanceof Parent ? link.context.carrier() : undefined)?.traceparent?.split("-") ?? [];
		if (this.inert || traceId === undefined || spanId === undefined) return;
		(this.#span.links ??= []).push({ traceId, spanId, attributes: attributesOf(link.attributes ?? {}) });
	}

	addEvent(name: string, attributes: SpanAttributes = {}): void {
		if (!this.inert) (this.#span.events ??= []).push({ timeUnixNano: nanos(Date.now()), name, attributes: attributesOf(attributes) });
	}

	setAttributes(attributes: SpanAttributes): void {
		if (this.inert) return;
		for (const a of attributesOf(attributes)) this.#attributes.set(a.key, a);
	}

	setStatus(status: SpanStatus): void {
		if (!this.inert) this.#status = status;
	}

	/** End the span: ok, or an error if the callback threw and nothing said otherwise. */
	settle(thrown?: { error: unknown }): void {
		if (this.inert) return;
		this.inert = true;
		const e = thrown?.error;
		const error = e instanceof Error ? { name: e.name, message: e.message } : { name: "Error", message: String(e) };
		const status: SpanStatus = this.#status ?? (thrown === undefined ? { status: "ok" } : { status: "error", error });
		const span = this.#span;
		span.attributes = [...this.#attributes.values()];
		span.endTimeUnixNano = nanos(Date.now());
		span.status = { code: status.status === "ok" ? 1 : 2 };
		if (status.status === "error" && status.error !== undefined) {
			const message = status.error.message.slice(0, 500);
			span.status.message = message;
			(span.events ??= []).push({ timeUnixNano: span.endTimeUnixNano, name: "exception", attributes: [attr("exception.type", status.error.name), attr("exception.message", message)] });
		}
		this.finish(span);
	}
}

function attributesOf(attributes: SpanAttributes): Attribute[] {
	return Object.entries(attributes).flatMap(([key, value]) => (value === undefined ? [] : [attr(key, value)]));
}

/**
 * Pi's telemetry context (`HarnessOptions.telemetry`) over the exporter: its spans, events and statuses become OTLP
 * spans in the same batches. Propagation is W3C `traceparent`. Metrics are not offered: OTLP metrics are another
 * endpoint, and `/metrics` carries Scout's own.
 */
export class PiTelemetry extends Parent {
	constructor(finish: (span: Span) => void) {
		let root: Parent;
		const propagation: TelemetryPropagation = {
			inject: (context) => (context instanceof Parent ? context.carrier() : undefined),
			extract: (carrier) => {
				const [, traceId, spanId] = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(carrier?.traceparent ?? "") ?? [];
				return traceId === undefined || spanId === undefined ? root : new Parent(finish, propagation, { traceId, spanId }, true);
			},
		};
		super(finish, propagation);
		root = this;
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
