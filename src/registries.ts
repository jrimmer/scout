import { readFileSync } from "node:fs";
import { join } from "node:path";
import { whyNotHost } from "./egress.ts";

/**
 * The package registries a sandbox may reach so it can install the tools a task needs (a Python library, a JDK, a
 * Terraform provider) without anyone approving each host. They're data, `registries.json` (copy it and point
 * `SCOUT_REGISTRIES_FILE` at the copy to add a mirror, an internal registry or another ecosystem): each ecosystem has
 * the `hosts` of its registries and, apart, the `cdn` hosts a registry sends downloads to (a redirect), which
 * `SCOUT_REGISTRY_CDNS=off` leaves out. A repository names ecosystems (`registries` in the repos file,
 * `SCOUT_REPO_REGISTRIES`) and gets their hosts on top of its egress list. Public repositories get all of them unless
 * they say otherwise; a private one gets none until someone allows `@python` (or `@all`) for it from Slack.
 *
 * Each host must be one Scout would allow from Slack (egress.ts `whyNotHost`): a host name, not an address, and no
 * wildcard over a place anyone can publish a page (GitHub, S3, CloudFront). A file that has any other is refused at start.
 */
export type RegistryTable = Record<string, { about?: string; hosts: string[]; cdn?: string[] }>;

/** `@all` stands for every ecosystem in the table. */
export const ALL_REGISTRIES = "all";

export const DEFAULT_REGISTRIES_FILE = join(import.meta.dirname, "..", "registries.json");

/** The table in `path`, checked; throws a plain message naming the file when it can't be used. */
export function loadRegistries(path = DEFAULT_REGISTRIES_FILE): RegistryTable {
	let table: unknown;
	try {
		table = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`can't read the package registries in ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof table !== "object" || table === null || Array.isArray(table)) throw new Error(`${path} should be an object of ecosystems, { "python": { "hosts": [...] }, … }`);
	for (const [name, entry] of Object.entries(table)) {
		const e = entry as { hosts?: unknown; cdn?: unknown };
		if (name === ALL_REGISTRIES || !/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`${path}: "${name}" can't be an ecosystem's name (lowercase letters, digits and dashes, and not "all")`);
		for (const key of ["hosts", "cdn"] as const) {
			const list = e[key];
			if (key === "cdn" && list === undefined) continue;
			if (!Array.isArray(list) || (key === "hosts" && list.length === 0) || list.some((h) => typeof h !== "string")) throw new Error(`${path}: ${name}.${key} should be a list of host names`);
			for (const host of list as string[]) {
				const why = whyNotHost(host);
				if (why !== undefined) throw new Error(`${path}: ${name} lists ${host}, which I wouldn't allow: ${why}`);
			}
		}
	}
	return table as RegistryTable;
}

/** `python`, `@python`, `all`, `@all` → the name, if the table has it. */
export function registryName(table: RegistryTable, text: string): string | undefined {
	const name = text.trim().replace(/^@/, "").toLowerCase();
	return name === ALL_REGISTRIES || Object.hasOwn(table, name) ? name : undefined;
}

/** The hosts for these ecosystems (names, or `all`); unknown names are ignored. Each host once. */
export function registryHosts(table: RegistryTable, names: string[], cdns = true): string[] {
	const wanted = names.map((n) => registryName(table, n));
	const chosen = wanted.includes(ALL_REGISTRIES) ? Object.keys(table) : wanted.filter((n): n is string => n !== undefined);
	return [...new Set(chosen.flatMap((name) => [...table[name]!.hosts, ...(cdns ? (table[name]!.cdn ?? []) : [])]))];
}

/** Names in a list that aren't in the table, so a typo is told at start. */
export function unknownRegistries(table: RegistryTable, names: string[]): string[] {
	return names.filter((n) => registryName(table, n) === undefined);
}
