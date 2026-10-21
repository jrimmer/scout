import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Images } from "../src/images.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("repository images", () => {
	it("builds when a setup script is new or changed, weekly otherwise, and waits an hour after a failure", async () => {
		const images = new Images(":memory:");
		const scripts: Record<string, { script: string; base: string } | undefined> = { app: { script: "a".repeat(40), base: "1".repeat(40) }, plain: undefined };
		const built: string[] = [];
		let failing = false;
		const builder = {
			repos: () => ["app", "plain"],
			setup: async (repo: string) => scripts[repo],
			build: async (repo: string, label: string) => {
				built.push(`${repo} ${label}`);
				if (failing) throw new Error("setup.sh failed (1): npm ERR! network");
				return { name: `scout/${repo}`, version: built.length };
			},
		};
		const t0 = Date.parse("2026-10-20T12:00:00Z");

		assert.deepEqual(await images.refresh(builder, t0), ["built scout/app v1 for app (aaaaaaaaaaaa-111111111111)"]);
		assert.equal(images.get("app")?.snapshot, "scout/app");
		assert.equal(images.get("plain"), undefined, "no setup script, no image");

		scripts.app = { script: "a".repeat(40), base: "2".repeat(40) };
		assert.deepEqual(await images.refresh(builder, t0 + HOUR), [], "a new base alone doesn't rebuild within the week");
		assert.equal((await images.refresh(builder, t0 + 8 * DAY)).length, 1, "a week later it does");

		scripts.app = { script: "b".repeat(40), base: "2".repeat(40) };
		failing = true;
		await assert.rejects(images.refresh(builder, t0 + 9 * DAY), /app: setup\.sh failed \(1\): npm ERR! network/);
		assert.equal(images.get("app")?.version, 2, "threads keep starting from the last good image");
		assert.equal(images.failure("app"), "setup.sh failed (1): npm ERR! network");
		assert.deepEqual(await images.refresh(builder, t0 + 9 * DAY + 10 * 60 * 1000), [], "the same script isn't retried within the hour");
		failing = false;
		assert.equal((await images.refresh(builder, t0 + 9 * DAY + 2 * HOUR)).length, 1);
		assert.equal(images.failure("app"), undefined);
		assert.equal(built.length, 4);
		images.close();
	});
});
