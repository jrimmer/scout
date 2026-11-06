import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createCodeHostExtension, mergeBaseInto, type PullTarget } from "../src/codehost.ts";
import { Mirror } from "../src/sandbox.ts";
import { git, seedRepo, tempDir } from "./helpers.ts";

const IDENTITY = { name: "Scout", email: "scout@localhost" };
const BRANCH = "scout/reflect-2026-11-05";

/** A profile repository, its mirror, and a reflection's directory clone on its own branch. */
async function setup() {
	const root = tempDir("scout-profile-conflict-");
	const repo = seedRepo(root, "profile", "main", { "system.md": "line one\nline two\nline three\n", "notes.md": "notes\n" });
	const mirror = new Mirror(join(root, "mirror.git"), repo.remote);
	const dir = join(root, "clone");
	await mirror.clone(dir, BRANCH, "main", IDENTITY);
	const target: PullTarget = { source: { kind: "dir", dir }, branch: BRANCH, base: "main", slug: "acme/profile", mirror };
	const edit = (file: string, text: string) => writeFileSync(join(dir, file), text);
	/** Someone else changes `main` on the code host. */
	const elsewhere = (changes: Record<string, string>, message: string) => {
		repo.commit(changes, message);
		repo.push();
	};
	return { root, repo, mirror, dir, target, edit, elsewhere, text: (file: string) => readFileSync(join(dir, file), "utf8") };
}

describe("bringing the base into a reflection's pull request", () => {
	it("says there is nothing to do when the base hasn't moved", async () => {
		const t = await setup();
		assert.deepEqual(await mergeBaseInto(t.target), { state: "current", files: [] });
	});

	it("merges a base that moved in other files, and keeps the agent's unsaved edits", async () => {
		const t = await setup();
		t.edit("notes.md", "notes\nmy note\n");
		t.elsewhere({ "system.md": "line one\nline two\nline three\nline four\n" }, "someone adds a line");
		assert.deepEqual(await mergeBaseInto(t.target), { state: "merged", files: [] });
		assert.equal(t.text("system.md"), "line one\nline two\nline three\nline four\n");
		assert.equal(t.text("notes.md"), "notes\nmy note\n");
		assert.equal(git("-C", t.dir, "status", "--porcelain"), "", "committed, nothing left half done");
	});

	it("leaves the conflict in the files for the agent to resolve, and publishes only once it has", async () => {
		const t = await setup();
		t.edit("system.md", "line one\nmine two\nline three\n");
		t.elsewhere({ "system.md": "line one\ntheirs two\nline three\n" }, "someone rewrites line two");
		const merge = await mergeBaseInto(t.target);
		assert.deepEqual(merge, { state: "conflicts", files: ["system.md"] });
		assert.match(t.text("system.md"), /<<<<<<< [\s\S]*mine two[\s\S]*=======[\s\S]*theirs two[\s\S]*>>>>>>> /);

		const requests: string[] = [];
		const extension = createCodeHostExtension({
			name: "profile-codehost",
			selfEmail: IDENTITY.email,
			codeHost: { kind: "github", apiUrl: "https://api.example", token: "t" },
			commitAll: true,
			target: async () => t.target,
			fetch: async (url) => {
				requests.push(String(url));
				return new Response(JSON.stringify({ html_url: "https://example/pull/7", number: 7 }), { status: 201 });
			},
		});
		const open = () => extension.tools![0]!.execute({ title: "Update the profile", body: "What changed." } as never, { conversationId: 1 } as never, context);

		await assert.rejects(open(), /Conflict markers \(<<<<<<< and >>>>>>>\) are still in system\.md/);
		assert.equal(requests.length, 0, "nothing was published");

		t.edit("system.md", "line one\nmine and theirs two\nline three\n");
		await open();
		assert.equal(requests.length > 0, true);
		const outgoing = git("-C", t.mirror.path, "rev-list", "--parents", "-n", "1", `refs/scout/outgoing/${BRANCH}`).split(" ");
		assert.equal(outgoing.length, 3, "a merge commit: the agent's commit and the base's");
		assert.equal(git("-C", t.mirror.path, "show", `refs/scout/outgoing/${BRANCH}:system.md`), "line one\nmine and theirs two\nline three");
	});

	it("starts over from the current base when it moves again before the conflict is resolved", async () => {
		const t = await setup();
		t.edit("system.md", "line one\nmine two\nline three\n");
		t.elsewhere({ "system.md": "line one\ntheirs two\nline three\n" }, "first");
		assert.equal((await mergeBaseInto(t.target)).state, "conflicts");
		t.elsewhere({ "notes.md": "notes\nmore\n" }, "second, elsewhere");
		const again = await mergeBaseInto(t.target);
		assert.deepEqual(again, { state: "conflicts", files: ["system.md"] });
		assert.equal(t.text("notes.md"), "notes\nmore\n", "the newest base is in");
	});

	it("doesn't take a document that talks about conflict markers for one that has them", async () => {
		const t = await setup();
		const extension = createCodeHostExtension({
			name: "profile-codehost",
			selfEmail: IDENTITY.email,
			codeHost: { kind: "github", apiUrl: "https://api.example", token: "t" },
			commitAll: true,
			target: async () => t.target,
			fetch: async () => new Response(JSON.stringify({ html_url: "https://example/pull/8", number: 8 }), { status: 201 }),
		});
		t.edit("notes.md", "notes\n\nA conflict looks like:\n\n<<<<<<< HEAD\n");
		await extension.tools![0]!.execute({ title: "Document conflicts", body: "x" } as never, { conversationId: 1 } as never, context);
	});
});
