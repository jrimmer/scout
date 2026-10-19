import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { loadConfig } from "../src/config.ts";
import { loadProfile, profileExtension } from "../src/profile.ts";
import { openScout } from "../src/scout.ts";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

function bareRepo(root: string, name: string, branch: string): string {
	const remote = join(root, `${name}.git`);
	const seed = join(root, `${name}-seed`);
	git("init", "--quiet", "--bare", `--initial-branch=${branch}`, remote);
	git("init", "--quiet", `--initial-branch=${branch}`, seed);
	writeFileSync(join(seed, "README.md"), `${name}\n`);
	git("-C", seed, "add", ".");
	git("-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "seed");
	git("-C", seed, "push", "--quiet", remote, branch);
	return remote;
}

describe("repositories and zones", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "scout-repos-")));
	const api = bareRepo(root, "api", "main");
	const web = bareRepo(root, "web", "develop");
	const profileDir = join(root, "profile");
	mkdirSync(join(profileDir, "channels", "web-team"), { recursive: true });
	writeFileSync(
		join(profileDir, "channels", "web-team", "instructions.md"),
		"---\nrepo: web\nzones: apps/storefront, libs/ui\n---\nWe ship on Tuesdays.\n",
	);
	mkdirSync(join(profileDir, "channels", "lost"), { recursive: true });
	writeFileSync(join(profileDir, "channels", "lost", "instructions.md"), "---\nrepo: nope\n---\n");
	const reposFile = join(root, "repos.json");
	writeFileSync(reposFile, JSON.stringify([{ name: "web", gitUrl: web, slug: "team/web", base: "develop" }]));

	it("reads a channel's repository and zones from its instructions", () => {
		const channel = loadProfile(profileDir).channels.get("web-team");
		assert.deepEqual(channel, { instructions: "We ship on Tuesdays.", repo: "web", zones: ["apps/storefront", "libs/ui"], skills: [] });
	});

	it("starts each channel's threads in its repository", async () => {
		const config = loadConfig({
			SCOUT_REPO_URL: api,
			SCOUT_REPO_SLUG: "team/api",
			SCOUT_REPOS_FILE: reposFile,
			SCOUT_CODEHOST_TOKEN: "t",
			SCOUT_CODEHOST_API: "http://forge/api/v1",
			SCOUT_DATA_DIR: join(root, "data"),
			SCOUT_PROFILE_DIR: profileDir,
		});
		assert.deepEqual(config.repos.map((r) => [r.name, r.base]), [["api", "main"], ["web", "develop"]]);
		const scout = await openScout({ config, storage: new MemoryStorage(), dataDir: config.dataDir, instance: "t", context, models: createModels(), watchProfile: false });
		assert.equal(scout.repoFor("web-team"), "web");
		assert.equal(scout.repoFor("anything-else"), "api");
		assert.equal(scout.repoFor("lost"), "api", "an unknown repository falls back to the default");

		await scout.workspaces.prepare(1, "web");
		await scout.workspaces.prepare(2, undefined);
		const repo = (id: number) => scout.workspaces.paths(id).repo;
		assert.equal(git("-C", repo(1), "remote", "get-url", "origin"), web);
		assert.equal(git("-C", repo(1), "rev-parse", "--abbrev-ref", "HEAD"), "scout/t-1");
		assert.equal(git("-C", repo(1), "merge-base", "HEAD", "origin/develop"), git("-C", repo(1), "rev-parse", "origin/develop"));
		assert.equal(git("-C", repo(2), "remote", "get-url", "origin"), api);
		await scout.close();
	});

	it("tells Scout which repository it is in and where its team works", async () => {
		const extension = profileExtension(loadProfile(profileDir), {
			repo: async () => ({ name: "web", base: "develop" }),
			branch: () => "scout/t-1",
		});
		const workspace = extension.sections!.find((s) => s.key === "workspace")!;
		const text = await workspace.render(
			{
				conversationId: 1,
				env: { cwd: "/data/threads/t-1/repo" },
				read: { snapshot: async () => ({ channelName: "web-team" }) },
			} as never,
			context,
		);
		assert.match(String(text), /Repository web: \/data\/threads\/t-1\/repo \(your own clone, on branch scout\/t-1, from develop\)/);
		assert.match(String(text), /This team mostly works in apps\/storefront, libs\/ui\. Start there\./);
	});
});
