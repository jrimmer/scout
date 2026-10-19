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

/** The reviewer: read-only file access to the workspace, and its instructions (profile `review.md`). */
export function reviewExtension(instructions: () => string | undefined) {
	return defineExtension({
		name: "review",
		tools: [createReadTool()],
		sections: [section("review", () => instructions() ?? DEFAULT_REVIEW_INSTRUCTIONS, { tag: false })],
	});
}

/** The reviewer's environment: the workspace, read through `ConfinedEnv` (and its only tool reads). */
export async function reviewEnv(target: EnvTarget, context: Context): Promise<ConfinedEnv | undefined> {
	const doc = await target.read.snapshot(ReviewDoc, target.conversationId, context);
	if (doc === undefined || doc.root === "") return undefined;
	return new ConfinedEnv({ id: `review:${target.conversationId}`, cwd: doc.cwd, root: doc.root, tmp: doc.root, protectGit: true });
}

export function parseReview(text: string): Review {
	const first = text.trim().split("\n")[0]?.trim().toUpperCase() ?? "";
	return { verdict: first.startsWith("CHANGES") ? "changes" : "approve", text: text.trim() };
}

/**
 * Run a review in a conversation the calling tool owns, so stopping the tool stops the review. `agent` picks the
 * reviewer's model and extensions.
 */
export async function reviewAsSubtask(
	api: ToolExecutionApi,
	options: { agent: AgentChange; root: string; cwd: string; prompt: string; requestId: string },
	context: Context,
): Promise<Review> {
	const childId = await api.commit(async (tx) => {
		const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
		if (existing !== undefined) return existing.id;
		const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
		await configure(tx, created.id, { ...options.agent, tools: null, modelTools: null });
		const doc = await tx.doc(ReviewDoc, created.id);
		doc.root = options.root;
		doc.cwd = options.cwd;
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

/** What a branch changes against its base, from the host-owned mirror. */
export async function diffOf(mirrorPath: string, base: string, branch: string): Promise<{ stat: string; diff: string; lines: number }> {
	const range = `refs/heads/${base}...refs/heads/${branch}`;
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
