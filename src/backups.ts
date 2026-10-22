import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Is Scout's data backed up off this machine? Production ran for days without Litestream once, and nothing said so;
 * now the doctor, the dashboard, `/metrics` and the home channel do.
 *
 * Litestream (0.3 and 0.5 alike) keeps a directory next to each database it replicates, `.<file>-litestream`, and
 * writes to it within a second of every change to the database (its shadow WAL in 0.3, LTX files in 0.5). So a
 * database is backed up when that directory exists and holds Litestream's copy of the latest change: nothing the
 * database's WAL has seen is older than FRESH without a newer copy beside it. An idle database isn't a problem; a
 * change Litestream hasn't copied for FRESH is. This sees Litestream at work, not where its replica goes.
 */
export type Backup = { status: "ok" | "off" | "missing"; problems: string[] };

/** What `SCOUT_BACKUP` says: Litestream (the default), or none, on purpose, for test and throwaway installs. */
export type BackupSetting = "litestream" | "none";

export const DATABASES = ["pi.sqlite", "scout.sqlite"] as const;

/**
 * How long a change may go uncopied: Litestream copies within its one-second monitor interval and, while failing,
 * backs off up to 5 minutes between tries (0.5); three times that rides out a hiccup and still bounds what's at risk.
 */
export const FRESH = 15 * 60_000;

/** How long after a start before Scout says so in its home channel: Litestream starting alongside writes first. */
export const GRACE = 20 * 60_000;

const DOCS = "docs/operations.md#backups";

export function backupState(dataDir: string, setting: BackupSetting, now = Date.now()): Backup {
	if (setting === "none") return { status: "off", problems: [] };
	const uncopied: string[] = [];
	const problems: string[] = [];
	for (const db of DATABASES) {
		const changed = mtime(join(dataDir, `${db}-wal`)) ?? mtime(join(dataDir, db));
		if (changed === undefined) {
			problems.push(`there's no ${db} in ${dataDir}`);
			continue;
		}
		const copied = newest(join(dataDir, `.${db}-litestream`));
		if (copied === undefined) uncopied.push(db);
		else if (changed - copied > FRESH) problems.push(`Litestream last copied ${db} ${ago(now - copied)} ago, and it has changed since`);
	}
	if (uncopied.length > 0) problems.unshift(`no Litestream copy of ${uncopied.join(" or ")}`);
	return { status: problems.length === 0 ? "ok" : "missing", problems };
}

/** The doctor's line, and the dashboard's: why, in a few words. */
export function describeBackup(b: Backup): string {
	if (b.status === "off") return "backups off, on purpose (SCOUT_BACKUP=none)";
	if (b.status === "ok") return `Litestream is copying ${DATABASES.join(" and ")}`;
	return `Scout's data isn't backed up off this machine: ${b.problems.join("; ")}`;
}

/** The home channel, once a start, GRACE after it, while backups are missing. */
export function startNotice(b: Backup, startedAt: number, now = Date.now()): string | undefined {
	if (b.status !== "missing" || now - startedAt < GRACE) return undefined;
	return `Heads up: my data isn't being backed up off this machine (${b.problems.join("; ")}). If this box goes, every thread goes with it. ${DOCS} has the steps.`;
}

/** A line for the Monday report while backups are still missing. */
export function weekLine(b: Backup): string | undefined {
	if (b.status !== "missing") return undefined;
	return `My data still isn't backed up off this machine (${b.problems.join("; ")}); ${DOCS} has the steps.`;
}

/** For `/metrics`: an alert on 0 is an install losing data on a bad day. Off on purpose isn't one. */
export function backupGauge(b: Backup): { help: string; value: number } {
	return { help: "1 while Scout's databases are backed up off this machine (or backups are off on purpose, SCOUT_BACKUP=none), 0 while not.", value: b.status === "missing" ? 0 : 1 };
}

function mtime(path: string): number | undefined {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return undefined;
	}
}

/** The newest modification under `dir`, itself included: Litestream appends to files deep inside it. */
function newest(dir: string): number | undefined {
	const own = mtime(dir);
	if (own === undefined) return undefined;
	let latest = own;
	try {
		for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
			const at = mtime(join(entry.parentPath, entry.name));
			if (at !== undefined && at > latest) latest = at;
		}
	} catch {
		// Unreadable: the directory's own time is all there is.
	}
	return latest;
}

function ago(ms: number): string {
	const minutes = Math.max(1, Math.round(ms / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}
