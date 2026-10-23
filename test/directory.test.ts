import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { loadConfig } from "../src/config.ts";
import { openScout } from "../src/scout.ts";
import { AutheliaFile, approversOf, parseAutheliaUsers } from "../src/directory.ts";
import { Permissions } from "../src/permissions.ts";
import { tempDir } from "./helpers.ts";

const USERS = `---
users:
  alex:
    displayname: 'Jason Rimmer'
    password: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA'
    email: alex@example.com
    groups:
      - admins
      - users
  sam:
    displayname: "Sam Lee"
    password: "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$b3RoZXI"
    email: 'sam@example.com'   # a comment
    groups: [users, user]
`;

describe("the identity provider", () => {
	it("reads Authelia's users file: usernames, emails and groups, never passwords", () => {
		const people = parseAutheliaUsers(USERS);
		assert.deepEqual(people, [
			{ username: "alex", email: "alex@example.com", groups: ["admins", "users"] },
			{ username: "sam", email: "sam@example.com", groups: ["users", "user"] },
		]);
		assert.doesNotMatch(JSON.stringify(people), /argon2/);
	});

	it("finds people by email, reading the file again only after a while", async () => {
		let reads = 0;
		const directory = new AutheliaFile(async () => (reads++, USERS));
		assert.equal((await directory.byEmail("Alex@Example.com"))?.username, "alex");
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
			loginOf: async (user) => (user === "UALEX" ? "alex" : undefined),
			fetch: (async (url: string | URL | Request) => {
				asked.push(new URL(String(url)).pathname);
				return Response.json({ permission: "write" });
			}) as typeof fetch,
		});
		assert.equal((await permissions.admit("UALEX", "example.org/gatus")).ok, true);
		assert.equal((await permissions.admit("UOVERRIDE", "example.org/gatus")).ok, true);
		const stranger = await permissions.admit("USTRANGER", "example.org/gatus");
		assert.ok(!stranger.ok && /don't know your Forgejo account/.test(stranger.reason));
		assert.deepEqual(asked, ["/api/v1/repos/example.org/gatus/collaborators/alex/permission", "/api/v1/repos/example.org/gatus/collaborators/someone-else/permission"]);
	});

	it("lets people ask for work by their groups, found by the people file or their Slack email", async () => {
		const root = tempDir("scout-roles-");
		const remote = join(root, "remote.git");
		execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
		mkdirSync(join(root, "profile"));
		writeFileSync(join(root, "users_database.yml"), USERS);
		writeFileSync(join(root, "roles.json"), JSON.stringify({ request: { "*": ["admins"], gatus: ["admins", "users"] } }));
		writeFileSync(join(root, "people.json"), JSON.stringify({ UALEX: "alex" }));
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
			emailOf: async (user) => (user === "USAM" ? "sam@example.com" : undefined),
			fetch: (async () => assert.fail("the code host isn't asked when groups decide")) as typeof fetch,
		});
		const admit = scout.admitter(async () => []);
		const ask = (user: string, repo?: string) => admit({ user, channelName: "x", ...(repo === undefined ? {} : { repo }), starting: true });
		assert.deepEqual(await ask("UALEX"), { ok: true }, "an admin, by the people file");
		assert.deepEqual(await ask("USAM", "gatus"), { ok: true }, "a user, by email, where users may ask");
		const sam = await ask("USAM");
		assert.ok(!sam.ok && /only take work in r from people in admins/.test(sam.reason));
		const stranger = await ask("UNOBODY");
		assert.ok(!stranger.ok && /can't find you in the directory/.test(stranger.reason));
		await scout.close();
	});

	/** Scout with the users file above, `roles`, and `people`, on settings `env` adds to. */
	async function withRoles(roles: unknown, people: Record<string, string>, env: Record<string, string>, body: (scout: Awaited<ReturnType<typeof openScout>>) => Promise<void>) {
		const root = tempDir("scout-roles-");
		const remote = join(root, "remote.git");
		execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
		mkdirSync(join(root, "profile"));
		writeFileSync(join(root, "users_database.yml"), USERS);
		writeFileSync(join(root, "roles.json"), JSON.stringify(roles));
		writeFileSync(join(root, "people.json"), JSON.stringify(people));
		const config = loadConfig({
			SCOUT_REPO_URL: remote,
			SCOUT_REPO_SLUG: "o/r",
			SCOUT_CODEHOST_TOKEN: "t",
			SCOUT_CODEHOST_API: "http://forge/api/v1",
			SCOUT_DATA_DIR: join(root, "data"),
			SCOUT_PROFILE_DIR: join(root, "profile"),
			SCOUT_PEOPLE_FILE: join(root, "people.json"),
			SCOUT_DIRECTORY: "authelia-file",
			SCOUT_DIRECTORY_SOURCE: join(root, "users_database.yml"),
			SCOUT_ROLES_FILE: join(root, "roles.json"),
			...env,
		});
		const scout = await openScout({
			config,
			storage: new MemoryStorage(),
			dataDir: config.dataDir,
			instance: "t",
			context,
			models: createModels(),
			watchProfile: false,
			emailOf: async (user) => ({ UALEX: "alex@example.com", USAM: "sam@example.com" })[user],
			fetch: (async () => assert.fail("the code host isn't asked when groups decide")) as typeof fetch,
		});
		try {
			await body(scout);
		} finally {
			await scout.close();
			rmSync(root, { recursive: true, force: true });
		}
	}

	it("applies the roles file's request groups even with the requester check off", async () => {
		await withRoles({ request: { "*": ["admins"] } }, {}, { SCOUT_REQUESTER_CHECK: "off" }, async (scout) => {
			const admit = scout.admitter(async () => []);
			const ask = (user: string) => admit({ user, channelName: "x", starting: true });
			assert.deepEqual(await ask("UALEX"), { ok: true });
			const sam = await ask("USAM");
			assert.ok(!sam.ok && /only take work in r from people in admins/.test(sam.reason), "the operator narrowed it; off doesn't undo that");
			const stranger = await ask("UNOBODY");
			assert.ok(!stranger.ok && /can't find you in the directory/.test(stranger.reason));
			assert.equal((await scout.mayAsk("sam", { name: "r", slug: "o/r" })).ok, false, "on the code host too");
		});
	});

	it("on GitHub, takes a login for a person only through the people file, never by its name", async () => {
		const github = { SCOUT_CODEHOST: "github", SCOUT_CODEHOST_API: "https://api.github.example" };
		await withRoles({ request: { "*": ["admins"] } }, { UALEX: "alex-gh" }, github, async (scout) => {
			const repo = { name: "r", slug: "o/r" };
			// Anyone can sign up as "alex" on github.com: that's not the directory's alex.
			const impostor = await scout.mayAsk("alex", repo);
			assert.ok(!impostor.ok && /can't find alex in the directory: whoever runs me can link your GitHub account to you in the people file/.test(impostor.reason));
			// The people file says which Slack user alex-gh is; their Slack email says who they are.
			assert.deepEqual(await scout.mayAsk("alex-gh", repo), { ok: true });
			assert.equal((await scout.mayAsk("sam", repo)).ok, false);
			assert.equal(await scout.loginOf("USAM"), undefined, "a directory username isn't a GitHub login");
			assert.equal(await scout.loginOf("UALEX"), "alex-gh");
		});
		// Forgejo behind the directory: its logins are directory usernames, unless the operator says they aren't.
		await withRoles({ request: { "*": ["admins"] } }, {}, {}, async (scout) => {
			assert.deepEqual(await scout.mayAsk("alex", { name: "r", slug: "o/r" }), { ok: true });
		});
		await withRoles({ request: { "*": ["admins"] } }, {}, { SCOUT_CODEHOST_LOGINS: "separate" }, async (scout) => {
			assert.equal((await scout.mayAsk("alex", { name: "r", slug: "o/r" })).ok, false);
		});
	});

	it("counts as admins the groups that may approve changes to everything, and nobody without them", async () => {
		await withRoles({ approve: { "*": ["admins"], grafana: ["users"] } }, {}, {}, async (scout) => {
			assert.equal(await scout.isAdmin("UALEX"), true);
			assert.equal(await scout.isAdmin("USAM"), false, "approving one server's changes isn't being an admin");
			assert.equal(await scout.isAdmin("UNOBODY"), false);
		});
		await withRoles({}, {}, {}, async (scout) => {
			assert.equal(await scout.isAdmin("UALEX"), false, "no roles, no admins in Slack");
		});
	});
});
