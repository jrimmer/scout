import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Hit, History } from "./history.ts";
import type { ThreadRow, Threads } from "./threads.ts";

/**
 * Scout's questions to the session index (docs/session-index.md, docs/session-querying.md): finding earlier threads
 * and pull requests, reading them whole, and what a repository's recent work looks like. Everything here is public
 * work, so anyone may ask by default; `SCOUT_HISTORY_ASK=admin` keeps the questions about people and the reports to
 * admins, and plain search for earlier threads open to everyone as it always was.
 */
export type HistoryAccess = {
	history: History;
	threads: Threads;
	/** A link to a Slack thread. */
	link: (thread: ThreadRow) => Promise<string | undefined>;
	/** The repositories this conversation may read (the person asking may work in them): a pull request from any other doesn't come back. */
	readable: (conversationId: number) => Promise<{ name: string; slug: string }[]>;
	/** Every repository, with the channels it is worked on in. */
	repos: () => { name: string; slug: string; channels: string[] }[];
	/** Who asked, for the conversation: its thread's last asker. */
	askerOf: (conversationId: number) => string | undefined;
	ask: "public" | "admin";
	isAdmin: (user: string) => Promise<boolean>;
	now?: () => number;
};

const DAY = 24 * 60 * 60 * 1000;
const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const say = (text: string) => ({ output: [{ type: "text" as const, text }] });

