import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ConfinedEnv } from "../src/sandbox.ts";
import { tempDir } from "./helpers.ts";

function setup() {
	const data = tempDir("scout-sandbox-");
	const root = join(data, "threads", "t-1");
	const paths = { root, repo: join(root, "repo"), tmp: join(root, "tmp") };
	mkdirSync(paths.repo, { recursive: true });
	mkdirSync(paths.tmp, { recursive: true });
	writeFileSync(join(paths.repo, "README.md"), "hello");
	const secret = join(data, "secret.txt");
	writeFileSync(secret, "do not read");
	return { env: new ConfinedEnv({ id: "t", cwd: paths.repo, root: paths.root, tmp: paths.tmp, protectGit: true }), paths, secret };
}

describe("ConfinedEnv file confinement", () => {
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


describe("ConfinedEnv with protectGit", () => {
	it("keeps the agent out of .git, where the host's git would run its hooks", async () => {
		const { env } = setup();
		const result = await env.writeFile(".git/hooks/pre-commit", "#!/bin/sh", context);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.error.code, "permission_denied");
		assert.equal((await env.exec("echo hi", undefined, context)).ok, false, "and runs no commands");
	});
});
