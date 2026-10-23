import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { Audit } from "../src/audit.ts";
import { loadConfig } from "../src/config.ts";
import { ThreadDoc } from "../src/docs.ts";
import { Limits, SpendLedger, weekStart } from "../src/limits.ts";
import { observeExtension } from "../src/observe.ts";
import { Permissions } from "../src/permissions.ts";
import { Pricing } from "../src/pricing.ts";
import { applyRetention } from "../src/retention.ts";
import { findSecrets, redact, rememberSecrets } from "../src/scan.ts";
import { resolveSecrets, rotate, secretValues } from "../src/secrets.ts";
import { Counters, Tracer } from "../src/telemetry.ts";
import { Threads, threadKey } from "../src/threads.ts";
import { tempDir } from "./helpers.ts";

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

	it("redacts the tokens Scout itself holds, and the common ones", () => {
		const hex = "0123456789abcdef0123456789abcdef01234567";
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
		const shapes: [text: string, kind: string][] = [
			["xapp-1-A0123456789-1234567890123-abcdef0123456789", "Slack token"],
			["xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOp", "Slack token"],
			["xoxp-123456789012-1234567890123-AbCdEfGh", "Slack token"],
			["xoxa-2-123456789012-AbCdEfGhIj", "Slack token"],
			["xoxr-123456789012-AbCdEfGhIj", "Slack token"],
			["xoxe.xoxp-1-Mi0yLTEyMzQ1Njc4OTAx", "Slack token"],
			["xoxe-1-My0xLTEyMzQ1Njc4OTAx", "Slack token"],
			[`FORGEJO_TOKEN=${hex}`, "Forgejo/Gitea token"],
			[`{"token": "${hex}"}`, "Forgejo/Gitea token"],
			[`Authorization: token ${hex}`, "Forgejo/Gitea token"],
			["glsa_abcdefghijklmnopqrstuvwxyz012345_abcdef12", "Grafana token"],
			["glc_eyJvIjoiMTIzNDU2IiwibiI6InN0YWNrIiwiayI6ImFiYyJ9", "Grafana token"],
			[jwt, "JWT"],
			["Authorization: Bearer abc.def-ghi_jkl012345", "authorization header"],
			["authorization: Basic dXNlcjpwYXNzd29yZA==", "authorization header"],
			["curl -H 'Bearer 0123456789abcdefXYZ'", "bearer token"],
			[`AWS_ACCESS_KEY_ID=${aws}`, "AWS access key"],
			[`aws_secret_access_key = ${"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}`, "AWS secret key"],
			[gh, "GitHub token"],
			[`gho_${"b".repeat(36)}`, "GitHub token"],
			[`ghs_${"c".repeat(36)}`, "GitHub token"],
			[`github_pat_${"d".repeat(82)}`, "GitHub token"],
		];
		for (const [text, kind] of shapes) {
			assert.ok(findSecrets(text).some((f) => f.kind === kind), `${text} is a ${kind}`);
			assert.ok(redact(`see ${text} here`).includes("[redacted "), `${text} is redacted`);
			assert.ok(!redact(`see ${text} here`).includes(text), `${text} is gone`);
		}
		// A private key goes whole, not only its first line.
		const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----";
		assert.equal(redact(`key:\n${key}\nafter`), "key:\n[redacted private key]\nafter");
		// Base64 of a token is found by what it decodes to.
		assert.deepEqual(findSecrets(Buffer.from(gh).toString("base64")), [{ kind: "GitHub token (base64)" }]);
	});

	it("leaves commit hashes and ordinary hex alone", () => {
		const sha = "0123456789abcdef0123456789abcdef01234567";
		for (const text of [
			sha,
			`commit ${sha}`,
			`Merge ${sha.slice(0, 7)} into main (${sha})`,
			`https://forge.example/acme/app/commit/${sha}`,
			`sha256:${"ab".repeat(32)}`,
			"color: #ff00aa; id=deadbeef",
			"Bearer tokens are how the gateway authenticates.",
		]) {
			assert.equal(redact(text), text, text);
			assert.deepEqual(findSecrets(text), [], text);
		}
	});

	it("redacts the secrets Scout loaded by value, whatever their shape", () => {
		const gateway = "sk-gw-0123456789abcdefghij";
		assert.equal(redact(`key ${gateway}`), `key ${gateway}`, "not a shape anything knows");
		rememberSecrets([gateway, "short", undefined]);
		assert.equal(redact(`the gateway said no to ${gateway}`), "the gateway said no to [redacted configured secret]");
		assert.deepEqual(findSecrets(`GATEWAY=${gateway}`), [{ kind: "configured secret" }]);
		assert.equal(redact("short and sweet"), "short and sweet", "too short to tell from ordinary words");
	});

	it("collects the values of the secrets in the environment, the OTLP headers and the MCP file's variables", () => {
		const path = join(tempDir("scout-secrets-"), "mcp.json");
		writeFileSync(path, JSON.stringify({ servers: { wh: { command: "wh", env: { TOKEN: "${WAREHOUSE_TOKEN}" } } } }));
		const values = secretValues(
			{
				SCOUT_CODEHOST_TOKEN: "forge-token-1",
				LITESTREAM_SECRET_ACCESS_KEY: "litestream-secret",
				WAREHOUSE_TOKEN: "warehouse-secret",
				SCOUT_OTLP_HEADERS: '{"authorization": "Bearer otlp-secret"}',
				HOME: "/home/scout",
			},
			path,
		);
		for (const value of ["forge-token-1", "litestream-secret", "warehouse-secret", "Bearer otlp-secret", "otlp-secret"]) assert.ok(values.includes(value), value);
		assert.ok(!values.includes("/home/scout"), "only secrets");
	});
});

