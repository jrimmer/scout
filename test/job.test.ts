import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { loadConfig } from "../src/config.ts";
import { runJob } from "../src/job.ts";
import { openScout } from "../src/scout.ts";

describe("job mode", () => {
	it("runs one task without Slack, reports progress, and answers", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "scout-job-")));
		mkdirSync(join(root, "profile"));
		const config = loadConfig({
			SCOUT_MODEL: "faux/m",
			SCOUT_REPO_URL: join(root, "nowhere.git"),
			SCOUT_REPO_SLUG: "o/r",
			SCOUT_CODEHOST_TOKEN: "t",
			SCOUT_CODEHOST_API: "http://forge/api/v1",
			SCOUT_DATA_DIR: join(root, "data"),
			SCOUT_PROFILE_DIR: join(root, "profile"),
		});
		const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const scout = await openScout({ config, storage: new MemoryStorage(), dataDir: config.dataDir, instance: "j", context, models, watchProfile: false });

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("search_threads", { query: "lint" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Nothing to fix: lint is clean."),
		]);
		const progress: string[] = [];
		const result = await runJob(scout, "fix lint everywhere", { progress: (line) => progress.push(line) });
		assert.deepEqual(result, { ok: true, answer: "Nothing to fix: lint is clean.", pullRequests: [] });
		assert.deepEqual(progress, ["search_threads lint"]);
		await scout.close();
	});
});
