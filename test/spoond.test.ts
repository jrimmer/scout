import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { SpoondDriver } from "../src/drivers/spoond.ts";
import { Workspaces } from "../src/workspaces.ts";
import { fakeSpoond } from "./fake-spoond.ts";
import { bareRepo, tempDir } from "./helpers.ts";

describe("spoond driver", () => {
	const root = tempDir("scout-spoond-");
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
			idle_suspend: 900,
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

	it("starts a repository's threads from its snapshot, when it names one", async () => {
		const warm = new Workspaces({
			dataDir: join(root, "data-warm"),
			instance: "w",
			repos: [{ name: "app", gitUrl: remote, base: "main", snapshot: "scout/node24" }],
			driver: new SpoondDriver({ url: spoond.url, token: "sdt-test", home: join(root, "guest-warm") }),
			sandbox: { image: "dev-base", network: "none" },
			git: { name: "Scout", email: "scout@localhost" },
		});
		try {
			await warm.env(7);
			const lease = [...spoond.leases.values()].find((l) => l.holder === "scout:w-7");
			assert.equal(lease?.body.snapshot, "scout/node24");
			assert.equal(lease?.body.image, undefined, "a snapshot carries its own image");
			await warm.remove(7);
		} finally {
			await warm.close();
		}
	});

	it("names a lease for its thread, so people can tell leases apart, and still finds older ones", async () => {
		const about = `#app-dev: ${"fix the flaky login test, it fails about one run in five ".repeat(4)}`;
		workspaces.describe = async (id) => (id === 3 ? { about, link: "https://example.slack.com/archives/C1/p100" } : {});
		try {
			await workspaces.env(3);
			const lease = [...spoond.leases.values()].find((l) => l.holder.startsWith("scout:t-3 "));
			assert.ok(lease !== undefined, "a lease named for its thread");
			assert.ok(lease.holder.startsWith("scout:t-3 #app-dev: fix the flaky login test"), lease.holder);
			assert.equal([...lease.holder].length, 128, "cut to spoond's limit");
			assert.ok(lease.holder.endsWith("…"));
			assert.equal(lease.holder_url, "https://example.slack.com/archives/C1/p100");

			// Thread 1's lease came from before it could be described: it's found, and labelled, when next opened.
			workspaces.describe = async (id) => (id === 1 ? { about: "#app-dev: bump the README" } : {});
			await workspaces.suspend(1);
			await workspaces.close();
			workspaces = new Workspaces({
				dataDir: join(root, "data"),
				instance: "t",
				repos: [{ name: "app", gitUrl: remote, base: "main" }],
				driver: new SpoondDriver({ url: spoond.url, token: "sdt-test", home: join(root, "guest") }),
				sandbox: { image: "dev-base", network: "none" },
				git: { name: "Scout", email: "scout@localhost" },
			});
			workspaces.describe = async (id) => (id === 1 ? { about: "#app-dev: bump the README" } : {});
			const leases = spoond.leases.size;
			await workspaces.env(1);
			assert.equal(spoond.leases.size, leases, "no second lease for thread 1");
			assert.equal(spoond.leases.get("lease1")?.holder, "scout:t-1 #app-dev: bump the README");
			await workspaces.remove(3);
		} finally {
			workspaces.describe = async () => ({});
		}
	});

	it("deletes the lease when the work is over", async () => {
		await workspaces.remove(1);
		assert.equal(spoond.leases.size, 0);
	});
});

