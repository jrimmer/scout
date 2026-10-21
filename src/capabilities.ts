import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * What this Slack workspace lets Scout do. Slack doesn't tell an app its plan, and plans change, so Scout finds out
 * what works: the scopes the app was granted (from Slack's own answer to any call), and, for features a plan may not
 * include (Lists, canvases), whether the first real call works. Each feature that's off says why, once, in the log,
 * and turns itself on when it can; Scout does everything else the same either way.
 */
export type Feature = "attachments" | "emails" | "reactions" | "shortcuts" | "unfurls" | "canvases" | "lists" | "workflowSteps";

/** What each feature needs from the app's scopes (slack-manifest.yaml). */
export const NEEDS: Record<Feature, { scopes: string[]; what: string }> = {
	attachments: { scopes: ["files:write"], what: "long answers attached in full" },
	emails: { scopes: ["users:read.email"], what: "finding people in the directory by email" },
	reactions: { scopes: ["reactions:write"], what: "👀/✅/⚠️ on requests" },
	shortcuts: { scopes: ["commands"], what: "the /scout command and the Ask Scout shortcut" },
	unfurls: { scopes: ["links:read", "links:write"], what: "previews of code host links" },
	canvases: { scopes: ["canvases:write"], what: "each channel's Scout canvas" },
	lists: { scopes: ["lists:write"], what: "the list of Scout's work" },
	workflowSteps: { scopes: [], what: "the Ask Scout step in Workflow Builder" },
};

/** Slack's errors that mean the workspace's plan or settings don't allow a feature, as opposed to a passing failure. */
const NOT_ALLOWED = /paid_only|paid_teams_only|team_not_paid|feature_not_enabled|not_allowed_token_type|access_denied|restricted_action|not_enabled|plan/i;
/** How long a feature found unavailable stays off before Scout tries again. */
const RECHECK_MS = 24 * 60 * 60 * 1000;

export class Capabilities {
	readonly #db: DatabaseSync;
	#scopes = new Set<string>();

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.#db = new DatabaseSync(path, { timeout: 5000 });
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS slack_features (feature TEXT PRIMARY KEY, available INTEGER NOT NULL, why TEXT, checked_at INTEGER NOT NULL);
		`);
	}

	/** The scopes Slack says the app has (`x-oauth-scopes`), learned at start. */
	granted(scopes: readonly string[]): void {
		this.#scopes = new Set(scopes.map((s) => s.trim()).filter(Boolean));
	}

	/** Why a feature is off, or undefined when it's on (as far as Scout knows). */
	off(feature: Feature, now = Date.now()): string | undefined {
		const missing = NEEDS[feature].scopes.filter((s) => !this.#scopes.has(s));
		if (missing.length > 0) return `needs the ${missing.join(" and ")} scope${missing.length === 1 ? "" : "s"}: update the app from slack-manifest.yaml and reinstall`;
		const row = this.#db.prepare("SELECT available, why, checked_at FROM slack_features WHERE feature = ?").get(feature) as { available: number; why: string | null; checked_at: number } | undefined;
		if (row !== undefined && row.available === 0 && now - row.checked_at < RECHECK_MS) return row.why ?? "not available in this workspace";
		return undefined;
	}

	on(feature: Feature, now = Date.now()): boolean {
		return this.off(feature, now) === undefined;
	}

	/**
	 * Run a feature's call, learning from it: an error that means the workspace doesn't allow the feature turns it off
	 * (for a day, then Scout tries again) and is logged once; any other error is passed on. Returns undefined when off.
	 */
	async use<T>(feature: Feature, call: () => Promise<T>, log: (line: string) => void = console.log, now = Date.now()): Promise<T | undefined> {
		if (!this.on(feature, now)) return undefined;
		try {
			const result = await call();
			this.#record(feature, true, undefined, now);
			return result;
		} catch (error) {
			const code = (error as { data?: { error?: string } }).data?.error ?? (error instanceof Error ? error.message : String(error));
			if (!NOT_ALLOWED.test(code)) throw error;
			const why = `this workspace doesn't allow it (${code})`;
			const before = this.#db.prepare("SELECT available FROM slack_features WHERE feature = ?").get(feature) as { available: number } | undefined;
			this.#record(feature, false, why, now);
			if (before?.available !== 0) log(`Slack: ${NEEDS[feature].what} is off: ${why}. I'll try again tomorrow.`);
			return undefined;
		}
	}

	/** One line per feature, for the log at start: what's on, and why the rest isn't. */
	summary(now = Date.now()): string[] {
		return (Object.keys(NEEDS) as Feature[]).map((feature) => {
			const why = this.off(feature, now);
			const label = NEEDS[feature].what;
			if (feature === "workflowSteps" && why === undefined) return `Slack: ${label}: on where the workspace's plan allows custom steps (Workflow Builder shows it, or doesn't)`;
			return why === undefined ? `Slack: ${label}: on` : `Slack: ${label}: off, ${why}`;
		});
	}

	#record(feature: Feature, available: boolean, why: string | undefined, now: number): void {
		this.#db
			.prepare("INSERT OR REPLACE INTO slack_features (feature, available, why, checked_at) VALUES (?, ?, ?, ?)")
			.run(feature, available ? 1 : 0, why ?? null, now);
	}

	close(): void {
		this.#db.close();
	}
}
