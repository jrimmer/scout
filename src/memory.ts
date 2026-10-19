import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	type DocumentReader,
	defineExtension,
	defineTool,
	section,
} from "@earendil-works/pi-durable";
import { ReflectionDoc, ThreadDoc } from "./docs.ts";

/**
 * River's memory is "constantly learning and un-learning". The profile is the slow, reviewed half of that; this is the
 * fast half: notes Scout keeps while working, which the next thread in the channel sees at once.
 *
 * Each night the reflection reads the notes and folds the lasting ones into its profile proposal. They are retired
 * when that proposal merges, and kept if it is rejected, so nothing is lost to a "no".
 */
export type MemoryNote = { id: number; channelName: string; note: string; createdAt: number };

/** Notes that apply in every channel have no channel. */
const EVERYWHERE = "";
const SHOWN = 30;

export class Memory {
	readonly #db: DatabaseSync;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.#db = new DatabaseSync(path);
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS memories (
				id INTEGER PRIMARY KEY,
				channel_name TEXT NOT NULL,
				note TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				retired_at INTEGER,
				retire_with TEXT
			);
		`);
	}

	remember(channelName: string, note: string, now = Date.now()): number {
		const result = this.#db
			.prepare("INSERT INTO memories (channel_name, note, created_at) VALUES (?, ?, ?)")
			.run(channelName, note.trim(), now);
		return Number(result.lastInsertRowid);
	}

	forget(id: number, now = Date.now()): boolean {
		return this.#db.prepare("UPDATE memories SET retired_at = ? WHERE id = ? AND retired_at IS NULL").run(now, id).changes > 0;
	}

	/** What a thread in `channelName` sees: its channel's notes and everyone's, newest last. */
	forChannel(channelName: string): MemoryNote[] {
		return this.#db
			.prepare(
				`SELECT * FROM (SELECT * FROM memories WHERE retired_at IS NULL AND channel_name IN (?, ?)
				 ORDER BY id DESC LIMIT ?) ORDER BY id`,
			)
			.all(channelName, EVERYWHERE, SHOWN)
			.map(toNote);
	}

	active(): MemoryNote[] {
		return this.#db.prepare("SELECT * FROM memories WHERE retired_at IS NULL ORDER BY channel_name, id").all().map(toNote);
	}

	/** A reflection folded these into its proposal for `day`; they retire when that proposal merges. */
	consolidate(ids: readonly number[], day: string): number {
		const mark = this.#db.prepare("UPDATE memories SET retire_with = ? WHERE id = ? AND retired_at IS NULL");
		return ids.reduce((count, id) => count + Number(mark.run(day, id).changes), 0);
	}

	/** The proposal for `day` was decided: merged retires its notes, rejected keeps them. */
	proposalDecided(day: string, merged: boolean, now = Date.now()): void {
		if (merged) this.#db.prepare("UPDATE memories SET retired_at = ? WHERE retire_with = ? AND retired_at IS NULL").run(now, day);
		else this.#db.prepare("UPDATE memories SET retire_with = NULL WHERE retire_with = ?").run(day);
	}

	close(): void {
		this.#db.close();
	}
}

async function channelOf(read: DocumentReader, conversationId: ConversationId, context: Context): Promise<string> {
	return (await read.snapshot(ThreadDoc, conversationId, context))?.channelName ?? "";
}

/** `remember`, `forget`, and the notes section, for thread conversations. */
export function memoryExtension(memory: Memory) {
	const remember = defineTool({
		name: "remember",
		description:
			"Keep a short note for later threads: something you learned or were told that will matter again (a " +
			"command, a convention, a gotcha). Not for this thread's progress. Notes are visible to everyone.",
		parameters: Type.Object({
			note: Type.String({ description: "One or two sentences, specific enough to act on" }),
			everywhere: Type.Optional(Type.Boolean({ description: "True if it applies beyond this channel" })),
		}),
		execute: async (args, api, context) => {
			const channel = args.everywhere === true ? EVERYWHERE : await channelOf(api, api.conversationId, context);
			const id = memory.remember(channel, args.note);
			return { output: [{ type: "text", text: `Noted as [${id}].` }] };
		},
	});
	const forget = defineTool({
		name: "forget",
		description: "Retire a note that turned out to be wrong or no longer holds. Say why in the thread.",
		parameters: Type.Object({ id: Type.Number() }),
		execute: async (args) => {
			const forgotten = memory.forget(args.id);
			return { output: [{ type: "text", text: forgotten ? `Forgot [${args.id}].` : `No note [${args.id}].` }] };
		},
	});
	return defineExtension({
		name: "memory",
		tools: [remember, forget],
		sections: [
			section("memory", async (input, context) => {
				const notes = memory.forChannel(await channelOf(input.read, input.conversationId, context));
				if (notes.length === 0) return undefined;
				return [
					"Notes from earlier threads (yours, not yet reviewed; forget any that prove wrong):",
					...notes.map((n) => `[${n.id}]${n.channelName === EVERYWHERE ? " (everywhere)" : ""} ${n.note}`),
				].join("\n");
			}),
		],
	});
}

/** For reflection conversations: mark the notes this proposal makes permanent. */
export function consolidationExtension(memory: Memory) {
	const consolidate = defineTool({
		name: "consolidate_memories",
		description:
			"List the notes your profile changes now cover. They retire once people merge your pull request, and stay " +
			"if they don't.",
		parameters: Type.Object({ ids: Type.Array(Type.Number()) }),
		execute: async (args, api, context) => {
			const day = (await api.snapshot(ReflectionDoc, api.conversationId, context))?.day;
			if (day === undefined || day === "") throw new Error("Only a reflection can consolidate notes.");
			const marked = memory.consolidate(args.ids, day);
			return { output: [{ type: "text", text: `${marked} note${marked === 1 ? "" : "s"} will retire on merge.` }] };
		},
	});
	return defineExtension({ name: "consolidation", tools: [consolidate] });
}

export function describeNotes(notes: readonly MemoryNote[]): string {
	if (notes.length === 0) return "";
	return [
		"Notes Scout kept during threads, not yet in the profile. Fold the lasting ones into your changes, then call " +
			"consolidate_memories with their ids. Leave the rest.",
		...notes.map((n) => `[${n.id}] ${n.channelName === EVERYWHERE ? "(everywhere)" : `#${n.channelName}`}: ${n.note}`),
	].join("\n");
}

function toNote(row: Record<string, unknown>): MemoryNote {
	return {
		id: Number(row.id),
		channelName: String(row.channel_name),
		note: String(row.note),
		createdAt: Number(row.created_at),
	};
}