describe("repository images", () => {
	const root = tempDir("scout-images-");
	const remote = bareRepo(root, "app");
	const seed = join(root, "app-seed");
	const commit = (message: string) => {
		execFileSync("git", ["-C", seed, "add", "."]);
		execFileSync("git", ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", message]);
		execFileSync("git", ["-C", seed, "push", "--quiet", remote, "main"]);
	};
	let spoond: Awaited<ReturnType<typeof fakeSpoond>>;
	let workspaces: Workspaces;

	before(async () => {
		spoond = await fakeSpoond("sdt-test");
		process.env.SCOUT_SPOOND_TOKEN = "sdt-test";
		workspaces = new Workspaces({
			dataDir: join(root, "data"),
			instance: "t",
			repos: [{ name: "app", gitUrl: remote, base: "main" }],
			// The fake keeps one guest home for every lease, which stands in for a sandbox starting from a snapshot.
			driver: new SpoondDriver({ url: spoond.url, token: "sdt-test", home: join(root, "guest") }),
			sandbox: { image: "dev-base", network: "none" },
			git: { name: "Scout", email: "scout@localhost" },
		});
	});
	after(async () => {
		await workspaces.close();
		await spoond.close();
	});

	it("has none until the repository has a setup script", async () => {
		assert.equal(await workspaces.setupScript("app"), undefined);
	});

	it("builds an image from the setup script, and new threads start from it with their checkout already built", async () => {
		mkdirSync(join(seed, ".scout"), { recursive: true });
		writeFileSync(join(seed, ".scout", "setup.sh"), "mkdir -p _build && echo built > _build/out && echo changed >> README.md\n");
		writeFileSync(join(seed, ".gitignore"), "_build/\n");
		commit("add a setup script");
		const setup = await workspaces.setupScript("app");
		assert.ok(setup !== undefined && /^[0-9a-f]{40}$/.test(setup.script));

		const saved = await workspaces.buildImage("app", "build-1");
		assert.deepEqual(saved, { name: "scout/app", version: 1 });
		assert.equal(spoond.leases.size, 0, "the build's sandbox is gone once saved");
		const build = [...spoond.calls].filter((c) => c === "POST /api/leases").length;
		assert.equal(build, 1);
		assert.deepEqual(await workspaces.buildImage("app", "build-1"), saved, "the same build saved twice is one version");

		// The base moves on after the image was built; a thread still starts at the latest base.
		writeFileSync(join(seed, "NEWS.md"), "news\n");
		commit("news");
		workspaces.builtImage = (repo) => (repo === "app" ? "scout/app" : undefined);
		const env = await workspaces.env(5);
		let out = "";
		const result = await env.exec("git branch --show-current; cat _build/out; cat NEWS.md; git status --porcelain; ls ../.scout", { onOutput: (t) => (out += t) }, context);
		assert.ok(result.ok, out);
		assert.deepEqual(out.trim().split("\n"), ["scout/t-5", "built", "news"], "on its own branch at the latest base, the build kept, the setup's edit undone, the mark gone");
		const lease = [...spoond.leases.values()].find((l) => l.holder.startsWith("scout:t-5"));
		assert.equal(lease?.body.snapshot, "scout/app");
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

	it("retries a busy lease, but takes any other 409 as the answer", async () => {
		let calls = 0;
		const answers = [
			() => Response.json({ code: "lease_busy" }, { status: 409 }),
			() => new Response("", { status: 409, headers: { "retry-after": "0" } }),
			() => Response.json({ error: "a directory is in the way" }, { status: 409 }),
		];
		const fetch = (async () => answers[calls++]!()) as typeof globalThis.fetch;
		await assert.rejects(new SpoondDriver({ url: "http://spoond", token: "t", fetch }).remove("t-1"), /409 .*directory is in the way/);
		assert.equal(calls, 3);
	});

	it("gives up when spoond stays full past its patience", async () => {
		const spoond = answering([503, 503]);
		const driver = new SpoondDriver({ url: "http://spoond", token: "t", fetch: spoond.fetch, patience: 0 });
		await assert.rejects(driver.remove("t-1"), /The sandbox host stayed full for 0 minutes, so I couldn't get a workspace\. Try again in a while/);
		assert.equal(spoond.calls, 1);
	});

	it("says when a new sandbox starts and stops waiting for room, so its thread can tell people", async () => {
		let calls = 0;
		const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			calls++;
			if (String(url).endsWith("/api/leases") && (init?.method ?? "GET") === "GET") return Response.json({ sandboxes: [] });
			if (calls === 2) return new Response("full", { status: 503, headers: { "retry-after": "0" } });
			if (String(url).endsWith("/api/leases")) return Response.json({ id: "lease1", holder: "scout:t-9" }, { status: 201 });
			return Response.json({ stdout: "x86_64\n" });
		}) as typeof globalThis.fetch;
		const waits: string[] = [];
		const driver = new SpoondDriver({ url: "http://spoond", token: "t", fetch, transport: "rest", onWait: (key, waiting) => void waits.push(`${key} ${waiting}`) });
		await driver.open("t-9", { image: "dev-base", network: { mode: "none" }, labels: {} });
		assert.deepEqual(waits, ["t-9 true", "t-9 false"]);
	});
});

/**
 * The same against a real spoond: `SCOUT_SPOOND_TESTS=1 SCOUT_SPOOND_URL=… SCOUT_SPOOND_TOKEN=… npm test`. The image
 * (SCOUT_SANDBOX_IMAGE, default dev-base) needs git; the code host here is a bundle-only local repo, so nothing leaves.
 */
const real = process.env.SCOUT_SPOOND_TESTS === "1";
describe("spoond driver against spoond", { skip: !real && "set SCOUT_SPOOND_TESTS=1 with SCOUT_SPOOND_URL and SCOUT_SPOOND_TOKEN" }, () => {
	const root = tempDir("scout-spoond-real-");
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
		rmSync(dirname(bundle), { recursive: true, force: true });
	});
});
