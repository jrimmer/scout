import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import { SpoondDriver } from "../src/drivers/spoond.ts";
import { Workspaces } from "../src/workspaces.ts";
import { fakeSpoond } from "./fake-spoond.ts";
import { bareRepo } from "./helpers.ts";

const spec = { image: "dev-base", network: { mode: "none" as const }, labels: {} };

/**
 * Pi's own checks of an `ExecutionEnv`, against spoond's REST API. `start` opens the environment's sandbox and says
 * where cases may write; `listFiles` runs the listing cases, which need spoond's real .gitignore handling.
 */
function conformance(name: string, start: () => Promise<{ connect: (cwd: string) => ExecutionEnv; root: string; stop: () => Promise<void> }>, listFiles: boolean, skip?: string): void {
	describe(name, { ...(skip === undefined ? {} : { skip }) }, () => {
		let connect: (cwd: string) => ExecutionEnv;
		let root: string;
		let stop = async () => {};
		before(async () => {
			({ connect, root, stop } = await start());
		});
		after(() => stop());

		let n = 0;
		const cases = createEnvConformance({
			listFiles,
			assertions: {
				ok: (value, message) => assert.ok(value, message ?? "expected a truthy value"),
				strictEqual: (actual, expected) => assert.strictEqual(actual, expected),
				deepEqual: (actual, expected) => assert.deepStrictEqual(actual, expected),
				partialDeepEqual: (actual, expected) => assert.partialDeepStrictEqual(actual, expected),
				greaterThan: (actual, expected) => assert.ok(actual > expected),
				rejects: (operation, includes) => assert.rejects(operation, (e: Error) => e.message.includes(includes)),
			},
			withEnv: async (use) => {
				const cwd = join(root, `case-${n++}`);
				const env = connect(root);
				assert.ok((await env.createDir(cwd, { recursive: true }, context)).ok);
				await use(connect(cwd));
			},
		});
		for (const c of cases) {
			const skip = c.name.startsWith("watch") && "Scout doesn't use spoond's watch (#22)";
			it(c.name, { skip, timeout: c.timeoutMs ?? 30_000 }, () => c.run());
		}
	});
}

for (const modern of [true, false]) {
	conformance(`spoond REST environment conformance${modern ? "" : " (older spoond: no ranged reads or error codes)"}`, async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "scout-spoond-rest-")));
		const spoond = await fakeSpoond("sdt-test", { ranges: modern, codes: modern });
		const driver = new SpoondDriver({ url: spoond.url, token: "sdt-test", home: join(root, "guest"), transport: "rest" });
		const handle = await driver.open("conformance", spec);
		return { connect: (cwd) => handle.connect!({ id: "sandbox:conformance", cwd }), root, stop: () => spoond.close() };
	}, false);
}

/** The same against a real spoond, listing included: `SCOUT_SPOOND_TESTS=1 SCOUT_SPOOND_URL=… SCOUT_SPOOND_TOKEN=…`. */
conformance("spoond REST environment conformance against spoond", async () => {
	const driver = new SpoondDriver({ url: process.env.SCOUT_SPOOND_URL ?? "", token: process.env.SCOUT_SPOOND_TOKEN ?? "", transport: "rest" });
	const key = `conformance-${process.pid}`;
	const handle = await driver.open(key, { ...spec, labels: { purpose: "conformance" } });
	return { connect: (cwd) => handle.connect!({ id: `sandbox:${key}`, cwd }), root: "/root/conformance", stop: () => driver.remove(key) };
}, true, process.env.SCOUT_SPOOND_TESTS === "1" ? undefined : "set SCOUT_SPOOND_TESTS=1 with SCOUT_SPOOND_URL and SCOUT_SPOOND_TOKEN");

