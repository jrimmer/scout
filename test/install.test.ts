import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import { tempDir } from "./helpers.ts";

const script = join(import.meta.dirname, "..", "install.sh");

describe("install.sh", () => {
	it("is valid shell", () => {
		const checked = spawnSync("bash", ["-n", script], { encoding: "utf8" });
		assert.equal(checked.status, 0, checked.stderr);
	});

	it("says what it would do, and changes nothing, on a dry run", () => {
		const dir = join(tempDir("scout-install-"), "scout");
		const ran = spawnSync("bash", [script], { encoding: "utf8", env: { ...process.env, SCOUT_DRY_RUN: "1", SCOUT_REF: "v1.0.1", SCOUT_DIR: dir, SCOUT_DOCKER: "no" } });
		assert.equal(ran.status, 0, ran.stdout + ran.stderr);
		// As root (CI) the clone runs as the scout user; as anyone else, as themselves.
		assert.match(ran.stdout, /would run: (runuser -u \S+ -- |sudo -u \S+ -- )?git clone --quiet --branch v1\.0\.1 \S+ \S+scout\n/);
		assert.match(ran.stdout, /would run: npm run setup/);
		assert.equal(spawnSync("test", ["-e", dir]).status, 1, "nothing was made");
	});
});
