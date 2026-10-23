/**
 * Credentials that shouldn't be in a pull request (codehost.ts scans everything a push carries), a note, the audit
 * trail, the search index, an error people see, or what an MCP server hands the model. Built-in patterns for the
 * common formats and for the tokens Scout itself holds, plus the exact values of the secrets Scout loaded
 * (`rememberSecrets`), whatever their shape. Matches are reported by kind, never echoed back. A precise scanner
 * (gitleaks and the like) is a later step.
 */
const PATTERNS: [kind: string, pattern: RegExp][] = [
	["private key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/],
	["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
	["AWS secret key", /secret_?access_?key\w*["':= \t]+[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/i],
	["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
	["Slack token", /\b(?:xox[abeposr](?:\.xox[a-z])?|xapp)-[A-Za-z0-9-]{10,}/],
	["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
	["OpenAI key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/],
	["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
	["Stripe key", /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/],
	["Grafana token", /\b(?:glsa|glc)_[A-Za-z0-9_+/=-]{20,}/],
	["JWT", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{3,}/],
	// A bare 40-hex string is a commit hash as often as a token: only next to a name that says token, or in a header.
	[
		"Forgejo/Gitea token",
		/(?:token|authoriz\w*|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|credential)\w*["':= \t]+(?:(?:token|bearer|basic)\s+)?[0-9a-f]{40}\b/i,
	],
	["authorization header", /\b(?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token|digest)\s+[A-Za-z0-9._~+/=-]{8,}/i],
	["bearer token", /\bbearer\s+[A-Za-z0-9._~+/-]{16,}=*/i],
	["password in a URL", /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]{6,}@/i],
];

/** The whole of a private key, for redacting: the header alone says what it is, but the body is the secret. */
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;

/** Base64 long enough to hide a token; what it decodes to is scanned too. */
const BASE64 = /[A-Za-z0-9+/_-]{24,}={0,2}/g;

/** Longest first, so one that contains another is redacted whole. */
let known: string[] = [];

/**
 * Secrets Scout loaded (its tokens and keys, the MCP servers' `${NAME}` values), so they're found and redacted by
 * value, whatever they look like. Short values are skipped: they'd match ordinary text.
 */
export function rememberSecrets(values: Iterable<string | undefined>): void {
	const all = new Set(known);
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed !== undefined && trimmed.length >= 8) all.add(trimmed);
	}
	known = [...all].sort((a, b) => b.length - a.length);
}

export type Finding = { kind: string; line?: number };

/** What looks like a credential in `text`, by kind (and line number, for multi-line text). */
export function findSecrets(text: string): Finding[] {
	const findings: Finding[] = [];
	const lines = text.split("\n");
	lines.forEach((line, i) => {
		for (const kind of kindsIn(line)) findings.push({ kind, ...(lines.length > 1 ? { line: i + 1 } : {}) });
	});
	return findings;
}

/** The kinds of credential in one line, including in base64 it holds. */
function kindsIn(line: string): string[] {
	const kinds = plainKindsIn(line);
	for (const run of line.match(BASE64) ?? []) {
		const decoded = Buffer.from(run.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1");
		// Only text: random bytes would match nothing but cost the scan.
		if (!/^[\x20-\x7e\t\r\n]+$/.test(decoded)) continue;
		for (const kind of plainKindsIn(decoded)) if (!kinds.includes(`${kind} (base64)`)) kinds.push(`${kind} (base64)`);
	}
	return kinds;
}

function plainKindsIn(line: string): string[] {
	const kinds: string[] = [];
	if (known.some((value) => line.includes(value))) kinds.push("configured secret");
	for (const [kind, pattern] of PATTERNS) if (pattern.test(line)) kinds.push(kind);
	return kinds;
}

/** `text` with anything that looks like a credential replaced by `[redacted <kind>]`. */
export function redact(text: string): string {
	let out = text;
	for (const value of known) out = out.split(value).join("[redacted configured secret]");
	out = out.replace(PRIVATE_KEY_BLOCK, "[redacted private key]");
	for (const [kind, pattern] of PATTERNS) out = out.replace(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`), `[redacted ${kind}]`);
	return out;
}
