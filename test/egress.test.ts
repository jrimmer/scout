import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { allowInReposFile, EgressRequests, egressExtension, hostOf, whyNotHost } from "../src/egress.ts";
import { tempDir } from "./helpers.ts";

describe("asking for network access", () => {
	it("takes just the host from what a log or Scout says", () => {
		assert.equal(hostOf("registry.npmjs.org"), "registry.npmjs.org");
		assert.equal(hostOf("https://user:pw@Proxy.Golang.org:443/github.com/x/@v/list"), "proxy.golang.org");
		assert.equal(hostOf("*.pythonhosted.org"), "*.pythonhosted.org");
		assert.equal(hostOf("*.npmjs.org"), "*.npmjs.org");
		assert.equal(hostOf("*.example.co.uk"), "*.example.co.uk");
		assert.equal(hostOf("my-bucket.s3.amazonaws.com"), "my-bucket.s3.amazonaws.com", "one host on shared hosting is fine");
		assert.equal(hostOf("not a host"), undefined);
		assert.equal(hostOf("localhost"), undefined, "a name without a domain isn't something to allow");
	});

	it("refuses addresses, ranges, hosts inside the network and wide wildcards, so a click can't open the sandbox up", () => {
		const refused = [
			// IP literals and ranges, v4 and v6, however they're written
			"10.1.0.0/16",
			"0.0.0.0/0",
			"127.0.0.1",
			"8.8.8.8",
			"169.254.169.254",
			"http://169.254.169.254/latest/meta-data/",
			"2130706433",
			"127.1",
			"0x7f.0.0.1",
			"::1",
			"fd00:ec2::254",
			"[fd00:ec2::254]",
			"http://[fd00:ec2::254]:80/latest",
			"2001:db8::/32",
			// names that stay inside the network, or resolve to whatever they say
			"localhost.",
			"api.localhost",
			"*.localhost",
			"metadata.google.internal",
			"instance-data.ec2.internal",
			"printer.local",
			"nas.lan",
			"router.home.arpa",
			"169.254.169.254.nip.io",
			"10.0.0.1.sslip.io",
			"metadata",
			// wildcards wider than one registrable domain, and wildcards over shared hosting
			"*",
			"*.com",
			"*.co.uk",
			"*.com.au",
			"*.*.example.com",
			"foo.*.example.com",
			"*example.com",
			"*.amazonaws.com",
			"*.s3.amazonaws.com",
			"*.github.io",
			"*.herokuapp.com",
			// public suffixes on their own
			"co.uk",
			"github.io",
			// broken names
			"-bad.example.com",
			"bad-.example.com",
			`${"a".repeat(64)}.example.com`,
			"lease:abc",
		];
		for (const text of refused) assert.equal(hostOf(text), undefined, `${text} must be refused`);
		assert.match(whyNotHost("169.254.169.254") ?? "", /IP address/);
		assert.match(whyNotHost("10.0.0.0/8") ?? "", /range/);
		assert.match(whyNotHost("metadata.google.internal") ?? "", /inside the network/);
		assert.match(whyNotHost("*.com") ?? "", /wildcard/);
		assert.equal(whyNotHost("registry.npmjs.org"), undefined);
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
		await assert.rejects(tool!.execute({ host: "169.254.169.254", why: "x" } as never, { conversationId: 9 } as never, context), /IP address/);
		assert.deepEqual(asked, ["9 registry.npmjs.org npm ci"], "nothing refused was passed on");
	});
});
