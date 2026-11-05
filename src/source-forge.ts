import type { Page, Source } from "./crawler.ts";
import { type Change, type Forge, type Remark, TooManyChanges } from "./forge.ts";
import { type Doc, type History, type Link, threadRef } from "./history.ts";

/**
 * The code host as a source for the session index (docs/session-index.md): pull requests and issues, what people said
 * on them, and the links between them (`Fixes #12`, `Reverts #40`, "builds on #8") that say what became of a change.
 * A thread's pull requests are linked to it, so `History.outcome` can say whether the work held.
 */

const DAY = 24 * 60 * 60 * 1000;
/** Where a first crawl of a repository starts: further back is a lot of requests for old news. */
const BACKFILL = 180 * DAY;
const MOST_MENTIONS = 20;

export type ForgeSourceOptions = {
	forge: Forge;
	/** The repositories to read (`owner/name`), as they are now. */
	repos: () => string[];
	/** The thread (its key) that opened a pull request, when Scout did. */
	threadOf: (slug: string, number: number) => string | undefined;
	/** How many issues and pull requests make a page (each is a few requests for its comments and reviews). */
	pageSize?: number;
	backfillMs?: number;
	now?: () => number;
};

/** `forge:item:owner/name#12`, lower case: how a reference finds the document, whichever way it was written. */
export const itemId = (slug: string, number: number): string => `forge:item:${slug.toLowerCase()}#${number}`;

/** A person on the code host as the index knows them; Scout's own account is Scout. */
export const authorId = (login: string, me: string): string => (login === me ? "scout" : `forge:${login}`);

export function forgeSource(options: ForgeSourceOptions): Source {
	const now = options.now ?? Date.now;
	const pageSize = options.pageSize ?? 10;
	return {
		name: "forge",
		scopes: () => options.repos(),
		async *crawl(slug, cursor, signal): AsyncGenerator<Page> {
			const since = cursor === undefined ? now() - (options.backfillMs ?? BACKFILL) : Number(cursor);
			const me = await options.forge.me();
			// More than the host lets one pass read (a big repository's first look): start nearer, and the older end goes unread.
			let from = since;
			let changes: Change[] | undefined;
			for (let attempt = 0; changes === undefined; attempt++) {
				try {
					changes = await options.forge.changed(slug, from);
				} catch (error) {
					if (!(error instanceof TooManyChanges) || attempt >= 6) throw error;
					from = from + (now() - from) / 2;
					console.error(`${slug}: ${error.message}; reading from ${new Date(from).toISOString()} instead`);
				}
			}
			for (let i = 0; i < changes.length; i += pageSize) {
				if (signal.aborted) return;
				const docs: Doc[] = [];
				const links: Link[] = [];
				const batch = changes.slice(i, i + pageSize);
				for (const change of batch) {
					// An item that has gone (deleted, or no longer ours to read) is kept without its comments, not retried for ever.
					const remarks = await options.forge.remarks(change, { allPages: true }).catch((error: unknown) => {
						if (error instanceof Error && /answered (404|410)\b/.test(error.message)) return [];
						throw error;
					});
					const thread = change.pull ? options.threadOf(slug, change.number) : undefined;
					const made = itemDocs(slug, change, remarks, me);
					docs.push(...made.docs);
					links.push(...made.links, ...(thread === undefined ? [] : [{ from: threadRef(thread), to: itemId(slug, change.number), rel: "opened", at: change.createdAt, source: "forge" }]));
				}
				yield { docs, links, cursor: String(batch.at(-1)!.updatedAt) };
			}
		},
	};
}

