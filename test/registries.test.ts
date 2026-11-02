import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { allowInReposFile, hostOf, whyNotHost } from "../src/egress.ts";
import { REGISTRIES, registryHosts, registryName, unknownRegistries } from "../src/registries.ts";
import { LocalDriver } from "../src/drivers/local.ts";
import { Workspaces } from "../src/workspaces.ts";
import { tempDir } from "./helpers.ts";

describe("package registries", () => {
	it("names ecosystems, with or without the @, and `all` stands for every one", () => {
		assert.equal(registryName("@Python"), "python");
		assert.equal(registryName("jvm"), "jvm");
		assert.equal(registryName("all"), "all");
		assert.equal(registryName("pythn"), undefined);
		assert.deepEqual(unknownRegistries(["python", "pythn", "@all"]), ["pythn"]);
		assert.deepEqual(registryHosts(["all"]).sort(), registryHosts(Object.keys(REGISTRIES)).sort());
	});

	it("lists exact hosts only: no wildcard, no address, nothing anyone can publish a page on", () => {
		for (const host of registryHosts(["all"])) {
			assert.equal(whyNotHost(host), undefined, `${host} is a host Scout would allow`);
			assert.ok(!host.startsWith("*."), `${host} is not a wildcard`);
		}
	});

	it("leaves a registry's download hosts out when asked, and lists each host once", () => {
		assert.ok(registryHosts(["dotnet"]).includes("globalcdn.nuget.org"));
		assert.ok(!registryHosts(["dotnet"], false).includes("globalcdn.nuget.org"));
		assert.ok(registryHosts(["dotnet"], false).includes("api.nuget.org"));
		assert.equal(registryHosts(["python", "@python", "all"]).length, new Set(registryHosts(["all"])).size);
		assert.deepEqual(registryHosts(["nope"]), []);
	});

	it("is asked for as @ecosystem, and saved as registries in the repos file, not as a host", () => {
		assert.equal(hostOf("@jvm"), "@jvm");
		assert.equal(whyNotHost("@all"), undefined);
		assert.match(whyNotHost("@nope") ?? "", /isn't a host name/);
		const path = join(tempDir("scout-registries-"), "repos.json");
		writeFileSync(path, JSON.stringify([{ name: "api", gitUrl: "x", slug: "a/api" }]));
		assert.equal(allowInReposFile(path, "api", "@jvm"), true);
		assert.equal(allowInReposFile(path, "api", "@jvm"), true, "asking again changes nothing");
		assert.equal(allowInReposFile(path, "api", "pypi.org"), true);
		const [entry] = JSON.parse(readFileSync(path, "utf8")) as { registries?: string[]; egress?: string[] }[];
		assert.deepEqual(entry?.registries, ["jvm"]);
		assert.deepEqual(entry?.egress, ["pypi.org"]);
	});

	it("adds a repository's registries to its egress list, and not when the network is open", () => {
		const make = (network: "none" | "open", registryCdns?: boolean) =>
			new Workspaces({
				dataDir: tempDir("scout-registries-ws-"),
				instance: "t",
				repos: [
					{ name: "pub", gitUrl: "x", base: "main", registries: ["python"] },
					{ name: "own", gitUrl: "x", base: "main", registries: ["dotnet"], egress: ["example.com"] },
					{ name: "private", gitUrl: "x", base: "main", registries: [] },
					{ name: "plain", gitUrl: "x", base: "main" },
				],
				driver: new LocalDriver({ root: tempDir("scout-registries-sb-") }),
				sandbox: { image: "unused", network, ...(registryCdns === undefined ? {} : { registryCdns }) },
				git: { name: "Scout", email: "scout@localhost" },
			});
		const closed = make("none");
		const named = (name: string) => closed.egressOf(closed.repo(name));
		assert.deepEqual(named("pub"), ["pypi.org", "files.pythonhosted.org"]);
		assert.deepEqual(named("own"), ["example.com", "api.nuget.org", "builds.dotnet.microsoft.com", "globalcdn.nuget.org", "ci.dot.net"]);
		assert.equal(named("private"), undefined, "no registries and no list: the plain network setting stands");
		assert.equal(named("plain"), undefined);
		const noCdn = make("none", false);
		assert.ok(!noCdn.egressOf(noCdn.repo("own"))!.includes("globalcdn.nuget.org"));
		const open = make("open");
		assert.equal(open.egressOf(open.repo("pub")), undefined, "an open network already reaches them; a list would only narrow it");
		assert.deepEqual(open.egressOf(open.repo("own")), ["example.com"]);
		for (const w of [closed, noCdn, open]) void w.close();
	});
});
