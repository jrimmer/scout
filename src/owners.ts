/**
 * Who should review a change: the repository's CODEOWNERS for the files it touches, or else the people who changed
 * those files most recently. So Scout's pull requests reach someone instead of waiting to be noticed.
 */
export type Owners = { users: string[]; teams: string[] };

/** Where code hosts look for the file, in their order. */
export const CODEOWNERS_PATHS = [".forgejo/CODEOWNERS", ".gitea/CODEOWNERS", ".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

type Rule = { pattern: RegExp; owners: string[] };

/** CODEOWNERS lines: a gitignore-style pattern, then owners (`@user`, `@org/team`, or an email, which is skipped). */
export function parseCodeOwners(text: string): Rule[] {
	const rules: Rule[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.replace(/(^|\s)#.*$/, "").trim();
		if (line === "") continue;
		const [pattern, ...owners] = line.split(/\s+/);
		rules.push({ pattern: patternToRegExp(pattern!), owners: owners.filter((o) => o.startsWith("@")).map((o) => o.slice(1)) });
	}
	return rules;
}

/** The owners of the files, the last matching rule winning per file, as on GitHub and Forgejo. */
export function ownersOf(rules: Rule[], files: readonly string[]): Owners {
	const users = new Set<string>();
	const teams = new Set<string>();
	for (const file of files) {
		const rule = rules.findLast((r) => r.pattern.test(file));
		for (const owner of rule?.owners ?? []) (owner.includes("/") ? teams : users).add(owner);
	}
	return { users: [...users], teams: [...teams] };
}

function patternToRegExp(pattern: string): RegExp {
	const anchored = pattern.startsWith("/");
	let p = pattern.replace(/^\//, "");
	const directory = p.endsWith("/");
	if (directory) p = `${p}**`;
	const body = p
		.split(/(\*\*\/|\/\*\*|\*\*|\*|\?)/)
		.map((part) => {
			if (part === "**/") return "(?:.*/)?";
			if (part === "/**") return "(?:/.*)?";
			if (part === "**") return ".*";
			if (part === "*") return "[^/]*";
			if (part === "?") return "[^/]";
			return part.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		})
		.join("");
	// Without a slash before its end, a pattern matches at any depth; a name also matches a directory's contents.
	const anywhere = !anchored && !p.slice(0, -1).includes("/");
	return new RegExp(`^${anywhere ? "(?:.*/)?" : ""}${body}(?:/.*)?$`);
}

/**
 * Who to ask when there's no CODEOWNERS rule: the people (as logins) who most recently changed the files, most
 * frequent first, at most `limit`, never Scout itself or whoever asked for the change.
 */
export function recentOwners(authorLogins: readonly (string | undefined)[], exclude: readonly string[], limit = 2): string[] {
	const counts = new Map<string, number>();
	const skip = new Set(exclude.map((e) => e.toLowerCase()));
	for (const login of authorLogins) {
		if (login === undefined || skip.has(login.toLowerCase())) continue;
		counts.set(login, (counts.get(login) ?? 0) + 1);
	}
	return [...counts].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([login]) => login);
}