/** The documents and links for one issue or pull request with what was said on it. */
export function itemDocs(slug: string, change: Change, remarks: Remark[], me: string): { docs: Doc[]; links: Link[] } {
	const id = itemId(slug, change.number);
	const state = change.pull ? (change.merged ? "merged" : change.state === "closed" ? "closed" : "open") : change.state === "closed" ? "closed" : "open";
	const docs: Doc[] = [
		{
			id,
			source: "forge",
			kind: change.pull ? "pull" : "issue",
			repo: slug,
			author: authorId(change.author, me),
			authorName: change.author,
			at: change.createdAt,
			title: change.title,
			url: change.url,
			text: change.body,
			meta: { state, ...(change.mergedAt === undefined ? {} : { mergedAt: change.mergedAt }), ...(change.closedAt === undefined ? {} : { closedAt: change.closedAt }) },
		},
	];
	for (const r of remarks) {
		const verdict = r.review === undefined ? undefined : /approv/i.test(r.review) ? "approved" : /change/i.test(r.review) ? "changes" : "comment";
		const summary = r.id.startsWith("review:");
		const text = r.body.trim() !== "" ? r.body : summary && verdict === "approved" ? "Approved." : summary && verdict === "changes" ? "Asked for changes." : "";
		if (text === "") continue;
		docs.push({
			id: `forge:remark:${slug.toLowerCase()}#${change.number}:${r.id}`,
			source: "forge",
			kind: summary ? "review" : "comment",
			repo: slug,
			author: authorId(r.author, me),
			authorName: r.author,
			at: r.at,
			url: r.url ?? change.url,
			parent: id,
			text,
			meta: { ...(verdict === undefined ? {} : { review: verdict }), ...(r.path === undefined ? {} : { path: r.path }), ...(r.line === undefined ? {} : { line: r.line }) },
		});
	}
	return { docs, links: linksIn(slug, change, id) };
}

const REF = String.raw`(?:([\w.-]+\/[\w.-]+))?#(\d+)`;

/** What the title and description say about other issues and pull requests, as links from this one. */
export function linksIn(slug: string, change: Pick<Change, "number" | "title" | "body" | "pull" | "createdAt">, from: string): Link[] {
	const text = `${change.title}\n${change.body}`;
	const links = new Map<string, Link>();
	const add = (rel: string, repo: string | undefined, number: string) => {
		const to = itemId(repo ?? slug, Number(number));
		if (to === from) return;
		const key = `${to} ${rel}`;
		if (!links.has(key)) links.set(key, { from, to, rel, at: change.createdAt, source: "forge" });
	};
	const each = (pattern: RegExp, rel: string) => {
		for (const m of text.matchAll(pattern)) add(rel, m[1], m[2]!);
	};
	each(new RegExp(String.raw`\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s*:?\s+${REF}`, "gi"), "closes");
	if (change.pull) {
		// "Revert "Add the cache (#40)"" in the title, or a line of the description that begins "Reverts #40".
		if (/^revert\b/i.test(change.title)) for (const m of change.title.matchAll(new RegExp(REF, "g"))) add("reverts", m[1], m[2]!);
		for (const m of change.body.matchAll(new RegExp(String.raw`(?:^|\n)[ \t>*-]*(?:this\s+)?reverts?\s+(?:(?:pull\s+request|pr)\s+)?${REF}`, "gi"))) add("reverts", m[1], m[2]!);
	}
	each(new RegExp(String.raw`\b(?:builds?\s+on|follow(?:s|ing)?[ -]?ups?\s+(?:to|of|on|for)|follows|stacked\s+on|depends\s+on|based\s+on)\s+${REF}`, "gi"), "builds_on");
	const specific = new Set([...links.values()].map((l) => l.to));
	let mentions = 0;
	for (const m of text.matchAll(new RegExp(String.raw`(?<![\w/&#.:@-])${REF}`, "g"))) {
		const to = itemId(m[1] ?? slug, Number(m[2]));
		if (specific.has(to) || mentions >= MOST_MENTIONS) continue;
		const before = links.size;
		add("mentions", m[1], m[2]!);
		if (links.size > before) mentions++;
	}
	return [...links.values()];
}

/**
 * Tells the index which code host logins are which Slack users, so what someone said in Slack and what they wrote
 * there are one person's. `loginOf` is the same lookup that decides who may ask for work.
 */
export async function linkLogins(history: History, loginOf: (user: string) => Promise<string | undefined>): Promise<number> {
	let linked = 0;
	for (const person of history.everyone()) {
		if (!/^[UW][A-Z0-9]{2,}$/.test(person.id)) continue;
		const login = await loginOf(person.id).catch(() => undefined);
		if (login === undefined || login === "") continue;
		history.alias(`forge:${login}`, person.id);
		linked++;
	}
	return linked;
}
