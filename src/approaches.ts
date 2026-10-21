import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Type } from "@earendil-works/pi-ai";
import { AssistantEntry, configure, type ConversationId, defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { ThreadDoc } from "./docs.ts";
import type { ChatMessage } from "./render.ts";

/**
 * Experimental: trying several approaches at once ("try a few ways: a cache, or fixing the query"). Each approach runs
 * in its own conversation and sandbox, starting from the thread's last commit, and reports back; one message in the
 * thread compares them as they go, and people pick one with a button. The chosen approach's commits come onto the
 * thread's branch, and the others' sandboxes go. Only when someone asks for it, for now.
 */
export const MAX_APPROACHES = 4;
export const USE_APPROACH = "scout_use_approach";
/** How often the comparison message is brought up to date while the approaches work. */
const REFRESH_MS = 3_000;

export type ApproachState = "working" | "done" | "failed";
export type Approach = {
	parentId: number;
	index: number;
	name: string;
	plan: string;
	childId: number;
	state: ApproachState;
	tests?: "passed" | "failed" | "not run";
	diff?: string;
	cost?: number;
	report?: string;
	startedAt: number;
	finishedAt?: number;
	chosenBy?: string;
};

export class Approaches {
	readonly #db: DatabaseSync;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.#db = new DatabaseSync(path, { timeout: 5000 });
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS approaches (
				parent_id INTEGER NOT NULL,
				idx INTEGER NOT NULL,
				name TEXT NOT NULL,
				plan TEXT NOT NULL,
				child_id INTEGER NOT NULL,
				state TEXT NOT NULL,
				tests TEXT,
				diff TEXT,
				cost REAL,
				report TEXT,
				started_at INTEGER NOT NULL,
				finished_at INTEGER,
				chosen_by TEXT,
				PRIMARY KEY (parent_id, idx)
			);
		`);
	}

	/** A new set of approaches for a thread replaces any earlier one. */
	start(parentId: number, approaches: { name: string; plan: string; childId: number }[], now = Date.now()): void {
		this.#db.prepare("DELETE FROM approaches WHERE parent_id = ?").run(parentId);
		approaches.forEach((a, i) =>
			this.#db
				.prepare("INSERT INTO approaches (parent_id, idx, name, plan, child_id, state, started_at) VALUES (?, ?, ?, ?, ?, 'working', ?)")
				.run(parentId, i + 1, a.name, a.plan, a.childId, now),
		);
	}

	finished(parentId: number, index: number, result: { state: ApproachState; tests?: string; diff?: string; cost?: number; report?: string }, now = Date.now()): void {
		this.#db
			.prepare("UPDATE approaches SET state = ?, tests = ?, diff = ?, cost = ?, report = ?, finished_at = ? WHERE parent_id = ? AND idx = ?")
			.run(result.state, result.tests ?? null, result.diff ?? null, result.cost ?? null, result.report ?? null, now, parentId, index);
	}

	chosen(parentId: number, index: number, by: string): void {
		this.#db.prepare("UPDATE approaches SET chosen_by = ? WHERE parent_id = ? AND idx = ?").run(by, parentId, index);
	}

	forThread(parentId: number): Approach[] {
		return this.#db
			.prepare("SELECT * FROM approaches WHERE parent_id = ? ORDER BY idx")
			.all(parentId)
			.map((r) => ({
				parentId: Number(r.parent_id),
				index: Number(r.idx),
				name: String(r.name),
				plan: String(r.plan),
				childId: Number(r.child_id),
				state: String(r.state) as ApproachState,
				...(r.tests === null ? {} : { tests: String(r.tests) as Approach["tests"] }),
				...(r.diff === null ? {} : { diff: String(r.diff) }),
				...(r.cost === null ? {} : { cost: Number(r.cost) }),
				...(r.report === null ? {} : { report: String(r.report) }),
				startedAt: Number(r.started_at),
				...(r.finished_at === null ? {} : { finishedAt: Number(r.finished_at) }),
				...(r.chosen_by === null ? {} : { chosenBy: String(r.chosen_by) }),
			}));
	}

	close(): void {
		this.#db.close();
	}
}

/** What the approaches need from the thread's workspaces (workspaces.ts). */
export type ApproachWorkspaces = {
	status(conversationId: number): Promise<string>;
	head(conversationId: number): Promise<string>;
	exportBranch(conversationId: number): Promise<string | undefined>;
	startFrom(conversationId: number, bundle: string): Promise<void>;
	diffStat(conversationId: number, since: string): Promise<string>;
	adopt(conversationId: number, bundle: string): Promise<void>;
	remove(conversationId: number): Promise<void>;
};

export type ApproachesOptions = {
	store: Approaches;
	workspaces: ApproachWorkspaces;
	/** What a conversation has cost since `since`, in dollars. */
	costOf: (conversationId: number, since: number) => number;
	/** Show the comparison in the thread: posts it the first time (returns its ts), then edits it. */
	show: (parentId: number, message: ChatMessage, ts?: string) => Promise<string | undefined>;
	/** Extensions an approach must not have: this one (no approaches within approaches) and opening pull requests. */
	childWithout: () => Extension[];
	now?: () => number;
};

const TESTS = /^\s*Tests:\s*(passed|failed|not run)\s*\.?\s*$/im;

/** `try_approaches`, for the thread's agent. */
export function approachesExtension(options: ApproachesOptions): Extension {
	const now = options.now ?? Date.now;
	const tool = defineTool({
		name: "try_approaches",
		description:
			"Experimental. Only when someone asks you to try or compare several approaches: work on 2 to 4 of them at once, " +
			"each in its own sandbox from your branch's last commit (commit first), and post a comparison people choose " +
			"from with a button. It costs about as much as that many separate requests; say so. Don't pick one yourself.",
		parameters: Type.Object({
			request: Type.String({ description: "What was asked, complete enough for someone starting fresh" }),
			approaches: Type.Array(Type.Object({ name: Type.String({ description: "A few words" }), plan: Type.String({ description: "The approach, in a sentence or two" }) }), {
				minItems: 2,
				maxItems: MAX_APPROACHES,
			}),
		}),
		execute: async (args, api, context) => {
			const parentId: number = api.conversationId;
			const { workspaces, store } = options;
			if ((await workspaces.status(parentId)) !== "") throw new Error("Commit your work first: each approach starts from your branch's last commit.");
			const from = await workspaces.head(parentId);
			const bundle = await workspaces.exportBranch(parentId);
			const thread = await api.snapshot(ThreadDoc, parentId as ConversationId, context);
			const started = now();
			try {
				// One conversation per approach, owned by this call: stopping the thread stops them all.
				const children = await api.commit(async (tx) => {
					const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, MAX_APPROACHES)).items;
					if (existing.length === args.approaches.length) return existing.map((c) => c.id as number);
					const ids: number[] = [];
					for (const _ of args.approaches) {
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						await configure(tx, created.id, { extensions: { remove: options.childWithout() } });
						if (thread !== undefined) Object.assign(await tx.doc(ThreadDoc, created.id), { ...thread, threadTs: "" });
						ids.push(created.id);
					}
					return ids;
				}, context);
				store.start(
					parentId,
					args.approaches.map((a, i) => ({ ...a, childId: children[i]! })),
					started,
				);
				let ts: string | undefined;
				let showing = Promise.resolve();
				const refresh = () => {
					showing = showing
						.then(async () => {
							ts = (await options.show(parentId, comparison(store.forThread(parentId), now(), options.costOf), ts)) ?? ts;
						})
						.catch((error: unknown) => console.error("showing the comparison failed:", error));
					return showing;
				};
				await refresh();
				const timer = setInterval(() => void refresh(), REFRESH_MS);
				timer.unref?.();
				try {
					await Promise.all(
						args.approaches.map(async (approach, i) => {
							const index = i + 1;
							const childId = children[i]!;
							try {
								if (bundle !== undefined) await workspaces.startFrom(childId, bundle);
								const child = await api.conversation(childId as ConversationId, context);
								if (child === undefined) throw new Error("the approach's conversation disappeared");
								const prompt = [
									`You're one of several teammates trying different approaches to the same request, side by side, so people can compare them. Yours: *${approach.name}*: ${approach.plan}`,
									`The request: ${args.request}`,
									"Implement only this approach, in your own workspace (it starts from the thread's branch). Run the relevant tests. Commit your work. Don't open a pull request: people will choose an approach first.",
									"Then report in a few short lines: what you changed, how it went, and this approach's trade-offs. End with exactly one line: `Tests: passed`, `Tests: failed`, or `Tests: not run`.",
								].join("\n\n");
								const settled = await (await child.submit({ type: "input", content: prompt, requestId: `approach:${api.taskId}:${index}` }, context)).wait(context);
								if (settled.status !== "done" || settled.type !== "input") throw new Error(`it ended ${settled.status}`);
								const entry = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
								const content = entry?.model?.[0]?.content ?? [];
								const report = (typeof content === "string" ? content : content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n")).trim();
								const tests = TESTS.exec(report)?.[1]?.toLowerCase();
								store.finished(parentId, index, {
									state: "done",
									...(tests === undefined ? {} : { tests }),
									diff: await workspaces.diffStat(childId, from).catch(() => "unknown"),
									cost: options.costOf(childId, started),
									report: report.replace(TESTS, "").trim(),
								}, now());
							} catch (error) {
								store.finished(parentId, index, { state: "failed", cost: options.costOf(childId, started), report: error instanceof Error ? error.message : String(error) }, now());
							}
							void refresh();
						}),
					);
				} finally {
					clearInterval(timer);
				}
				await refresh();
				await options.show(parentId, comparison(store.forThread(parentId), now(), options.costOf, true), ts);
				const results = store.forThread(parentId);
				const summary = results
					.map((a) => `${a.index}. ${a.name}: ${a.state}${a.tests === undefined ? "" : `, tests ${a.tests}`}${a.diff === undefined ? "" : `, ${a.diff}`}\n${a.report ?? ""}`)
					.join("\n\n");
				return {
					output: [
						{
							type: "text",
							text: `${summary}\n\nThe thread shows these side by side, with a button to choose each. Sum up the trade-offs in a few lines and wait for people to choose; don't pick one yourself.`,
						},
					],
				};
			} finally {
				if (bundle !== undefined) await rm(dirname(bundle), { recursive: true, force: true });
			}
		},
	});
	const extension = defineExtension({ name: "approaches", tools: [tool] });
	return extension;
}

