import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { loadConfig } from "../src/config.ts";
import { openScout } from "../src/scout.ts";
import { AutheliaFile, approversOf, parseAutheliaUsers } from "../src/directory.ts";
import { Permissions } from "../src/permissions.ts";

const USERS = `---
users:
  jrimmer:
    displayname: 'Jason Rimmer'
    password: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA'
    email: jason@rimmer.net
    groups:
      - admins
      - users
  trina:
    displayname: "Trina Rimmer"
    password: "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$b3RoZXI"
    email: 'trina@rimmer.net'   # a comment
    groups: [users, user]
`;

describe("the identity provider", () => {
	it("reads Authelia's users file: usernames, emails and groups, never passwords", () => {
		const people = parseAutheliaUsers(USERS);
		assert.deepEqual(people, [
			{ username: "jrimmer", email: "jason@rimmer.net", groups: ["admins", "users"] },
			{ username: "trina", email: "trina@rimmer.net", groups: ["users", "user"] },
		]);
		assert.doesNotMatch(JSON.stringify(people), /argon2/);
	});

	it("finds people by email, reading the file again only after a while", async () => {
		let reads = 0;
		const directory = new AutheliaFile(async () => (reads++, USERS));
		assert.equal((await directory.byEmail("Jason@Rimmer.net"))?.username, "jrimmer");
		assert.equal(await directory.byEmail("nobody@example.com"), undefined);
		assert.equal(reads, 1);
	});

	it("names who may approve changes, per server or for all", () => {
		const roles = { approve: { "*": ["admins"], grafana: ["devops-leads"] } };
		assert.deepEqual(approversOf(roles, "grafana"), ["devops-leads"]);
		assert.deepEqual(approversOf(roles, "status"), ["admins"]);
		assert.equal(approversOf({}, "grafana"), undefined, "no roles file: anyone admitted may approve");
	});

	it("links a Slack user to their code host login through the directory, the people file winning", async () => {
		const asked: string[] = [];
		const permissions = new Permissions({
			config: { mode: "enforce", people: { UOVERRIDE: "someone-else" } },
			codeHost: { kind: "forgejo", apiUrl: "http://forge/api/v1", token: "t" },
			loginOf: async (user) => (user === "UJASON" ? "jrimmer" : undefined),
			fetch: (async (url: string | URL | Request) => {
				asked.push(new URL(String(url)).pathname);
				return Response.json({ permission: "write" });
			}) as typeof fetch,
		});
		assert.equal((await permissions.admit("UJASON", "lacy.casa/gatus")).ok, true);
		assert.equal((await permissions.admit("UOVERRIDE", "lacy.casa/gatus")).ok, true);
		const stranger = await permissions.admit("USTRANGER", "lacy.casa/gatus");
		assert.ok(!stranger.ok && /don't know your Forgejo account/.test(stranger.reason));
		assert.deepEqual(asked, ["/api/v1/repos/lacy.casa/gatus/collaborators/jrimmer/permission", "/api/v1/repos/lacy.casa/gatus/collaborators/someone-else/permission"]);
	});

	it("lets people ask for work by their groups, found by the people file or their Slack email", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "scout-roles-")));
		const remote = join(root, "remote.git");
		execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
		mkdirSync(join(root, "profile"));
		writeFileSync(join(root, "users_database.yml"), USERS);
		writeFileSync(join(root, "roles.json"), JSON.stringify({ request: { "*": ["admins"], gatus: ["admins", "users"] } }));
		writeFileSync(join(root, "people.json"), JSON.stringify({ UJASON: "jrimmer" }));
		writeFileSync(join(root, "repos.json"), JSON.stringify([{ name: "gatus", gitUrl: remote, slug: "o/gatus" }]));
		const config = loadConfig({
			SCOUT_REPO_URL: remote,
			SCOUT_REPO_SLUG: "o/r",
			SCOUT_REPOS_FILE: join(root, "repos.json"),
			SCOUT_CODEHOST_TOKEN: "t",
			SCOUT_CODEHOST_API: "http://forge/api/v1",
			SCOUT_DATA_DIR: join(root, "data"),
			SCOUT_PROFILE_DIR: join(root, "profile"),
			SCOUT_REQUESTER_CHECK: "enforce",
			SCOUT_PEOPLE_FILE: join(root, "people.json"),
			SCOUT_DIRECTORY: "authelia-file",
			SCOUT_DIRECTORY_SOURCE: join(root, "users_database.yml"),
			SCOUT_ROLES_FILE: join(root, "roles.json"),
		});
		const scout = await openScout({
			config,
			storage: new MemoryStorage(),
			dataDir: config.dataDir,
			instance: "t",
			context,
			models: createModels(),
			watchProfile: false,
			emailOf: async (user) => (user === "UTRINA" ? "trina@rimmer.net" : undefined),
			fetch: (async () => assert.fail("the code host isn't asked when groups decide")) as typeof fetch,
		});
		const admit = scout.admitter(async () => []);
		const ask = (user: string, repo?: string) => admit({ user, channelName: "x", ...(repo === undefined ? {} : { repo }), starting: true });
		assert.deepEqual(await ask("UJASON"), { ok: true }, "an admin, by the people file");
		assert.deepEqual(await ask("UTRINA", "gatus"), { ok: true }, "a user, by email, where users may ask");
		const trina = await ask("UTRINA");
		assert.ok(!trina.ok && /only take work in r from people in admins/.test(trina.reason));
		const stranger = await ask("UNOBODY");
		assert.ok(!stranger.ok && /can't find you in the directory/.test(stranger.reason));
		await scout.close();
	});
});
