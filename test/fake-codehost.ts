import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";

/**
 * Enough of a code host to run Scout against over HTTP: Forgejo's API (`/api/v1`), or GitHub's where the two differ
 * (`kind: "github"`). It keeps repositories with their issues and pull requests (one numbering, as both do), comments,
 * reviews and line comments, reactions, requested reviewers, commit statuses, collaborators and Scout's notifications,
 * and records every call. A repository given its bare git directory reads pull requests' head commits and changed
 * files from it, so what Scout pushed is what the host shows. Scout's account is `scout`.
 */
export type Kind = "forgejo" | "github";
export type HostCall = { method: string; path: string; body: unknown };
type User = { login: string };
type Comment = { id: number; body: string; user: User; created_at: string; html_url: string };
type Review = { id: number; body: string; user: User; state: string; submitted_at: string; html_url: string; comments_count: number; commit_id?: string };
type LineComment = { id: number; body: string; user: User; created_at: string; html_url: string; path: string; line: number; review: number };
type Item = {
	number: number;
	title: string;
	body: string;
	author: string;
	state: "open" | "closed";
	assignees: string[];
	/** Who assigned it to its assignees: its author, unless said otherwise. */
	assignedBy?: string;
	createdAt: string;
	updatedAt: string;
	pull?: { head: string; base: string; sha?: string; fork?: string; merged: boolean; reviewers: string[]; teams: string[]; files?: string[]; mergeable?: boolean; draft?: boolean };
	comments: Comment[];
	reviews: Review[];
	lines: LineComment[];
};
type Repo = { slug: string; private: boolean; git?: string; items: Map<number, Item>; collaborators: Map<string, string>; branches: Set<string> };
type Status = { state: "pending" | "success" | "failure" | "error"; context?: string; target_url?: string; description?: string };

