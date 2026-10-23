import { redact } from "../src/scan.ts";
import { getJson, serve, setting, type Tool } from "./serve.ts";

/**
 * Forgejo Actions, read-only: a repository's recent runs, a run's jobs, and a job's log (its tail, or the lines that
 * match). Scout's own token; logs are redacted for credentials before the model sees them.
 *
 *     FORGEJO_API=http://git.example/api/v1 FORGEJO_TOKEN=… node mcp/forgejo-ci.ts
 */

type Run = {
	id: number;
	index_in_repo: number;
	title: string;
	status: string;
	event: string;
	prettyref: string;
	commit_sha: string;
	workflow_id: string;
	html_url: string;
	started?: string;
	stopped?: string;
};
type Job = { id: number; name: string; status: string; attempt?: number };

const REPO = { type: "string", description: "owner/name, e.g. acme/web" };

export function ciTools(api: string, token: string, fetch: typeof globalThis.fetch = globalThis.fetch): Tool[] {
	const headers = { authorization: `token ${token}` };
	const repoPath = (repo: unknown) => {
		// Forgejo's characters for owners and repositories; `.` and `..` would walk out of /repos/ once the URL is resolved.
		const parts = typeof repo === "string" ? repo.split("/") : [];
		if (parts.length !== 2 || parts.some((p) => !/^[\w.-]+$/.test(p) || p === "." || p === "..")) throw new Error("repo must look like owner/name");
		return `${api}/repos/${repo}`;
	};
	return [
		{
			name: "ci_runs",
			description: "Recent CI runs of a repository, newest first: number, status, workflow, branch, commit and title.",
			inputSchema: {
				type: "object",
				properties: {
					repo: REPO,
					branch: { type: "string", description: "Only runs for this branch" },
					status: { type: "string", description: "Only runs with this status: success, failure, running, waiting, cancelled" },
					limit: { type: "number", description: "How many to show (default 15, at most 50)" },
				},
				required: ["repo"],
			},
			async run(args) {
				const limit = Math.min(50, Number(args.limit ?? 15) || 15);
				// Filters apply to a wider page, so a branch's runs aren't crowded out by others'.
				const { workflow_runs: runs } = (await getJson(fetch, `${repoPath(args.repo)}/actions/runs?limit=50`, headers)) as { workflow_runs: Run[] };
				const shown = runs
					.filter((r) => args.branch === undefined || r.prettyref === args.branch)
					.filter((r) => args.status === undefined || r.status === args.status)
					.slice(0, limit);
				if (shown.length === 0) return "No runs match.";
				return shown
					.map((r) => `#${r.index_in_repo} (run ${r.id}) ${r.status} · ${r.workflow_id} · ${r.prettyref} @ ${r.commit_sha.slice(0, 8)} · ${r.event} · ${r.started ?? "not started"}\n  ${r.title}\n  ${r.html_url}`)
					.join("\n");
			},
		},
		{
			name: "ci_jobs",
			description: "The jobs of one CI run (its run id from ci_runs), with their status.",
			inputSchema: { type: "object", properties: { repo: REPO, run_id: { type: "number", description: "The run's id (not its #number)" } }, required: ["repo", "run_id"] },
			async run(args) {
				const jobs = (await getJson(fetch, `${repoPath(args.repo)}/actions/runs/${Number(args.run_id)}/jobs`, headers)) as Job[];
				return jobs.length === 0 ? "No jobs." : jobs.map((j) => `job ${j.id} · ${j.name} · ${j.status}${j.attempt && j.attempt > 1 ? ` (attempt ${j.attempt})` : ""}`).join("\n");
			},
		},
		{
			name: "ci_log",
			description: "A CI job's log: its last lines, or only the lines matching a pattern (with a little context).",
			inputSchema: {
				type: "object",
				properties: {
					repo: REPO,
					job_id: { type: "number", description: "The job's id, from ci_jobs" },
					tail: { type: "number", description: "How many lines from the end (default 150)" },
					match: { type: "string", description: "Only lines containing this text (case-insensitive), each with 2 lines around it" },
				},
				required: ["repo", "job_id"],
			},
			async run(args) {
				const response = await fetch(`${repoPath(args.repo)}/actions/jobs/${Number(args.job_id)}/logs`, { headers });
				if (!response.ok) throw new Error(`the log answered ${response.status}`);
				// Forgejo stamps each line; the date carries nothing the model needs.
				const lines = (await response.text()).split("\n").map((line) => line.replace(/^\S+Z /, ""));
				let picked: string[];
				if (typeof args.match === "string" && args.match !== "") {
					const needle = args.match.toLowerCase();
					const keep = new Set<number>();
					lines.forEach((line, i) => {
						if (line.toLowerCase().includes(needle)) for (let k = i - 2; k <= i + 2; k++) keep.add(k);
					});
					picked = [...keep].filter((i) => i >= 0 && i < lines.length).sort((a, b) => a - b).map((i) => `${i + 1}: ${lines[i]}`);
					if (picked.length === 0) return `No lines contain "${args.match}" (${lines.length} lines in all).`;
				} else {
					const tail = Math.max(1, Number(args.tail ?? 150) || 150);
					picked = lines.slice(-tail);
					if (lines.length > tail) picked.unshift(`… ${lines.length - tail} earlier lines`);
				}
				return redact(picked.join("\n"));
			},
		},
	];
}

if (import.meta.main) await serve("forgejo-ci", ciTools(setting("FORGEJO_API").replace(/\/$/, ""), setting("FORGEJO_TOKEN")));
