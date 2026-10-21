import type { CodeHost } from "./codehost.ts";
import type { CiRow, PullRow, Pulls } from "./pulls.ts";

/**
 * Watching CI on Scout's own pull requests, so a red build comes back to the thread that made it instead of waiting
 * for someone to notice. Scout reads the head commit's combined status (Forgejo Actions and GitHub both report there):
 * green, it says so; red, it's asked to read the logs and fix what its change broke, at most `MAX_FIXES` times per
 * pull request before it hands over to a person. A repository without CI never reports, and Scout stops waiting.
 *
 * Polled (Scout has no public address). Pi Durable's sleeping tools (#23) could later let the thread itself wait.
 */
export const MAX_FIXES = 2;
/** How long a commit may go without any status before Scout decides the repository has no CI for it. */
const NO_CI_AFTER_MS = 15 * 60 * 1000;

/** One check's result, for the thread: its name, state, and where to look. */
export type Check = { context: string; state: string; url?: string; description?: string };

export type CiHandlers = {
	passed(pull: PullRow, sha: string): Promise<void>;
	/** Red: ask the thread to fix it. `attempt` counts from 1. */
	failed(pull: PullRow, sha: string, checks: Check[], attempt: number): Promise<void>;
	/** Red again after `MAX_FIXES` tries: tell the people in the thread. */
	stuck(pull: PullRow, sha: string, checks: Check[]): Promise<void>;
};

type Status = { state: string; total_count: number; statuses?: { context?: string; status?: string; state?: string; target_url?: string; description?: string }[] };

export class CiWatcher {
	readonly #pulls: Pulls;
	readonly #host: CodeHost;
	readonly #handlers: CiHandlers;
	readonly #fetch: typeof fetch;
	#polling = false;

	constructor(options: { pulls: Pulls; host: CodeHost; handlers: CiHandlers; fetch?: typeof fetch }) {
		this.#pulls = options.pulls;
		this.#host = options.host;
		this.#handlers = options.handlers;
		this.#fetch = options.fetch ?? fetch;
	}

	async poll(now = Date.now()): Promise<void> {
		if (this.#polling) return;
		this.#polling = true;
		try {
			for (const pull of this.#pulls.open("work")) {
				await this.#check(pull, now).catch((error: unknown) =>
					console.error(`checking CI for ${pull.url} failed:`, error instanceof Error ? error.message : error),
				);
			}
		} finally {
			this.#polling = false;
		}
	}

	async #check(pull: PullRow, now: number): Promise<void> {
		const current = (await this.#api(`/repos/${pull.slug}/pulls/${pull.number}`)) as { head: { sha: string }; state?: string };
		// Merged or closed since the last refresh: nothing left to fix. Its branch may live on in a newer pull request
		// (a thread keeps its branch), whose red build is that one's to report, not this one's.
		if (current.state !== undefined && current.state !== "open") return;
		const head = current.head.sha;
		const seen = this.#pulls.ci(pull.url);
		if (seen?.sha === head && seen.outcome !== "pending") return;
		const attempts = seen?.attempts ?? 0;
		const since = seen?.sha === head ? seen.since : now;
		const save = (row: Omit<CiRow, "sha" | "since">) => this.#pulls.ciSaw(pull.url, { sha: head, since, ...row });

		const status = (await this.#api(`/repos/${pull.slug}/commits/${head}/status`)) as Status;
		if (status.total_count === 0) {
			save({ outcome: now - since > NO_CI_AFTER_MS ? "none" : "pending", attempts });
			return;
		}
		if (status.state === "pending") {
			save({ outcome: "pending", attempts });
			return;
		}
		if (status.state === "success") {
			save({ outcome: "success", attempts });
			await this.#handlers.passed(pull, head);
			return;
		}
		const checks: Check[] = (status.statuses ?? [])
			.map((s) => ({
				context: s.context ?? "check",
				state: s.status ?? s.state ?? status.state,
				...(s.target_url ? { url: s.target_url.startsWith("/") ? `${new URL(this.#host.apiUrl).origin}${s.target_url}` : s.target_url } : {}),
				...(s.description ? { description: s.description } : {}),
			}))
			.filter((c) => c.state !== "success");
		if (attempts >= MAX_FIXES) {
			save({ outcome: "failure", attempts });
			await this.#handlers.stuck(pull, head, checks);
			return;
		}
		save({ outcome: "failure", attempts: attempts + 1 });
		await this.#handlers.failed(pull, head, checks, attempts + 1);
	}

	async #api(path: string): Promise<unknown> {
		const host = this.#host;
		const response = await this.#fetch(`${host.apiUrl}${path}`, {
			headers: {
				accept: host.kind === "github" ? "application/vnd.github+json" : "application/json",
				authorization: host.kind === "github" ? `Bearer ${host.token}` : `token ${host.token}`,
			},
		});
		if (!response.ok) throw new Error(`code host answered ${response.status} for ${path}`);
		return response.json();
	}
}
