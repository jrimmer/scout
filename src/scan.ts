/**
 * Credentials that shouldn't be in a pull request, a note, the audit trail or the search index. Built-in patterns for
 * the common formats; a precise scanner (gitleaks and the like) is a later step. Matches are reported by kind, never
 * echoed back.
 */
const PATTERNS: [kind: string, pattern: RegExp][] = [
	["private key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/],
	["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
	["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
	["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/],
	["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
	["OpenAI key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/],
	["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
	["Stripe key", /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/],
	["Forgejo/Gitea token", /\b(?:token|authorization)["':= ]+(?:token |bearer )?[0-9a-f]{40}\b/i],
	["password in a URL", /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]{6,}@/i],
];

export type Finding = { kind: string; line?: number };

/** What looks like a credential in `text`, by kind (and line number, for multi-line text). */
export function findSecrets(text: string): Finding[] {
	const findings: Finding[] = [];
	const lines = text.split("\n");
	lines.forEach((line, i) => {
		for (const [kind, pattern] of PATTERNS) {
			if (pattern.test(line)) findings.push({ kind, ...(lines.length > 1 ? { line: i + 1 } : {}) });
		}
	});
	return findings;
}

/** `text` with anything that looks like a credential replaced by `[redacted <kind>]`. */
export function redact(text: string): string {
	let out = text;
	for (const [kind, pattern] of PATTERNS) out = out.replace(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`), `[redacted ${kind}]`);
	return out;
}

/** Credentials a diff adds, with the file each is in. */
export function secretsInDiff(diff: string): { file: string; kind: string }[] {
	const found: { file: string; kind: string }[] = [];
	let file = "";
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++ ")) file = line.slice(4).replace(/^b\//, "");
		else if (line.startsWith("+") && !line.startsWith("+++")) {
			for (const { kind } of findSecrets(line.slice(1))) found.push({ file, kind });
		}
	}
	return found;
}
