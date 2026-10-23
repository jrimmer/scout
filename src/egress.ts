import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

/**
 * When a sandbox can't reach a host it needs (an install, a download), Scout says so and asks whoever runs it to
 * allow that host for the repository, instead of people working out from a failed install that it's the network.
 * Sandboxes can't widen their own network: a person in the `egress` approvers (roles.json, named for egress itself;
 * approvers for every server don't count) decides, with a button, and an allowed host goes into the repository's egress
 * list (the repos file) for its new sandboxes. With no egress approvers named, nobody can allow one from Slack.
 */
export type EgressRequest = {
	id: number;
	repo: string;
	host: string;
	why: string;
	conversationId: number;
	state: "pending" | "allowed" | "declined";
	decidedBy?: string;
};

/**
 * What a sandbox may be allowed to reach from Slack: a host name on the internet, or `*.` and one domain under a public
 * suffix (`*.npmjs.org`, which spoond's allowlist takes as every host under it). Not an IP address or range, v4 or v6
 * (an address can be inside the network, or the cloud's metadata service, and spoond lets an allowlisted private
 * address through its firewall); not a name that stays inside the network or resolves to any address it's given; not a
 * wildcard over a public suffix (`*`, `*.com`, `*.co.uk`) or over a domain where anyone can have a host (`*.amazonaws.com`).
 * Whoever runs Scout can still put anything in the repos file themselves.
 *
 * A host name that resolves to a private address anyway (DNS rebinding, or just a bad record) is the substrate's to stop:
 * spoond checks the address a name resolves to when the sandbox connects and refuses private, link-local and host
 * addresses unless the allowlist names that address itself. Scout doesn't resolve names.
 */
export function whyNotHost(text: string): string | undefined {
	const checked = checkHost(text);
	return "reason" in checked ? checked.reason : undefined;
}

/** The host from what Scout or a log said (no scheme, path, port or credentials), if it's one Scout may ask for. */
export function hostOf(text: string): string | undefined {
	const checked = checkHost(text);
	return "host" in checked ? checked.host : undefined;
}

const NOT_A_HOST = "it isn't a host name; give just the host, like registry.npmjs.org.";
const ADDRESS = "it's an IP address, and I only ask for host names, like registry.npmjs.org. An address can be inside the network or the cloud's metadata service.";
const RANGE = "it's an address range, and I only ask for host names, like registry.npmjs.org.";
const INSIDE = "it's a name inside the network, or one that resolves to whatever address it's given, and sandboxes never get those.";
const WIDE = "a wildcard can only stand for the hosts under one domain, like *.npmjs.org; ask for the host itself.";
const SHARED_WILDCARD = "anyone can have a host under that domain, so ask for the exact host instead of a wildcard.";
const SUFFIX = "that's a domain suffix anyone can register under, not a host.";

/** Last labels that never leave the network, or aren't on the internet at all (RFC 6761, 6762, 8375, 9476, and habit). */
const INSIDE_NAMES = new Set(["localhost", "local", "localdomain", "internal", "intranet", "lan", "home", "corp", "private", "arpa", "test", "example", "invalid", "onion", "alt"]);
/** Domains whose names resolve to whatever address is written in them, or to loopback. */
const ANY_ADDRESS = ["nip.io", "sslip.io", "xip.io", "localtest.me", "lvh.me", "traefik.me"];
/** Domains where anyone can have a host: one host there may be fine, a wildcard over them isn't. */
const SHARED = [
	"amazonaws.com", "cloudfront.net", "azureedge.net", "windows.net", "azurewebsites.net", "googleapis.com", "googleusercontent.com",
	"appspot.com", "web.app", "firebaseapp.com", "github.io", "githubusercontent.com", "gitlab.io", "herokuapp.com", "vercel.app",
	"netlify.app", "pages.dev", "workers.dev", "r2.dev", "fly.dev", "deno.dev", "onrender.com", "blogspot.com", "ngrok.io", "ngrok.app",
	"ngrok-free.app", "trycloudflare.com", "digitaloceanspaces.com", "surge.sh", "glitch.me", "repl.co",
];
/** Second-level labels that make a public suffix under a country's domain (`co.uk`, `com.au`). */
const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "gob", "mil", "nic", "ltd", "plc", "sch", "gen", "biz", "info", "nom", "web", "int"]);

const under = (name: string, domain: string) => name === domain || name.endsWith(`.${domain}`);

/** A suffix people register names under (`com`, `co.uk`, `github.io`), as near as Scout can tell without the full list. */
function publicSuffix(name: string): boolean {
	const labels = name.split(".");
	if (labels.length === 1) return true;
	if (labels.length === 2 && labels[1]!.length === 2 && SECOND_LEVEL.has(labels[0]!)) return true;
	return SHARED.includes(name);
}

