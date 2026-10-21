import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { Audit } from "../src/audit.ts";
import { ThreadDoc } from "../src/docs.ts";
import { Limits, SpendLedger, weekStart } from "../src/limits.ts";
import { observeExtension } from "../src/observe.ts";
import { Permissions } from "../src/permissions.ts";
import { Pricing } from "../src/pricing.ts";
import { applyRetention } from "../src/retention.ts";
import { findSecrets, redact, secretsInDiff } from "../src/scan.ts";
import { resolveSecrets, rotate } from "../src/secrets.ts";
import { Counters, Tracer } from "../src/telemetry.ts";
import { Threads, threadKey } from "../src/threads.ts";

const toolUse = { stopReason: "toolUse" } as const;

describe("secrets", () => {
	it("resolves files, systemd credentials and 1Password references, and leaves config files alone", async () => {
		const files: Record<string, string> = { "/run/slack": "xoxb-file", "/creds/codehost": "forge-token", "/etc/scout/mcp.json": "{}" };
		const vault: Record<string, string> = { "op://scout/gateway/key": "gw-1" };
		const read = { file: async (p: string) => files[p] ?? "", onePassword: async (r: string) => vault[r] ?? "" };
		const env: NodeJS.ProcessEnv = {
			SLACK_BOT_TOKEN_FILE: "/run/slack",
			SCOUT_CODEHOST_TOKEN: "cred:codehost",
			CREDENTIALS_DIRECTORY: "/creds",
			SCOUT_GATEWAY_KEY: "op://scout/gateway/key",
			SCOUT_MCP_FILE: "/etc/scout/mcp.json",
		};
		const sources = await resolveSecrets(env, read);
		assert.equal(env.SLACK_BOT_TOKEN, "xoxb-file");
		assert.equal(env.SCOUT_CODEHOST_TOKEN, "forge-token");
		assert.equal(env.SCOUT_GATEWAY_KEY, "gw-1");
		assert.equal(env.SCOUT_MCP, undefined, "a config file is not a secret");
		assert.equal(env.SCOUT_MCP_FILE, "/etc/scout/mcp.json");

		vault["op://scout/gateway/key"] = "gw-2";
		assert.deepEqual(await rotate(sources, env, read), ["SCOUT_GATEWAY_KEY"]);
		assert.equal(env.SCOUT_GATEWAY_KEY, "gw-2");
	});
});

describe("credential scanning", () => {
	const aws = "AKIA" + "ABCDEFGHIJKLMNOP";
	const gh = "ghp_" + "a".repeat(36);
	it("finds credentials by kind, and redacts them", () => {
		assert.deepEqual(findSecrets(`key = "${aws}"`), [{ kind: "AWS access key" }]);
		assert.deepEqual(findSecrets("-----BEGIN OPENSSH PRIVATE KEY-----"), [{ kind: "private key" }]);
		assert.deepEqual(findSecrets("const answer = 42; // ordinary code"), []);
		assert.equal(redact(`token ${gh} here`), "token [redacted GitHub token] here");
	});

	it("names the file a diff adds a credential to, ignoring removed lines", () => {
		const diff = ["+++ b/config/prod.env", `+AWS_KEY=${aws}`, `-OLD=${gh}`, "+++ b/README.md", "+fine"].join("\n");
		assert.deepEqual(secretsInDiff(diff), [{ file: "config/prod.env", kind: "AWS access key" }]);
	});
});

describe("audit trail", () => {
	it("is append-only, redacts, and filters", () => {
		const path = join(mkdtempSync(join(tmpdir(), "scout-audit-")), "scout.sqlite");
		const audit = new Audit(path);
		audit.record("request", { actor: "U1", conversationId: 1, channel: "team", detail: { text: `use ${"ghp_" + "b".repeat(36)}` } }, 1000);
		audit.record("pull_opened", { actor: "scout", detail: { url: "u" } }, 2000);
		assert.deepEqual(audit.list({ kind: "request" }).map((r) => r.detail), [{ text: "use [redacted GitHub token]" }]);
		assert.deepEqual(audit.list({ since: 1500 }).map((r) => r.kind), ["pull_opened"]);
		const db = new DatabaseSync(path);
		assert.throws(() => db.exec("UPDATE audit SET actor = 'someone else'"), /append-only/);
		assert.throws(() => db.exec("DELETE FROM audit"), /append-only/);
		db.close();
		audit.close();
	});
});

