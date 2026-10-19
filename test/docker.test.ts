import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createCodeHostExtension } from "../src/codehost.ts";
import { Workspaces } from "../src/sandbox.ts";

/**
 * The real thing: a clone, a container, commands in it, and a push from the host. Needs Docker and the sandbox image:
 *
 *     docker build -t scout-sandbox:latest sandbox && SCOUT_DOCKER_TESTS=1 npm test
 */
const enabled = process.env.SCOUT_DOCKER_TESTS === "1";

describe("docker sandbox", { skip: !enabled && "set SCOUT_DOCKER_TESTS=1" }, () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "scout-docker-")));
	const remote = join(root, "remote.git");
	const seed = join(root, "seed");
	const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
	git("init", "--quiet", "--bare", "--initial-branch=main", remote);
	git("init", "--quiet", "--initial-branch=main", seed);
	writeFileSync(join(seed, "README.md"), "hello\n");
	git("-C", seed, "add", ".");
	git("-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "seed");
	git("-C", seed, "push", "--quiet", remote, "main");

	const dataDir = join(root, "data");
	const workspaces = new Workspaces({
		dataDir,
		instance: `t${process.pid}`,
		repo: { gitUrl: remote, base: "main" },
		sandbox: { image: process.env.SCOUT_SANDBOX_IMAGE ?? "scout-sandbox:latest", network: "none", memory: "1g" },
		git: { name: "Scout", email: "scout@localhost" },
	});

	after(() => {
		execFileSync("docker", ["rm", "-f", `scout-t${process.pid}-1`], { stdio: "ignore" });
	});

	it("runs commands in the thread's container, in its clone", async () => {
		const env = await workspaces.env(1);
		let out = "";
		const result = await env.exec(
			"git branch --show-current && cat README.md && id -u && echo $HOME",
			{ onOutput: (text) => (out += text) },
			context,
		);
		assert.ok(result.ok && result.value.exitCode === 0, out);
		const [branch, readme, uid, home] = out.trim().split("\n");
		assert.equal(branch, workspaces.branch(1));
		assert.equal(readme, "hello");
		assert.equal(uid, String(process.getuid?.()));
		assert.equal(home, workspaces.paths(1).home);
	});

	it("keeps host secrets and the network out", async () => {
		process.env.SCOUT_TEST_SECRET = "hunter2";
		const env = await workspaces.env(1);
		let out = "";
		await env.exec("env; curl -s -m 3 https://example.com || echo offline", { onOutput: (t) => (out += t) }, context);
		assert.doesNotMatch(out, /hunter2/);
		assert.match(out, /offline/);
	});

	it("stops runaway commands at their timeout", async () => {
		const env = await workspaces.env(1);
		const started = Date.now();
		const result = await env.exec("sleep 30", { timeout: 1 }, context);
		assert.equal(result.ok, false);
		assert.ok(Date.now() - started < 10_000);
		let ps = "";
		await env.exec(["ps", "-eo", "args"], { onOutput: (t) => (ps += t) }, context);
		await new Promise((resolve) => setTimeout(resolve, 6_000));
		ps = "";
		await env.exec(["ps", "-eo", "args"], { onOutput: (t) => (ps += t) }, context);
		assert.doesNotMatch(ps, /sleep 30/);
	});

	it("pushes from the host and opens a pull request", async () => {
		const env = await workspaces.env(1);
		await env.exec("echo change >> README.md && git commit -qam 'Change README'", undefined, context);
		// A hook the agent planted must never run on the host.
		writeFileSync(join(workspaces.paths(1).repo, ".git/hooks/pre-push"), "#!/bin/sh\ntouch /tmp/pwned\n", { mode: 0o755 });

		const requests: { url: string; body: unknown }[] = [];
		const extension = createCodeHostExtension({
			name: "codehost",
			codeHost: { kind: "forgejo", apiUrl: "http://forge/api/v1", token: "t" },
			target: async (id) => ({
				dir: workspaces.paths(id).repo,
				branch: workspaces.branch(id),
				base: "main",
				slug: "o/r",
				mirror: workspaces.mirror,
				link: "https://slack/thread",
			}),
			fetch: async (url, init) => {
				requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
				return new Response(JSON.stringify({ html_url: "http://forge/o/r/pulls/1" }), { status: 201 });
			},
		});
		const tool = extension.tools![0]!;
		const result = await tool.execute(
			{ title: "Change README", body: "Because." },
			{ conversationId: 1 } as never,
			context,
		);
		assert.match(JSON.stringify(result.output), /pulls\/1/);
		assert.equal(git("--git-dir", remote, "log", "-1", "--format=%s", workspaces.branch(1)), "Change README");
		assert.deepEqual(requests[0]?.body, {
			title: "Change README",
			body: "Because.\n\n---\nWorked out in the open: https://slack/thread",
			head: workspaces.branch(1),
			base: "main",
		});
		assert.throws(() => execFileSync("test", ["-e", "/tmp/pwned"]));
	});
});