describe("audit trail", () => {
	it("is append-only, redacts, and filters", () => {
		const path = join(tempDir("scout-audit-"), "scout.sqlite");
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

	it("requires the user group even with the check off, and only logs whom it would refuse in warn mode", async (t) => {
		const off = new Permissions({ config: { mode: "off", people: {}, userGroup: "S1" }, codeHost: host, fetch, groupMembers: async () => new Set(["UZ"]) });
		assert.match(((await off.admit("UA", "o/r")) as { reason: string }).reason, /people in the group/, "the group is a narrowing the operator asked for");
		assert.deepEqual(await off.admit("UZ", "o/r"), { ok: true });

		const warned = t.mock.method(console, "warn", () => {});
		const warn = new Permissions({ config: { mode: "warn", people: { UB: "bob" } }, codeHost: host, fetch });
		assert.deepEqual(await warn.admit("UB", "o/r"), { ok: true });
		assert.deepEqual(await warn.admitLogin("mallory", "o/r"), { ok: true });
		assert.deepEqual(
			warned.mock.calls.map((c) => String(c.arguments[0])),
			["requester check (warn): would refuse UB in o/r: You (bob) can't change o/r, so I can't change it for you. Someone who can could ask instead.", "requester check (warn): would refuse mallory in o/r: You (mallory) can't change o/r, so I can't change it for you. Someone who can could ask instead."],
		);
	});

	it("checks requesters unless told off, and refuses a setting it doesn't know rather than guess", () => {
		const env = { SCOUT_REPO_URL: "git@forge:o/r.git", SCOUT_REPO_SLUG: "o/r", SCOUT_CODEHOST_TOKEN: "t", SCOUT_CODEHOST_API: "http://forge/api/v1" };
		assert.equal(loadConfig(env).governance.requesterCheck, "enforce", "on unless it's turned off");
		assert.equal(loadConfig({ ...env, SCOUT_REQUESTER_CHECK: "Enforce" }).governance.requesterCheck, "enforce");
		assert.equal(loadConfig({ ...env, SCOUT_REQUESTER_CHECK: "WARN" }).governance.requesterCheck, "warn");
		assert.equal(loadConfig({ ...env, SCOUT_REQUESTER_CHECK: "off" }).governance.requesterCheck, "off");
		for (const value of ["on", "true", "enforced"]) {
			assert.throws(() => loadConfig({ ...env, SCOUT_REQUESTER_CHECK: value }), /SCOUT_REQUESTER_CHECK must be off, warn or enforce/, value);
		}
		assert.equal(loadConfig(env).governance.codeHostLogins, "directory", "Forgejo signs people in through the directory");
		assert.equal(loadConfig({ ...env, SCOUT_CODEHOST: "github" }).governance.codeHostLogins, "separate", "GitHub logins are anyone's to take");
		assert.equal(loadConfig({ ...env, SCOUT_CODEHOST_LOGINS: "separate" }).governance.codeHostLogins, "separate");
		assert.throws(() => loadConfig({ ...env, SCOUT_CODEHOST_LOGINS: "same" }), /SCOUT_CODEHOST_LOGINS must be directory or separate/);
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
