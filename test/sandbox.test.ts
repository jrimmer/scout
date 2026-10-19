import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { SandboxEnv, threadPaths } from "../src/sandbox.ts";

function setup() {
	const data = realpathSync(mkdtempSync(join(tmpdir(), "scout-sandbox-")));
	const paths = threadPaths(data, "test", 1);
	mkdirSync(paths.repo, { recursive: true });
	mkdirSync(paths.tmp, { recursive: true });
	writeFileSync(join(paths.repo, "README.md"), "hello");
	const secret = join(data, "secret.txt");
	writeFileSync(secret, "do not read");
	return { env: new SandboxEnv("scout-test-1", paths), paths, secret };
}

describe("SandboxEnv file confinement", () => {
	it("reads and writes inside the thread", async () => {
		const { env } = setup();
		assert.deepEqual(await env.readTextFile("README.md", context), { ok: true, value: "hello" });
		assert.equal((await env.writeFile("src/new/file.ts", "x", context)).ok, true);
		assert.deepEqual(await env.readTextFile("src/new/file.ts", context), { ok: true, value: "x" });
	});

	it("refuses paths outside the thread", async () => {
		const { env, secret } = setup();
		for (const path of [secret, "../../secret.txt", "/etc/hostname"]) {
			const result = await env.readTextFile(path, context);
			assert.equal(result.ok, false, path);
			if (!result.ok) assert.equal(result.error.code, "permission_denied", path);
		}
		assert.equal((await env.writeFile("../../escaped.txt", "x", context)).ok, false);
		assert.equal((await env.exists(secret, context)).ok, false);
	});

	it("refuses symlinks that lead out", async () => {
		const { env, paths, secret } = setup();
		symlinkSync(secret, join(paths.repo, "link.txt"));
		symlinkSync(join(secret, ".."), join(paths.repo, "dir-link"));
		assert.equal((await env.readTextFile("link.txt", context)).ok, false);
		assert.equal((await env.writeFile("link.txt", "x", context)).ok, false);
		assert.equal((await env.writeFile("dir-link/new.txt", "x", context)).ok, false);
	});

	it("keeps temp files inside the thread", async () => {
		const { env, paths } = setup();
		const dir = await env.createTempFile({ prefix: "out-" }, context);
		assert.ok(dir.ok && dir.value.startsWith(paths.tmp));
	});
});
