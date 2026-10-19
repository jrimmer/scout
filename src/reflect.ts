import { mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
	type AgentChange,
	type ConversationId,
	defineExtension,
	type EntryRecord,
	type EnvTarget,
	type Harness,
	section,
} from "@earendil-works/pi-durable";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import type { PullTarget } from "./codehost.ts";
import { ReflectionDoc, ThreadDoc } from "./docs.ts";
import { describeNotes, type Memory } from "./memory.ts";
import type { Pulls } from "./pulls.ts";
import { ConfinedEnv, Mirror } from "./sandbox.ts";
import type { ThreadRow, Threads } from "./threads.ts";

/**
 * The nightly learning loop. Shopify's merge rate went from 36% to 77% in two months without a model change: people
 * watched where River got stuck and wrote down what it should have known. This does the first draft of that writing.
 *
 * Once a day, a reflection conversation reads every thread with new activity, edits a clone of the profile repo with
 * file tools only (no shell; `.git` off limits), and opens a pull request. People review and merge it; Scout keeps
 * its profile pulled, so merged changes reach every thread.
 */

export const DEFAULT_REFLECT_INSTRUCTIONS =
	"Read the threads below and improve Scout's profile so the next thread goes better. Edit the files, then call " +
	"open_pull_request. If nothing is worth changing, say so and change nothing.";

const THREAD_BUDGET = 12_000;
const DIGEST_BUDGET = 150_000;

export type ReflectorOptions = {
	harness: Harness;
	threads: Threads;
	pulls: Pulls;
	/** Notes kept during threads, for the reflection to fold into the profile. */
	memory?: Memory;
	context: Context;
	dataDir: string;
	profileRepo: { gitUrl: string; base: string; slug: string };
	git: { name: string; email: string };
	/** Model and extensions for the reflection conversation: `reflectionExtensions()` plus a profile code host. */
	agent: AgentChange;
	threadLink: (thread: ThreadRow) => Promise<string | undefined>;
};

export class Reflector {
	readonly #options: ReflectorOptions;
	readonly #dataDir: string;
	readonly mirror: Mirror;