/** The comparison message: a line per approach, then (when they're all done) their trade-offs and a button each. */
export function comparison(approaches: readonly Approach[], now: number, costOf: (conversationId: number, since: number) => number, final = false): ChatMessage {
	const chosen = approaches.find((a) => a.chosenBy !== undefined);
	const icon = (a: Approach) => (a.state === "working" ? "⚙️" : a.state === "failed" ? "⚠️" : a.tests === "passed" ? "✅" : a.tests === "failed" ? "❌" : "☑️");
	const seconds = (a: Approach) => Math.round(((a.finishedAt ?? now) - a.startedAt) / 1000);
	const line = (a: Approach) => {
		const cost = a.cost ?? costOf(a.childId, a.startedAt);
		const facts = [
			a.state === "working" ? `working, ${seconds(a)}s` : a.state === "failed" ? "didn't finish" : a.tests === undefined ? "done" : `tests ${a.tests}`,
			...(a.diff === undefined ? [] : [a.diff]),
			`$${cost.toFixed(2)}`,
		];
		return `${icon(a)} *${a.index}. ${a.name}*: ${facts.join(" · ")}`;
	};
	const header = `🧪 _Experimental:_ trying ${approaches.length} approaches side by side.`;
	const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: [header, ...approaches.map(line)].join("\n") } }];
	const done = final || approaches.every((a) => a.state !== "working");
	if (done) {
		for (const a of approaches) {
			if (a.report === undefined || a.report === "") continue;
			blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `*${a.index}. ${a.name}*: ${clip(a.report, 600)}` }] });
		}
		if (chosen !== undefined) {
			blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `✅ <@${chosen.chosenBy}> chose *${chosen.index}. ${chosen.name}*. Its commits are on the thread's branch.` }] });
		} else {
			const choices = approaches.filter((a) => a.state === "done");
			if (choices.length > 0) {
				blocks.push({
					type: "actions",
					elements: choices.map((a) => ({ type: "button", action_id: `${USE_APPROACH}_${a.index}`, text: { type: "plain_text", text: `Use ${a.index}. ${clip(a.name, 30)}` }, value: `${a.parentId}:${a.index}` })),
				});
			}
		}
	}
	return { text: header, blocks };
}

/**
 * Someone chose an approach: its commits come onto the thread's branch, and the approaches' sandboxes go. Returns what
 * was chosen; throws when nothing can be (already chosen, didn't finish, or its commits conflict with the thread's).
 */
export async function chooseApproach(options: Pick<ApproachesOptions, "store" | "workspaces">, parentId: number, index: number, by: string): Promise<Approach> {
	const all = options.store.forThread(parentId);
	const approach = all.find((a) => a.index === index);
	if (approach === undefined) throw new Error("That approach is gone.");
	if (all.some((a) => a.chosenBy !== undefined)) throw new Error("An approach has already been chosen here.");
	if (approach.state !== "done") throw new Error("That approach didn't finish, so there's nothing to use.");
	const bundle = await options.workspaces.exportBranch(approach.childId);
	if (bundle !== undefined) {
		try {
			await options.workspaces.adopt(parentId, bundle);
		} finally {
			await rm(dirname(bundle), { recursive: true, force: true });
		}
	}
	options.store.chosen(parentId, index, by);
	for (const a of all) await options.workspaces.remove(a.childId).catch(() => {});
	return { ...approach, chosenBy: by };
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
