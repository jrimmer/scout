import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createCodeHostExtension } from "../src/codehost.ts";
import { LocalDriver } from "../src/drivers/local.ts";
import { Workspaces } from "../src/workspaces.ts";
import { bareRepo } from "./helpers.ts";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

async function run(env: Awaited<ReturnType<Workspaces["env"]>>, command: string): Promise<string> {
	let out = "";
	const result = await env.exec(command, { onOutput: (text) => (out += text) }, context);
	assert.ok(result.ok && result.value.exitCode === 0, `${command}: ${out}`);
	return out.trim();
}

describe("workspaces (local driver)", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "scout-ws-")));
	const api = bareRepo(root, "api");
	const web = bareRepo(root, "web", "develop");
	const workspaces = new Workspaces({
		dataDir: join(root, "data"),
		instance: "t",
		repos: [
			{ name: "api", gitUrl: api, base: "main" },
			{ name: "web", gitUrl: web, base: "develop", egress: ["registry.npmjs.org"] },
		],
		driver: new LocalDriver({ root: join(root, "sandboxes") }),
		sandbox: { image: "unused", network: "none" },
		git: { name: "Scout", email: "scout@localhost" },
	});
	workspaces.repoOf = async (id) => (id === 2 ? "web" : undefined);
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
			target: async (id) => ({
				source: { kind: "sandbox", status: () => workspaces.status(id), exportBranch: () => workspaces.exportBranch(id) },
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
		const result = await extension.tools![0]!.execute({ title: "Add feature", body: "Adds it." }, { conversationId: 1 } as never, context);
		assert.match(JSON.stringify(result.output), /pulls\/1 \(1 commit\)/);
		assert.equal(git("--git-dir", api, "show", "scout/t-1:feature.txt"), "new");
		assert.equal((requests[0] as { head: string }).head, "scout/t-1");
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

	it("removes a sandbox when the work is over", async () => {
		const env = await workspaces.env(3);
		const where = await run(env, "pwd");
		await workspaces.remove(3);
		assert.equal(existsSync(where), false);
	});
});
