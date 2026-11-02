import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { allowInReposFile, hostOf, whyNotHost } from "../src/egress.ts";
import { loadRegistries, registryHosts, registryName, unknownRegistries } from "../src/registries.ts";
import { LocalDriver } from "../src/drivers/local.ts";
import { Workspaces } from "../src/workspaces.ts";
import { tempDir } from "./helpers.ts";

const REGISTRIES = loadRegistries();

describe("package registries", () => {
	it("names ecosystems, with or without the @, and `all` stands for every one", () => {
		assert.equal(registryName(REGISTRIES, "@Python"), "python");
		assert.equal(registryName(REGISTRIES, "jvm"), "jvm");
		assert.equal(registryName(REGISTRIES, "all"), "all");
		assert.equal(registryName(REGISTRIES, "pythn"), undefined);
		assert.deepEqual(unknownRegistries(REGISTRIES, ["python", "pythn", "@all"]), ["pythn"]);
		assert.deepEqual(registryHosts(REGISTRIES, ["all"]).sort(), registryHosts(REGISTRIES, Object.keys(REGISTRIES)).sort());
	});

	it("lists exact hosts only: no wildcard, no address, nothing anyone can publish a page on", () => {
		for (const host of registryHosts(REGISTRIES, ["all"])) {
			assert.equal(whyNotHost(host), undefined, `${host} is a host Scout would allow`);
			assert.ok(!host.startsWith("*."), `${host} is not a wildcard`);
		}
	});

	it("leaves a registry's download hosts out when asked, and lists each host once", () => {
		assert.ok(registryHosts(REGISTRIES, ["dotnet"]).includes("globalcdn.nuget.org"));
		assert.ok(!registryHosts(REGISTRIES, ["dotnet"], false).includes("globalcdn.nuget.org"));
		assert.ok(registryHosts(REGISTRIES, ["dotnet"], false).includes("api.nuget.org"));
		assert.equal(registryHosts(REGISTRIES, ["python", "@python", "all"]).length, new Set(registryHosts(REGISTRIES, ["all"])).size);
		assert.deepEqual(registryHosts(REGISTRIES, ["nope"]), []);
	});

	it("comes from a file, which can add ecosystems and is refused if it names a host Scout wouldn't allow", () => {
		const dir = tempDir("scout-registries-file-");
		const write = (name: string, table: unknown) => {
			const path = join(dir, name);
			writeFileSync(path, JSON.stringify(table));
			return path;
		};
		const mine = loadRegistries(write("ok.json", { nix: { hosts: ["cache.nixos.org"] }, mirror: { hosts: ["artifactory.example.com"], cdn: ["blobs.example.com"] } }));
		assert.deepEqual(registryHosts(mine, ["mirror"]), ["artifactory.example.com", "blobs.example.com"]);
		assert.throws(() => loadRegistries(write("wild.json", { x: { hosts: ["*.amazonaws.com"] } })), /x lists \*\.amazonaws\.com, which I wouldn't allow/);
		assert.throws(() => loadRegistries(write("ip.json", { x: { hosts: ["10.0.0.1"] } })), /which I wouldn't allow/);
		assert.throws(() => loadRegistries(write("all.json", { all: { hosts: ["a.example.com"] } })), /can't be an ecosystem's name/);
		assert.throws(() => loadRegistries(write("empty.json", { x: { hosts: [] } })), /x\.hosts should be a list/);
		assert.throws(() => loadRegistries(join(dir, "missing.json")), /can't read the package registries/);
	});

	it("is asked for as @ecosystem, and saved as registries in the repos file, not as a host", () => {
		assert.equal(hostOf("@jvm"), "@jvm");
		assert.equal(whyNotHost("@all"), undefined);
		assert.equal(whyNotHost("@nope"), undefined, "whether the install has that ecosystem is for the one who asks to check");
		assert.match(whyNotHost("@jvm and more") ?? "", /isn't a host name/);
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
				sandbox: { image: "unused", network, registries: REGISTRIES, ...(registryCdns === undefined ? {} : { registryCdns }) },
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
