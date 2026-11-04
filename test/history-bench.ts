import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { History } from "../src/history.ts";

/**
 * The session index's speed on a made-up corpus (docs/session-index.md): `npm run bench:history [chunks]`. Exits 1 when
 * a target is missed: full-text search under 50 ms at the 95th percentile with 100,000 chunks, ingest above 500 a second.
 */
const total = Number(process.argv[2] ?? 100_000);
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const vocabulary = Array.from({ length: 8000 }, (_, i) => `w${i.toString(36)}x`);
// Zipf-ish: a few words everywhere, most words rare.
const word = () => vocabulary[Math.floor(vocabulary.length * rand() ** 3)]!;
const sentence = (n: number) => Array.from({ length: n }, word).join(" ");

const dir = mkdtempSync(join(tmpdir(), "history-bench-"));
const history = new History(join(dir, "scout.sqlite"));
const people = Array.from({ length: 60 }, (_, i) => `U${i}`);
const repos = Array.from({ length: 12 }, (_, i) => `org/repo${i}`);

const started = performance.now();
for (let at = 0; at < total; at += 500) {
	history.putAll(
		Array.from({ length: Math.min(500, total - at) }, (_, j) => {
			const n = at + j;
			const thread = Math.floor(n / 5);
			return {
				id: `slack:message:T:${thread}:${n}`,
				source: n % 4 === 0 ? "forge" : "slack",
				kind: "message",
				thread: `C:${thread}`,
				conversationId: thread,
				channel: "bench",
				repo: repos[thread % repos.length]!,
				author: people[n % people.length]!,
				authorName: `Person ${n % people.length}`,
				at: 1_700_000_000_000 + n * 60_000,
				text: sentence(40),
			};
		}),
	);
}
const ingest = total / ((performance.now() - started) / 1000);

const p95 = (queries: Parameters<History["search"]>[0][]) => {
	const times = queries.map((q) => {
		const t = performance.now();
		history.search(q);
		return performance.now() - t;
	}).sort((a, b) => a - b);
	return times[Math.floor(times.length * 0.95)]!;
};
const text = () => `${word()} ${word()}`;
const plain = p95(Array.from({ length: 300 }, text));
const filtered = p95(Array.from({ length: 300 }, () => ({ text: text(), person: people[Math.floor(rand() * people.length)]!, repo: repos[Math.floor(rand() * repos.length)]! })));
const dated = p95(Array.from({ length: 300 }, () => ({ text: text(), since: 1_700_000_000_000 + total * 30_000 })));

const rows = [
	["chunks", String(total)],
	["ingest per second", ingest.toFixed(0), ingest > 500 ? "ok" : "MISSED (> 500)"],
	["search p95, ms", plain.toFixed(1), plain < 50 ? "ok" : "MISSED (< 50)"],
	["search p95 with person and repo, ms", filtered.toFixed(1), filtered < 50 ? "ok" : "MISSED (< 50)"],
	["search p95 over the recent half, ms", dated.toFixed(1), dated < 50 ? "ok" : "MISSED (< 50)"],
];
for (const row of rows) console.log(row.join("  "));
history.close();
rmSync(dir, { recursive: true, force: true });
process.exit(rows.some((r) => r[2]?.startsWith("MISSED")) ? 1 : 0);
