import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { allowInReposFile, EgressRequests, egressExtension, hostOf } from "../src/egress.ts";
import { tempDir } from "./helpers.ts";

describe("asking for network access", () => {
	it("takes just the host from what a log or Scout says", () => {
		assert.equal(hostOf("registry.npmjs.org"), "registry.npmjs.org");
		assert.equal(hostOf("https://user:pw@Proxy.Golang.org:443/github.com/x/@v/list"), "proxy.golang.org");
		assert.equal(hostOf("*.pythonhosted.org"), "*.pythonhosted.org");
		assert.equal(hostOf("10.1.0.0/16"), "10.1.0.0/16");
		assert.equal(hostOf("not a host"), undefined);
		assert.equal(hostOf("localhost"), undefined, "a name without a domain isn't something to allow");
	});

	it("asks once per host and repository, and decides once", () => {
		const requests = new EgressRequests(":memory:");
		const first = requests.ask({ repo: "web", host: "registry.npmjs.org", why: "npm ci", conversationId: 4 });
		assert.equal(first.isNew, true);
		assert.equal(requests.ask({ repo: "web", host: "registry.npmjs.org", why: "again", conversationId: 5 }).isNew, false, "already waiting");
		assert.equal(requests.ask({ repo: "api", host: "registry.npmjs.org", why: "npm ci", conversationId: 6 }).isNew, true, "another repository asks for itself");
		assert.equal(requests.decide(first.request.id, true, "UANN")?.state, "allowed");
		assert.equal(requests.decide(first.request.id, false, "UBOB"), undefined, "someone else got there first");
		assert.equal(requests.get(first.request.id)?.decidedBy, "UANN");
		assert.equal(requests.ask({ repo: "web", host: "registry.npmjs.org", why: "later", conversationId: 7 }).isNew, true, "decided ones don't block a new ask");
		requests.close();
	});

	it("adds an allowed host to the repository's egress list in the repos file, keeping a backup", () => {
		const dir = tempDir("scout-egress-");
		const file = join(dir, "repos.json");
		writeFileSync(file, JSON.stringify([{ name: "web", gitUrl: "g", slug: "o/web", egress: ["github.com"] }, { name: "api", gitUrl: "g", slug: "o/api" }]));
		assert.equal(allowInReposFile(file, "web", "registry.npmjs.org"), true);
		assert.equal(allowInReposFile(file, "api", "proxy.golang.org"), true);
		assert.equal(allowInReposFile(file, "web", "registry.npmjs.org"), true, "already there: nothing to do");
		assert.equal(allowInReposFile(file, "billing", "x.org"), false, "not in the file");
		const repos = JSON.parse(readFileSync(file, "utf8")) as { name: string; egress?: string[] }[];
		assert.deepEqual(repos.map((r) => r.egress), [["github.com", "registry.npmjs.org"], ["proxy.golang.org"]]);
		assert.ok(existsSync(`${file}.bak`));
		assert.equal(allowInReposFile(join(dir, "missing.json"), "web", "x.org"), false);
	});

	it("passes a clean host to whoever asks, and refuses one it can't read", async () => {
		const asked: string[] = [];
		const [tool] = egressExtension(async (id, host, why) => {
			asked.push(`${id} ${host} ${why}`);
			return "asked";
		}).tools!;
		const said = await tool!.execute({ host: "https://registry.npmjs.org/", why: "npm ci" } as never, { conversationId: 9 } as never, context);
		assert.match(JSON.stringify(said.output), /asked/);
		assert.deepEqual(asked, ["9 registry.npmjs.org npm ci"]);
		await assert.rejects(tool!.execute({ host: "the npm one", why: "x" } as never, { conversationId: 9 } as never, context), /isn't a host name/);
	});
});
