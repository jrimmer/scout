import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { backupGauge, backupState, describeBackup, FRESH, GRACE, startNotice, weekLine } from "../src/backups.ts";

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 22, 12);

/** A data directory: each database written `changed` ms before NOW, with Litestream's copy `copied` ms before (none: no copy). */
function dataDir(dbs: Record<string, { changed: number; copied?: number }>): string {
	const dir = mkdtempSync(join(tmpdir(), "scout-backups-"));
	for (const [db, at] of Object.entries(dbs)) {
		writeFileSync(join(dir, db), "");
		writeFileSync(join(dir, `${db}-wal`), "");
		const changed = (NOW - at.changed) / 1000;
		utimesSync(join(dir, `${db}-wal`), changed, changed);
		if (at.copied === undefined) continue;
		// Litestream 0.3's layout: the shadow WAL deep inside, appended to while the directories above stay old.
		const meta = join(dir, `.${db}-litestream`);
		const wal = join(meta, "generations", "abc", "wal");
		mkdirSync(wal, { recursive: true });
		writeFileSync(join(wal, "00000001.wal"), "");
		const old = (NOW - 30 * 24 * 60 * MINUTE) / 1000;
		for (const d of [meta, join(meta, "generations"), join(meta, "generations", "abc"), wal]) utimesSync(d, old, old);
		const copied = (NOW - at.copied) / 1000;
		utimesSync(join(wal, "00000001.wal"), copied, copied);
	}
	return dir;
}

describe("backups", () => {
	it("calls a database backed up when Litestream's copy holds its latest change", () => {
		const dir = dataDir({ "pi.sqlite": { changed: MINUTE, copied: MINUTE - 1000 }, "scout.sqlite": { changed: 2 * MINUTE, copied: 2 * MINUTE } });
		assert.deepEqual(backupState(dir, "litestream", NOW), { status: "ok", problems: [] });
	});

	it("doesn't mind an idle database whose copy is old: nothing has changed since", () => {
		const dir = dataDir({ "pi.sqlite": { changed: 9 * 60 * MINUTE, copied: 9 * 60 * MINUTE }, "scout.sqlite": { changed: MINUTE, copied: MINUTE } });
		assert.equal(backupState(dir, "litestream", NOW).status, "ok");
	});

	it("says which database Litestream isn't copying, and why", () => {
		const missing = backupState(dataDir({ "pi.sqlite": { changed: MINUTE }, "scout.sqlite": { changed: MINUTE, copied: MINUTE } }), "litestream", NOW);
		assert.deepEqual(missing, { status: "missing", problems: ["no Litestream copy of pi.sqlite"] });
		const neither = backupState(dataDir({ "pi.sqlite": { changed: MINUTE }, "scout.sqlite": { changed: MINUTE } }), "litestream", NOW);
		assert.deepEqual(neither.problems, ["no Litestream copy of pi.sqlite or scout.sqlite"]);
		const stale = backupState(dataDir({ "pi.sqlite": { changed: MINUTE, copied: MINUTE }, "scout.sqlite": { changed: MINUTE, copied: 3 * 60 * MINUTE } }), "litestream", NOW);
		assert.deepEqual(stale.problems, ["Litestream last copied scout.sqlite 3h ago, and it has changed since"]);
		const empty = mkdtempSync(join(tmpdir(), "scout-backups-"));
		assert.deepEqual(backupState(empty, "litestream", NOW).problems, [`there's no pi.sqlite in ${empty}`, `there's no scout.sqlite in ${empty}`]);
	});

	it("allows a change FRESH to be copied, and no longer", () => {
		const at = (copied: number) => backupState(dataDir({ "pi.sqlite": { changed: MINUTE, copied }, "scout.sqlite": { changed: MINUTE, copied: MINUTE } }), "litestream", NOW).status;
		assert.equal(at(MINUTE + FRESH - 1000), "ok");
		assert.equal(at(MINUTE + FRESH + 1000), "missing");
	});

	it("is off, on purpose, with SCOUT_BACKUP=none: no notices, and not an alert", () => {
		const off = backupState(dataDir({ "pi.sqlite": { changed: MINUTE } }), "none", NOW);
		assert.deepEqual(off, { status: "off", problems: [] });
		assert.equal(describeBackup(off), "backups off, on purpose (SCOUT_BACKUP=none)");
		assert.equal(startNotice(off, NOW - 2 * GRACE, NOW), undefined);
		assert.equal(weekLine(off), undefined);
		assert.equal(backupGauge(off).value, 1);
	});

	it("says so in the home channel once Litestream has had its grace, and on Mondays while still missing", () => {
		const missing = { status: "missing" as const, problems: ["no Litestream copy of pi.sqlite"] };
		assert.equal(startNotice(missing, NOW - GRACE + 1000, NOW), undefined, "Litestream starting alongside gets its grace");
		assert.equal(
			startNotice(missing, NOW - GRACE, NOW),
			"Heads up: my data isn't being backed up off this machine (no Litestream copy of pi.sqlite). If this box goes, every thread goes with it. docs/operations.md#backups has the steps.",
		);
		assert.equal(weekLine(missing), "My data still isn't backed up off this machine (no Litestream copy of pi.sqlite); docs/operations.md#backups has the steps.");
		assert.equal(backupGauge(missing).value, 0);
		const ok = { status: "ok" as const, problems: [] };
		assert.equal(startNotice(ok, NOW - 2 * GRACE, NOW), undefined);
		assert.equal(weekLine(ok), undefined);
		assert.equal(backupGauge(ok).value, 1);
	});
});