	constructor(options: ReflectorOptions) {
		this.#options = options;
		mkdirSync(options.dataDir, { recursive: true });
		this.#dataDir = realpathSync(options.dataDir);
		this.mirror = new Mirror(join(this.#dataDir, "profile-mirror.git"), options.profileRepo.gitUrl);
	}

	/**
	 * Reflect on everything since the last reflection, once per `day`. Returns what it started, or nothing when the
	 * day's reflection already ran or no thread has new activity.
	 */
	async run(day: string): Promise<{ conversationId: number; threads: number } | undefined> {
		const { harness, threads, context, profileRepo, git, agent } = this.#options;
		if (threads.reflection(day) !== undefined) return undefined;
		const pending = threads.unreflected();
		if (pending.length === 0) return undefined;

		const digest = await this.digest(pending);
		const root = join(this.#dataDir, "reflections", day);
		mkdirSync(join(root, "tmp"), { recursive: true });
		await this.mirror.clone(join(root, "profile"), branchForDay(day), profileRepo.base, git);

		const conversation = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent,
				init: async (tx, id) => {
					const doc = await tx.doc(ReflectionDoc, id);
					doc.day = day;
					doc.root = root;
				},
			},
			context,
		);
		await conversation.submit({ type: "input", content: digest, requestId: `reflect:${day}` }, context);
		threads.reflected(day, conversation.id, pending);
		return { conversationId: conversation.id, threads: pending.length };
	}

	/** The environment for a reflection conversation's file tools, or undefined for any other conversation. */
	async env(target: EnvTarget, context: Context): Promise<ConfinedEnv | undefined> {
		const doc = await target.read.snapshot(ReflectionDoc, target.conversationId, context);
		if (doc === undefined || doc.root === "") return undefined;
		return new ConfinedEnv({
			id: `reflection:${doc.day}`,
			cwd: join(doc.root, "profile"),
			root: doc.root,
			tmp: join(doc.root, "tmp"),
			protectGit: true,
		});
	}

	/** Where a reflection's pull request goes: the profile repo. */
	async target(conversationId: number, context: Context): Promise<PullTarget> {
		const doc = await this.#options.harness.snapshot(ReflectionDoc, conversationId as ConversationId, context);
		if (doc === undefined || doc.root === "") throw new Error("Only a reflection can propose profile changes.");
		return {
			dir: join(doc.root, "profile"),
			branch: branchForDay(doc.day),
			base: this.#options.profileRepo.base,
			slug: this.#options.profileRepo.slug,
			mirror: this.mirror,
		};
	}

	async digest(pending: readonly ThreadRow[]): Promise<string> {
		const { harness, context } = this.#options;
		const parts: string[] = [];
		let used = 0;
		let omitted = 0;
		for (const thread of [...pending].sort((a, b) => b.lastActivity - a.lastActivity)) {
			const id = thread.conversationId as ConversationId;
			const conversation = await harness.conversation(id, context);
			if (conversation === undefined) continue;
			const entries: EntryRecord[] = [];
			let cursor: Parameters<typeof conversation.entries>[2];
			do {
				const page = await conversation.entries({ order: "ascending" }, 500, cursor, context);
				entries.push(...page.items);
				cursor = page.next;
			} while (cursor !== undefined);
			const channel = (await harness.snapshot(ThreadDoc, id, context))?.channelName || thread.channel;
			const link = await this.#options.threadLink(thread);
			const pulls = this.#options.pulls.forConversation(thread.conversationId);
			const header = [
				`## #${channel}${link === undefined ? "" : ` (${link})`}`,
				`${thread.runs} run${thread.runs === 1 ? "" : "s"}; ` +
					(pulls.length === 0 ? "no pull request" : `pull requests: ${pulls.map((p) => `${p.url} (${p.state})`).join(", ")}`),
			].join("\n");
			const part = `${header}\n\n${clipMiddle(renderTranscript(entries), THREAD_BUDGET)}`;
			if (used + part.length > DIGEST_BUDGET) {
				omitted++;
				continue;
			}
			parts.push(part);
			used += part.length;
		}
		const proposals = this.#options.pulls.recent("profile", 10);
		const outcomes =
			proposals.length === 0
				? ""
				: [
						"Your recent proposals to this profile, and what people did with them:",
						...proposals.map((p) => `- ${p.title}: ${p.state} (${p.url})`),
						"",
						"",
					].join("\n");
		const notes = describeNotes(this.#options.memory?.active() ?? []);
		const intro =
			`${outcomes}${notes === "" ? "" : `${notes}\n\n`}` +
			`Threads with new activity since the last reflection: ${pending.length}.`;
		const tail = omitted > 0 ? `\n\n(${omitted} more thread${omitted === 1 ? "" : "s"} left out for length.)` : "";
		return `${intro}\n\n${parts.join("\n\n")}${tail}`;
	}
}

/** Tools and prompt for reflection conversations. `instructions` is read at each request, so profile edits apply. */
export function reflectionExtensions(instructions: () => string | undefined) {
	const files = defineExtension({ name: "profile-files", tools: [createReadTool(), createWriteTool(), createEditTool()] });
	const reflect = defineExtension({
		name: "reflect",
		sections: [
			section("reflect", () => instructions() ?? DEFAULT_REFLECT_INSTRUCTIONS, { tag: false }),
			section("profile-files", (input) => {
				const cwd = input.env?.cwd;
				if (cwd === undefined) return undefined;
				return [`The profile repository is checked out at ${cwd}. Its files:`, ...listFiles(cwd).map((f) => `- ${f}`)].join(
					"\n",
				);
			}),
		],
	});
	return { files, reflect };
}

/** A thread as a reviewer would skim it: who said what, what Scout did, and what failed. */
export function renderTranscript(entries: readonly EntryRecord[]): string {
	const lines: string[] = [];
	for (const entry of entries) {
		const message = entry.model?.[0] as
			| { role: string; content: unknown; toolName?: string; isError?: boolean }
			| undefined;
		if (entry.kind === "slack.message") {
			const data = entry.data as { name?: string; text?: string } | undefined;
			lines.push(`${data?.name ?? "someone"}: ${data?.text ?? ""}`);
		} else if (entry.kind === "pi.user" && message !== undefined) {
			lines.push(`(input) ${textOf(message.content)}`);
		} else if (entry.kind === "pi.assistant" && message !== undefined && Array.isArray(message.content)) {
			const text = textOf(message.content);
			if (text !== "") lines.push(`Scout: ${text}`);
			for (const block of message.content as { type: string; name?: string; arguments?: Record<string, unknown> }[]) {
				if (block.type === "toolCall") lines.push(`  → ${block.name} ${summarizeArgs(block.arguments ?? {})}`);
			}
		} else if (entry.kind === "pi.tool-result" && message?.isError === true) {
			lines.push(`  ✗ ${message.toolName}: ${clip(textOf(message.content), 400)}`);
		} else if (entry.kind === "pi.compaction") {
			lines.push("(earlier context was summarized)");
		}
	}
	return lines.join("\n");
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function summarizeArgs(args: Record<string, unknown>): string {
	const value = args.command ?? args.path ?? args.name ?? args.title;
	return typeof value === "string" ? clip(value.split("\n")[0] ?? "", 160) : "";
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Keep the start (the ask) and the end (how it went); drop the middle. */
function clipMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = Math.floor(max * 0.25);
	return `${text.slice(0, head)}\n(…)\n${text.slice(text.length - (max - head))}`;
}

function listFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (path: string) => {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			if (entry.name === ".git") continue;
			const full = join(path, entry.name);
			if (entry.isDirectory()) walk(full);
			else out.push(relative(dir, full));
		}
	};
	walk(dir);
	return out.sort();
}

export function branchForDay(day: string): string {
	return `scout/reflect-${day}`;
}

/** Local calendar day, `YYYY-MM-DD`. */
export function localDay(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
