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
import { changedLines, parsePullReview } from "../src/review.ts";
import { openScout } from "../src/scout.ts";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

async function until(check: () => boolean, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("pull request review, when asked", () => {
	it("reviews pull requests Scout was asked to, as a review with line comments, then each new push", async () => {
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
		mkdirSync(join(profileDir, "channels", "team"), { recursive: true });
		writeFileSync(join(profileDir, "reviewer.md"), "Review strictly.");
		writeFileSync(join(profileDir, "channels", "team", "instructions.md"), "---\nrepo: r\n---\nWe care about tests.");
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
		});
		const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const scout = await openScout({ config, storage: new MemoryStorage(), dataDir: config.dataDir, instance: "t", context, models, watchProfile: false });

		let requested = true;
		const pull = (number: number, author: string, asked: boolean) => ({
			number,
			title: `Pull ${number}`,
			body: "Adds b.",
			html_url: `http://forge/o/r/pulls/${number}`,
			user: { login: author },
			requested_reviewers: asked ? [{ login: "scout" }] : [],
			head: { sha: head, ref: "feature" },
			base: { ref: "main" },
		});
		const reviews: { path: string; body: { body: string; event: string; commit_id: string; comments?: unknown[] } }[] = [];
		const announced: string[] = [];
		const reviewer = new PullReviewer({
			scout,
			config,
			context,
			onReview: async (posted) => void announced.push(`${posted.repo} #${posted.number} ${posted.review.verdict}`),
			fetch: async (url, init) => {
				const path = new URL(String(url)).pathname;
				if (init?.method === "POST") {
					reviews.push({ path, body: JSON.parse(String(init.body)) });
					return Response.json({}, { status: 201 });
				}
				if (path === "/api/v1/user") return Response.json({ login: "scout" });
				if (path === "/api/v1/repos/o/r/pulls/4") return Response.json(pull(4, "ann", false));
				// Pull 4 asked Scout (until it answered); 5 didn't; 6 is Scout's own.
				return Response.json([pull(4, "ann", requested), pull(5, "ann", false), pull(6, "scout", true)]);
			},
		});

		let prompt = "";
		faux.setResponses([
			(transcript) => {
				prompt = JSON.stringify(transcript);
				return fauxAssistantMessage("CHANGES\nb.txt needs a test.\n### b.txt:1\nName this better.\n### a.txt:1\nUnrelated, and not in the diff.");
			},
		]);
		await reviewer.poll();
		await reviewer.poll();
		await until(() => reviews.length === 1 && announced.length === 1);
		const first = reviews[0]!;
		assert.equal(first.path, "/api/v1/repos/o/r/pulls/4/reviews");
		assert.equal(first.body.event, "REQUEST_CHANGES");
		assert.equal(first.body.commit_id, head);
		assert.deepEqual(first.body.comments, [{ path: "b.txt", new_position: 1, old_position: 0, body: "Name this better." }]);
		assert.match(first.body.body, /^b\.txt needs a test\.\n\n\*\*a\.txt:1\*\*: Unrelated/);
		assert.match(first.body.body, /ask me about it in #team/);
		assert.match(prompt, /Review strictly\./);
		assert.match(prompt, /We care about tests\./);
		assert.match(prompt, /\+b/);
		assert.deepEqual(announced, ["r #4 changes"]);

		// Answering clears the request; a new push is still reviewed, the same commit never twice.
		requested = false;
		await reviewer.poll();
		head = commit("b.test.txt", "test\n", "test b");
		git("-C", seed, "push", "--quiet", remote, "feature");
		faux.setResponses([fauxAssistantMessage("APPROVE")]);
		await reviewer.poll();
		await until(() => reviews.length === 2);
		await reviewer.poll();
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(reviews.length, 2);
		assert.equal(reviews[1]!.body.event, "APPROVED");
		assert.match(reviews[1]!.body.body, /^Looks good to me\./);
		await scout.close();
	});
});

describe("reading a review", () => {
	const diff = [
		"diff --git a/src/cart.ts b/src/cart.ts",
		"--- a/src/cart.ts",
		"+++ b/src/cart.ts",
		"@@ -10,3 +10,4 @@ export function total() {",
		" \tlet sum = 0;",
		"-\tfor (const i of items) sum += i;",
		"+\tfor (const i of items) sum += i.price;",
		"+\treturn sum;",
		" }",
		"diff --git a/old.txt b/old.txt",
		"--- a/old.txt",
		"+++ /dev/null",
		"@@ -1 +0,0 @@",
		"-gone",
	].join("\n");

	it("knows which new lines a diff shows, added or context", () => {
		assert.deepEqual([...(changedLines(diff).get("src/cart.ts") ?? [])], [10, 11, 12, 13]);
		assert.equal(changedLines(diff).has("old.txt"), false);
	});

	it("takes the verdict from the first line, and moves comments on unshown lines into the body", () => {
		const review = parsePullReview(
			"Changes requested\nThe total ignores quantity.\n\n### src/cart.ts:11\nMultiply by `i.quantity`.\n### `src/cart.ts`:40\nUnrelated, but this rounds.",
			diff,
		);
		assert.equal(review.verdict, "changes");
		assert.deepEqual(review.comments, [{ path: "src/cart.ts", line: 11, body: "Multiply by `i.quantity`." }]);
		assert.equal(review.body, "The total ignores quantity.\n\n**src/cart.ts:40**: Unrelated, but this rounds.");
		assert.equal(parsePullReview("APPROVE", diff).verdict, "approve");
		assert.deepEqual(parsePullReview("Some thoughts first.", diff), { verdict: "comment", body: "Some thoughts first.", comments: [] });
	});
});