describe("pricing", () => {
	it("uses local prices when set, the catalog's otherwise", () => {
		const pricing = new Pricing({ "anthropic/claude-x": { input: 3, output: 15 } });
		const usage = { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 9.99 } };
		assert.equal(pricing.cost({ provider: "anthropic", model: "claude-x", usage }), 4.5);
		assert.equal(pricing.cost({ provider: "openai", model: "gpt-x", usage }), 9.99);
	});
});

describe("limits", () => {
	const message = (cost: number) => ({ provider: "p", model: "m", usage: { input: 1, output: 1, cost: { total: cost } } }) as never;

	it("declines a channel over its weekly budget, and queues past concurrency", () => {
		const pricing = new Pricing();
		const ledger = new SpendLedger(":memory:", pricing);
		const limits = new Limits({ weekly: { perChannel: 10, channels: { big: 100 }, total: 150 }, concurrency: { perChannel: 1, total: 3 } }, ledger, pricing);
		const now = Date.now();
		ledger.responded({ conversationId: 1, channel: "team", message: message(12) }, now);
		ledger.responded({ conversationId: 1, channel: "team", message: message(50) }, weekStart(new Date(now)) - 1000);
		assert.equal(ledger.spent(weekStart(new Date(now)), "team"), 12, "last week doesn't count");
		assert.match((limits.admit("team", [], now) as { reason: string }).reason, /used its \$10 of Scout for the week/);
		assert.deepEqual(limits.admit("big", [], now), { ok: true });
		const busy = limits.admit("big", [{ channel: "big" }], now);
		assert.equal(busy.ok, false);
		assert.equal((busy as { wait?: boolean }).wait, true);
		assert.equal(limits.admit("other", [{ channel: "a" }, { channel: "b" }, { channel: "c" }], now).ok, false);
		ledger.close();
	});

	it("says what a run cost, against the week's budget that applies", () => {
		const pricing = new Pricing();
		const ledger = new SpendLedger(":memory:", pricing);
		const now = Date.now();
		ledger.responded({ conversationId: 1, channel: "team", message: message(12) }, now - 60_000);
		ledger.responded({ conversationId: 2, channel: "team", message: message(0.034) }, now);
		ledger.responded({ conversationId: 3, channel: "other", message: message(0.001) }, now);
		const runStart = now - 1000;
		const channelBudget = new Limits({ weekly: { perChannel: 100, total: 500 } }, ledger, pricing);
		assert.equal(channelBudget.costNote(2, runStart, now), "$0.03 · $12.03 of $100 this week");
		const overall = new Limits({ weekly: { total: 500 } }, ledger, pricing);
		assert.equal(overall.costNote(3, runStart, now), "<$0.01 · $12.04 of $500 this week");
		assert.equal(new Limits({}, ledger, pricing).costNote(2, runStart, now), "$0.03");
		assert.equal(new Limits({}, ledger, pricing).costNote(9, runStart, now), "$0.00", "a run with no model calls cost nothing");
		ledger.close();
	});
});

