import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
});
