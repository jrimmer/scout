/**
 * Where a thread's commands and files live: a sandbox on some substrate (Docker on this host, a spoond microVM, …).
 *
 * The harness, credentials and Slack stay with Scout; a driver only provides a place to work and a way to start a
 * pi-env daemon inside it. Every file operation and command then goes through that daemon (`RemoteExecutionEnv`), so
 * Scout never touches a sandbox's files directly, and git moves in and out as bundles, so no sandbox needs
 * credentials. A new substrate is a new driver.
 */
export type NetworkPolicy =
	| { mode: "none" }
	| { mode: "open" }
	/** Only these hosts (and their subdomains); for substrates with an egress firewall. */
	| { mode: "allow"; hosts: string[] };

export type SandboxSpec = {
	image: string;
	network: NetworkPolicy;
	/** A size the substrate understands (Docker: memory like `4g`; spoond: a size class). */
	size?: string;
	/** What the sandbox is for, for the substrate's own bookkeeping and dashboards. */
	labels: Record<string, string>;
};

export type SandboxHandle = {
	/** Starts the pi-env daemon inside the sandbox, speaking on stdin and stdout (pi-env appends `serve --token …`). */
	daemonCommand: readonly string[];
	/** A directory inside the sandbox the work can use, writable and kept while the sandbox is kept. */
	workdir: string;
	/** Environment for commands in the sandbox. */
	env?: Record<string, string>;
};

export interface SandboxDriver {
	readonly name: string;
	/** The sandbox for `key`, created or resumed as needed. Idempotent. */
	open(key: string, spec: SandboxSpec): Promise<SandboxHandle>;
	/** Free its compute but keep its files; the next `open` resumes it. */
	suspend(key: string): Promise<void>;
	/** Delete it and its files. */
	remove(key: string): Promise<void>;
	/** Which network policies this substrate can enforce. */
	supports(policy: NetworkPolicy): boolean;
}
