import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createCodeHostExtension, createOrFindPull } from "../src/codehost.ts";
import { Mirror } from "../src/sandbox.ts";
import { bareRepo, seedRepo, tempDir } from "./helpers.ts";

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
		const root = tempDir("scout-push-");
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

	describe("won't push a credential anywhere in what it pushes", () => {
		const token = `ghp_${"A".repeat(36)}`;
		/** A clone with Scout's branch, the commits `work` makes in it, and what open_pull_request then says. */
		const attempt = async (work: (commit: (files: Record<string, string>, message: string) => void, dir: string) => void, pull = { title: "Change", body: "Why." }) => {
			const root = tempDir("scout-scan-");
			// Already on the code host, so already public: not this push's to refuse.
			const remote = seedRepo(root, "app", "main", { "README.md": "app\n", "fixture.txt": `example=${token}\n` }).remote;
			const mirror = new Mirror(join(root, "mirror.git"), remote);
			const dir = join(root, "clone");
			await mirror.clone(dir, "scout/t-1", "main", { name: "Scout", email: "scout@localhost" });
			work((files, message) => {
				for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
				git("-C", dir, "add", "--all");
				git("-C", dir, "commit", "--quiet", "--allow-empty", "-m", message);
			}, dir);
			const extension = createCodeHostExtension({
				name: "app",
				codeHost: { kind: "forgejo", apiUrl: "http://forge/api/v1", token: "t" },
				selfEmail: "scout@localhost",
				target: async () => ({ source: { kind: "dir", dir }, branch: "scout/t-1", base: "main", slug: "o/app", mirror }),
				fetch: async () => Response.json({ html_url: "http://forge/o/app/pulls/2", number: 2 }, { status: 201 }),
			});
			const said = await extension.tools![0]!.execute(pull, { conversationId: 1 } as never, context).then(
				(result) => (result.output![0] as { text: string }).text,
				(error: Error) => error.message,
			);
			const pushed = git("--git-dir", remote, "for-each-ref", "--format=%(refname:short)", "refs/heads/scout/");
			return { said, pushed };
		};

		it("past what the self-review reads of a big diff", async () => {
			const { said, pushed } = await attempt((commit) => commit({ "a-big.txt": `${"x".repeat(70_000)}\n`, "z.txt": `token=${token}\n` }, "big"));
			assert.match(said, /GitHub token in z\.txt \(commit [0-9a-f]{7}\)/);
			assert.doesNotMatch(said, /AAAAAAAA/, "never the value");
			assert.equal(pushed, "", "nothing pushed");
		});

		it("in a commit a later one undoes", async () => {
			const { said, pushed } = await attempt((commit) => {
				commit({ "k.txt": `${token}\n` }, "add");
				commit({ "k.txt": "nothing\n" }, "remove");
			});
			assert.match(said, /GitHub token in k\.txt \(commit [0-9a-f]{7}\)[\s\S]*a later commit that removes it isn't enough/);
			assert.equal(pushed, "");
		});

		it("in a commit's message", async () => {
			const { said, pushed } = await attempt((commit) => commit({ "m.txt": "m\n" }, `msg\n\nused ${token}`));
			assert.match(said, /GitHub token in the message of commit [0-9a-f]{7}/);
			assert.equal(pushed, "");
		});

		it("in a file git calls binary", async () => {
			const { said, pushed } = await attempt((commit) => commit({ "b.dat": `\0\x01\x02${token}\0\n` }, "bin"));
			assert.match(said, /GitHub token in b\.dat/);
			assert.equal(pushed, "");
		});

		it("at the end of a line of megabytes", async () => {
			const { said, pushed } = await attempt((commit) => commit({ "min.js": `var a="${"x".repeat(3_000_000)}",t="${token}";\n` }, "minified"));
			assert.match(said, /GitHub token in min\.js/);
			assert.equal(pushed, "");
		});

		it("in what a merge adds itself", async () => {
			const { said, pushed } = await attempt((commit, dir) => {
				git("-C", dir, "checkout", "--quiet", "-b", "side");
				commit({ "side.txt": "side\n" }, "side");
				git("-C", dir, "checkout", "--quiet", "scout/t-1");
				commit({ "own.txt": "own\n" }, "own");
				git("-C", dir, "merge", "--quiet", "--no-ff", "--no-commit", "side");
				commit({ "evil.txt": `${token}\n` }, "Merge side");
			});
			assert.match(said, /GitHub token in evil\.txt \(commit [0-9a-f]{7}\)/);
			assert.doesNotMatch(said, /side\.txt|own\.txt/);
			assert.equal(pushed, "");
		});

		it("in base64", async () => {
			const { said, pushed } = await attempt((commit) => commit({ "e.txt": `blob: ${Buffer.from(token).toString("base64")}\n` }, "enc"));
			assert.match(said, /GitHub token \(base64\) in e\.txt/);
			assert.equal(pushed, "");
		});

		it("in the pull request's description", async () => {
			const { said, pushed } = await attempt((commit) => commit({ "f.txt": "fine\n" }, "fine"), { title: "Change", body: `Set ${token} first.` });
			assert.match(said, /GitHub token in the pull request's title or description/);
			assert.equal(pushed, "");
		});

		it("and pushes a change without one, whatever the code host already has", async () => {
			const { said, pushed } = await attempt((commit) => commit({ "README.md": "app, with commit 0123456789abcdef0123456789abcdef01234567\n" }, "Mention a commit"));
			assert.match(said, /Pull request: http:\/\/forge\/o\/app\/pulls\/2/);
			assert.equal(pushed, "scout/t-1");
		});
	});
});