export function historyExtension(access: HistoryAccess) {
	const { history, threads } = access;
	const now = () => (access.now ?? Date.now)();

	/** Whether this conversation's asker may ask about people and get reports. */
	const mayAnalyze = async (conversationId: number): Promise<boolean> => {
		if (access.ask === "public") return true;
		const asker = access.askerOf(conversationId);
		return asker !== undefined && asker !== "scout" && (await access.isAdmin(asker));
	};
	const refusal = say("Questions about particular people's threads, and reports on a repository, are for admins here. I can still search earlier threads by topic.");

	/** Who this name is: one person, or why not. */
	const personNamed = (name: string): { id: string; name: string } | { say: ReturnType<typeof say> } => {
		const found = access.history.people(name);
		const exact = found.filter((p) => p.name.toLowerCase() === name.trim().toLowerCase() || p.id === name.trim());
		const pick = exact.length === 1 ? exact : found;
		if (pick.length === 1) return pick[0]!;
		if (pick.length === 0) return { say: say(`I don't know anyone called "${name}" from these threads.`) };
		return { say: say(`More than one person matches "${name}": ${pick.map((p) => p.name).join(", ")}. Which one?`) };
	};
	/** A repository by name, if it is one this conversation may read. */
	const repoNamed = async (name: string, conversationId: number) => {
		const known = access.repos().find((r) => r.name.toLowerCase() === name.trim().toLowerCase() || r.slug.toLowerCase() === name.trim().toLowerCase());
		if (known === undefined) return { say: say(`I don't work in a repository called "${name}". These I do: ${access.repos().map((r) => r.name).join(", ")}.`) };
		const mayRead = (await access.readable(conversationId)).some((r) => r.name === known.name);
		return mayRead ? known : { say: say(`I can't read ${known.name} from this thread.`) };
	};
	const since = (days: number | undefined, fallback?: number) => (days === undefined ? fallback : now() - Math.min(Math.max(days, 0), 3650) * DAY);
	/** Hits from a repository this conversation may not read are left out. */
	const visible = async (hits: Hit[], conversationId: number): Promise<Hit[]> => {
		if (!hits.some((h) => h.repo !== "")) return hits;
		const slugs = new Set((await access.readable(conversationId)).map((r) => r.slug.toLowerCase()));
		return hits.filter((h) => h.repo === "" || slugs.has(h.repo.toLowerCase()));
	};
	const where = async (key: string, url: string): Promise<string> => {
		const thread = threads.get(key);
		return thread === undefined ? url : ((await access.link(thread)) ?? "");
	};

	const searchHistory = defineTool({
		name: "search_history",
		description:
			"Search earlier threads in public channels and the code host's pull requests, reviews and issues: what people " +
			"asked, what was found or decided, and what came of it. Use it when something may have come up before, and " +
			"link what you find. Narrow it by person, repository, source (slack or forge), kind (message, pull, issue, " +
			"review, comment; tool is what Scout ran) or how many days back. Each result gives an id for read_history.",
		parameters: Type.Object({
			query: Type.String({ description: "Words to look for" }),
			person: Type.Optional(Type.String({ description: "Only what this person said or wrote (a name)" })),
			repo: Type.Optional(Type.String({ description: "Only this repository's pull requests and issues, and the threads in its channels" })),
			source: Type.Optional(Type.String({ description: "slack or forge" })),
			kind: Type.Optional(Type.String({ description: "message, pull, issue, review, comment or tool" })),
			since_days: Type.Optional(Type.Number({ description: "Only the last this many days" })),
			limit: Type.Optional(Type.Number({ description: "At most this many results (default 5, at most 20)" })),
		}),
		replay: "safe",
		execute: async (args, api) => {
			const current = threads.byConversation(api.conversationId);
			let person: string | undefined;
			if (args.person !== undefined && args.person.trim() !== "") {
				if (!(await mayAnalyze(api.conversationId))) return refusal;
				const who = personNamed(args.person);
				if ("say" in who) return who.say;
				person = who.id;
			}
			let repo: { slug: string; channels: string[] } | undefined;
			if (args.repo !== undefined && args.repo.trim() !== "") {
				const named = await repoNamed(args.repo, api.conversationId);
				if ("say" in named) return named.say;
				repo = named;
			}
			const limit = Math.min(Math.max(args.limit ?? 5, 1), 20);
			const sinceAt = since(args.since_days);
			const found = history.search({
				text: args.query,
				limit: limit * 4,
				...(person === undefined ? {} : { person }),
				...(repo === undefined ? {} : { repo: repo.slug, channels: repo.channels }),
				...(args.source ? { source: args.source } : {}),
				...(args.kind ? { kind: args.kind } : {}),
				...(sinceAt === undefined ? {} : { since: sinceAt }),
				...(current === undefined ? {} : { excludeThread: current.key }),
			});
			const hits = (await visible(found, api.conversationId)).slice(0, limit);
			if (hits.length === 0) return say("Nothing earlier matches.");
			const lines: string[] = [];
			for (const hit of hits) {
				const url = await where(hit.key, hit.url);
				const place = hit.source === "slack" ? `#${hit.channelName}` : hit.repo;
				lines.push(`- ${hit.speaker} in ${place}, ${day(hit.at)}${url === "" ? "" : ` ${url}`}\n  ${hit.snippet}\n  id: ${hit.key}`);
			}
			return say(lines.join("\n"));
		},
	});

	const readHistory = defineTool({
		name: "read_history",
		description:
			"Read earlier threads, pull requests or issues whole, as they unfolded. Give an id from search_history, or a " +
			"person (a name) with, optionally, a repository and how many days back, to read their most recent threads. " +
			"For questions like how someone works or how a feature was built. It is clipped to a budget and says what it " +
			"left out. When you describe a person's way of working: quote them, say which threads you read and how " +
			"many, and describe patterns; never rank or score people.",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "A result's id" })),
			person: Type.Optional(Type.String({ description: "A name; reads their most recent threads" })),
			repo: Type.Optional(Type.String({ description: "With person: only in this repository" })),
			since_days: Type.Optional(Type.Number({ description: "With person: only the last this many days" })),
			limit: Type.Optional(Type.Number({ description: "With person: how many threads (default 3, at most 8)" })),
			budget: Type.Optional(Type.Number({ description: "Characters to read in all (default 12000, at most 30000)" })),
		}),
		replay: "safe",
		execute: async (args, api) => {
			if (!(await mayAnalyze(api.conversationId))) return refusal;
			const budget = Math.min(Math.max(args.budget ?? 12_000, 1000), 30_000);
			let keys: string[];
			let heading: string;
			if (args.id !== undefined && args.id !== "") {
				keys = [args.id];
				heading = "";
			} else if (args.person !== undefined && args.person.trim() !== "") {
				const who = personNamed(args.person);
				if ("say" in who) return who.say;
				let repo: { slug: string; channels: string[] } | undefined;
				if (args.repo !== undefined && args.repo.trim() !== "") {
					const named = await repoNamed(args.repo, api.conversationId);
					if ("say" in named) return named.say;
					repo = named;
				}
				const sinceAt = since(args.since_days);
				const all = history.threads({ person: who.id, ...(repo === undefined ? {} : { repo: repo.slug, channels: repo.channels }), ...(sinceAt === undefined ? {} : { since: sinceAt }), limit: 50 });
				const wanted = Math.min(Math.max(args.limit ?? 3, 1), 8);
				keys = all.slice(0, wanted).map((t) => t.key);
				heading = `Read the ${keys.length} most recent of ${all.length}${all.length === 50 ? "+" : ""} threads ${who.name} took part in${sinceAt === undefined ? "" : ` since ${day(sinceAt)}`}${repo === undefined ? "" : ` in ${args.repo}`}.\n\n`;
			} else {
				return say("Give me an id from search_history, or a person's name.");
			}
			if (keys.length === 0) return say("Nothing earlier matches.");
			const slugs = new Set((await access.readable(api.conversationId)).map((r) => r.slug.toLowerCase()));
			const out: string[] = [];
			const each = Math.floor(budget / keys.length);
			for (const key of keys) {
				const t = history.read(key, { budget: each });
				if (t === undefined) {
					out.push(`(${key}: nothing there)`);
					continue;
				}
				if (t.repo !== "" && !slugs.has(t.repo.toLowerCase())) {
					out.push(`(${key}: I can't read ${t.repo} from this thread)`);
					continue;
				}
				const url = await where(key, t.url);
				out.push(
					`## ${t.repo === "" ? `#${t.channel}` : t.repo} · ${day(t.at)}${url === "" ? "" : ` · ${url}`}\n` +
						t.entries.map((e) => `${e.speaker || "someone"}: ${e.text}`).join("\n") +
						(t.omitted > 0 ? `\n(… ${t.omitted} entries in the middle left out to fit)` : ""),
				);
			}
			return say(heading + out.join("\n\n"));
		},
	});

	const repoActivity = defineTool({
		name: "repo_activity",
		description:
			"What a repository's recent work looks like: threads in its channels, pull requests opened, merged and closed, " +
			"how many merged without a request for changes and how many after, reviews asking for changes, and what came " +
			"of the pull requests Scout opened (held, fixed, reverted…). Counts, to describe and to ask the next question " +
			"from; they don't say who is good or bad. Pull requests are counted by when they were opened.",
		parameters: Type.Object({
			repo: Type.String({ description: "The repository's name" }),
			since_days: Type.Optional(Type.Number({ description: "How many days back (default 30, at most 365)" })),
		}),
		replay: "safe",
		execute: async (args, api) => {
			if (!(await mayAnalyze(api.conversationId))) return refusal;
			const repo = await repoNamed(args.repo, api.conversationId);
			if ("say" in repo) return repo.say;
			const until = now();
			const from = until - Math.min(Math.max(args.since_days ?? 30, 1), 365) * DAY;
			const a = history.activity({ repo: repo.slug, channels: repo.channels, since: from, until });
			const outcomes = Object.entries(a.outcomes).map(([verdict, n]) => `${n} ${verdict}`);
			return say(
				[
					`${repo.name}, ${day(from)} to ${day(until)}:`,
					`- ${a.threads} threads in ${repo.channels.map((c) => `#${c}`).join(", ") || "no channel"}, ${a.people} people`,
					`- ${a.pulls.opened} pull requests opened (${a.pulls.byScout} by Scout): ${a.pulls.merged} merged, ${a.pulls.closed} closed without merging, ${a.pulls.open} open`,
					`- of the merged: ${a.mergedFirstTime} with no request for changes, ${a.mergedAfterChanges} after at least one; ${a.changeRequests} reviews asked for changes in all`,
					`- ${a.issues.opened} issues opened, ${a.issues.closed} of them closed`,
					`- what became of Scout's pull requests: ${outcomes.length === 0 ? "none opened in this period" : outcomes.join(", ")}`,
				].join("\n"),
			);
		},
	});

	return defineExtension({ name: "history", tools: [searchHistory, readHistory, repoActivity] });
}
