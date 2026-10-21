import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/** Every file under `dir` ending in `.ts`. */
function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true, recursive: true })
		.filter((e) => e.isFile() && e.name.endsWith(".ts"))
		.map((e) => join(e.parentPath, e.name));
}

describe("settings", () => {
	it("lists every setting Scout reads in .env.example, so installing from it misses nothing", () => {
		const names = (text: string) => new Set(text.match(/\b(?:SCOUT|SLACK)_[A-Z0-9_]+\b/g) ?? []);
		const documented = names(readFileSync(".env.example", "utf8"));
		const read = new Set([...sources("src"), ...sources("mcp")].flatMap((file) => [...names(readFileSync(file, "utf8"))]));
		const missing = [...read].filter((name) => !documented.has(name)).sort();
		assert.deepEqual(missing, [], "add these to .env.example, with what they do");
	});
});
