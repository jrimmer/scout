import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createCodeHostExtension } from "../src/codehost.ts";
import { Mirror } from "../src/sandbox.ts";
import { git, seedRepo, tempDir } from "./helpers.ts";

describe("open_pull_request won't push CI config", () => {
	const attempt = async (work: (commit: (files: Record<string, string>, message: string) => void, dir: string) => void) => {
		const root = tempDir("scout-ci-");
		const remote = seedRepo(root, "app").remote;
		const mirror = new Mirror(join(root, "mirror.git"), remote);
		const dir = join(root, "clone");
		await mirror.clone(dir, "scout/t-1", "main", { name: "Scout", email: "scout@localhost" });
		work((files, message) => {
			for (const [file, text] of Object.entries(files)) {
				mkdirSync(dirname(join(dir, file)), { recursive: true });
				writeFileSync(join(dir, file), text);
			}
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
		const said = await extension.tools![0]!.execute({ title: "Change", body: "Why." }, { conversationId: 1 } as never, context).then(
			(result) => (result.output![0] as { text: string }).text,
			(error: Error) => error.message,
		);
		return { said, pushed: git("--git-dir", remote, "for-each-ref", "--format=%(refname:short)", "refs/heads/scout/"), mirror, remote };
	};

	for (const path of [".github/workflows/ci.yml", ".forgejo/workflows/x.yaml", ".gitea/workflows/x.yml", ".gitlab-ci.yml", "sub/.github/workflows/y.yml", ".circleci/config.yml"]) {
		it(`refuses ${path}, and says a person has to`, async () => {
			const { said, pushed } = await attempt((commit) => commit({ [path]: "on: push\n" }, "ci"));
			assert.match(said, /touches CI config/);
			assert.ok(said.includes(path), said);
			assert.match(said, /A person has to make that change/);
			assert.equal(pushed, "");
		});
	}

	it("refuses a workflow added in one commit and removed in the next", async () => {
		const { said, pushed } = await attempt((commit, dir) => {
			commit({ ".github/workflows/steal.yml": "on: push\n" }, "add");
			git("-C", dir, "rm", "--quiet", ".github/workflows/steal.yml");
			git("-C", dir, "commit", "--quiet", "-m", "remove");
		});
		assert.match(said, /touches CI config/);
		assert.equal(pushed, "");
	});

	it("pushes ordinary changes, including other .github files, and pushes by commit", async () => {
		const { said, pushed } = await attempt((commit) => commit({ ".github/CODEOWNERS": "* @o\n", "src/a.ts": "x\n" }, "fine"));
		assert.match(said, /Pull request: /);
		assert.equal(pushed, "scout/t-1");
	});

	it("keeps its outgoing ref across a mirror refresh that prunes", async () => {
		const { mirror, remote } = await attempt((commit) => commit({ "src/a.ts": "x\n" }, "fine"));
		git("-C", mirror.path, "update-ref", "refs/scout/outgoing/keep", git("--git-dir", remote, "rev-parse", "main"));
		await mirror.refresh(0);
		assert.equal(git("-C", mirror.path, "rev-parse", "--verify", "refs/scout/outgoing/keep"), git("--git-dir", remote, "rev-parse", "main"));
	});
});
