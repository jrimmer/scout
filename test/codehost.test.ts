import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createCodeHostExtension, createOrFindPull } from "../src/codehost.ts";
import { Mirror } from "../src/sandbox.ts";
import { bareRepo } from "./helpers.ts";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

describe("code host", () => {
	it("brings an open pull request's title and description up to date when its branch moves on", async () => {
		const calls: { method: string; url: string; body?: unknown }[] = [];
		const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			calls.push({ method, url: String(url), ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) });
			if (method === "POST") return new Response("pull request already exists", { status: 409 });
			if (method === "GET") return Response.json([{ html_url: "https://forge/team/app/pulls/7", number: 7, head: { ref: "scout/t-1" } }]);
			return Response.json({});
		}) as typeof globalThis.fetch;

		const pull = { title: "Fix it, and the docs", body: "Now with docs.", head: "scout/t-1", base: "main" };
		const created = await createOrFindPull({ kind: "forgejo", apiUrl: "https://forge/api/v1", token: "t" }, "team/app", fetch, pull);
		assert.deepEqual(created, { url: "https://forge/team/app/pulls/7", number: 7 });
		assert.deepEqual(calls.at(-1), { method: "PATCH", url: "https://forge/api/v1/repos/team/app/pulls/7", body: { title: pull.title, body: pull.body } });
	});

	it("never pushes over someone else's commits on its branch: a clone on the host gets them merged in, or is told they conflict", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "scout-push-")));
		const remote = bareRepo(root, "profile");
		const mirror = new Mirror(join(root, "mirror.git"), remote);
		const dir = join(root, "reflection");
		await mirror.clone(dir, "scout/reflect-1", "main", { name: "Scout", email: "scout@localhost" });
		const extension = createCodeHostExtension({
			name: "profile",
			codeHost: { kind: "forgejo", apiUrl: "http://forge/api/v1", token: "t" },
			selfEmail: "scout@localhost",
			commitAll: true,
			target: async () => ({ source: { kind: "dir", dir }, branch: "scout/reflect-1", base: "main", slug: "o/profile", mirror }),
			fetch: async () => Response.json({ html_url: "http://forge/o/profile/pulls/2", number: 2 }, { status: 201 }),
		});
		const open = () => extension.tools![0]!.execute({ title: "Lessons", body: "From yesterday." }, { conversationId: 1 } as never, context);
		const teammate = (file: string, text: string) => {
			const clone = join(root, `teammate-${file}`);
			git("clone", "--quiet", "--branch", "scout/reflect-1", remote, clone);
			writeFileSync(join(clone, file), text);
			git("-C", clone, "add", ".");
			git("-C", clone, "-c", "user.name=Ann", "-c", "user.email=ann@example.com", "commit", "--quiet", "-m", `Ann edits ${file}`);
			git("-C", clone, "push", "--quiet", "origin", "scout/reflect-1");
		};

		writeFileSync(join(dir, "system.md"), "lesson one\n");
		await open();
		teammate("skills.md", "ann's skill\n");
		writeFileSync(join(dir, "system.md"), "lesson one\nlesson two\n");
		await assert.rejects(open(), /Ann edits skills\.md[\s\S]*I merged their commits into your files/);
		assert.equal(git("--git-dir", remote, "log", "-1", "--format=%s", "scout/reflect-1"), "Ann edits skills.md", "nothing erased");
		await open();
		assert.equal(git("--git-dir", remote, "show", "scout/reflect-1:skills.md"), "ann's skill");
		assert.equal(git("--git-dir", remote, "show", "scout/reflect-1:system.md"), "lesson one\nlesson two");

		teammate("system.md", "ann rewrote it\n");
		writeFileSync(join(dir, "system.md"), "lesson one\nlesson two\nlesson three\n");
		await assert.rejects(open(), /Their changes conflict with yours, and I can't merge them here/);
		assert.equal(git("--git-dir", remote, "show", "scout/reflect-1:system.md"), "ann rewrote it", "still theirs on the code host");
		assert.equal(git("-C", dir, "status", "--porcelain"), "", "and no half-done merge left behind");
	});
});
