import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, type EntryRecord, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createCodeHostExtension } from "../src/codehost.ts";
import { consolidationExtension, Memory } from "../src/memory.ts";
import { Pulls } from "../src/pulls.ts";
import { ThreadDoc } from "../src/docs.ts";
import { branchForDay, Reflector, reflectionExtensions, renderTranscript } from "../src/reflect.ts";
import { threadKey, Threads } from "../src/threads.ts";

const toolUse = { stopReason: "toolUse" } as const;
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

describe("renderTranscript", () => {
	it("shows who said what, what Scout did, and what failed", () => {
		const entries = [
			{ kind: "slack.message", data: { name: "ann", text: "deploy is broken" } },
			{
				kind: "pi.assistant",
				model: [
					{
						role: "assistant",
						content: [
							{ type: "text", text: "Looking." },
							{ type: "toolCall", id: "1", name: "bash", arguments: { command: "make deploy\nmore" } },
						],
					},
				],
			},
			{ kind: "pi.tool-result", model: [{ role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "no rule to make target" }] }] },
			{ kind: "pi.tool-result", model: [{ role: "toolResult", toolName: "read", isError: false, content: [{ type: "text", text: "fine" }] }] },
			{ kind: "pi.system", model: [{ role: "system", content: "" }] },
		] as unknown as EntryRecord[];
		assert.equal(
			renderTranscript(entries),
			["ann: deploy is broken", "Scout: Looking.", "  → bash make deploy", "  ✗ bash: no rule to make target"].join("\n"),
		);
	});
});

describe("nightly reflection", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "scout-reflect-")));
	const remote = join(root, "profile.git");
	const seed = join(root, "seed");
	git("init", "--quiet", "--bare", "--initial-branch=main", remote);
	git("init", "--quiet", "--initial-branch=main", seed);
	mkdirSync(join(seed, "skills"));
	writeFileSync(join(seed, "system.md"), "You are Scout.\n");
	git("-C", seed, "add", ".");
	git("-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "seed");
	git("-C", seed, "push", "--quiet", remote, "main");

	const threads = new Threads(":memory:");
	const pulls = new Pulls(":memory:");
	const memory = new Memory(":memory:");
	after(() => {
		threads.close();
		pulls.close();
		memory.close();
	});

	it("reads new threads, edits the profile, and proposes it once a day", async () => {
		const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
		const models = createModels();
		models.setProvider(faux.provider);

		let reflector: Reflector | undefined;
		const requests: { url: string; body: Record<string, unknown> }[] = [];
		const reflection = reflectionExtensions(() => "Learn from the threads.");
		const codeHost = createCodeHostExtension({
			name: "profile-codehost",
			codeHost: { kind: "github", apiUrl: "https://api.example", token: "t" },
			commitAll: true,
			target: (id, ctx) => reflector!.target(id, ctx),
			onPullRequest: (id, pull) => pulls.opened({ ...pull, kind: "profile", conversationId: id }),
			fetch: async (url, init) => {
				requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
				return new Response(JSON.stringify({ html_url: "https://example/pull/7", number: 7 }), { status: 201 });
			},
		});
		const consolidation = consolidationExtension(memory);
		const registry = createRegistry();
		registry.install(consolidation);
		registry.install(reflection.reflect);
		registry.install(reflection.files);
		registry.install(codeHost);
		const harness = await Harness.open(
			new MemoryStorage(),
			{ models, registry, env: async (target, ctx) => reflector?.env(target, ctx) },
			context,
		);
		const model = { provider: "faux", modelId: "faux-model" };
		reflector = new Reflector({
			harness,
			threads,
			pulls,
			memory,
			context,
			dataDir: join(root, "data"),
			profileRepo: { gitUrl: remote, base: "main", slug: "team/scout-profile" },
			git: { name: "Scout", email: "scout@localhost" },
			agent: { model, extensions: [reflection.reflect, reflection.files, codeHost, consolidation] },
			threadLink: async () => "https://slack/archives/C1/p1",
		});

		// A day's thread: Scout tried a command it doesn't have, and got stuck.
		const thread = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model, extensions: [] },
				init: async (tx, id) => {
					(await tx.doc(ThreadDoc, id)).channelName = "deploys";
				},
			},
			context,
		);
		threads.insert({ key: threadKey("C1", "1.0"), conversationId: thread.id, channel: "C1", threadTs: "1.0", startedBy: "UANN" });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "make deploy" })], toolUse),
			fauxAssistantMessage("I couldn't run the deploy."),
		]);
		await (
			await thread.submit(
				{ type: "input", content: "ann: deploy please", entry: { kind: "slack.message", data: { name: "ann", text: "deploy please" } } },
				context,
			)
		).wait(context);
		threads.spoke(threadKey("C1", "1.0"), "scout", Date.now() + 1);
		const note = memory.remember("deploys", "Deploys go through ./bin/deploy.");

		let digest = "";
		faux.setResponses([
			(transcript) => {
				digest = JSON.stringify(transcript);
				return fauxAssistantMessage([
					fauxToolCall("write", { path: "skills/deploys.md", content: "---\ndescription: Deploying\n---\nUse ./bin/deploy.\n" }),
					fauxToolCall("write", { path: ".git/hooks/pre-commit", content: "#!/bin/sh\ntouch /tmp/scout-pwned\n" }),
				], toolUse);
			},
			fauxAssistantMessage(
				[
					fauxToolCall("consolidate_memories", { ids: [note] }),
					fauxToolCall("open_pull_request", { title: "Teach Scout to deploy", body: "From #deploys." }),
				],
				toolUse,
			),
			fauxAssistantMessage("Proposed a deploy skill."),
		]);

		const started = await reflector.run("2026-10-19");
		assert.equal(started?.threads, 1);
		await harness.waitForIdle(context);

		assert.match(digest, /#deploys \(https:\/\/slack\/archives\/C1\/p1\)/);
		assert.match(digest, /ann: deploy please/);
		assert.match(digest, /→ bash make deploy/);
		assert.match(digest, /✗ bash:/, "the failed step is in the digest");
		assert.match(digest, /Scout: I couldn't run the deploy\./);
		assert.match(digest, /Learn from the threads\./);
		assert.match(digest, /system\.md/, "the reflection sees the profile's files");
		assert.match(digest, /\[1\] #deploys: Deploys go through \.\/bin\/deploy\./, "and the notes kept since");

		const branch = branchForDay("2026-10-19");
		assert.equal(git("--git-dir", remote, "show", `${branch}:skills/deploys.md`), "---\ndescription: Deploying\n---\nUse ./bin/deploy.");
		assert.equal(git("--git-dir", remote, "log", "-1", "--format=%s", branch), "Teach Scout to deploy");
		assert.equal(existsSync(join(root, "data/reflections/2026-10-19/profile/.git/hooks/pre-commit")), false);
		assert.equal(existsSync("/tmp/scout-pwned"), false);
		assert.deepEqual(requests.map((r) => [r.url, r.body.head, r.body.base]), [
			["https://api.example/repos/team/scout-profile/pulls", branch, "main"],
		]);

		assert.equal(pulls.get("https://example/pull/7")?.title, "Teach Scout to deploy");
		memory.proposalDecided(threads.reflectionDay(started!.conversationId)!, true);
		assert.deepEqual(memory.active(), [], "the note retires once the proposal merges");

		// Once per day, and only for threads with something new.
		assert.equal(await reflector.run("2026-10-19"), undefined);
		assert.equal(await reflector.run("2026-10-20"), undefined);
		assert.deepEqual(threads.unreflected(), []);
		await harness.close(context);
	});
});
