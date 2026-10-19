import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Secrets from somewhere better than a plain `.env`, with what a single host has:
 *
 * - `NAME_FILE=/path`: read NAME from a file (Docker and Kubernetes secrets), for the names in `SECRETS`.
 * - `NAME=file:/path`: the same, inline.
 * - `NAME=cred:name`: a systemd credential (`LoadCredential=name:…`), from $CREDENTIALS_DIRECTORY.
 * - `NAME=op://vault/item/field`: a 1Password reference, read with the `op` CLI (a service account token in
 *   OP_SERVICE_ACCOUNT_TOKEN, or a signed-in session).
 *
 * Resolved values replace the references in the environment Scout reads its configuration from. `rotate()` reads
 * them all again (SIGHUP), so a rotated token takes effect without a restart where Scout reads it per use.
 */
export type SecretSource = { name: string; reference: string };

export async function resolveSecrets(env: NodeJS.ProcessEnv = process.env, read: Readers = defaultReaders): Promise<SecretSource[]> {
	const sources: SecretSource[] = [];
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		const name = key.endsWith("_FILE") ? key.slice(0, -"_FILE".length) : undefined;
		if (name !== undefined && SECRETS.has(name)) {
			if (env[name] === undefined || env[name] === "") sources.push({ name, reference: `file:${value}` });
		} else if (/^(file:|cred:|op:\/\/)/.test(value)) {
			sources.push({ name: key, reference: value });
		}
	}
	for (const source of sources) env[source.name] = await resolve(source.reference, env, read);
	return sources;
}

/** Read every referenced secret again, in place. Returns the names that changed. */
export async function rotate(sources: readonly SecretSource[], env: NodeJS.ProcessEnv = process.env, read: Readers = defaultReaders): Promise<string[]> {
	const changed: string[] = [];
	for (const source of sources) {
		const value = await resolve(source.reference, env, read);
		if (env[source.name] !== value) changed.push(source.name);
		env[source.name] = value;
	}
	return changed;
}

export type Readers = { file: (path: string) => Promise<string>; onePassword: (reference: string) => Promise<string> };

const defaultReaders: Readers = {
	file: async (path) => (await readFile(path, "utf8")).trim(),
	onePassword: async (reference) => {
		try {
			return (await run("op", ["read", "--no-newline", reference])).stdout;
		} catch (error) {
			throw new Error(`couldn't read ${reference} with the 1Password CLI: ${(error as Error).message.split("\n")[0]}`);
		}
	},
};

async function resolve(reference: string, env: NodeJS.ProcessEnv, read: Readers): Promise<string> {
	if (reference.startsWith("file:")) return read.file(reference.slice("file:".length));
	if (reference.startsWith("cred:")) {
		const dir = env.CREDENTIALS_DIRECTORY;
		if (dir === undefined) throw new Error(`${reference}: not running with systemd credentials (no CREDENTIALS_DIRECTORY)`);
		return read.file(join(dir, reference.slice("cred:".length)));
	}
	if (reference.startsWith("op://")) return read.onePassword(reference);
	return reference;
}

/**
 * The variables that hold secrets, which may come from `NAME_FILE`. Only these: Scout's own `*_FILE` settings
 * (`SCOUT_MCP_FILE` and the like) name configuration files, not secrets.
 */
export const SECRETS = new Set([
	"SLACK_BOT_TOKEN",
	"SLACK_APP_TOKEN",
	"SCOUT_CODEHOST_TOKEN",
	"SCOUT_GATEWAY_KEY",
	"SCOUT_SPOOND_TOKEN",
	"SCOUT_DASH_PASSWORD_HASH",
	"SCOUT_METRICS_TOKEN",
	"SCOUT_OTLP_HEADERS",
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"LITESTREAM_ACCESS_KEY_ID",
	"LITESTREAM_SECRET_ACCESS_KEY",
]);
