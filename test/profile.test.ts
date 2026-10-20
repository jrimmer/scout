import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { watchProfile } from "../src/profile.ts";

describe("profile", () => {
	it("reloads when the profile's files change, not when a pull only touches .git", async () => {
		const dir = mkdtempSync(join(tmpdir(), "scout-profile-"));
		mkdirSync(join(dir, ".git"));
		writeFileSync(join(dir, "system.md"), "You are Scout.");
		let reloads = 0;
		const stop = watchProfile(dir, () => reloads++);
		try {
			await new Promise((resolve) => setTimeout(resolve, 100));
			writeFileSync(join(dir, ".git", "FETCH_HEAD"), "abc\n");
			await new Promise((resolve) => setTimeout(resolve, 600));
			assert.equal(reloads, 0, "a pull with nothing new isn't a change");
			writeFileSync(join(dir, "system.md"), "You are Scout, a teammate.");
			await new Promise((resolve) => setTimeout(resolve, 600));
			assert.equal(reloads, 1);
		} finally {
			stop();
		}
	});
});
