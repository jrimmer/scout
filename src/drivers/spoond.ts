import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { packagedDaemon } from "@earendil-works/pi-env";
import type { NetworkPolicy, SandboxDriver, SandboxHandle, SandboxSpec } from "./types.ts";

/**
 * spoond: a Firecracker microVM per sandbox, leased from spoond's API. A thread's lease is persistent (its disk and
 * memory survive suspend), suspends itself when idle, and is checkpointed so a host crash doesn't lose it. Network
 * policy maps onto spoond's: `none`, `internet` for open, and `restricted` with an egress allowlist.
 *
 * spoond's exec is buffered and takes no input, so the pi-env daemon runs over its stream WebSocket in binary mode,
 * through a small relay process (spoond-relay.ts). Only the bearer token is needed; no SSH keys.
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
};

type Lease = { id: string; holder?: string; state?: string };

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
		else await this.#api("POST", `/api/leases/${lease.id}/keepalive`, { ttl: 0 });
		const daemon = await this.#daemon(lease.id);
		const home = this.#options.home ?? "/root";
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

	async #find(key: string): Promise<Lease | undefined> {
		// An owner with no leases gets `"sandboxes": null`.
		const { sandboxes } = (await this.#api("GET", "/api/leases")) as { sandboxes: Lease[] | null };
		return sandboxes?.find((s) => s.holder === holder(key));
	}

	async #create(key: string, spec: SandboxSpec): Promise<Lease> {
		const lease = (await this.#api("POST", "/api/leases", {
			image: spec.image,
			persistent: true,
			ttl: 0,
			...(spec.size !== undefined && SIZES.has(spec.size) ? { size: spec.size } : {}),
			network_policy: spec.network.mode === "none" ? "none" : spec.network.mode === "open" ? "internet" : "restricted",
			...(spec.network.mode === "allow" ? { egress_allowlist: spec.network.hosts } : {}),
			holder: holder(key),
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
			const put = await this.#request("PUT", `/api/leases/${leaseId}/files${path}?mode=0755`, binary);
			if (!put.ok) throw new Error(`uploading pi-env to ${leaseId}: spoond answered ${put.status}`);
		} else if (!stat.ok) {
			throw new Error(`checking pi-env in ${leaseId}: spoond answered ${stat.status}`);
		}
		this.#daemons.set(leaseId, path);
		return path;
	}

	async #api(method: string, path: string, body?: unknown): Promise<unknown> {
		const response = await this.#request(method, path, body === undefined ? undefined : JSON.stringify(body));
		if (!response.ok) {
			throw new Error(`spoond ${method} ${path}: ${response.status} ${(await response.text()).slice(0, 300)}`);
		}
		return response.status === 204 ? undefined : response.json();
	}

	/**
	 * One request, waiting and retrying when spoond is full or busy (it says how long with Retry-After). Near full it
	 * answers creates with 503 or 429 more often, and pauses leases to keep memory free, so this waits minutes, not tries.
	 */
	async #request(method: string, path: string, body?: string | Uint8Array<ArrayBuffer>): Promise<Response> {
		const deadline = Date.now() + (this.#options.patience ?? 600) * 1000;
		for (;;) {
			const response = await this.#fetch(`${this.#options.url}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${typeof this.#options.token === "function" ? this.#options.token() : this.#options.token}`,
					...(typeof body === "string" ? { "content-type": "application/json" } : {}),
				},
				...(body === undefined ? {} : { body }),
			});
			const busy = response.status === 409 || response.status === 429 || response.status === 503;
			if (!busy) return response;
			const seconds = Number(response.headers.get("retry-after") ?? 5);
			const wait = Math.min(60, Number.isFinite(seconds) && seconds >= 0 ? seconds : 5) * 1000;
			if (Date.now() + wait >= deadline) return response;
			await response.body?.cancel();
			await new Promise((resolve) => setTimeout(resolve, wait));
		}
	}
}

function holder(key: string): string {
	return `scout:${key}`;
}
