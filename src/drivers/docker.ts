import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { packagedDaemon } from "@earendil-works/pi-env";
import type { NetworkPolicy, SandboxDriver, SandboxHandle, SandboxSpec } from "./types.ts";

const run = promisify(execFile);
const WORKDIR = "/work";
const DAEMON_DIR = "/opt/pi-env";
/** The user commands run as: not root, whatever the image. */
const USER = "1000:1000";

/**
 * Docker on this host: one container per sandbox, its work in a named volume (kept across stops), no capabilities,
 * no new privileges, and no network unless the policy is `open`. The pi-env daemon is mounted read-only from this
 * package; nothing from the host is mounted besides it.
 */
export class DockerDriver implements SandboxDriver {
	readonly name = "docker";
	readonly #prefix: string;
	/** The docker network `open` means (`bridge` by default). */
	readonly #openNetwork: string;

	constructor(options: { prefix: string; openNetwork?: string }) {
		this.#prefix = options.prefix;
		this.#openNetwork = options.openNetwork ?? "bridge";
	}

	supports(policy: NetworkPolicy): boolean {
		return policy.mode !== "allow";
	}

	#name(key: string): string {
		return `${this.#prefix}-${key}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
	}

	async open(key: string, spec: SandboxSpec): Promise<SandboxHandle> {
		const name = this.#name(key);
		const state = await run("docker", ["inspect", "-f", "{{.State.Running}}", name]).then(
			(out) => out.stdout.trim(),
			() => "missing",
		);
		if (state === "false") await run("docker", ["start", name]);
		if (state === "missing") await this.#create(name, spec);
		return {
			daemonCommand: ["docker", "exec", "-i", "--workdir", WORKDIR, name, `${DAEMON_DIR}/pi-env`],
			workdir: WORKDIR,
		};
	}

	async #create(name: string, spec: SandboxSpec): Promise<void> {
		if (spec.network.mode === "allow") {
			throw new Error("Docker can't limit a sandbox to some hosts; use none or open, or a substrate with an egress firewall");
		}
		// A new volume belongs to root; hand it to the sandbox's user once, before anything runs in it.
		await run("docker", ["volume", "create", "--label", `scout.sandbox=${name}`, name]);
		await run("docker", ["run", "--rm", "--network", "none", "--volume", `${name}:${WORKDIR}`, "--user", "0:0", spec.image, "chown", USER, WORKDIR]);
		const daemon = dirname(packagedDaemon({ platform: "linux", arch: process.arch === "arm64" ? "arm64" : "x64" }));
		await run("docker", [
			"run", "--detach", "--name", name,
			...Object.entries(spec.labels).flatMap(([k, v]) => ["--label", `scout.${k}=${v}`]),
			"--network", spec.network.mode === "open" ? this.#openNetwork : "none",
			...(spec.size === undefined ? [] : ["--memory", spec.size]),
			"--pids-limit", "1024",
			"--cap-drop", "ALL",
			"--security-opt", "no-new-privileges",
			"--user", USER,
			"--env", `HOME=${WORKDIR}/home`,
			"--volume", `${name}:${WORKDIR}`,
			"--volume", `${daemon}:${DAEMON_DIR}:ro`,
			"--workdir", WORKDIR,
			spec.image,
			"sleep", "infinity",
		]);
	}

	async suspend(key: string): Promise<void> {
		await run("docker", ["stop", "--time", "5", this.#name(key)]).catch(() => {});
	}

	async remove(key: string): Promise<void> {
		const name = this.#name(key);
		await run("docker", ["rm", "--force", name]).catch(() => {});
		await run("docker", ["volume", "rm", "--force", name]).catch(() => {});
	}
}
