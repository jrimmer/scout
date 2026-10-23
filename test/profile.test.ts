import assert from "node:assert/strict";
import { mkdirSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";
import { cloneProfile, watchProfile } from "../src/profile.ts";
import { tempDir, until } from "./helpers.ts";

describe("profile", () => {
	it("reloads when the profile's files change, not when a pull only touches .git", async () => {
		const dir = tempDir("scout-profile-");
		mkdirSync(join(dir, ".git"));
		writeFileSync(join(dir, "system.md"), "You are Scout.");
		let reloads = 0;
		const stop = watchProfile(dir, () => reloads++);
		// A watcher of the test's own, set up after Scout's: once it has seen a change, so has Scout's.
		const seen: string[] = [];
		const spy = watch(dir, { recursive: true }, (_event, file) => void seen.push(String(file)));
		try {
			writeFileSync(join(dir, ".git", "FETCH_HEAD"), "abc\n");
			await until(() => seen.some((f) => f.endsWith("FETCH_HEAD")), 5000, "the .git change to be seen");
			// A reload would follow the change by the watcher's debounce (300 ms): wait that out, and a little more.
			await new Promise((resolve) => setTimeout(resolve, 500));
			assert.equal(reloads, 0, "a pull with nothing new isn't a change");
			writeFileSync(join(dir, "system.md"), "You are Scout, a teammate.");
			await until(() => reloads === 1, 5000, "the reload");
		} finally {
			spy.close();
			stop();
		}
	});

	it("clones a profile repository into the data directory unless told where, not over the example profile/", async () => {
		const env = { SCOUT_MODEL: "faux/m", SCOUT_REPO_URL: "ssh://git@h/o/r.git", SCOUT_REPO_SLUG: "o/r", SCOUT_CODEHOST_TOKEN: "t", SCOUT_CODEHOST_API: "http://forge/api/v1", SCOUT_DATA_DIR: "/srv/scout" };
		assert.ok(loadConfig(env).profileDir.endsWith("/profile"), "no profile repository: the profile/ directory that ships here");
		const withRepo = { ...env, SCOUT_PROFILE_REPO_URL: "ssh://git@h/o/p.git", SCOUT_PROFILE_REPO_SLUG: "o/p" };
		assert.equal(loadConfig(withRepo).profileDir, "/srv/scout/profile");
		assert.equal(loadConfig({ ...withRepo, SCOUT_PROFILE_DIR: "/srv/mine" }).profileDir, "/srv/mine");

		const dir = tempDir("scout-profile-");
		writeFileSync(join(dir, "system.md"), "not a clone");
		await assert.rejects(cloneProfile(dir, { gitUrl: "ssh://git@h/o/p.git", base: "main" }), /exists but is not a clone of ssh:\/\/git@h\/o\/p.git/);
	});
});