export async function fakeCodeHost(options: { kind?: Kind; me?: string } = {}) {
	const kind = options.kind ?? "forgejo";
	const me = options.me ?? "scout";
	const calls: HostCall[] = [];
	const repos = new Map<string, Repo>();
	const statuses = new Map<string, Status[]>();
	const notifications: { id: number; slug: string; number: number; pull: boolean }[] = [];
	/** Reactions Scout left, as `slug#number` or `slug comment id`, with the emoji. */
	const reactions: string[] = [];
	/** Branches Scout deleted, as `slug:branch`. */
	const deleted: string[] = [];
	/** Calls to answer with an error instead, while `left` lasts (`fail`, below). */
	const faults: { method: string; path: RegExp; status: number; left: number }[] = [];
	/** Every request as it arrives, before any `slow` hold: what `arrived` counts. */
	const arrivals: { method: string; path: string }[] = [];
	/** Calls to hold before they take effect, while `left` lasts (`slow`, below). */
	const delays: { method: string; path: RegExp; ms: number; left: number }[] = [];
	let ids = 1000;
	let notices = 0;
	let port = 0;
	const web = () => `http://127.0.0.1:${port}`;
	const now = () => new Date().toISOString();

	const repo = (slug: string, init: { private?: boolean; git?: string } = {}): Repo => {
		let r = repos.get(slug.toLowerCase());
		if (r === undefined) {
			r = { slug, private: init.private ?? false, items: new Map(), collaborators: new Map([[me, "write"]]), branches: new Set(), ...(init.git === undefined ? {} : { git: init.git }) };
			repos.set(slug.toLowerCase(), r);
		}
		if (init.private !== undefined) r.private = init.private;
		if (init.git !== undefined) r.git = init.git;
		return r;
	};
	const item = (slug: string, number: number): Item | undefined => repos.get(slug.toLowerCase())?.items.get(number);
	const add = (slug: string, fields: Partial<Item> & { title: string }): Item => {
		const r = repo(slug);
		const number = r.items.size + 1;
		const it: Item = { number, body: "", author: "ann", state: "open", assignees: [], createdAt: now(), updatedAt: now(), comments: [], reviews: [], lines: [], ...fields };
		r.items.set(number, it);
		return it;
	};
	const git = (r: Repo, ...args: string[]): string | undefined => {
		if (r.git === undefined) return undefined;
		try {
			return execFileSync("git", ["--git-dir", r.git, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		} catch {
			return undefined;
		}
	};
	const htmlUrl = (r: Repo, it: Item) => `${web()}/${r.slug}/${it.pull === undefined ? "issues" : "pulls"}/${it.number}`;
	const issueJson = (r: Repo, it: Item) => ({
		number: it.number,
		title: it.title,
		body: it.body,
		html_url: htmlUrl(r, it),
		user: { login: it.author },
		state: it.state,
		assignees: it.assignees.map((login) => ({ login })),
		created_at: it.createdAt,
		updated_at: it.updatedAt,
		...(it.pull === undefined ? {} : { pull_request: { merged: it.pull.merged } }),
	});
	const pullJson = (r: Repo, it: Item) => {
		const p = it.pull!;
		return {
			...issueJson(r, it),
			merged: p.merged,
			draft: p.draft === true,
			...(p.mergeable === undefined ? {} : { mergeable: p.mergeable }),
			head: { ref: p.head, sha: p.sha ?? git(r, "rev-parse", `refs/heads/${p.head}`) ?? "0".repeat(40), repo: { full_name: p.fork ?? r.slug } },
			base: { ref: p.base, sha: git(r, "rev-parse", `refs/heads/${p.base}`) ?? "0".repeat(40) },
			requested_reviewers: p.reviewers.map((login) => ({ login })),
			requested_teams: p.teams.map((name) => ({ name })),
		};
	};
	const files = (r: Repo, it: Item): string[] => {
		const p = it.pull!;
		if (p.files !== undefined) return p.files;
		const changed = git(r, "diff", "--name-only", `refs/heads/${p.base}...refs/heads/${p.head}`);
		return changed === undefined || changed === "" ? [] : changed.split("\n");
	};
	const combined = (sha: string) => {
		const all = statuses.get(sha) ?? [];
		const state = all.length === 0 ? "pending" : all.some((s) => s.state === "failure" || s.state === "error") ? "failure" : all.some((s) => s.state === "pending") ? "pending" : "success";
		return { state, total_count: all.length, sha, statuses: all.map((s) => ({ ...s, status: s.state })) };
	};

	type Answer = { status: number; body?: unknown };
	const route = (method: string, path: string, query: URLSearchParams, body: Record<string, unknown>): Answer => {
		const ok = (json: unknown, status = 200): Answer => ({ status, body: json });
		if (path === "/user") return ok({ login: me });
		if (path === "/notifications" && method === "GET") {
			return ok(
				notifications.map((n) => ({
					id: n.id,
					repository: { full_name: n.slug },
					subject: { type: n.pull ? (kind === "github" ? "PullRequest" : "Pull") : "Issue", url: `${web()}/api/v1/repos/${n.slug}/${n.pull ? "pulls" : "issues"}/${n.number}` },
				})),
			);
		}
		const read = /^\/notifications\/threads\/(\d+)$/.exec(path);
		if (read !== null && method === "PATCH") {
			const at = notifications.findIndex((n) => String(n.id) === read[1]);
			if (at >= 0) notifications.splice(at, 1);
			return { status: 205 };
		}
		const repoPath = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(path);
		if (repoPath === null) return { status: 404, body: { message: "not found" } };
		const r = repos.get(repoPath[1]!.toLowerCase());
		if (r === undefined) return { status: 404, body: { message: "no such repository" } };
		const rest = repoPath[2] ?? "";
		if (rest === "") return ok({ full_name: r.slug, private: r.private });

		const permission = /^\/collaborators\/([^/]+)\/permission$/.exec(rest);
		if (permission !== null) return ok({ permission: r.collaborators.get(decodeURIComponent(permission[1]!)) ?? "none" });
		const status = /^\/commits\/([^/]+)\/status$/.exec(rest);
		if (status !== null) return ok(combined(status[1]!));
		if (/^\/commits\/[^/]+\/check-runs$/.test(rest)) return ok({ check_runs: [] });
		const branch = kind === "github" ? /^\/git\/refs\/heads\/(.+)$/.exec(rest) : /^\/branches\/([^/]+)$/.exec(rest);
		if (branch !== null && method === "DELETE") {
			deleted.push(`${r.slug}:${decodeURIComponent(branch[1]!)}`);
			if (r.git !== undefined) git(r, "update-ref", "-d", `refs/heads/${decodeURIComponent(branch[1]!)}`);
			return { status: 204 };
		}

		if (rest === "/pulls" && method === "POST") {
			const head = String(body.head);
			const open = [...r.items.values()].find((i) => i.pull?.head === head && i.state === "open");
			if (open !== undefined) return { status: kind === "github" ? 422 : 409, body: { message: "a pull request for this branch already exists" } };
			const it = add(r.slug, { title: String(body.title), body: String(body.body ?? ""), author: me, pull: { head, base: String(body.base), merged: false, reviewers: [], teams: [] } });
			return ok(pullJson(r, it), 201);
		}
		if (rest === "/pulls" || rest === "/issues") {
			const state = query.get("state") ?? "open";
			const wanted = [...r.items.values()].filter((i) => (rest === "/pulls") === (i.pull !== undefined) && (state === "all" || i.state === state));
			return ok(wanted.map((i) => (i.pull === undefined ? issueJson(r, i) : pullJson(r, i))));
		}

		const reaction = /^\/issues\/(?:comments\/(\d+)|(\d+))\/reactions$/.exec(rest);
		if (reaction !== null && method === "POST") {
			reactions.push(`${r.slug}${reaction[1] === undefined ? `#${reaction[2]}` : ` comment ${reaction[1]}`} ${String(body.content)}`);
			return ok({ content: body.content }, 201);
		}
		const m = /^\/(issues|pulls)\/(\d+)(\/[a-z_]+)?(?:\/(\d+)\/comments)?$/.exec(rest);
		const it = m === null ? undefined : r.items.get(Number(m[2]));
		if (m === null || it === undefined) return { status: 404, body: { message: "not found" } };
		const sub = m[3] ?? "";
		const by = { login: me };
		if (sub === "" && method === "GET") return ok(m[1] === "pulls" && it.pull !== undefined ? pullJson(r, it) : issueJson(r, it));
		if (sub === "" && method === "PATCH") {
			if (body.state === "closed" || body.state === "open") it.state = body.state;
			if (typeof body.title === "string") it.title = body.title;
			if (typeof body.body === "string") it.body = body.body;
			it.updatedAt = now();
			return ok(it.pull === undefined ? issueJson(r, it) : pullJson(r, it));
		}
		if (sub === "/comments" && m[1] === "issues") {
			if (method === "POST") {
				const comment = { id: ++ids, body: String(body.body), user: by, created_at: now(), html_url: `${htmlUrl(r, it)}#issuecomment-${ids}` };
				it.comments.push(comment);
				it.updatedAt = now();
				return ok(comment, 201);
			}
			return ok(it.comments);
		}
		if (sub === "/comments" && m[1] === "pulls") return ok(it.lines.map(({ review, ...c }) => ({ ...c, pull_request_review_id: review })));
		if (sub === "/reviews" && m[4] !== undefined) return ok(it.lines.filter((c) => c.review === Number(m[4])).map(({ review: _, ...c }) => c));
		if (sub === "/reviews" && method === "POST") {
			const review: Review = { id: ++ids, body: String(body.body ?? ""), user: by, state: String(body.event ?? "COMMENT"), submitted_at: now(), html_url: `${htmlUrl(r, it)}#review-${ids}`, comments_count: 0, ...(typeof body.commit_id === "string" ? { commit_id: body.commit_id } : {}) };
			for (const c of (body.comments ?? []) as { path: string; line?: number; new_position?: number; body: string }[]) {
				it.lines.push({ id: ++ids, body: c.body, user: by, created_at: now(), html_url: review.html_url, path: c.path, line: c.line ?? c.new_position ?? 0, review: review.id });
				review.comments_count++;
			}
			it.reviews.push(review);
			return ok(review, 200);
		}
		if (sub === "/reviews") return ok(it.reviews);
		if (sub === "/requested_reviewers" && method === "POST" && it.pull !== undefined) {
			it.pull.reviewers.push(...((body.reviewers ?? []) as string[]));
			it.pull.teams.push(...((body.team_reviewers ?? []) as string[]));
			return ok(pullJson(r, it), 201);
		}
		if (sub === "/files" && it.pull !== undefined) return ok(files(r, it).map((filename) => ({ filename })));
		// The issue's history: who assigned whom (GitHub's events, Forgejo's timeline), all on the first page.
		if ((sub === "/events" && kind === "github") || (sub === "/timeline" && kind === "forgejo")) {
			if (query.get("page") !== "1") return ok([]);
			const by = { login: it.assignedBy ?? it.author };
			return ok(it.assignees.map((login) => (kind === "github" ? { event: "assigned", actor: by, assignee: { login } } : { type: "assignees", user: by, assignee: { login }, removed_assignee: false })));
		}
		return { status: 404, body: { message: "not found" } };
	};

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://host");
		const path = url.pathname.replace(/^\/api\/v1/, "").replace(/\/$/, "");
		const raw = await read(req);
		const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
		const method = req.method ?? "GET";
		arrivals.push({ method, path });
		const delay = delays.find((d) => d.left > 0 && d.method === method && d.path.test(path));
		if (delay !== undefined) {
			delay.left--;
			await new Promise((resolve) => setTimeout(resolve, delay.ms));
		}
		calls.push({ method, path, body });
		const fault = faults.find((f) => f.left > 0 && f.method === method && f.path.test(path));
		if (fault !== undefined) fault.left--;
		const answer = fault === undefined ? route(method, path, url.searchParams, body) : { status: fault.status, body: { message: "the code host is having a bad day" } };
		res.writeHead(answer.status, { "content-type": "application/json" }).end(answer.body === undefined ? undefined : JSON.stringify(answer.body));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	port = typeof address === "object" && address !== null ? address.port : 0;

	return {
		kind,
		/** What SCOUT_CODEHOST_API should say. */
		apiUrl: kind === "github" ? web() : `${web()}/api/v1`,
		webUrl: web(),
		calls,
		reactions,
		deleted,
		/** Requests that have reached the host, including ones still held by `slow` (`called` has only the ones it has handled). */
		arrived: (method: string, path: RegExp) => arrivals.filter((c) => c.method === method && path.test(c.path)),
		/** Calls with this method whose path matches. */
		called: (method: string, path: RegExp) => calls.filter((c) => c.method === method && path.test(c.path)),
		/** A repository (made if new): public unless said otherwise; `git` is its bare repository on disk. */
		repo: (slug: string, init: { private?: boolean; git?: string } = {}) => repo(slug, init),
		/** Someone's permission on a repository: "read", "write", "admin". */
		collaborator: (slug: string, login: string, permission: string) => void repo(slug).collaborators.set(login, permission),
		issue: (slug: string, fields: { title: string; body?: string; author?: string; assignees?: string[]; assignedBy?: string }) => add(slug, fields).number,
		/** Someone's pull request, from `head` into `base` (main); `fork` is the repository it comes from. */
		pull: (slug: string, fields: { title: string; head: string; base?: string; body?: string; author?: string; reviewers?: string[]; sha?: string; fork?: string; files?: string[] }) =>
			add(slug, {
				title: fields.title,
				body: fields.body ?? "",
				author: fields.author ?? "ann",
				pull: {
					head: fields.head,
					base: fields.base ?? "main",
					merged: false,
					reviewers: fields.reviewers ?? [],
					teams: [],
					...(fields.sha === undefined ? {} : { sha: fields.sha }),
					...(fields.fork === undefined ? {} : { fork: fields.fork }),
					...(fields.files === undefined ? {} : { files: fields.files }),
				},
			}).number,
		/** The issue or pull request, as the host keeps it: its comments, reviews, line comments and state. */
		get: (slug: string, number: number) => item(slug, number),
		/** Pull requests Scout opened, oldest first. */
		opened: () => [...repos.values()].flatMap((r) => [...r.items.values()].filter((i) => i.pull !== undefined && i.author === me).map((i) => ({ slug: r.slug, ...i }))),
		/** Someone comments; with `notify`, Scout gets a notification for it, as for a mention. */
		comment: (slug: string, number: number, author: string, body: string, notify = true) => {
			const it = item(slug, number)!;
			const id = ++ids;
			it.comments.push({ id, body, user: { login: author }, created_at: now(), html_url: `${htmlUrl(repo(slug), it)}#issuecomment-${id}` });
			it.updatedAt = now();
			if (notify) notifications.push({ id: ++notices, slug: repo(slug).slug, number, pull: it.pull !== undefined });
			return id;
		},
		/** A notification for an issue or pull request (assigned, review requested, mentioned). */
		notify: (slug: string, number: number) => void notifications.push({ id: ++notices, slug: repo(slug).slug, number, pull: item(slug, number)?.pull !== undefined }),
		/** Someone reviews a pull request: "APPROVED", "REQUEST_CHANGES" or "COMMENT", with comments on lines. */
		review: (slug: string, number: number, author: string, state: string, body: string, lines: { path: string; line: number; body: string }[] = []) => {
			const it = item(slug, number)!;
			const review: Review = { id: ++ids, body, user: { login: author }, state, submitted_at: now(), html_url: `${htmlUrl(repo(slug), it)}#review-${ids}`, comments_count: lines.length };
			for (const l of lines) it.lines.push({ id: ++ids, body: l.body, user: { login: author }, created_at: now(), html_url: review.html_url, path: l.path, line: l.line, review: review.id });
			it.reviews.push(review);
			it.updatedAt = now();
		},
		merge: (slug: string, number: number) => {
			const it = item(slug, number)!;
			it.state = "closed";
			it.pull!.merged = true;
			it.updatedAt = now();
		},
		closePull: (slug: string, number: number) => {
			const it = item(slug, number)!;
			it.state = "closed";
			it.updatedAt = now();
		},
		/** A commit's CI: each context's latest state. */
		ci: (sha: string, state: Status["state"], context = "ci/test", extra: Omit<Status, "state" | "context"> = {}) => {
			const all = (statuses.get(sha) ?? []).filter((s) => s.context !== context);
			statuses.set(sha, [...all, { state, context, ...extra }]);
		},
		/** A pull request's head commit, as the host sees it. */
		headOf: (slug: string, number: number) => pullJson(repo(slug), item(slug, number)!).head.sha,
		/** Answer the next calls matching `method` and `path` with `status`, `times` times: an outage. */
		fail: (method: string, path: RegExp, status = 500, times = 1) => void faults.push({ method, path, status, left: times }),
		/** Hold matching calls `ms` before they take effect (a slow code host). */
		slow: (method: string, path: RegExp, ms: number, times = 1) => void delays.push({ method, path, ms, left: times }),
		close: () => {
			server.closeAllConnections();
			return new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

export type FakeCodeHost = Awaited<ReturnType<typeof fakeCodeHost>>;

function read(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString()));
		req.on("error", reject);
	});
}
