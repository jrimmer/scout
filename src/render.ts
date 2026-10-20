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
	/** Notes Scout kept during the run, shown with its answer so people can object. */
	notes?: string[];
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
	readonly #onRunMessage: (ts: string | undefined) => void;
	#resumeTs: string | undefined;
	#run: Run | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#queue: Promise<void> = Promise.resolve();

	constructor(options: {
		surface: ChatSurface;
		channel: string;
		threadTs: string;
		/** After the run's final message is in Slack, with Scout's answer when it gave one. */
		onRunEnd?: (answer: string | undefined) => void;
		/** The Slack message of a run in progress before a restart, to keep editing instead of posting another. */
		resumeTs?: string;
		/** A run's message was posted (its ts), or the run ended (undefined): remember it across restarts. */
		onRunMessage?: (ts: string | undefined) => void;
		now?: () => number;
	}) {
		this.#resumeTs = options.resumeTs;
		this.#onRunMessage = options.onRunMessage ?? (() => {});
		this.#surface = options.surface;
		this.#channel = options.channel;
		this.#threadTs = options.threadTs;
		this.#onRunEnd = options.onRunEnd ?? (() => {});
		this.#now = options.now ?? Date.now;
	}

	get busy(): boolean {
		return this.#run !== undefined;
	}

	/** The current run, for the dashboard: when it started, how many steps, and the latest. */
	get runInfo(): { startedAt: number; steps: number; lastStep?: string } | undefined {
		const run = this.#run;
		if (run === undefined) return undefined;
		const last = run.steps.at(-1);
		return { startedAt: run.startedAt, steps: run.steps.length, ...(last === undefined ? {} : { lastStep: last.replaceAll("`", "") }) };
	}

	/** The Slack message showing the current run, once posted. */
	get runTs(): string | undefined {
		return this.#run?.ts;
	}

	/** Someone stopped the current run; its message says so when it ends. */
	markStopped(by: string): void {
		if (this.#run !== undefined) this.#run.stoppedBy = by;
	}

	/** Someone's reply steered the current run: say so among its steps, so they know it was heard. */
	tookIn(name: string): void {
		if (this.#run === undefined) return;
		this.#run.steps.push(`_Took in ${name}'s reply_`);
		this.#schedule();
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
				if (event.toolName === "remember" && typeof event.args.note === "string") {
					(this.#run.notes ??= []).push(event.args.note);
				}
				this.#schedule();
				return;
			case "message_end": {
				if (this.#run === undefined) return;
				// A model call that failed ends the run without an answer; without this the reply would read "Done."
				const failure = assistantError(event.entry.model);
				if (failure !== undefined) this.#run.error = `the model didn't answer (${failure})`;
				const text = assistantText(event.entry.model);
				if (text === undefined) return;
				delete this.#run.error;
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
		const resumed = this.#resumeTs;
		this.#resumeTs = undefined;
		this.#enqueue(async () => {
			if (resumed !== undefined) {
				run.ts = resumed;
				await this.#surface.update(this.#channel, resumed, progressMessage(run, this.#now()));
				return;
			}
			run.ts = await this.#surface.post(this.#channel, this.#threadTs, progressMessage(run, this.#now()));
			this.#onRunMessage(run.ts);
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
			this.#onRunMessage(undefined);
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
	run: Pick<Run, "startedAt" | "steps" | "text" | "error" | "stoppedBy" | "notes">,
	now: number,
): ChatMessage {
	const answer =
		run.stoppedBy !== undefined
			? `Stopped by ${run.stoppedBy}.${stoppedAt(run)}`
			: run.text === undefined
				? run.error === undefined
					? "Done."
					: `I ran into a problem and stopped: ${clip(run.error, 500)}`
				: run.error === undefined
					? run.text
					: `${run.text}\n\n_Then I ran into a problem and stopped: ${clip(run.error, 500)}_`;
	const steps = run.steps.length;
	const footer = `${steps} step${steps === 1 ? "" : "s"} · ${duration(now - run.startedAt)}`;
	return {
		text: clip(answer, 3_000),
		blocks: [
			{ type: "markdown", text: clip(answer, MARKDOWN_LIMIT) },
			...(run.notes === undefined
				? []
				: [
						{
							type: "context",
							elements: [
								{
									type: "mrkdwn",
									text: `Noted for this channel: ${run.notes.map((n) => `“${clip(n, 200)}”`).join(" · ")}. Disagree? Tell me to forget it.`,
								},
							],
						},
					]),
			{ type: "context", elements: [{ type: "mrkdwn", text: footer }] },
		],
	};
}

/** Where a stopped run had got to: its last words, or else its last steps, so the work done so far isn't lost. */
function stoppedAt(run: Pick<Run, "steps" | "text">): string {
	if (run.text !== undefined) return ` Where I'd got to:\n\n${run.text}`;
	if (run.steps.length === 0) return "";
	return ` My last steps:\n${run.steps.slice(-VISIBLE_STEPS).map((step) => `• ${step}`).join("\n")}`;
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

/** Why a model call failed (the gateway's own message when it sent JSON), or undefined if none did. */
function assistantError(messages: readonly unknown[] | undefined): string | undefined {
	for (const message of messages ?? []) {
		const m = message as { role?: string; stopReason?: string; errorMessage?: string };
		if (m.role !== "assistant" || m.stopReason !== "error") continue;
		const error = m.errorMessage ?? "no reason given";
		return error.match(/"message"\s*:\s*"([^"]+)"/)?.[1] ?? clip(error, 300);
	}
	return undefined;
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
