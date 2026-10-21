import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

/**
 * When a sandbox can't reach a host it needs (an install, a download), Scout says so and asks whoever runs it to
 * allow that host for the repository, instead of people working out from a failed install that it's the network.
 * Sandboxes can't widen their own network: a person in the `egress` approvers (roles.json) decides, with a button,
 * and an allowed host goes into the repository's egress list (the repos file) for its new sandboxes.
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

/** A bare host name, IP or CIDR from what Scout or a log said: no scheme, path, port or credentials. */
export function hostOf(text: string): string | undefined {
	const cidr = text.trim();
	if (/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(cidr)) return cidr;
	let host = text.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
	host = host.replace(/^[^@/]*@/, "").split(/[/?#]/)[0]!;
	if (!host.includes("/") && /:\d+$/.test(host)) host = host.replace(/:\d+$/, "");
	host = host.toLowerCase().replace(/\.$/, "");
	if (/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(host)) return host;
	if (/^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/.test(host)) return host;
	return undefined;
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
			const host = hostOf(args.host);
			if (host === undefined) throw new Error(`"${args.host}" isn't a host name I can ask for; give just the host, like registry.npmjs.org.`);
			return { output: [{ type: "text", text: await propose(api.conversationId, host, args.why) }] };
		},
	});
	return defineExtension({ name: "egress", tools: [ask] });
}
