import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";
import { cloneProfile, watchProfile } from "../src/profile.ts";

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

	it("clones a profile repository into the data directory unless told where, not over the example profile/", async () => {
		const env = { SCOUT_MODEL: "faux/m", SCOUT_REPO_URL: "ssh://git@h/o/r.git", SCOUT_REPO_SLUG: "o/r", SCOUT_CODEHOST_TOKEN: "t", SCOUT_CODEHOST_API: "http://forge/api/v1", SCOUT_DATA_DIR: "/srv/scout" };
		assert.ok(loadConfig(env).profileDir.endsWith("/profile"), "no profile repository: the profile/ directory that ships here");
		const withRepo = { ...env, SCOUT_PROFILE_REPO_URL: "ssh://git@h/o/p.git", SCOUT_PROFILE_REPO_SLUG: "o/p" };
		assert.equal(loadConfig(withRepo).profileDir, "/srv/scout/profile");
		assert.equal(loadConfig({ ...withRepo, SCOUT_PROFILE_DIR: "/srv/mine" }).profileDir, "/srv/mine");

		const dir = mkdtempSync(join(tmpdir(), "scout-profile-"));
		writeFileSync(join(dir, "system.md"), "not a clone");
		await assert.rejects(cloneProfile(dir, { gitUrl: "ssh://git@h/o/p.git", base: "main" }), /exists but is not a clone of ssh:\/\/git@h\/o\/p.git/);
	});
});
