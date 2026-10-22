import type { Axis, ModelScores } from "../bench.ts";

/**
 * The dashboard's Benchmark page (/bench, linked from its footer): two radar charts of the nightly benchmark
 * (bench.ts), what each model can do and what it's like to work with, one outline per model, with the numbers behind
 * them. Plain SVG drawn here, so the page needs no script and works under the dashboard's content security policy
 * (colours come from dash.css classes).
 */
export function benchPage(scores: readonly ModelScores[], meta: { lastRun?: string; keep: number; hour: number; tasks: number }): string {
	const body =
		scores.length === 0
			? `<p class="note">No runs yet. They start each night after ${String(meta.hour).padStart(2, "0")}:00, and the scores show here once a model has finished its tasks.</p>`
			: [
					`<p class="note">${meta.tasks} tasks from Scout's own history, run by every model once a night. Scores are over each model's last ${meta.keep} runs (the latest ${esc(meta.lastRun ?? "")}), on fixed scales, so they mean the same from week to week. A toy: few tasks, one codebase. Compare models with each other here, not with public leaderboards: "Reasoning" here is finding bugs. Tasks the provider cut short aren't scored as the model's, but a slow night still shows on the right: look at it before comparing.</p>`,
					`<ol class="legend">${scores.map((s, i) => `<li class="s${i % SERIES}"><i></i>${esc(s.model)} <small>${s.runs} run${s.runs === 1 ? "" : "s"}</small></li>`).join("")}</ol>`,
					`<section class="charts">`,
					figure("What it can do", scores, (s) => s.capability),
					figure("Working with it", scores, (s) => s.operations),
					`</section>`,
					table("What it can do", scores, (s) => s.capability),
					table("Working with it", scores, (s) => s.operations),
				].join("\n");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scout benchmark</title>
<link rel="stylesheet" href="/static/fonts/jetbrains-mono.css">
<link rel="stylesheet" href="/static/dash.css">
</head>
<body><main class="bench">
<h1>Benchmark</h1>
${body}
${footer("/", "Dashboard")}
</main></body>
</html>
`;
}

/** A page's footer link: the dashboard's to the Benchmark (only when the benchmark is on), and back. */
export function footer(href: string, label: string): string {
	return `<footer class="links"><a href="${href}">${label}</a></footer>`;
}

const SERIES = 4;

function figure(title: string, scores: readonly ModelScores[], axes: (s: ModelScores) => Axis[]): string {
	return `<figure>${radar(scores.map(axes), scores.map((s) => s.model))}<figcaption>${esc(title)}</figcaption></figure>`;
}

/** A radar chart: one spoke per axis, rings at 25/50/75/100, one outline per series. */
export function radar(series: readonly Axis[][], names: readonly string[]): string {
	const axes = series[0] ?? [];
	const n = axes.length;
	const R = 100;
	const at = (i: number, r: number) => {
		const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
		return [r * Math.cos(angle), r * Math.sin(angle)] as const;
	};
	const pts = (r: (i: number) => number) => axes.map((_, i) => at(i, r(i)).map((v) => v.toFixed(1)).join(",")).join(" ");
	const rings = [25, 50, 75, 100].map((p) => `<polygon class="ring" points="${pts(() => (R * p) / 100)}"/>`).join("");
	const spokes = axes.map((_, i) => `<line class="ring" x1="0" y1="0" x2="${at(i, R)[0].toFixed(1)}" y2="${at(i, R)[1].toFixed(1)}"/>`).join("");
	const labels = axes
		.map((a, i) => {
			const [x, y] = at(i, R + 14);
			const anchor = Math.abs(x) < 5 ? "middle" : x > 0 ? "start" : "end";
			return `<text x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="${anchor}"><title>${esc(a.about)}</title>${esc(a.name)}</text>`;
		})
		.join("");
	const shapes = series
		.map((s, k) => {
			const dots = s.map((a, i) => `<circle cx="${at(i, (R * a.score) / 100)[0].toFixed(1)}" cy="${at(i, (R * a.score) / 100)[1].toFixed(1)}" r="2.5"><title>${esc(`${names[k]}: ${a.name} ${a.score} (${a.value})`)}</title></circle>`).join("");
			return `<g class="s${k % SERIES}"><polygon points="${pts((i) => (R * (s[i]?.score ?? 0)) / 100)}"/>${dots}</g>`;
		})
		.join("");
	return `<svg viewBox="-190 -135 380 265" role="img" aria-label="${esc(series.map((s, k) => `${names[k]}: ${s.map((a) => `${a.name} ${a.score}`).join(", ")}`).join("; "))}">${rings}${spokes}${shapes}${labels}</svg>`;
}

function table(title: string, scores: readonly ModelScores[], axes: (s: ModelScores) => Axis[]): string {
	const first = axes(scores[0]!);
	const head = `<tr><th>${esc(title)}</th>${scores.map((s, i) => `<th class="s${i % SERIES}">${esc(s.model)}</th>`).join("")}</tr>`;
	const rows = first.map((a, i) => `<tr><td><b>${esc(a.name)}</b><br><small>${esc(a.about)}</small></td>${scores.map((s) => `<td><b>${axes(s)[i]!.score}</b><br><small>${esc(axes(s)[i]!.value)}</small></td>`).join("")}</tr>`);
	return `<table>${head}${rows.join("")}</table>`;
}

function esc(text: string): string {
	return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
