import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord";
import {
	AssistantEntry,
	type AgentChange,
	configure,
	defineExtension,
	type EnvTarget,
	type ToolExecutionApi,
	section,
} from "@earendil-works/pi-durable";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { ReviewDoc } from "./docs.ts";
import { ConfinedEnv } from "./sandbox.ts";

const run = promisify(execFile);

/**
 * A second look before people are asked for theirs. Tobi's worry about agents is "slop grenades": output handed to
 * colleagues who don't read it closely. Scout reviews its own change in a fresh conversation that sees only the diff
 * and the code, and fixes what that review finds before anyone else spends time on it.
 */
export type Review = { verdict: "approve" | "changes"; text: string };

export const DEFAULT_REVIEW_INSTRUCTIONS =
	"Review this change before people see it. Read the diff and enough of the surrounding code to judge it. Look for " +
	"bugs, missing or weak tests, changes unrelated to the stated goal, leftover debugging, and secrets. Ignore " +
	"matters of taste. Start your answer with a line that is exactly APPROVE or CHANGES, then list concrete problems, " +
	"each with the file and what to do.";

const DIFF_BUDGET = 60_000;

/** Reviewing someone else's pull request, when the profile has no `reviewer.md`. */
export const DEFAULT_PULL_REVIEW_INSTRUCTIONS =
	"Review this pull request for its author. Read the diff and enough of the surrounding code, and the repository's " +
	"AGENTS.md, to judge it. Say what matters most first: bugs, missing tests, risk. Start your answer with a line " +
	"that is exactly APPROVE, CHANGES or COMMENT. For a comment on one line, add a line `### path:line` (the line in " +
	"the new file) and the comment under it.";

/**
 * A reviewer: read-only file access to the workspace, and its instructions, Scout's own change (profile `review.md`)
 * or someone else's pull request (`reviewer.md`).
 */
export function reviewExtension(instructions: () => string | undefined, fallback = DEFAULT_REVIEW_INSTRUCTIONS, name = "review") {
	return defineExtension({
		name,
		tools: [createReadTool()],
		sections: [section("review", () => instructions() ?? fallback, { tag: false })],
	});
}

/**
 * The reviewer's environment: the thread's own sandbox (`sandboxEnv`), or a checkout on this host read through
 * `ConfinedEnv`. Either way its only tool reads.
 */
export async function reviewEnv(
	target: EnvTarget,
	context: Context,
	sandboxEnv: (conversationId: number) => Promise<ExecutionEnv>,
): Promise<ExecutionEnv | undefined> {
	const doc = await target.read.snapshot(ReviewDoc, target.conversationId, context);
	if (doc === undefined) return undefined;
	if (doc.sandbox !== undefined) return sandboxEnv(doc.sandbox);
	if (doc.root === "") return undefined;
	return new ConfinedEnv({ id: `review:${target.conversationId}`, cwd: doc.cwd, root: doc.root, tmp: doc.root, protectGit: true });
}

export function parseReview(text: string): Review {
	const first = text.trim().split("\n")[0]?.trim().toUpperCase() ?? "";
	return { verdict: first.startsWith("CHANGES") ? "changes" : "approve", text: text.trim() };
}

/** A review of someone else's pull request, ready for the code host: a verdict, a body, and comments on lines. */
export type PullReview = {
	verdict: "approve" | "changes" | "comment";
	body: string;
	comments: { path: string; line: number; body: string }[];
};

/**
 * The reviewer's answer as a review: its first line is the verdict, `### path:line` headings start comments on lines.
 * A code host takes comments only on lines the diff shows, so a comment on any other line goes in the body instead.
 */
