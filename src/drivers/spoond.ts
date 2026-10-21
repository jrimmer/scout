import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { packagedDaemon } from "@earendil-works/pi-env";
import { SpoondRestEnv } from "./spoond-rest.ts";
import type { NetworkPolicy, SandboxDriver, SandboxHandle, SandboxSpec } from "./types.ts";

/**
 * spoond: a Firecracker microVM per sandbox, leased from spoond's API. A thread's lease is persistent (its disk and
 * memory survive suspend), suspends itself when idle, and is checkpointed so a host crash doesn't lose it. Network
 * policy maps onto spoond's: `none`, `internet` for open, and `restricted` with an egress allowlist.
 *
 * Two transports. `stream` (the default): spoond's exec is buffered and takes no input, so the pi-env daemon runs over
 * its stream WebSocket in binary mode, through a small relay process (spoond-relay.ts); that holds one of the account's
 * exec slots while tools run. `rest`: files and commands go straight to spoond's files and background-job APIs
 * (spoond-rest.ts), and Scout holds no connection at all. Only the bearer token is needed either way; no SSH keys.
 */
export type SpoondOptions = {
	/** The lease API, e.g. `https://spoond.lan:8890`. */
	url: string;
	/** A function reads it per request, so a rotated token applies at once. */
	token: string | (() => string);
	fetch?: typeof fetch;
	/** Seconds a quiet lease runs before spoond suspends it. */
	idleSuspend?: number;
	/** Seconds between checkpoints, so a lease survives the host. */
	checkpointInterval?: number;
	/** The guest's home directory (spoond's images run as root). */
	home?: string;
	/** Seconds to keep retrying while spoond is full or busy (default 600). */
	patience?: number;
	/** How commands and files reach the lease: a pi-env daemon over the stream WebSocket, or spoond's REST API. */
	transport?: "stream" | "rest";
};

/** One request to spoond, waiting out busy and full answers. */
export type SpoondRequest = (method: string, path: string, init?: RequestOptions) => Promise<Response>;
type RequestOptions = { body?: string | Uint8Array<ArrayBuffer>; headers?: Record<string, string>; signal?: AbortSignal };

type Lease = { id: string; holder?: string; holder_url?: string; state?: string };

const SIZES = new Set(["small", "medium", "large", "xlarge"]);
const RELAY = fileURLToPath(new URL("./spoond-relay.ts", import.meta.url));

export class SpoondDriver implements SandboxDriver {
	readonly name = "spoond";
	readonly #options: SpoondOptions;
	readonly #fetch: typeof fetch;
	readonly #daemons = new Map<string, string>();

	constructor(options: SpoondOptions) {
		this.#options = { ...options, url: options.url.replace(/\/$/, "") };
		this.#fetch = options.fetch ?? fetch;
	}

	supports(_policy: NetworkPolicy): boolean {
		return true;
	}

