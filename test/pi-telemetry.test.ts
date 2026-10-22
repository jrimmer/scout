import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import type { RecordedTelemetrySpan } from "@earendil-works/pi-telemetry";
import { createTelemetryAdapterConformance } from "@earendil-works/pi-telemetry/testing";
import { Pricing } from "../src/pricing.ts";
import { Tracer } from "../src/telemetry.ts";

type Value = { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean };
type Attribute = { key: string; value: Value & { arrayValue?: { values: Value[] } } };
type Exported = {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	flags?: number;
	name: string;
	attributes: Attribute[];
	events?: { name: string; attributes: Attribute[] }[];
	links?: { traceId: string; spanId: string; attributes: Attribute[] }[];
	status: { code: number; message?: string };
};

/** A stand-in OTLP endpoint: the spans a tracer has exported to it. */
function collector() {
	const spans: Exported[] = [];
	const fetch: typeof globalThis.fetch = async (_url, init) => {
		for (const rs of JSON.parse(String(init?.body)).resourceSpans) for (const ss of rs.scopeSpans) spans.push(...ss.spans);
		return new Response("{}");
	};
	return { spans, tracer: new Tracer({ endpoint: "http://otel/v1/traces", pricing: new Pricing({}), fetch }) };
}

const value = (v: Attribute["value"]): string | number | boolean | (string | number | boolean)[] =>
	v.arrayValue !== undefined ? v.arrayValue.values.map((x) => value(x) as string) : (v.stringValue ?? (v.intValue !== undefined ? Number(v.intValue) : (v.boolValue ?? v.doubleValue!)));
const attributes = (list: Attribute[]) => Object.fromEntries(list.map((a) => [a.key, value(a.value)]));
const carrier = (traceId: string, spanId: string) => ({ traceparent: `00-${traceId}-${spanId}-01` });

/** What the exporter received, in the conformance suite's terms: exported (settled) order is end order. */
function normalize(spans: Exported[]): RecordedTelemetrySpan[] {
	return spans.map((s, index) => {
		const parent = (s.flags ?? 0) & 0x200 ? -1 : spans.findIndex((p) => p.spanId === s.parentSpanId);
		const exception = s.events?.find((e) => e.name === "exception");
		const error = exception === undefined ? undefined : { name: String(attributes(exception.attributes)["exception.type"]), message: String(attributes(exception.attributes)["exception.message"]) };
		return {
			id: index,
			parentId: parent < 0 ? null : parent,
			context: carrier(s.traceId, s.spanId),
			parentContext: s.parentSpanId === undefined || parent >= 0 ? null : carrier(s.traceId, s.parentSpanId),
			links: (s.links ?? []).map((l) => ({ context: carrier(l.traceId, l.spanId), attributes: attributes(l.attributes) })),
			name: s.name,
			attributes: attributes(s.attributes),
			events: (s.events ?? []).filter((e) => e !== exception).map((e) => ({ name: e.name, attributes: attributes(e.attributes) })),
			status: s.status.code === 1 ? { status: "ok" } : error === undefined ? { status: "error" } : { status: "error", error },
			settled: true,
			endSequence: index,
		} as RecordedTelemetrySpan;
	});
}

const conformance = createTelemetryAdapterConformance(async () => {
	const { spans, tracer } = collector();
	const telemetry = tracer.piTelemetry();
	return {
		context: telemetry,
		propagation: telemetry.propagation,
		getSpans: async () => {
			await tracer.flush();
			return normalize(spans);
		},
		[Symbol.asyncDispose]: () => tracer.close(),
	};
});

for (const group of new Set(conformance.map((c) => c.group))) {
	describe(`Pi telemetry adapter: ${group}`, () => {
		for (const testCase of conformance.filter((c) => c.group === group)) it(testCase.name, () => testCase.run());
	});
}

describe("Pi telemetry in a harness", () => {
	it("exports Pi's spans through Scout's exporter, with one span per model call", async () => {
		const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const { spans, tracer } = collector();
		const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry(), telemetry: tracer.piTelemetry() }, context);
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "m" } } }, context);
		faux.setResponses([fauxAssistantMessage("Done.")]);
		await (await conversation.submit({ type: "input", content: "secret request text" }, context)).wait(context);
		// What Scout's observers do for a run: a model call, which Pi's span already covers.
		tracer.requestStarted({ conversationId: 1, channel: "C", taskId: "t" });
		tracer.responded({ conversationId: 1, channel: "C", taskId: "t", message: fauxAssistantMessage("Done.") });
		tracer.runEnded({ conversationId: 1, channel: "C" });
		await harness.close(context);
		await tracer.close();

		const names = new Set(spans.map((s) => s.name));
		for (const name of ["pi.durable.submit", "pi.durable.phase", "pi.ai.request", "scout.run"]) assert.ok(names.has(name), `${name} exported: ${[...names].join(", ")}`);
		assert.ok(!names.has("scout.model_call"), "Pi's pi.ai.request is the model call's span");
		const request = spans.find((s) => s.name === "pi.ai.request")!;
		assert.equal(attributes(request.attributes).model, "m");
		assert.ok(spans.some((s) => s.spanId === request.parentSpanId), "a model request sits under its task phase");
		assert.ok(!JSON.stringify(spans).includes("secret request text"), "Pi's spans carry no content");
		assert.ok(attributes(spans.find((s) => s.name === "scout.run")!.attributes)["scout.cost_usd"] !== undefined, "spend stays on the run span");
	});
});
