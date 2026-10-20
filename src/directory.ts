import { readFileSync } from "node:fs";

/**
 * Who people are and which groups they're in, from the organization's identity provider: the source of truth for
 * roles, as Entra or Google Workspace is elsewhere. Scout links a Slack user to a person by their email, then:
 * - their username is their code host login (the code host signs people in through the same provider), for the
 *   requester check (permissions.ts);
 * - their groups decide who may approve changes made through tools (`SCOUT_ROLES_FILE`, mcp.ts).
 *
 * Adapters: Authelia's users file (`authelia-file`). Entra (Graph), Google (Admin SDK) or LDAP would each be one more.
 */
export type Person = { username: string; email: string; groups: string[] };

export interface Directory {
	byEmail(email: string): Promise<Person | undefined>;
}

/**
 * Authelia's file backend (`users_database.yml`): usernames, emails and groups. Password hashes are dropped as it's
 * read, never kept or logged. Read again at most every `ttlMs`.
 */
export class AutheliaFile implements Directory {
	readonly #read: () => Promise<string>;
	readonly #ttlMs: number;
	#cache: { at: number; people: Person[] } | undefined;

	constructor(read: () => Promise<string>, ttlMs = 10 * 60 * 1000) {
		this.#read = read;
		this.#ttlMs = ttlMs;
	}

	async byEmail(email: string): Promise<Person | undefined> {
		if (this.#cache === undefined || Date.now() - this.#cache.at > this.#ttlMs) {
			this.#cache = { at: Date.now(), people: parseAutheliaUsers(await this.#read()) };
		}
		return this.#cache.people.find((p) => p.email.toLowerCase() === email.toLowerCase());
	}
}

/** The users in Authelia's users file: just enough YAML for its fixed shape, and never a password. */
export function parseAutheliaUsers(text: string): Person[] {
	const people: Person[] = [];
	let current: Person | undefined;
	let inGroups = false;
	let inUsers = false;
	for (const raw of text.split("\n")) {
		const line = raw.replace(/\s+#.*$/, "");
		if (line.trim() === "" || line.trim() === "---") continue;
		const indent = line.length - line.trimStart().length;
		const item = line.trim();
		if (indent === 0) {
			inUsers = item === "users:";
			continue;
		}
		if (!inUsers) continue;
		if (indent === 2 && item.endsWith(":")) {
			current = { username: unquote(item.slice(0, -1)), email: "", groups: [] };
			people.push(current);
			inGroups = false;
			continue;
		}
		if (current === undefined) continue;
		if (item.startsWith("- ")) {
			if (inGroups) current.groups.push(unquote(item.slice(2)));
			continue;
		}
		const colon = item.indexOf(":");
		const key = item.slice(0, colon).trim();
		const value = item.slice(colon + 1).trim();
		inGroups = key === "groups";
		if (key === "email") current.email = unquote(value);
		if (key === "groups" && value.startsWith("[")) {
			current.groups.push(...value.slice(1, -1).split(",").map((g) => unquote(g.trim())).filter(Boolean));
			inGroups = false;
		}
	}
	return people.filter((p) => p.email !== "");
}

function unquote(value: string): string {
	return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
}

/**
 * Who may approve a change made through a tool (mcp.ts `writes: "approve"`), by group, per MCP server or `*` for the
 * rest. The operator's file, not the profile Scout edits: `{ "approve": { "*": ["admins"], "grafana": ["admins"] } }`.
 */
export type Roles = { approve?: Record<string, string[]> };

export function loadRoles(path: string | undefined): Roles {
	return path === undefined ? {} : (JSON.parse(readFileSync(path, "utf8")) as Roles);
}

/** The groups that may approve changes to `server`; undefined when the roles file says nothing (anyone admitted may). */
export function approversOf(roles: Roles, server: string): string[] | undefined {
	return roles.approve?.[server] ?? roles.approve?.["*"];
}
