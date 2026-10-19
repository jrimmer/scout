import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { PullReviewer } from "../src/automation.ts";
import { loadConfig } from "../src/config.ts";
import { openScout } from "../src/scout.ts";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

async function until(check: () => boolean, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("pull request review (automation mode)", () => {
	it("reviews labelled pull requests once per commit and comments", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "scout-automation-")));
		const remote = join(root, "remote.git");
		const seed = join(root, "seed");
		git("init", "--quiet", "--bare", "--initial-branch=main", remote);
		git("init", "--quiet", "--initial-branch=main", seed);
		const commit = (file: string, text: string, message: string) => {
			writeFileSync(join(seed, file), text);
			git("-C", seed, "add", ".");
			git("-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", message);
			return git("-C", seed, "rev-parse", "HEAD");
		};
		commit("a.txt", "a\n", "seed");
		git("-C", seed, "push", "--quiet", remote, "main");
		git("-C", seed, "checkout", "--quiet", "-b", "feature");
		let head = commit("b.txt", "b\n", "add b");
		git("-C", seed, "push", "--quiet", remote, "feature");

		const profileDir = join(root, "profile");
		mkdirSync(profileDir);
		writeFileSync(join(profileDir, "review.md"), "Review strictly.");
		const config = loadConfig({
			SLACK_BOT_TOKEN: "x",
			SLACK_APP_TOKEN: "x",
			SCOUT_MODEL: "faux/m",
			SCOUT_REPO_URL: remote,
			SCOUT_REPO_SLUG: "o/r",
			SCOUT_CODEHOST_TOKEN: "t",
			SCOUT_CODEHOST_API: "http://forge/api/v1",
			SCOUT_DATA_DIR: join(root, "data"),
			SCOUT_PROFILE_DIR: profileDir,
			SCOUT_REVIEW_LABEL: "scout-review",
		});
		const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const scout = await openScout({
			config,
			storage: new MemoryStorage(),
			dataDir: config.dataDir,
			instance: "t",
			context,
			models,
			watchProfile: false,
		});

		const comments: { url: string; body: string }[] = [];
		const listing = () => [
			{ number: 4, title: "Add b", body: "Adds b.", html_url: "http://forge/o/r/pulls/4", labels: [{ name: "scout-review" }], head: { sha: head, ref: "feature" }, base: { ref: "main" } },
			{ number: 5, title: "Unlabelled", body: "", html_url: "http://forge/o/r/pulls/5", labels: [], head: { sha: head, ref: "feature" }, base: { ref: "main" } },
		];
		const reviewer = new PullReviewer({
			scout,
			config,
			label: "scout-review",
			context,
			fetch: async (url, init) => {
				if (init?.method === "POST") {
					comments.push({ url: String(url), body: JSON.parse(String(init.body)).body });
					return new Response("{}", { status: 201 });
				}
				return new Response(JSON.stringify(listing()), { status: 200 });
			},
		});

		let prompt = "";
		faux.setResponses([
			(transcript) => {
				prompt = JSON.stringify(transcript);
				return fauxAssistantMessage("CHANGES\n- b.txt needs a test");
			},
		]);
		await reviewer.poll();
		await reviewer.poll();
		await until(() => comments.length === 1);
		assert.equal(comments[0]!.url, "http://forge/api/v1/repos/o/r/issues/4/comments");
		assert.match(comments[0]!.body, new RegExp(`^\\*\\*Scout's review\\*\\* of \`${head.slice(0, 7)}\``));
		assert.match(comments[0]!.body, /b\.txt needs a test/);
		assert.match(prompt, /Review strictly\./);
		assert.match(prompt, /\+b/);

		// The same commit is never reviewed twice; a new one is.
		await reviewer.poll();
		head = commit("b.test.txt", "test\n", "test b");
		git("-C", seed, "push", "--quiet", remote, "feature");
		faux.setResponses([fauxAssistantMessage("APPROVE")]);
		await reviewer.poll();
		await until(() => comments.length === 2);
		await reviewer.poll();
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(comments.length, 2);
		assert.match(comments[1]!.body, /APPROVE/);
		await scout.close();
	});
});