function checkHost(text: string): { host: string } | { reason: string } {
	const raw = text
		.trim()
		.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
		.replace(/^[^@/]*@/, "");
	const range = /^(.+)\/\d{1,3}$/.exec(raw);
	if (range !== null && isIP(range[1]!.replace(/^\[|\]$/g, "")) !== 0) return { reason: RANGE };
	let host = raw.split(/[/?#]/)[0]!;
	if (host.startsWith("[") || isIP(host) !== 0) return { reason: ADDRESS };
	host = host
		.replace(/:\d+$/, "")
		.toLowerCase()
		.replace(/\.$/, "");
	if (isIP(host) !== 0) return { reason: ADDRESS };
	if (host === "*") return { reason: WIDE };
	const wildcard = host.startsWith("*.");
	const name = wildcard ? host.slice(2) : host;
	if (name.includes("*")) return { reason: WIDE };
	const labels = name.split(".");
	if (name.length > 253 || !labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return { reason: NOT_A_HOST };
	// Numbers in the last label: an address written another way (127.1, 2130706433, 0x7f.0.0.1).
	if (/^(\d+|0x[0-9a-f]+)$/.test(labels.at(-1)!)) return { reason: ADDRESS };
	if (INSIDE_NAMES.has(labels.at(-1)!) || ANY_ADDRESS.some((d) => under(name, d))) return { reason: INSIDE };
	if (publicSuffix(name)) return { reason: wildcard ? WIDE : labels.length === 1 ? NOT_A_HOST : SUFFIX };
	if (!/^([a-z]{2,63}|xn--[a-z0-9-]+)$/.test(labels.at(-1)!)) return { reason: NOT_A_HOST };
	if (wildcard && SHARED.some((d) => under(name, d))) return { reason: SHARED_WILDCARD };
	return { host };
}

export class EgressRequests {
	readonly #db: DatabaseSync;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.#db = new DatabaseSync(path, { timeout: 5000 });
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS egress_requests (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				repo TEXT NOT NULL,
				host TEXT NOT NULL,
				why TEXT NOT NULL,
				conversation_id INTEGER NOT NULL,
				state TEXT NOT NULL DEFAULT 'pending',
				decided_by TEXT,
				created_at INTEGER NOT NULL,
				decided_at INTEGER
			);
		`);
	}

	/** A new request, or the one already waiting for this host in this repository (so it's asked once). */
	ask(r: { repo: string; host: string; why: string; conversationId: number }, now = Date.now()): { request: EgressRequest; isNew: boolean } {
		const waiting = this.#db.prepare("SELECT * FROM egress_requests WHERE repo = ? AND host = ? AND state = 'pending'").get(r.repo, r.host);
		if (waiting !== undefined) return { request: toRequest(waiting), isNew: false };
		const { lastInsertRowid } = this.#db
			.prepare("INSERT INTO egress_requests (repo, host, why, conversation_id, created_at) VALUES (?, ?, ?, ?, ?)")
			.run(r.repo, r.host, r.why, r.conversationId, now);
		return { request: this.get(Number(lastInsertRowid))!, isNew: true };
	}

	get(id: number): EgressRequest | undefined {
		const row = this.#db.prepare("SELECT * FROM egress_requests WHERE id = ?").get(id);
		return row === undefined ? undefined : toRequest(row);
	}

	/** Decide a waiting request; undefined if it was already decided (someone else got there first). */
	decide(id: number, allowed: boolean, by: string, now = Date.now()): EgressRequest | undefined {
		const done = this.#db
			.prepare("UPDATE egress_requests SET state = ?, decided_by = ?, decided_at = ? WHERE id = ? AND state = 'pending'")
			.run(allowed ? "allowed" : "declined", by, now, id);
		return done.changes === 0 ? undefined : this.get(id);
	}

	close(): void {
		this.#db.close();
	}
}

function toRequest(row: Record<string, unknown>): EgressRequest {
	return {
		id: Number(row.id),
		repo: String(row.repo),
		host: String(row.host),
		why: String(row.why),
		conversationId: Number(row.conversation_id),
		state: String(row.state) as EgressRequest["state"],
		...(row.decided_by === null ? {} : { decidedBy: String(row.decided_by) }),
	};
}

/**
 * Add `host` to a repository's egress list in the repos file (JSON), keeping a backup and replacing the file in one
 * step, so a crash never leaves it half written. False when the repository isn't in the file (it's configured in
 * the environment instead).
 */
export function allowInReposFile(path: string, repo: string, host: string): boolean {
	if (!existsSync(path)) return false;
	const list = JSON.parse(readFileSync(path, "utf8")) as { name?: string; egress?: string[] }[];
	const entry = list.find((r) => r.name === repo);
	if (entry === undefined) return false;
	if (entry.egress?.includes(host) === true) return true;
	entry.egress = [...(entry.egress ?? []), host];
	copyFileSync(path, `${path}.bak`);
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporary, path);
	return true;
}

/**
 * `ask_for_network`: for a thread whose sandbox couldn't reach a host. `propose` records the request and asks the
 * people who decide; what it returns is what the thread hears.
 */
export function egressExtension(propose: (conversationId: number, host: string, why: string) => Promise<string>) {
	const ask = defineTool({
		name: "ask_for_network",
		description:
			"Your sandbox couldn't reach a host it needs (a package registry, a download): DNS failures, 'could not resolve " +
			"host', connections refused or timing out during an install. Ask whoever runs you to allow that host for this " +
			"repository's sandboxes. Use it once per host, say in the thread that you've asked, and don't try to work " +
			"around the network.",
		parameters: Type.Object({
			host: Type.String({ description: "The host name, e.g. registry.npmjs.org (no scheme or path)" }),
			why: Type.String({ description: "What needed it, in a sentence: the command and what it was fetching" }),
		}),
		execute: async (args, api) => {
			const checked = checkHost(args.host);
			if ("reason" in checked) throw new Error(`"${args.host}" isn't something I can ask to allow: ${checked.reason}`);
			const host = checked.host;
			return { output: [{ type: "text", text: await propose(api.conversationId, host, args.why) }] };
		},
	});
	return defineExtension({ name: "egress", tools: [ask] });
}