describe("requester permissions", () => {
	const host = { kind: "forgejo" as const, apiUrl: "http://forge/api/v1", token: "t" };
	const permissionsOf: Record<string, string> = { alice: "write", bob: "read" };
	const fetch = (async (url: string | URL | Request) => {
		const login = decodeURIComponent(String(url).split("/collaborators/")[1]!.split("/")[0]!);
		const permission = permissionsOf[login];
		return permission === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify({ permission }), { status: 200 });
	}) as typeof globalThis.fetch;

	it("lets in only people who can change the repository, when enforced", async () => {
		const off = new Permissions({ config: { mode: "off", people: {} }, codeHost: host, fetch });
		assert.deepEqual(await off.admit("U9", "o/r"), { ok: true });
		const on = new Permissions({ config: { mode: "enforce", people: { UA: "alice", UB: "bob" } }, codeHost: host, fetch });
		assert.deepEqual(await on.admit("UA", "o/r"), { ok: true });
		assert.match(((await on.admit("UB", "o/r")) as { reason: string }).reason, /You \(bob\) can't change o\/r/);
		assert.match(((await on.admit("UC", "o/r")) as { reason: string }).reason, /don't know your Forgejo account/);
	});

	it("can also require a Slack user group", async () => {
		const p = new Permissions({ config: { mode: "enforce", people: { UA: "alice" }, userGroup: "S1" }, codeHost: host, fetch, groupMembers: async () => new Set(["UZ"]) });
		assert.match(((await p.admit("UA", "o/r")) as { reason: string }).reason, /people in the group/);
	});
});

describe("observers in a real run", () => {
	it("trace, count, audit and limit every model call and tool call", async () => {
		const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const pricing = new Pricing({ "faux/m": { input: 1_000_000, output: 0 } });
		const audit = new Audit(":memory:");
		const ledger = new SpendLedger(":memory:", pricing);
		const limits = new Limits({ perRun: { maxToolCalls: 1 } }, ledger, pricing);
		const counters = new Counters(pricing);
		const exported: { resourceSpans: { scopeSpans: { spans: { name: string; parentSpanId?: string; attributes: { key: string }[] }[] }[] }[] }[] = [];
		const tracer = new Tracer({
			endpoint: "http://otel/v1/traces",
			pricing,
			fetch: async (_url, init) => {
				exported.push(JSON.parse(String(init?.body)));
				return new Response("{}");
			},
		});
		const echo = defineTool({ name: "echo", description: "Echo", parameters: Type.Object({ text: Type.String() }), execute: async (args) => ({ output: [{ type: "text", text: args.text }] }) });
		const registry = createRegistry();
		registry.install(defineExtension({ name: "echo", tools: [echo] }));
		registry.install(observeExtension([audit, limits, ledger, counters, tracer], (e, reason) => audit.record("blocked", { actor: "scout", conversationId: e.conversationId, detail: { tool: e.name, reason } })));
		const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
		const conversation = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model: { provider: "faux", modelId: "m" } },
				init: async (tx, id) => {
					(await tx.doc(ThreadDoc, id)).channelName = "team";
				},
			},
			context,
		);
		let blocked = "";
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "one" })], toolUse),
			fauxAssistantMessage([fauxToolCall("echo", { text: "two" })], toolUse),
			(transcript) => {
				blocked = JSON.stringify(transcript);
				return fauxAssistantMessage("Stopping here.");
			},
		]);
		await (await conversation.submit({ type: "input", content: "go" }, context)).wait(context);
		await tracer.close();

		assert.match(blocked, /This request has used its 1 tool calls/);
		assert.deepEqual(
			audit.list().map((r) => [r.kind, r.detail.tool]),
			[
				["tool", "echo"],
				["tool", "echo"],
				["blocked", "echo"],
			],
		);
		assert.equal(audit.list()[0]?.channel, "team");
		const spans = exported.flatMap((e) => e.resourceSpans[0]!.scopeSpans[0]!.spans);
		assert.deepEqual(spans.map((s) => s.name).sort(), ["scout.model_call", "scout.model_call", "scout.model_call", "scout.run", "scout.tool echo"]);
		const run = spans.find((s) => s.name === "scout.run")!;
		assert.ok(spans.filter((s) => s.name !== "scout.run").every((s) => s.parentSpanId !== undefined && s.parentSpanId.length === 16 && run !== undefined));
		assert.ok(ledger.spent(0, "team") > 0, "spend is attributed to the channel");
		const metrics = counters.prometheus({ scout_working_threads: { help: "h", value: 0 } });
		assert.match(metrics, /scout_tool_calls_total\{tool="echo",outcome="ok"\} 1/);
		assert.match(metrics, /scout_runs_total 1/);
		await harness.close(context);
		audit.close();
		ledger.close();
	});
});

describe("retention", () => {
	it("deletes what quiet threads leave behind and keeps the audit trail", async () => {
		const threads = new Threads(":memory:");
		const audit = new Audit(":memory:");
		const removed: number[] = [];
		const forgotten: string[] = [];
		const day = 24 * 3600 * 1000;
		const now = Date.parse("2026-10-19T00:00:00Z");
		threads.insert({ key: threadKey("C", "1"), conversationId: 1, channel: "C", threadTs: "1", startedBy: "U" }, now - 100 * day);
		threads.insert({ key: threadKey("C", "2"), conversationId: 2, channel: "C", threadTs: "2", startedBy: "U" }, now - day);
		const options = {
			days: 30,
			threads,
			workspaces: { remove: async (id: number) => void removed.push(id) },
			search: { forget: (key: string) => void forgotten.push(key) },
			memory: { purge: () => 3 },
			audit,
			now,
		};
		assert.deepEqual(await applyRetention(options), { threads: 1, notes: 3 });
		assert.deepEqual(await applyRetention(options), { threads: 0, notes: 3 }, "each thread once");
		assert.deepEqual(removed, [1]);
		assert.deepEqual(forgotten, ["C:1"]);
		assert.equal(audit.list({ kind: "retention" }).length, 2);
		threads.close();
		audit.close();
	});
});