export function parsePullReview(text: string, diff: string): PullReview {
	const [first = "", ...others] = text.trim().split("\n");
	const word = first.trim().toUpperCase();
	const verdict = word.startsWith("CHANGES") ? "changes" : word.startsWith("APPROVE") ? "approve" : "comment";
	// The verdict line isn't part of the review; a first line that isn't one is.
	const rest = /^(CHANGES|APPROVE|COMMENT)/.test(word) ? others : [first, ...others];
	const body: string[] = [];
	const notes: { path: string; line: number; text: string[] }[] = [];
	for (const line of rest) {
		const heading = /^###\s+`?([^`\s:]+)`?:(\d+)\s*$/.exec(line);
		if (heading !== null) notes.push({ path: heading[1]!, line: Number(heading[2]), text: [] });
		else (notes.at(-1)?.text ?? body).push(line);
	}
	const shown = changedLines(diff);
	const comments: PullReview["comments"] = [];
	const elsewhere: string[] = [];
	for (const note of notes) {
		const text = note.text.join("\n").trim();
		if (text === "") continue;
		if (shown.get(note.path)?.has(note.line) === true) comments.push({ path: note.path, line: note.line, body: text });
		else elsewhere.push(`**${note.path}:${note.line}**: ${text}`);
	}
	return { verdict, body: [body.join("\n").trim(), ...elsewhere].filter(Boolean).join("\n\n"), comments };
}

/** The lines of each file's new version that a unified diff shows (added or context), which a review may comment on. */
export function changedLines(diff: string): Map<string, Set<number>> {
	const shown = new Map<string, Set<number>>();
	let lines: Set<number> | undefined;
	let next = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++ ")) {
			const path = line.slice(4).replace(/^b\//, "");
			lines = path === "/dev/null" ? undefined : (shown.get(path) ?? new Set());
			if (lines !== undefined) shown.set(path, lines);
			continue;
		}
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (hunk !== null) {
			next = Number(hunk[1]);
			continue;
		}
		if (lines === undefined || line.startsWith("--- ") || line.startsWith("-") || line.startsWith("\\")) continue;
		if (line.startsWith("+") || line.startsWith(" ")) lines.add(next++);
	}
	return shown;
}

/**
 * Run a review in a conversation the calling tool owns, so stopping the tool stops the review. `agent` picks the
 * reviewer's model and extensions.
 */
export async function reviewAsSubtask(
	api: ToolExecutionApi,
	options: { agent: AgentChange; workspace: { sandbox: number } | { root: string; cwd: string }; prompt: string; requestId: string },
	context: Context,
): Promise<Review> {
	const childId = await api.commit(async (tx) => {
		const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
		if (existing !== undefined) return existing.id;
		const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
		await configure(tx, created.id, { ...options.agent, tools: null, modelTools: null });
		const doc = await tx.doc(ReviewDoc, created.id);
		if ("sandbox" in options.workspace) doc.sandbox = options.workspace.sandbox;
		else {
			doc.root = options.workspace.root;
			doc.cwd = options.workspace.cwd;
		}
		return created.id;
	}, context);
	const child = await api.conversation(childId, context);
	if (child === undefined) throw new Error("the review conversation disappeared");
	const submission = await child.submit({ type: "input", content: options.prompt, requestId: options.requestId }, context);
	const settled = await submission.wait(context);
	if (settled.status !== "done" || settled.type !== "input") throw new Error("the self-review did not finish");
	const answer = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	const content = answer?.model?.[0]?.content ?? [];
	const text =
		typeof content === "string"
			? content
			: content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	return parseReview(text);
}

/** What `to` changes against `from` (refs or commits), from the host-owned mirror. */
export async function diffOf(mirrorPath: string, from: string, to: string): Promise<{ stat: string; diff: string; lines: number }> {
	const range = `${from}...${to}`;
	const git = async (...args: string[]) =>
		(await run("git", ["-C", mirrorPath, ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout;
	const numstat = await git("diff", "--numstat", range);
	const lines = numstat
		.split("\n")
		.filter(Boolean)
		.reduce((sum, line) => {
			const [added, removed] = line.split("\t");
			return sum + (Number(added) || 0) + (Number(removed) || 0);
		}, 0);
	const stat = (await git("diff", "--stat", range)).trim();
	const full = await git("diff", range);
	const diff = full.length <= DIFF_BUDGET ? full : `${full.slice(0, DIFF_BUDGET)}\n(… diff cut at ${DIFF_BUDGET} characters)`;
	return { stat, diff, lines };
}
