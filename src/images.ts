import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Each repository's image: a snapshot Scout builds itself from the repository's own `.scout/setup.sh`, so a thread
 * starts with the toolchain, dependencies and a built checkout already there instead of fetching and building them
 * every time. Rebuilt when the setup script changes on the base branch, and weekly so dependencies don't go stale.
 * The build itself is `Workspaces.buildImage`; this decides when, and remembers what was built.
 */
export type Image = { repo: string; snapshot: string; version: number; label: string; builtAt: number };

const WEEK = 7 * 24 * 60 * 60 * 1000;
/** After a failed build, how long before trying the same setup script again. */
const RETRY_MS = 60 * 60 * 1000;

export type ImageBuilder = {
	repos: () => string[];
	/** The repository's setup script on its base branch (its git blob), and the base commit; undefined without one. */
	setup: (repo: string) => Promise<{ script: string; base: string } | undefined>;
	build: (repo: string, label: string) => Promise<{ name: string; version: number }>;
};

export class Images {
	readonly #db: DatabaseSync;
	#building = false;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.#db = new DatabaseSync(path, { timeout: 5000 });
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS images (
				repo TEXT PRIMARY KEY,
				snapshot TEXT,
				version INTEGER,
				label TEXT,
				built_at INTEGER,
				failed_label TEXT,
				failed_at INTEGER,
				error TEXT
			);
		`);
	}

	/** The repository's latest image, if one has been built. */
	get(repo: string): Image | undefined {
		const row = this.#db.prepare("SELECT * FROM images WHERE repo = ? AND snapshot IS NOT NULL").get(repo) as Record<string, unknown> | undefined;
		if (row === undefined) return undefined;
		return { repo, snapshot: String(row.snapshot), version: Number(row.version), label: String(row.label), builtAt: Number(row.built_at) };
	}

	/** The last failed build's error, while it's the latest word on that repository. */
	failure(repo: string): string | undefined {
		const row = this.#db.prepare("SELECT error FROM images WHERE repo = ? AND failed_at IS NOT NULL").get(repo) as { error: string } | undefined;
		return row?.error;
	}

	/**
	 * Build every image that's due, one at a time: a setup script not built yet (or changed), or a build over a week
	 * old. A failure waits an hour before the same script is tried again. Returns what happened, for the log.
	 */
	async refresh(builder: ImageBuilder, now = Date.now()): Promise<string[]> {
		if (this.#building) return [];
		this.#building = true;
		const said: string[] = [];
		const failures: string[] = [];
		try {
			for (const repo of builder.repos()) {
				const setup = await builder.setup(repo);
				if (setup === undefined) continue;
				const label = `${setup.script.slice(0, 12)}-${setup.base.slice(0, 12)}`;
				const built = this.get(repo);
				const sameScript = built?.label.startsWith(`${setup.script.slice(0, 12)}-`) === true;
				if (built !== undefined && sameScript && now - built.builtAt < WEEK) continue;
				const row = this.#db.prepare("SELECT failed_label, failed_at FROM images WHERE repo = ?").get(repo) as { failed_label: string | null; failed_at: number | null } | undefined;
				if (row?.failed_label?.startsWith(`${setup.script.slice(0, 12)}-`) === true && now - (row.failed_at ?? 0) < RETRY_MS) continue;
				try {
					const saved = await builder.build(repo, label);
					this.#db
						.prepare(
							`INSERT INTO images (repo, snapshot, version, label, built_at) VALUES (?, ?, ?, ?, ?)
							 ON CONFLICT DO UPDATE SET snapshot = excluded.snapshot, version = excluded.version, label = excluded.label,
							   built_at = excluded.built_at, failed_label = NULL, failed_at = NULL, error = NULL`,
						)
						.run(repo, saved.name, saved.version, label, now);
					said.push(`built ${saved.name} v${saved.version} for ${repo} (${label})`);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					this.#db
						.prepare(
							`INSERT INTO images (repo, failed_label, failed_at, error) VALUES (?, ?, ?, ?)
							 ON CONFLICT DO UPDATE SET failed_label = excluded.failed_label, failed_at = excluded.failed_at, error = excluded.error`,
						)
						.run(repo, label, now, message);
					failures.push(`${repo}: ${message}`);
				}
			}
		} finally {
			this.#building = false;
		}
		if (failures.length > 0) throw new Error(`building images failed: ${failures.join("; ")}`);
		return said;
	}

	close(): void {
		this.#db.close();
	}
}
