import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createWriteTool } from "@earendil-works/pi-durable/tools";
import { createCodeHostExtension } from "../src/codehost.ts";
import { parseReview, reviewAsSubtask, reviewEnv, reviewExtension } from "../src/review.ts";
import { ConfinedEnv, Mirror } from "../src/sandbox.ts";
import { tempDir } from "./helpers.ts";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const toolUse = { stopReason: "toolUse" } as const;

async function setup(options: { maxChangedLines?: number }) {
	const root = tempDir("scout-review-");
	const remote = join(root, "remote.git");
	const seed = join(root, "seed");
	git("init", "--quiet", "--bare", "--initial-branch=main", remote);
	git("init", "--quiet", "--initial-branch=main", seed);
	writeFileSync(join(seed, "a.txt"), "a\n");
	git("-C", seed, "add", ".");
	git("-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "seed");
	git("-C", seed, "push", "--quiet", remote, "main");

	const work = join(root, "work");
	mkdirSync(join(work, "tmp"), { recursive: true });
	const mirror = new Mirror(join(root, "mirror.git"), remote);
	await mirror.clone(join(work, "repo"), "scout/t-1", "main", { name: "Scout", email: "scout@localhost" });

	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = { provider: "faux", modelId: "m" };
	const bodies: string[] = [];
	const reviewer = reviewExtension(() => undefined);
	const codeHost = createCodeHostExtension({
		selfEmail: "scout@localhost",
		name: "codehost",
		codeHost: { kind: "forgejo", apiUrl: "http://forge/api/v1", token: "t" },
		commitAll: true,
		target: async () => ({ source: { kind: "dir", dir: join(work, "repo") }, branch: "scout/t-1", base: "main", slug: "o/r", mirror }),
		...(options.maxChangedLines === undefined ? {} : { maxChangedLines: options.maxChangedLines }),
		selfReview: (change, api, ctx) =>
			reviewAsSubtask(
				api,
				{ agent: { model, extensions: [reviewer] }, workspace: { root: work, cwd: join(work, "repo") }, prompt: change.diff, requestId: `review:${change.sha}` },
				ctx,
			),
		fetch: async (_url, init) => {
			bodies.push(String(JSON.parse(String(init?.body)).body));
			return new Response(JSON.stringify({ html_url: "http://forge/o/r/pulls/3", number: 3 }), { status: 201 });
		},
	});
	const registry = createRegistry();
	registry.install(reviewer);
	const files = defineExtension({ name: "files", tools: [createWriteTool()] });
	registry.install(files);
	registry.install(codeHost);
	const harness = await Harness.open(
		new MemoryStorage(),
		{
			models,
			registry,
			env: async (target, ctx) =>
				(await reviewEnv(target, ctx, async () => {
					throw new Error("no sandboxes here");
				})) ??
				new ConfinedEnv({ id: "work", cwd: join(work, "repo"), root: work, tmp: join(work, "tmp"), protectGit: true }),
		},
		context,
	);
	const thread = await harness.createConversation(
		{ ownership: { kind: "ownerless" }, agent: { model, extensions: [files, codeHost] } },
		context,
	);
	return { faux, harness, thread, bodies, remote };
}

describe("self-review", () => {
	it("parses the verdict line", () => {
		assert.equal(parseReview("APPROVE\nfine").verdict, "approve");
		assert.equal(parseReview("  changes:\n- x").verdict, "changes");
		assert.equal(parseReview("Looks fine to me").verdict, "approve");
	});

	it("sends Scout back to fix what its review finds, then opens the pull request", async () => {
		const { faux, harness, thread, bodies, remote } = await setup({});
		let reviewed = "";
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "b.txt", content: "b\n" })], toolUse),
			fauxAssistantMessage([fauxToolCall("open_pull_request", { title: "Add b", body: "Adds b." })], toolUse),
			(transcript) => {
				reviewed = JSON.stringify(transcript);
				return fauxAssistantMessage("CHANGES\n- b.txt has no test");
			},
			fauxAssistantMessage([fauxToolCall("write", { path: "b.test.txt", content: "test b\n" })], toolUse),
			fauxAssistantMessage([fauxToolCall("open_pull_request", { title: "Add b", body: "Adds b, tested." })], toolUse),
			fauxAssistantMessage("APPROVE\nLooks right."),
			fauxAssistantMessage("Opened http://forge/o/r/pulls/3"),
		]);
		await (await thread.submit({ type: "input", content: "add b" }, context)).wait(context);

		assert.match(reviewed, /\+b/, "the reviewer saw the diff");
		assert.match(reviewed, /Start your answer with a line that is exactly APPROVE or CHANGES/);
		assert.equal(bodies.length, 1, "no pull request until the review passes");
		assert.match(bodies[0]!, /Adds b, tested\.\n\n<details><summary>Scout's self-review<\/summary>\n\nAPPROVE\nLooks right\./);
		assert.equal(git("--git-dir", remote, "show", "scout/t-1:b.test.txt"), "test b");
		assert.equal(faux.getPendingResponseCount(), 0);
		await harness.close(context);
	});

	it("opens anyway when Scout disagrees and asks again unchanged", async () => {
		const { faux, harness, thread, bodies } = await setup({});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "b.txt", content: "b\n" })], toolUse),
			fauxAssistantMessage([fauxToolCall("open_pull_request", { title: "Add b", body: "Adds b." })], toolUse),
			fauxAssistantMessage("CHANGES\n- rename b"),
			fauxAssistantMessage(
				[fauxToolCall("open_pull_request", { title: "Add b", body: "Adds b. The name is what the issue asks for." })],
				toolUse,
			),
			fauxAssistantMessage("Opened."),
		]);
		await (await thread.submit({ type: "input", content: "add b" }, context)).wait(context);
		assert.equal(bodies.length, 1);
		assert.match(bodies[0]!, /The name is what the issue asks for\.[\s\S]*Opened over my own self-review's objections/);
		await harness.close(context);
	});

	it("refuses a change too big to review", async () => {
		const { faux, harness, thread, bodies } = await setup({ maxChangedLines: 2 });
		let error = "";
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "big.txt", content: "1\n2\n3\n" })], toolUse),
			fauxAssistantMessage([fauxToolCall("open_pull_request", { title: "Big", body: "Big." })], toolUse),
			(transcript) => {
				error = JSON.stringify(transcript);
				return fauxAssistantMessage("I'll split it.");
			},
		]);
		await (await thread.submit({ type: "input", content: "go big" }, context)).wait(context);
		assert.match(error, /touches 3 lines; the most I'll put in one pull request is 2/);
		assert.equal(bodies.length, 0);
		await harness.close(context);
	});
});
