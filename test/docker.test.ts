import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { DockerDriver } from "../src/drivers/docker.ts";
import { Workspaces } from "../src/workspaces.ts";
import { bareRepo } from "./helpers.ts";

/**
 * The Docker driver for real: isolation the local driver can't show. Needs Docker and the sandbox image:
 *
 *     docker build -t scout-sandbox:latest sandbox && SCOUT_DOCKER_TESTS=1 npm test
 */
const enabled = process.env.SCOUT_DOCKER_TESTS === "1";

describe("docker driver", { skip: !enabled && "set SCOUT_DOCKER_TESTS=1" }, () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "scout-docker-")));
	const remote = bareRepo(root, "app");
	const workspaces = new Workspaces({
		dataDir: join(root, "data"),
		instance: "t",
		repos: [{ name: "app", gitUrl: remote, base: "main" }],
		driver: new DockerDriver({ prefix: `scout-test${process.pid}` }),
		sandbox: { image: process.env.SCOUT_SANDBOX_IMAGE ?? "scout-sandbox:latest", network: "none", size: "1g" },
		git: { name: "Scout", email: "scout@localhost" },
	});
	after(async () => {
		await workspaces.remove(1);
		await workspaces.close();
	});

	const run = async (command: string, timeout?: number) => {
		let out = "";
		const env = await workspaces.env(1);
		const result = await env.exec(command, { onOutput: (t) => (out += t), ...(timeout === undefined ? {} : { timeout }) }, context);
		return { result, out: out.trim() };
	};

	it("works in its own clone, as an ordinary user, in /work", async () => {
		const { out } = await run("git branch --show-current; cat README.md; id -u; pwd");
		assert.deepEqual(out.split("\n"), ["scout/t-1", "app", "1000", "/work/repo"]);
	});

	it("keeps the host out: no network, no host environment, no host files", async () => {
		process.env.SCOUT_TEST_SECRET = "hunter2";
		const { out } = await run(`env; curl -s -m 3 https://example.com || echo offline; ls ${root} 2>&1 || true`);
		assert.doesNotMatch(out, /hunter2/);
		assert.match(out, /offline/);
		assert.match(out, /No such file or directory/);
	});

	it("stops runaway commands, inside the container", async () => {
		const started = Date.now();
		const { result } = await run("sleep 30", 1);
		assert.equal(result.ok, false);
		assert.ok(Date.now() - started < 10_000);
		const { out } = await run("ps -eo args");
		assert.doesNotMatch(out, /sleep 30/);
	});

	it("keeps its files across a suspend", async () => {
		await run("echo kept > /work/note.txt");
		await workspaces.suspend(1);
		const { out } = await run("cat /work/note.txt");
		assert.equal(out, "kept");
	});
});
