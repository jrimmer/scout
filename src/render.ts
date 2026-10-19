import type { AgentEvent } from "@earendil-works/pi-durable";

/** Where Scout's replies go. The Slack client in production, a fake in tests. */
export interface ChatSurface {
	post(channel: string, threadTs: string | undefined, message: ChatMessage): Promise<string>;
	update(channel: string, ts: string, message: ChatMessage): Promise<void>;
}

export type ChatMessage = { text: string; blocks: unknown[] };

/** Slack's markdown block takes standard Markdown, up to 12,000 characters. */
const MARKDOWN_LIMIT = 11_500;
const PROGRESS_INTERVAL_MS = 1_500;
const VISIBLE_STEPS = 6;

type Run = {
	startedAt: number;
	steps: string[];
	note?: string;
	text?: string;
	error?: string;
	ts?: string;
	stoppedBy?: string;
};

/**
 * Renders one thread's runs into Slack: one message per run, posted when the run starts, edited as it works, and
 * replaced by the answer when it ends. One message per run, from one place, is what keeps replies from doubling up.
 */
export class ThreadView {
	readonly #surface: ChatSurface;
	readonly #channel: string;
	readonly #threadTs: string;
	readonly #onRunEnd: (answer: string | undefined) => void;
	readonly #now: () => number;
	#run: Run | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#queue: Promise<void> = Promise.resolve();

	constructor(options: {
		surface: ChatSurface;
		channel: string;
		threadTs: string;
		/** After the run's final message is in Slack, with Scout's answer when it gave one. */
		onRunEnd?: (answer: string | undefined) => void;
		now?: () => number;
	}) {
		this.#surface = options.surface;
		this.#channel = options.channel;
		this.#threadTs = options.threadTs;
		this.#onRunEnd = options.onRunEnd ?? (() => {});
		this.#now = options.now ?? Date.now;
	}

	get busy(): boolean {
		return this.#run !== undefined;
	}

	/** The Slack message showing the current run, once posted. */
	get runTs(): string | undefined {
		return this.#run?.ts;
	}

	/** Someone stopped the current run; its message says so when it ends. */
	markStopped(by: string): void {
		if (this.#run !== undefined) this.#run.stoppedBy = by;
	}

	/** Resolves once every Slack call queued so far has finished. */
	settled(): Promise<void> {
		return this.#queue;
	}

	handle(events: readonly AgentEvent[]): void {
		for (const event of events) this.#handle(event);
	}

	#handle(event: AgentEvent): void {
		switch (event.type) {
			case "snapshot":
				// Attached mid-run, for example after a restart: pick the run up without its earlier steps.
				if (event.run !== undefined && this.#run === undefined) this.#start();
				return;
			case "run_start":
				this.#start();
				return;
			case "tool_execution_start":
				if (this.#run === undefined || event.parentToolCallId !== undefined) return;
				this.#run.steps.push(describeStep(event.toolName, event.args));
				this.#schedule();
				return;
			case "message_end": {
				if (this.#run === undefined) return;
				const text = assistantText(event.entry.model);
				if (text === undefined) return;
				this.#run.text = text;
				this.#run.note = text;
				this.#schedule();
				return;
			}
			case "task_failed":
				if (this.#run !== undefined) this.#run.error = event.message;
				return;
			case "run_end":
				this.#finish();
				return;
		}
	}

	#start(): void {
		const run: Run = { startedAt: this.#now(), steps: [] };
		this.#run = run;
		this.#enqueue(async () => {
			run.ts = await this.#surface.post(this.#channel, this.#threadTs, progressMessage(run, this.#now()));
		});
	}

	#schedule(): void {
		if (this.#timer !== undefined) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			const run = this.#run;
			if (run === undefined) return;
			this.#enqueue(async () => {
				if (run.ts !== undefined) await this.#surface.update(this.#channel, run.ts, progressMessage(run, this.#now()));
			});
		}, PROGRESS_INTERVAL_MS);
		this.#timer.unref?.();
	}

	#finish(): void {
		const run = this.#run;
		if (run === undefined) return;
		this.#run = undefined;
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#enqueue(async () => {
			const message = finalMessage(run, this.#now());
			if (run.ts === undefined) await this.#surface.post(this.#channel, this.#threadTs, message);
			else await this.#surface.update(this.#channel, run.ts, message);
			this.#onRunEnd(run.stoppedBy === undefined ? run.text : undefined);
		});
	}

	#enqueue(work: () => Promise<void>): void {
		this.#queue = this.#queue.then(work).catch((error: unknown) => {
			console.error(`slack render failed in ${this.#channel}/${this.#threadTs}:`, error);
		});
	}
}

export function progressMessage(run: Pick<Run, "startedAt" | "steps" | "note">, now: number): ChatMessage {
	const lines = [`_Working… ${duration(now - run.startedAt)}_`];
	if (run.note !== undefined) lines.push("", quote(clip(run.note, 600)));
	const hidden = run.steps.length - VISIBLE_STEPS;
	if (run.steps.length > 0) lines.push("");
	if (hidden > 0) lines.push(`_…${hidden} earlier step${hidden === 1 ? "" : "s"}_`);
	for (const step of run.steps.slice(-VISIBLE_STEPS)) lines.push(`• ${step}`);
	const text = lines.join("\n");
	return { text: "Working…", blocks: [{ type: "markdown", text }] };
}

export function finalMessage(
	run: Pick<Run, "startedAt" | "steps" | "text" | "error" | "stoppedBy">,
	now: number,
): ChatMessage {
	const answer =
		run.stoppedBy !== undefined
			? `Stopped by ${run.stoppedBy}.${run.text === undefined ? "" : ` Where I'd got to:\n\n${run.text}`}`
			: (run.text ??
				(run.error === undefined ? "Done." : `I ran into a problem and stopped: ${clip(run.error, 500)}`));
	const steps = run.steps.length;
	const footer = `${steps} step${steps === 1 ? "" : "s"} · ${duration(now - run.startedAt)}`;
	return {
		text: clip(answer, 3_000),
		blocks: [
			{ type: "markdown", text: clip(answer, MARKDOWN_LIMIT) },
			{ type: "context", elements: [{ type: "mrkdwn", text: footer }] },
		],
	};
}

export function describeStep(toolName: string, args: Record<string, unknown>): string {
	const arg = (name: string) => (typeof args[name] === "string" ? (args[name] as string) : undefined);
	const detail = toolName === "bash" ? arg("command")?.split("\n")[0] : (arg("path") ?? arg("name") ?? arg("title") ?? arg("query") ?? arg("note"));
	const label = detail === undefined ? toolName : `${toolName} ${detail}`;
	return `\`${clip(label, 100).replaceAll("`", "'")}\``;
}

function assistantText(messages: readonly unknown[] | undefined): string | undefined {
	const parts: string[] = [];
	for (const message of messages ?? []) {
		const m = message as { role?: string; content?: unknown };
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const block of m.content as { type?: string; text?: string }[]) {
			if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		}
	}
	const text = parts.join("\n\n").trim();
	return text === "" ? undefined : text;
}

function duration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function quote(text: string): string {
	return text
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
}