	async open(key: string, spec: SandboxSpec): Promise<SandboxHandle> {
		let lease = await this.#find(key);
		if (lease?.state === "lost") {
			await this.#api("DELETE", `/api/leases/${lease.id}`, { reason: "lost; starting over" }).catch(() => {});
			lease = undefined;
		}
		if (lease === undefined) lease = await this.#create(key, spec);
		else {
			await this.#api("POST", `/api/leases/${lease.id}/keepalive`, { ttl: 0 });
			await this.#relabel(lease, key, spec);
		}
		const home = this.#options.home ?? "/root";
		if (this.#options.transport === "rest") {
			const leaseId = lease.id;
			const request: SpoondRequest = (method, path, init) => this.#request(method, `/api/leases/${leaseId}${path}`, init);
			return {
				daemonCommand: [],
				workdir: `${home}/work`,
				env: { HOME: home },
				connect: (options) => new SpoondRestEnv({ ...options, request, home }),
			};
		}
		const daemon = await this.#daemon(lease.id);
		return {
			// The relay reads the token from SCOUT_SPOOND_TOKEN in its environment, never from its arguments.
			daemonCommand: [process.execPath, RELAY, this.#options.url, lease.id, daemon, home],
			workdir: `${home}/work`,
			env: { HOME: home },
		};
	}

	async suspend(key: string): Promise<void> {
		const lease = await this.#find(key);
		if (lease !== undefined && lease.state !== "suspended") await this.#api("POST", `/api/leases/${lease.id}/suspend`);
	}

	async remove(key: string): Promise<void> {
		const lease = await this.#find(key);
		if (lease !== undefined) await this.#api("DELETE", `/api/leases/${lease.id}`, { reason: "work is over" });
	}

	async snapshot(key: string, name: string, options: { keep: number; idempotencyKey: string }): Promise<{ name: string; version: number }> {
		const lease = await this.#find(key);
		if (lease === undefined) throw new Error(`no sandbox ${key} to save`);
		return (await this.#api("POST", `/api/leases/${lease.id}/snapshots`, { name, keep: options.keep, idempotency_key: options.idempotencyKey })) as { name: string; version: number };
	}

	async #find(key: string): Promise<Lease | undefined> {
		// An owner with no leases gets `"sandboxes": null`.
		const { sandboxes } = (await this.#api("GET", "/api/leases")) as { sandboxes: Lease[] | null };
		// `scout:<key>` alone, or followed by what the thread is about.
		return sandboxes?.find((s) => s.holder === holder(key) || s.holder?.startsWith(`${holder(key)} `) === true);
	}

	/** A lease from before its thread could be described, or whose link changed: label it as a new one would be. */
	async #relabel(lease: Lease, key: string, spec: SandboxSpec): Promise<void> {
		if (spec.about === undefined) return;
		const label = { holder: holder(key, spec.about), holder_url: holderUrl(spec.link) ?? "" };
		if (lease.holder === label.holder && (lease.holder_url ?? "") === label.holder_url) return;
		// Only a label: never worth failing the work over.
		await this.#api("PUT", `/api/leases/${lease.id}/holder`, label).catch(() => {});
	}

	async #create(key: string, spec: SandboxSpec): Promise<Lease> {
		const lease = (await this.#api("POST", "/api/leases", {
			// A snapshot carries its own image; naming a different one would be refused.
			...(spec.snapshot === undefined ? { image: spec.image } : { snapshot: spec.snapshot }),
			persistent: true,
			ttl: 0,
			...(spec.size !== undefined && SIZES.has(spec.size) ? { size: spec.size } : {}),
			network_policy: spec.network.mode === "none" ? "none" : spec.network.mode === "open" ? "internet" : "restricted",
			...(spec.network.mode === "allow" ? { egress_allowlist: spec.network.hosts } : {}),
			holder: holder(key, spec.about),
			...(holderUrl(spec.link) === undefined ? {} : { holder_url: holderUrl(spec.link) }),
			comment: Object.entries(spec.labels)
				.map(([k, v]) => `${k}=${v}`)
				.join(" ")
				.slice(0, 500),
			idle_suspend: this.#options.idleSuspend ?? 900,
			checkpoint_interval: this.#options.checkpointInterval ?? 600,
			wait: 60,
		})) as Lease;
		return lease;
	}

	/** The daemon for the lease's architecture, uploaded once (named by its hash, so an upgrade uploads anew). */
	async #daemon(leaseId: string): Promise<string> {
		const known = this.#daemons.get(leaseId);
		if (known !== undefined) return known;
		const { stdout } = (await this.#api("POST", `/api/leases/${leaseId}/exec`, { cmd: "uname -m", timeout: 30 })) as { stdout: string };
		const arch = stdout.trim() === "aarch64" ? "arm64" : "x64";
		const binary = new Uint8Array(await readFile(packagedDaemon({ platform: "linux", arch })));
		const path = `${this.#options.home ?? "/root"}/.scout/pi-env-${createHash("sha256").update(binary).digest("hex").slice(0, 12)}`;
		const stat = await this.#request("GET", `/api/leases/${leaseId}/files${path}?stat=1`);
		if (stat.status === 404) {
			const put = await this.#request("PUT", `/api/leases/${leaseId}/files${path}?mode=0755`, { body: binary });
			if (!put.ok) throw new Error(`uploading pi-env to ${leaseId}: spoond answered ${put.status}`);
		} else if (!stat.ok) {
			throw new Error(`checking pi-env in ${leaseId}: spoond answered ${stat.status}`);
		}
		this.#daemons.set(leaseId, path);
		return path;
	}

	async #api(method: string, path: string, body?: unknown): Promise<unknown> {
		const response = await this.#request(method, path, body === undefined ? {} : { body: JSON.stringify(body) });
		if (!response.ok) {
			throw new Error(`spoond ${method} ${path}: ${response.status} ${(await response.text()).slice(0, 300)}`);
		}
		return response.status === 204 ? undefined : response.json();
	}

	/**
	 * One request, waiting and retrying when spoond is full or busy (it says how long with Retry-After). Near full it
	 * answers creates with 503 or 429 more often, and pauses leases to keep memory free, so this waits minutes, not tries.
	 */
	async #request(method: string, path: string, init: RequestOptions = {}): Promise<Response> {
		const { body, signal } = init;
		const deadline = Date.now() + (this.#options.patience ?? 600) * 1000;
		for (;;) {
			const response = await this.#fetch(`${this.#options.url}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${typeof this.#options.token === "function" ? this.#options.token() : this.#options.token}`,
					...(typeof body === "string" ? { "content-type": "application/json" } : {}),
					...init.headers,
				},
				...(body === undefined ? {} : { body }),
				...(signal === undefined ? {} : { signal }),
			});
			if (!(await busy(response))) return response;
			const seconds = Number(response.headers.get("retry-after") ?? 5);
			const wait = Math.min(60, Number.isFinite(seconds) && seconds >= 0 ? seconds : 5) * 1000;
			if (Date.now() + wait >= deadline) return response;
			await response.body?.cancel();
			await new Promise((resolve) => setTimeout(resolve, wait));
			signal?.throwIfAborted();
		}
	}
}

/**
 * Whether spoond means "try again": full (429, 503) or a lease busy with a lifecycle operation (409 with Retry-After,
 * or `lease_busy`). Other 409s are answers (a directory in the way, a job still running).
 */
async function busy(response: Response): Promise<boolean> {
	if (response.status === 429 || response.status === 503) return true;
	if (response.status !== 409) return false;
	if (response.headers.has("retry-after")) return true;
	const answer = (await response.clone().json().catch(() => ({}))) as { code?: string };
	return answer.code === "lease_busy";
}

/**
 * `scout:<key>`, then what the thread is about, so a person reading spoond's leases can tell them apart. spoond takes
 * at most 128 printable characters.
 */
function holder(key: string, about?: string): string {
	const base = `scout:${key}`;
	const words = [...(about ?? "").replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim()];
	if (words.length === 0) return base;
	const room = 128 - base.length - 1;
	return `${base} ${words.length <= room ? words.join("") : `${words.slice(0, room - 1).join("")}…`}`;
}

/** The thread's link, when spoond will take it (an http(s) URL of at most 512 characters). */
function holderUrl(link: string | undefined): string | undefined {
	return link !== undefined && /^https?:\/\/\S+$/.test(link) && link.length <= 512 ? link : undefined;
}
