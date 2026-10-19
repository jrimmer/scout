import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { SpoondDriver } from "../src/drivers/spoond.ts";
import { Workspaces } from "../src/workspaces.ts";
import { fakeSpoond } from "./fake-spoond.ts";
import { bareRepo } from "./helpers.ts";

describe("spoond driver", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "scout-spoond-")));
	const remote = bareRepo(root, "app");
	let spoond: Awaited<ReturnType<typeof fakeSpoond>>;
	let workspaces: Workspaces;

	before(async () => {
		spoond = await fakeSpoond("sdt-test");
		process.env.SCOUT_SPOOND_TOKEN = "sdt-test";
		workspaces = new Workspaces({
			dataDir: join(root, "data"),
			instance: "t",
			repos: [{ name: "app", gitUrl: remote, base: "main", egress: ["registry.npmjs.org", "proxy.golang.org"] }],
			driver: new SpoondDriver({ url: spoond.url, token: "sdt-test", home: join(root, "guest") }),
			sandbox: { image: "dev-base", network: "none", size: "medium" },
			git: { name: "Scout", email: "scout@localhost" },
		});
	});
	after(async () => {
		await workspaces.close();
		await spoond.close();
	});

	it("leases a persistent microVM with the repository's egress allowlist", async () => {
		const env = await workspaces.env(1);
		let out = "";
		const result = await env.exec("git branch --show-current; cat README.md", { onOutput: (t) => (out += t) }, context);
		assert.ok(result.ok && result.value.exitCode === 0, out);
		assert.deepEqual(out.trim().split("\n"), ["scout/t-1", "app"]);

		const [lease] = [...spoond.leases.values()];
		assert.deepEqual(lease?.body, {
			image: "dev-base",
			persistent: true,
			ttl: 0,
			size: "medium",
			network_policy: "restricted",
			egress_allowlist: ["registry.npmjs.org", "proxy.golang.org"],
			holder: "scout:t-1",
			comment: "conversation=1 repo=app instance=t",
			idle_suspend: 3600,
			checkpoint_interval: 600,
			wait: 60,
		});
		assert.ok(spoond.calls.some((c) => c.startsWith("PUT /api/leases/lease1/files/") && c.includes("/.scout/pi-env-")), "the daemon was uploaded");
		assert.ok(spoond.calls.includes("STREAM lease1"), "and runs over the stream WebSocket");
	});

	it("finds the same lease again, keeps it alive, and suspends it when quiet", async () => {
		await workspaces.suspend(1);
		assert.equal(spoond.leases.get("lease1")?.state, "suspended");
		const env = await workspaces.env(1);
		let out = "";
		await env.exec("cat README.md", { onOutput: (t) => (out += t) }, context);
		assert.equal(out.trim(), "app");
		assert.equal(spoond.leases.size, 1, "no second lease");
		assert.ok(spoond.calls.includes("POST /api/leases/lease1/keepalive"));
	});

	it("deletes the lease when the work is over", async () => {
		await workspaces.remove(1);
		assert.equal(spoond.leases.size, 0);
	});
});

describe("spoond driver when spoond is full", () => {
	function answering(statuses: number[]): { fetch: typeof fetch; calls: number } {
		const state: { fetch: typeof fetch; calls: number } = { calls: 0, fetch: (async () => {
			const status = statuses[state.calls++] ?? 200;
			return status === 200
				? Response.json({ sandboxes: [] })
				: new Response(status === 503 ? "capacity_wait" : "box_full", { status, headers: { "retry-after": "0" } });
		}) as typeof fetch };
		return state;
	}

	it("waits out capacity_wait and box_full", async () => {
		const spoond = answering([503, 429, 503]);
		await new SpoondDriver({ url: "http://spoond", token: "t", fetch: spoond.fetch }).remove("t-1");
		assert.equal(spoond.calls, 4);
	});

	it("gives up when spoond stays full past its patience", async () => {
		const spoond = answering([503, 503]);
		const driver = new SpoondDriver({ url: "http://spoond", token: "t", fetch: spoond.fetch, patience: 0 });
		await assert.rejects(driver.remove("t-1"), /503 capacity_wait/);
		assert.equal(spoond.calls, 1);
	});
});

/**
 * The same against a real spoond: `SCOUT_SPOOND_TESTS=1 SCOUT_SPOOND_URL=… SCOUT_SPOOND_TOKEN=… npm test`. The image
 * (SCOUT_SANDBOX_IMAGE, default dev-base) needs git; the code host here is a bundle-only local repo, so nothing leaves.
 */
const real = process.env.SCOUT_SPOOND_TESTS === "1";
describe("spoond driver against spoond", { skip: !real && "set SCOUT_SPOOND_TESTS=1 with SCOUT_SPOOND_URL and SCOUT_SPOOND_TOKEN" }, () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "scout-spoond-real-")));
	const remote = bareRepo(root, "app");
	const workspaces = new Workspaces({
		dataDir: join(root, "data"),
		instance: `test${process.pid}`,
		repos: [{ name: "app", gitUrl: remote, base: "main" }],
		driver: new SpoondDriver({ url: process.env.SCOUT_SPOOND_URL ?? "", token: process.env.SCOUT_SPOOND_TOKEN ?? "" }),
		sandbox: { image: process.env.SCOUT_SANDBOX_IMAGE ?? "dev-base", network: "none" },
		git: { name: "Scout", email: "scout@localhost" },
	});
	after(async () => {
		await workspaces.remove(1);
		await workspaces.close();
	});

	it("clones, works, and hands commits back from a microVM", async () => {
		const env = await workspaces.env(1);
		let out = "";
		await env.exec("git branch --show-current && echo hi > f && git add f && git commit -qm f && echo ok", { onOutput: (t) => (out += t) }, context);
		assert.match(out, /scout\/test\d+-1\nok/);
		const bundle = await workspaces.exportBranch(1);
		assert.ok(bundle !== undefined);
	});
});