describe("spoond REST environment", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "scout-spoond-rest-")));
	let spoond: Awaited<ReturnType<typeof fakeSpoond>>;
	let env: ExecutionEnv;
	before(async () => {
		spoond = await fakeSpoond("sdt-test");
		const driver = new SpoondDriver({ url: spoond.url, token: "sdt-test", home: join(root, "guest"), transport: "rest" });
		env = (await driver.open("t", spec)).connect!({ id: "sandbox:t", cwd: root });
	});
	after(() => spoond.close());

	it("follows a command's output as it runs, and deletes the job after", async () => {
		const seen: string[] = [];
		const result = await env.exec("echo one; sleep 1.2; echo two", { onOutput: (t) => seen.push(t) }, context);
		assert.ok(result.ok && result.value.exitCode === 0);
		assert.deepEqual(seen, ["one\n", "two\n"]);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(spoond.jobs.size, 0, "the job is deleted once read");
	});

	it("stops waiting for a command spoond took but never started, and says to run it again", async () => {
		const quick = (await new SpoondDriver({ url: spoond.url, token: "sdt-test", home: join(root, "guest"), transport: "rest" }).open("t", spec)).connect!({ id: "sandbox:t", cwd: root, startCheckMs: 300 } as never);
		spoond.losing.next = true;
		const lost = await quick.exec("echo hi", {}, context);
		assert.ok(!lost.ok && /never started in the sandbox.*Run it again/.test(lost.error.message), String(!lost.ok && lost.error.message));
		const slow = await quick.exec("sleep 0.8; echo fine", {}, context);
		assert.ok(slow.ok && slow.value.exitCode === 0, "a command that started is left to run past the check");
	});

	it("says a command never started when spoond marks it so (spoond 3.12.1)", async () => {
		spoond.losing.next = true;
		spoond.losing.marked = true;
		const lost = await env.exec("echo hi", {}, context);
		spoond.losing.marked = false;
		assert.ok(!lost.ok && /never started in the sandbox.*Run it again/.test(lost.error.message), String(!lost.ok && lost.error.message));
	});

	it("gives up on a command when the sandbox stops answering under it, and leaves one that answers alone", async () => {
		const quick = (await new SpoondDriver({ url: spoond.url, token: "sdt-test", home: join(root, "guest"), transport: "rest" }).open("t", spec)).connect!({ id: "sandbox:t", cwd: root, startCheckMs: 100, aliveCheckMs: 100, unreachableMs: 600 } as never);
		const healthy = await quick.exec("sleep 1.5; echo fine", {}, context);
		assert.ok(healthy.ok && healthy.value.exitCode === 0, "a long command in a sandbox that answers runs to the end");

		const running = quick.exec("sleep 30", {}, context);
		await new Promise((resolve) => setTimeout(resolve, 1200));
		spoond.unreachable.on = true;
		const started = Date.now();
		const dead = await running;
		spoond.unreachable.on = false;
		assert.ok(!dead.ok && /stopped answering/.test(dead.error.message), String(!dead.ok && dead.error.message));
		assert.ok(Date.now() - started < 10_000, "it gives up soon after the sandbox goes quiet, not when the command would end");
	});

	it("reports output spoond dropped under a window as skipped", async () => {
		const window = { maxBytes: 10, maxLines: 2, minIntervalMs: 0, bytesPerSecond: 1e9 };
		let skipped: { bytes: number; newlines: number; endsWithNewline: boolean } | undefined;
		let after = "";
		// 2 MiB of lines with a sleep, so spoond drops the front (its cap is 1 MiB here) before the first read.
		const result = await env.exec(
			"head -c 2097152 /dev/zero | tr '\\0' 'x' | fold -w 99; sleep 0.3; echo end",
			{
				window,
				onOutput: (text, _c, info) => {
					if (info.skipped !== undefined) {
						skipped = info.skipped;
						after = "";
					}
					after += text;
				},
			},
			context,
		);
		assert.ok(result.ok && result.value.exitCode === 0);
		assert.ok(skipped !== undefined && skipped.bytes > 0 && skipped.newlines > 0, JSON.stringify(skipped));
		assert.equal(skipped.endsWithNewline, false, "the fake cuts mid-line here");
		assert.ok(after.endsWith("end\n"));
		const total = skipped.bytes + Buffer.byteLength(after);
		assert.equal(total, 2097152 + Math.floor(2097152 / 99) + 4, "skipped plus delivered is all of it");
	});

	it("takes spoond's error code at its word, with no command to ask the lease why", async () => {
		const before = spoond.calls.length;
		const read = await env.readTextFile(join(root, "missing.txt"), context);
		assert.ok(!read.ok && read.error.code === "not_found", JSON.stringify(read));
		assert.deepEqual(spoond.calls.slice(before).filter((c) => c.endsWith("/exec")), []);
	});

	it("reads on when spoond serves a range short", async () => {
		const short = await fakeSpoond("sdt-test", { maxRange: 3 });
		try {
			const driver = new SpoondDriver({ url: short.url, token: "sdt-test", home: join(root, "guest"), transport: "rest" });
			const shortEnv = (await driver.open("short", spec)).connect!({ id: "sandbox:short", cwd: root });
			const path = join(root, "letters.txt");
			assert.ok((await shortEnv.writeFile(path, "abcdefghij", context)).ok);
			const reader = await shortEnv.openBinaryReader(path, undefined, context);
			assert.ok(reader.ok);
			const read = await reader.value.read(2, 7, context);
			assert.ok(read.ok);
			assert.equal(Buffer.from(read.value).toString(), "cdefghi");
			await reader.value.close(context);
		} finally {
			await short.close();
		}
	});

	it("lists a tree within Pi's bounds: an exact fit isn't truncated, a limit of 0 lists nothing", async () => {
		const dir = join(root, "tree");
		for (const file of ["b.txt", "a/z.txt", "a/b/c.txt", ".hidden/x"]) assert.ok((await env.writeFile(join(dir, file), "", context)).ok);
		const listed = await env.listFiles!(dir, undefined, context);
		assert.ok(listed.ok);
		assert.deepEqual(listed.value.entries.map((e) => `${e.kind[0]} ${e.path}`), ["d .hidden", "f .hidden/x", "d a", "d a/b", "f a/b/c.txt", "f a/z.txt", "f b.txt"]);
		const exact = await env.listFiles!(dir, { maxEntries: 7 }, context);
		assert.ok(exact.ok && !exact.value.truncated && exact.value.entries.length === 7);
		const none = await env.listFiles!(dir, { maxEntries: 0 }, context);
		assert.ok(none.ok && none.value.truncated && none.value.entries.length === 0);
		// Pi counts each entry's path plus two bytes: ".hidden" (9) and ".hidden/x" (11) fit in 20, "a" doesn't.
		const bytes = await env.listFiles!(dir, { maxBytes: 20 }, context);
		assert.ok(bytes.ok && bytes.value.truncated);
		assert.deepEqual(bytes.value.entries.map((e) => e.path), [".hidden", ".hidden/x"]);
		const missing = await env.listFiles!(join(dir, "nope"), undefined, context);
		assert.ok(!missing.ok && missing.error.code === "not_found");
		const file = await env.listFiles!(join(dir, "b.txt"), undefined, context);
		assert.ok(!file.ok && file.error.code === "not_directory");
		const bad = await env.listFiles!(dir, { timeoutMs: 1.5 }, context);
		assert.ok(!bad.ok && bad.error.code === "invalid");
	});

	it("keeps a script's mode when it's rewritten", async () => {
		assert.ok((await env.writeFile("run.sh", "#!/bin/sh\necho one\n", context)).ok);
		assert.ok((await env.exec(["chmod", "755", "run.sh"], undefined, context)).ok);
		assert.ok((await env.writeFile("run.sh", "#!/bin/sh\necho two\n", context)).ok);
		let out = "";
		const result = await env.exec(["./run.sh"], { onOutput: (t) => (out += t) }, context);
		assert.ok(result.ok && result.value.exitCode === 0);
		assert.equal(out, "two\n");
	});
});

