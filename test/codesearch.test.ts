import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { codeSearchExtension, readCode, searchCode } from "../src/codesearch.ts";
import { Mirror } from "../src/sandbox.ts";
import { bareRepo, tempDir } from "./helpers.ts";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" });

describe("code search across repositories", async () => {
	const root = tempDir("scout-codesearch-");
	const commit = (name: string, files: Record<string, string>, branch = "main") => {
		const seed = join(root, `${name}-seed`);
		for (const [path, text] of Object.entries(files)) {
			mkdirSync(join(seed, path, ".."), { recursive: true });
			writeFileSync(join(seed, path), text);
		}
		git("-C", seed, "add", ".");
		git("-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "files");
		git("-C", seed, "push", "--quiet", join(root, `${name}.git`), branch);
	};
	const api = bareRepo(root, "api");
	const web = bareRepo(root, "web", "develop");
	commit("api", { "src/users.ts": "export function fetchUser(id) {\n  return db.get(id);\n}\n", "docs/notes.md": "fetchUser is cached\n" });
	commit("web", { "app/profile.tsx": "import { fetchUser } from 'api';\nconst user = fetchUser(1);\n" }, "develop");
	const repos = [
		{ name: "api", base: "main", mirror: new Mirror(join(root, "mirrors", "api.git"), api) },
		{ name: "web", base: "develop", mirror: new Mirror(join(root, "mirrors", "web.git"), web) },
	];
	await Promise.all(repos.map((r) => r.mirror.refresh()));

	it("finds text in every repository's base branch, and narrows by path", async () => {
		const { matches, truncated } = await searchCode(repos, { pattern: "fetchUser(" });
		assert.equal(truncated, false);
		assert.deepEqual(
			matches.map((m) => `${m.repo}:${m.path}:${m.line}`),
			["api:src/users.ts:1", "web:app/profile.tsx:2"],
		);
		assert.deepEqual((await searchCode(repos, { pattern: "fetch\\w+", regex: true, path: "docs/**" })).matches.map((m) => m.path), ["docs/notes.md"]);
		assert.deepEqual((await searchCode(repos, { pattern: "nothing like this" })).matches, []);
	});

	it("reads a file with line numbers, a range of it, and says when it isn't there", async () => {
		const { text, lines } = await readCode(repos[0]!, "src/users.ts", 2, 3);
		assert.equal(lines, 3);
		assert.equal(text, "2\t  return db.get(id);\n3\t}\n");
		await assert.rejects(readCode(repos[1]!, "src/users.ts"), /There's no src\/users\.ts on web's develop branch/);
	});

	it("offers the tools over the configured repositories only", async () => {
		const extension = codeSearchExtension(() => repos);
		const [search, read] = extension.tools!;
		const found = await search!.execute({ pattern: "fetchUser", repo: "web" } as never, {} as never, context);
		assert.match(JSON.stringify(found.output), /web:app\/profile\.tsx:1: import \{ fetchUser \}/);
		await assert.rejects(search!.execute({ pattern: "x", repo: "billing" } as never, {} as never, context), /don't work in a repository called billing\. These I do: api, web/);
		const file = await read!.execute({ repo: "api", path: "docs/notes.md" } as never, {} as never, context);
		assert.match(JSON.stringify(file.output), /api:docs\/notes\.md \(1 lines\)\\n1\\tfetchUser is cached/);
	});
});
