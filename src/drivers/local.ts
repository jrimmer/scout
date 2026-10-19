import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { localDaemon } from "@earendil-works/pi-env";
import type { NetworkPolicy, SandboxDriver, SandboxHandle, SandboxSpec } from "./types.ts";

/**
 * No sandbox at all: a directory on this host, with the daemon running as Scout's own user. For tests, and for trying
 * Scout on a laptop without Docker. Commands can reach anything Scout can, credentials included; never use it with
 * people you don't trust completely. Ignores the image and the network policy.
 */
export class LocalDriver implements SandboxDriver {
	readonly name = "local";
	readonly #root: string;

	constructor(options: { root: string }) {
		this.#root = options.root;
	}

	supports(_policy: NetworkPolicy): boolean {
		return true;
	}

	async open(key: string, _spec: SandboxSpec): Promise<SandboxHandle> {
		const workdir = join(this.#root, key.replace(/[^a-zA-Z0-9_.-]/g, "-"));
		await mkdir(join(workdir, "home"), { recursive: true });
		return { daemonCommand: [localDaemon()], workdir, env: { HOME: join(workdir, "home") } };
	}

	async suspend(_key: string): Promise<void> {}

	async remove(key: string): Promise<void> {
		await rm(join(this.#root, key.replace(/[^a-zA-Z0-9_.-]/g, "-")), { recursive: true, force: true });
	}
}