describe("workspaces over spoond's REST API", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "scout-spoond-rest-ws-")));
	const remote = bareRepo(root, "app");
	let spoond: Awaited<ReturnType<typeof fakeSpoond>>;
	let workspaces: Workspaces;
	before(async () => {
		spoond = await fakeSpoond("sdt-test");
		workspaces = new Workspaces({
			dataDir: join(root, "data"),
			instance: "t",
			repos: [{ name: "app", gitUrl: remote, base: "main" }],
			driver: new SpoondDriver({ url: spoond.url, token: "sdt-test", home: join(root, "guest"), transport: "rest" }),
			sandbox: { image: "dev-base", network: "none" },
			git: { name: "Scout", email: "scout@localhost" },
		});
	});
	after(async () => {
		await workspaces.close();
		await spoond.close();
	});

	it("clones, works and hands commits back with no connection held", async () => {
		const env = await workspaces.env(1);
		let out = "";
		const result = await env.exec("git branch --show-current && echo hi > f && git add f && git commit -qm f && echo ok", { onOutput: (t) => (out += t) }, context);
		assert.ok(result.ok && result.value.exitCode === 0, out);
		assert.equal(out, "scout/t-1\nok\n");
		assert.equal(workspaces.connected, 0);
		assert.ok(!spoond.calls.some((c) => c.startsWith("STREAM")), "no stream");
		assert.ok(!spoond.calls.some((c) => c.includes("/.scout/pi-env-")), "no daemon uploaded");
		const bundle = await workspaces.exportBranch(1);
		assert.ok(bundle !== undefined);
		assert.equal(await workspaces.status(1), "");
	});
});
