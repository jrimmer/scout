import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { History } from "../src/history.ts";

/**
 * The embeddings gate (docs/session-index.md, "Retrieval"): do embeddings find the right threads more often than plain
 * full-text search? Nothing here ships. It reads a copy of an index, embeds its chunks through an OpenAI-style
 * `/embeddings` endpoint, and for each question in a file compares recall at 5 for words alone, meaning alone and the
 * two fused (reciprocal rank fusion).
 *
 *   node test/retrieval-eval.ts --db copy.sqlite --questions questions.json [--url https://llm.lacy.casa/v1] [--model …]
 *   node test/retrieval-eval.ts --db copy.sqlite --mine        # candidate questions to label: each thread's first words
 *
 * questions.json: [{ "q": "why is the build slow", "expect": ["C0123:1700000000.000100"] }, …] where `expect` are the
 * keys of the threads (or pull requests) that a good answer should include. The gate is at least 50 real questions, and
 * hybrid has to win by the margin set before looking (10 points of recall at 5).
 */
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
	const a = process.argv[i]!;
	if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? "true" : process.argv[++i]!);
}
const dbPath = args.get("db");
if (dbPath === undefined) throw new Error("--db is required (a copy of scout.sqlite)");
const url = args.get("url") ?? "https://llm.lacy.casa/v1";
const model = args.get("model") ?? "local-embed//opt/llama-embed/nomic-embed-text.Q8.gguf";

const history = new History(dbPath);
const db = new DatabaseSync(dbPath, { readOnly: true });

type Row = { id: number; key: string; text: string };
const rows = db
	.prepare(
		`SELECT c.id, COALESCE(d.thread, d.parent, d.id) AS key, t.text FROM history_chunks c
		 JOIN history_docs d ON d.id = c.doc JOIN history_text t ON t.rowid = c.id WHERE d.kind <> 'tool'`,
	)
	.all() as Row[];

if (args.has("mine")) {
	const first = new Map<string, string>();
	for (const r of rows) if (!first.has(r.key)) first.set(r.key, r.text.replace(/\s+/g, " ").slice(0, 110));
	for (const [key, text] of first) console.log(`${key}\t${text}`);
	process.exit(0);
}

const questions = JSON.parse(readFileSync(args.get("questions") ?? "", "utf8")) as { q: string; expect: string[] }[];

async function embed(inputs: string[]): Promise<number[][]> {
	const out: number[][] = [];
	for (let i = 0; i < inputs.length; i += 16) {
		// The model's input limit is in tokens; a chunk is at most ~800, so clip the characters to stay inside any limit.
		const res = await fetch(`${url}/embeddings`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model, input: inputs.slice(i, i + 16).map((t) => t.slice(0, 2000)) }),
		});
		if (!res.ok) throw new Error(`embeddings answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
		out.push(...((await res.json()) as { data: { embedding: number[] }[] }).data.map((d) => d.embedding));
	}
	return out;
}
const norm = (v: number[]) => {
	const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
	return v.map((x) => x / n);
};
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

const started = performance.now();
const vectors = (await embed(rows.map((r) => r.text))).map(norm);
console.log(`embedded ${rows.length} chunks in ${((performance.now() - started) / 1000).toFixed(1)}s (${vectors[0]?.length} dimensions)`);

const unique = (keys: string[]) => [...new Set(keys)];
const recall = (got: string[], expect: string[]) => (expect.length === 0 ? 1 : expect.filter((e) => got.slice(0, 5).includes(e)).length / expect.length);
const totals = { words: 0, meaning: 0, both: 0 };
let latency = 0;
for (const { q, expect } of questions) {
	const words = unique(history.search({ text: q, limit: 50 }).map((h) => h.key));
	const t0 = performance.now();
	const [qv] = (await embed([q])).map(norm);
	const meaning = unique(
		vectors
			.map((v, i) => ({ score: dot(qv!, v), key: rows[i]!.key }))
			.sort((a, b) => b.score - a.score)
			.slice(0, 200)
			.map((s) => s.key),
	).slice(0, 50);
	latency += performance.now() - t0;
	const fused = new Map<string, number>();
	for (const list of [words, meaning]) list.forEach((key, rank) => fused.set(key, (fused.get(key) ?? 0) + 1 / (60 + rank + 1)));
	const both = [...fused].sort((a, b) => b[1] - a[1]).map(([key]) => key);
	totals.words += recall(words, expect);
	totals.meaning += recall(meaning, expect);
	totals.both += recall(both, expect);
}
const n = questions.length;
const pct = (x: number) => `${((100 * x) / n).toFixed(1)}%`;
console.log(`${n} questions: recall@5 words ${pct(totals.words)}, meaning ${pct(totals.meaning)}, both ${pct(totals.both)}`);
console.log(`meaning adds ${((100 * (totals.both - totals.words)) / n).toFixed(1)} points over words (the gate: at least 10, from at least 50 real questions); ${(latency / n).toFixed(0)} ms per question for the embedding and scan`);
if (n < 50) console.log(`only ${n} questions: this is a smoke test of the harness, not the gate`);
