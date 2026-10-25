import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createCodeHostExtension } from "../src/codehost.ts";
import { LocalDriver } from "../src/drivers/local.ts";
import { Workspaces } from "../src/workspaces.ts";
import { bareRepo, tempDir } from "./helpers.ts";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

async function run(env: Awaited<ReturnType<Workspaces["env"]>>, command: string): Promise<string> {
	let out = "";
	const result = await env.exec(command, { onOutput: (text) => (out += text) }, context);
	assert.ok(result.ok && result.value.exitCode === 0, `${command}: ${out}`);
	return out.trim();
}

describe("workspaces (local driver)", () => {
	const root = tempDir("scout-ws-");
	const api = bareRepo(root, "api");
	const web = bareRepo(root, "web", "develop");
	const workspaces = new Workspaces({
		dataDir: join(root, "data"),
		instance: "t",
		repos: [
			{ name: "api", gitUrl: api, base: "main" },
			{ name: "web", gitUrl: web, base: "develop", egress: ["registry.npmjs.org"], size: "large" },
		],
		driver: new LocalDriver({ root: join(root, "sandboxes") }),
		sandbox: { image: "unused", network: "none" },
		git: { name: "Scout", email: "scout@localhost" },
	});
	workspaces.repoOf = async (id) => (id === 2 ? "web" : undefined);
	// Conversation 5 is a pull request review's thread: it works on the reviewed branch.
	workspaces.baseOf = async (id) => (id === 5 ? "their-feature" : undefined);
	after(() => workspaces.close());

	it("clones each conversation's repository into its sandbox, on its own branch, with no credentials", async () => {
		const env = await workspaces.env(1);
		assert.equal(await run(env, "git branch --show-current"), "scout/t-1");
		assert.equal(await run(env, "cat README.md"), "api");
		assert.equal(await run(env, "git remote get-url origin"), api);
		const web2 = await workspaces.env(2);
		assert.equal(await run(web2, "git rev-parse --abbrev-ref HEAD"), "scout/t-2");
		assert.equal(await run(web2, "cat README.md"), "web");
		assert.equal(await run(web2, "git merge-base HEAD origin/develop"), await run(web2, "git rev-parse origin/develop"));
	});

	it("asks for the repository's egress list where the driver can enforce one", () => {
		assert.deepEqual(workspaces.spec(workspaces.repo("web"), 2).network, { mode: "allow", hosts: ["registry.npmjs.org"] });
		assert.deepEqual(workspaces.spec(workspaces.repo("api"), 1).network, { mode: "none" });
	});

	it("gives a repository that needs it bigger sandboxes", () => {
		assert.equal(workspaces.spec(workspaces.repo("web"), 2).size, "large");
		assert.equal(workspaces.spec(workspaces.repo("api"), 1).size, undefined, "the default otherwise");
	});

	it("hands commits out as a bundle, and the host pushes them from its mirror", async () => {
		const env = await workspaces.env(1);
		assert.equal(await workspaces.exportBranch(1), undefined, "nothing to hand out yet");
		assert.equal((await env.writeFile("feature.txt", "new\n", context)).ok, true);
		assert.equal(await workspaces.status(1), "?? feature.txt");
		await run(env, "git add feature.txt && git commit -qm 'Add feature'");
		assert.equal(await workspaces.status(1), "");

		const requests: unknown[] = [];
		const extension = createCodeHostExtension({
			name: "codehost",
			codeHost: { kind: "forgejo", apiUrl: "http://forge/api/v1", token: "t" },
			selfEmail: "scout@localhost",
			target: async (id) => ({
				source: {
					kind: "sandbox",
					status: () => workspaces.status(id),
					exportBranch: () => workspaces.exportBranch(id),
					importBranch: (bundle, branch) => workspaces.importBranch(id, bundle, branch),
				},
				branch: workspaces.branch(id),
				base: "main",
				slug: "o/api",
				mirror: workspaces.mirrorFor("api"),
			}),
			fetch: async (_url, init) => {
				requests.push(JSON.parse(String(init?.body)));
				return new Response(JSON.stringify({ html_url: "http://forge/o/api/pulls/1", number: 1 }), { status: 201 });
			},
		});
		const open = () => extension.tools![0]!.execute({ title: "Add feature", body: "Adds it." }, { conversationId: 1 } as never, context);
		const result = await open();
		assert.match(JSON.stringify(result.output), /pulls\/1 \(1 commit\)/);
		assert.equal(git("--git-dir", api, "show", "scout/t-1:feature.txt"), "new");
		assert.equal((requests[0] as { head: string }).head, "scout/t-1");

		// A teammate pushes a fix straight onto Scout's branch; Scout, not knowing, commits more and pushes again.
		const teammate = join(root, "teammate");
		git("clone", "--quiet", "--branch", "scout/t-1", api, teammate);
		writeFileSync(join(teammate, "fix.txt"), "ann's fix\n");
		git("-C", teammate, "add", ".");
		git("-C", teammate, "-c", "user.name=Ann", "-c", "user.email=ann@example.com", "commit", "--quiet", "-m", "Ann's fix");
		git("-C", teammate, "push", "--quiet", "origin", "scout/t-1");
		await run(env, "echo more >> feature.txt && git commit -qam 'More'");
		await assert.rejects(open(), /Someone else pushed to your branch scout\/t-1[\s\S]*- \w+ Ann: Ann's fix[\s\S]*git merge origin\/scout\/t-1/);
		assert.equal(git("--git-dir", api, "log", "-1", "--format=%s", "scout/t-1"), "Ann's fix", "nothing of theirs was erased");
		assert.equal(await run(env, "git log -1 --format=%s origin/scout/t-1"), "Ann's fix", "their commits are in the clone to build on");

		// Built on, it goes: both are there, theirs as they made it.
		await run(env, "git merge -q --no-edit origin/scout/t-1");
		await open();
		const annSha = git("-C", teammate, "rev-parse", "HEAD");
		assert.equal(execFileSync("git", ["--git-dir", api, "merge-base", "--is-ancestor", annSha, "scout/t-1"]).toString(), "");
		assert.equal(git("--git-dir", api, "show", "scout/t-1:feature.txt"), "new\nmore");

		// Scout may still rewrite its own commits (here the merge, amended): only someone else's are protected.
		await run(env, "git commit -q --amend -m 'Build on the fix'");
		await open();
		assert.equal(git("--git-dir", api, "log", "-1", "--format=%s", "scout/t-1"), "Build on the fix");
		assert.equal(execFileSync("git", ["--git-dir", api, "merge-base", "--is-ancestor", annSha, "scout/t-1"]).toString(), "", "Ann's commit is still in it");
	});

	it("works on a reviewed pull request's branch, and hands out only its own commits beyond it", async () => {
		const seed = join(root, "api-seed");
		git("-C", seed, "checkout", "--quiet", "-b", "their-feature");
		writeFileSync(join(seed, "theirs.txt"), "theirs\n");
		git("-C", seed, "add", ".");
		git("-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "Their change");
		git("-C", seed, "push", "--quiet", api, "their-feature");

		const env = await workspaces.env(5);
		assert.equal(await run(env, "git branch --show-current; cat theirs.txt"), "scout/t-5\ntheirs");
		await run(env, "echo fix > fix.txt && git add fix.txt && git commit -qm 'Fix what the review flagged'");
		const bundle = await workspaces.exportBranch(5);
		assert.ok(bundle !== undefined);
		const check = join(root, "bundle-check");
		git("clone", "--quiet", "--branch", "their-feature", api, check);
		git("-C", check, "fetch", "--quiet", bundle, "HEAD");
		assert.equal(git("-C", check, "rev-list", "--count", "their-feature..FETCH_HEAD"), "1", "just the fix, on top of their branch");
		rmSync(dirname(bundle), { recursive: true, force: true }); // the caller of exportBranch deletes the bundle's directory
	});

	it("saves attachments beside the repository, never in it", async () => {
		const first = await workspaces.saveAttachment(1, "../../etc/build log.txt", new TextEncoder().encode("log line"));
		const second = await workspaces.saveAttachment(1, "build log.txt", new TextEncoder().encode("again"));
		assert.match(first, /\/attachments\/build_log\.txt$/);
		assert.match(second, /\/attachments\/2-build_log\.txt$/);
		const env = await workspaces.env(1);
		assert.deepEqual(await env.readTextFile(first, context), { ok: true, value: "log line" });
		assert.equal(await workspaces.status(1), "", "the repository doesn't see them");
	});

	it("lets go of idle daemon connections, and reconnects on the next tool call", async () => {
		const env = await workspaces.env(1);
		await run(env, "true");
		assert.equal(await workspaces.disconnectIdle(Date.now(), 60_000), 0, "not yet idle");
		assert.ok((await workspaces.disconnectIdle(Date.now() + 61_000, 60_000)) >= 1);
		assert.equal(workspaces.connected, 0);
		assert.equal(await run(await workspaces.env(1), "git branch --show-current"), "scout/t-1", "the same sandbox, files intact");
	});

	it("parks a quiet thread's work on the host, and its next sandbox starts with it", async () => {
		const env = await workspaces.env(6);
		const first = await run(env, "pwd");
		await run(env, "echo done > done.txt && git add done.txt && git commit -qm 'Done part' && echo half >> README.md && echo new > new.txt && git rm -q --cached done.txt && rm done.txt && git commit -qm 'Drop it again' && echo back > done.txt");
		await workspaces.saveAttachment(6, "alert.json", new TextEncoder().encode("{}"));
		const status = await workspaces.status(6);
		assert.ok(workspaces.held().includes(6));
		assert.equal(await workspaces.park(6), true);
		assert.equal(existsSync(first), false, "the sandbox is gone");
		assert.ok(!workspaces.held().includes(6));
		assert.equal(await workspaces.park(6), false, "nothing left to park");

		const again = await workspaces.env(6);
		assert.equal(await run(again, "git branch --show-current"), "scout/t-6");
		assert.equal(await run(again, "git log -2 --format=%s"), "Drop it again\nDone part", "its commits");
		assert.equal(await workspaces.status(6), status, "its unfinished edits, still uncommitted");
		assert.equal(await run(again, "cat README.md new.txt done.txt"), "api\nhalf\nnew\nback");
		assert.equal(await run(again, "cat ../attachments/alert.json"), "{}", "its attachments");
		assert.ok(workspaces.held().includes(6));
		await workspaces.remove(6);
		assert.ok(!workspaces.held().includes(6));
	});

	it("removes a sandbox when the work is over", async () => {
		const env = await workspaces.env(3);
		const where = await run(env, "pwd");
		await workspaces.remove(3);
		assert.equal(existsSync(where), false);
	});
});
