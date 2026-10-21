import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * A Slack List of Scout's work: one row per thread, with what was asked, where, by whom, its state, its pull request
 * and CI, and what it cost, kept up to date as the work moves, for anyone who wants to sort and filter it (a manager,
 * a PM). Scout writes the rows; people read them, shared with Scout's home channel.
 */
export const STATES = ["Working", "Waiting on someone", "Answered", "Ran into a problem", "Pull request open", "Merged", "Closed"] as const;
export type WorkState = (typeof STATES)[number];
export const CI_STATES = ["Passing", "Failing", "Pending"] as const;
export type CiState = (typeof CI_STATES)[number];

export type WorkRow = {
	request?: string;
	channel?: string;
	askedBy?: string;
	state?: WorkState;
	pull?: { url: string; label: string };
	ci?: CiState;
	cost?: number;
	thread?: string;
};

/** The parts of Slack's Lists API this uses. */
export type ListsApi = {
	create(args: { name: string; schema: unknown[] }): Promise<{ list_id?: string; list_metadata?: { schema?: { id?: string; key?: string; options?: { choices?: { value?: string; label?: string }[] } }[] } }>;
	access: { set(args: { list_id: string; access_level: string; channel_ids?: string[] }): Promise<unknown> };
	items: {
		create(args: { list_id: string; initial_fields: unknown[] }): Promise<{ item?: { id?: string } }>;
		update(args: { list_id: string; cells: unknown[] }): Promise<unknown>;
	};
};

const COLORS: Record<string, string> = {
	Working: "blue",
	"Waiting on someone": "yellow",
	Answered: "green",
	"Ran into a problem": "red",
	"Pull request open": "blue",
	Merged: "green",
	Closed: "gray",
	Passing: "green",
	Failing: "red",
	Pending: "yellow",
};
const choices = (values: readonly string[]) => values.map((label, i) => ({ value: `opt${i}`, label, color: COLORS[label] ?? "gray" }));

const SCHEMA = [
	{ key: "request", name: "Request", type: "text", is_primary_column: true },
	{ key: "channel", name: "Channel", type: "channel" },
	{ key: "asked_by", name: "Asked by", type: "user" },
	{ key: "state", name: "State", type: "select", options: { choices: choices(STATES) } },
	{ key: "pull", name: "Pull request", type: "link" },
	{ key: "ci", name: "CI", type: "select", options: { choices: choices(CI_STATES) } },
	{ key: "cost", name: "Cost ($)", type: "number", options: { precision: 2 } },
	{ key: "thread", name: "Thread", type: "link" },
];

export class WorkList {
	readonly #db: DatabaseSync;
	readonly #api: () => ListsApi;
	readonly #shareWith: () => Promise<string | undefined>;
	#making: Promise<{ id: string; columns: Record<string, string>; options: Record<string, string> }> | undefined;

	constructor(options: { path: string; api: () => ListsApi; shareWith: () => Promise<string | undefined> }) {
		if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true });
		this.#db = new DatabaseSync(options.path, { timeout: 5000 });
		this.#api = options.api;
		this.#shareWith = options.shareWith;
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS work_list (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS work_list_rows (conversation_id INTEGER PRIMARY KEY, item_id TEXT NOT NULL);
		`);
	}

	/** Bring a thread's row up to date with what changed (made when it's first seen). */
	async update(conversationId: number, row: WorkRow): Promise<void> {
		const list = await this.#list();
		const fields = this.#fields(list, row);
		if (fields.length === 0) return;
		const existing = this.#db.prepare("SELECT item_id FROM work_list_rows WHERE conversation_id = ?").get(conversationId) as { item_id: string } | undefined;
		if (existing === undefined) {
			const made = await this.#api().items.create({ list_id: list.id, initial_fields: fields });
			if (made.item?.id !== undefined) this.#db.prepare("INSERT OR REPLACE INTO work_list_rows (conversation_id, item_id) VALUES (?, ?)").run(conversationId, made.item.id);
			return;
		}
		await this.#api().items.update({ list_id: list.id, cells: fields.map((f) => ({ ...f, row_id: existing.item_id })) });
	}

	/** The list's ID, for a link to it; undefined until it's made. */
	get id(): string | undefined {
		return this.#stored()?.id;
	}

	#stored(): { id: string; columns: Record<string, string>; options: Record<string, string> } | undefined {
		const row = this.#db.prepare("SELECT value FROM work_list WHERE key = 'list'").get() as { value: string } | undefined;
		return row === undefined ? undefined : (JSON.parse(row.value) as { id: string; columns: Record<string, string>; options: Record<string, string> });
	}

	/** The list, made the first time it's needed and shared with Scout's home channel for reading. */
	#list(): Promise<{ id: string; columns: Record<string, string>; options: Record<string, string> }> {
		const stored = this.#stored();
		if (stored !== undefined) return Promise.resolve(stored);
		this.#making ??= (async () => {
			const made = await this.#api().create({ name: "Scout's work", schema: SCHEMA });
			if (made.list_id === undefined) throw new Error("Slack made no list");
			const columns: Record<string, string> = {};
			const options: Record<string, string> = {};
			for (const column of made.list_metadata?.schema ?? []) {
				if (column.key === undefined || column.id === undefined) continue;
				columns[column.key] = column.id;
				for (const choice of column.options?.choices ?? []) if (choice.label !== undefined && choice.value !== undefined) options[`${column.key}:${choice.label}`] = choice.value;
			}
			// Slack may answer without the schema it made; then the keys are the IDs, and the values are as sent.
			for (const column of SCHEMA) {
				columns[column.key] ??= column.key;
				for (const choice of column.options?.choices ?? []) options[`${column.key}:${choice.label}`] ??= choice.value;
			}
			const list = { id: made.list_id, columns, options };
			this.#db.prepare("INSERT OR REPLACE INTO work_list (key, value) VALUES ('list', ?)").run(JSON.stringify(list));
			const channel = await this.#shareWith();
			if (channel !== undefined) await this.#api().access.set({ list_id: list.id, access_level: "read", channel_ids: [channel] }).catch((error: unknown) => console.error("sharing the list of Scout's work failed:", error));
			return list;
		})().finally(() => {
			this.#making = undefined;
		});
		return this.#making;
	}

	#fields(list: { columns: Record<string, string>; options: Record<string, string> }, row: WorkRow): Record<string, unknown>[] {
		const c = list.columns;
		const fields: Record<string, unknown>[] = [];
		const text = (value: string) => [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: value.slice(0, 500) }] }] }];
		const link = (url: string, label: string) => [{ original_url: url, display_as_url: false, display_name: label }];
		if (row.request !== undefined) fields.push({ column_id: c.request, rich_text: text(row.request) });
		if (row.channel !== undefined) fields.push({ column_id: c.channel, channel: [row.channel] });
		if (row.askedBy !== undefined) fields.push({ column_id: c.asked_by, user: [row.askedBy] });
		if (row.state !== undefined) fields.push({ column_id: c.state, select: [list.options[`state:${row.state}`]] });
		if (row.pull !== undefined) fields.push({ column_id: c.pull, link: link(row.pull.url, row.pull.label) });
		if (row.ci !== undefined) fields.push({ column_id: c.ci, select: [list.options[`ci:${row.ci}`]] });
		if (row.cost !== undefined) fields.push({ column_id: c.cost, number: [Math.round(row.cost * 100) / 100] });
		if (row.thread !== undefined) fields.push({ column_id: c.thread, link: link(row.thread, "Thread") });
		return fields;
	}

	close(): void {
		this.#db.close();
	}
}
