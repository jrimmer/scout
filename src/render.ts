import type { AgentEvent } from "@earendil-works/pi-durable";

/** Where Scout's replies go. The Slack client in production, a fake in tests. */
export interface ChatSurface {
	post(channel: string, threadTs: string | undefined, message: ChatMessage): Promise<string>;
	update(channel: string, ts: string, message: ChatMessage): Promise<void>;
	/** React to a message (👀 on a request Scout picked up), or take its reaction back. Optional: needs reactions:write. */
	react?(channel: string, ts: string, name: string, on: boolean): Promise<void>;
	/** Share a text file in the thread (a long answer in full). Absent or failing, the text goes in messages instead. */
	attach?(channel: string, threadTs: string, file: { name: string; content: string; title: string }): Promise<void>;
}

export type ChatMessage = { text: string; blocks: unknown[] };

/** How a run ended: with an answer, stopped by someone, or after running into a problem. */
export type RunOutcome = "answered" | "stopped" | "problem";

/** Slack's markdown block takes standard Markdown, up to 12,000 characters. */
const MARKDOWN_LIMIT = 11_500;
const PROGRESS_INTERVAL_MS = 1_500;
const VISIBLE_STEPS = 6;
/** Longer than this, an answer's message shows its opening and the whole answer is attached as a file. */
const LONG_ANSWER = 6_000;
/**
 * A run that hasn't moved on for this long gets a word about it in its progress message; for `GIVE_UP_MS` with no
 * command running, it stops. A long command (a full build, a test suite) isn't stuck: its tool has its own timeout.
 */
export const QUIET_MS = 10 * 60 * 1000;
export const GIVE_UP_MS = 45 * 60 * 1000;

/**
 * What Scout says while it waits, in its own voice: a colleague taking longer, not a system reporting a fault. One
 * phrasing per run (chosen by when it started), so the line doesn't flicker between them.
 */
export const SAYINGS = {
	slow: [
		"Taking a little longer to think this one through…",
		"Still mulling this over. Bear with me.",
		"This one needs a bit more thought than usual…",
		"Hang on, I'm still working out the best way to do this…",
	],
	behind: [
		"Heads up: I'm a bit slow today, so this may take me longer than usual.",
		"I'm running a little behind right now. Thanks for your patience.",
		"Fair warning: things are moving slowly on my side today.",
	],
	thinking: ["Still thinking… this one's taking a while.", "Still working it out. It's a knotty one.", "Still on it, just slower than I'd like."],
	longStep: ["Still on %s, %m minutes in. It's a long one!", "%s is taking its time (%m minutes). I'm still with it.", "Waiting on %s, %m minutes so far."],
} as const;

function say(lines: readonly string[], seed: number): string {
	return lines[Math.abs(Math.floor(seed / 1000)) % lines.length]!;
}

type Run = {
	startedAt: number;
	steps: string[];
	/** When it last moved on (a step, an answer), for the watchdog. */
	movedAt?: number;
	/** Its own tool calls still running: a long build is work, not being stuck. */
	running?: number;
	/** What it's waiting on, said in Scout's voice, under "Working…". */
	status?: string;
	/** Why it gave up on its own, for its final message. */
	gaveUp?: string;
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
	readonly #onRunEnd: (answer: string | undefined, ts: string | undefined, outcome: RunOutcome) => void;
	readonly #now: () => number;
	readonly #onRunMessage: (ts: string | undefined) => void;
	readonly #cost: ((startedAt: number) => string | undefined) | undefined;
	readonly #mood: (() => boolean) | undefined;
	readonly #onSlow: () => void;
	#resumeTs: string | undefined;
	#run: Run | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#queue: Promise<void> = Promise.resolve();

	constructor(options: {
		surface: ChatSurface;
		channel: string;
		threadTs: string;
		/** After the run's final message is in Slack, with Scout's answer when it gave one. */
		/** The run's answer (none when it was stopped), the message it's in, and how it ended. */
		onRunEnd?: (answer: string | undefined, ts: string | undefined, outcome: RunOutcome) => void;
		/** The Slack message of a run in progress before a restart, to keep editing instead of posting another. */
		resumeTs?: string;
		/** A run's message was posted (its ts), or the run ended (undefined): remember it across restarts. */
		onRunMessage?: (ts: string | undefined) => void;
		/** What the run that started at `startedAt` cost, for its footer ("$0.03 · $12.40 of $100 this week"). */
		cost?: (startedAt: number) => string | undefined;
		/** Whether Scout has been slow lately (other runs waited on the model), to warn people as a run starts. */
		behind?: () => boolean;
		/** A model call had to wait and try again: Scout is slow right now. */
		onSlow?: () => void;
		now?: () => number;
	}) {
		this.#cost = options.cost;
		this.#mood = options.behind;
		this.#onSlow = options.onSlow ?? (() => {});
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
				// A run that finished while Scout was down, its message still saying "Working…": give it its answer.
				else if (event.run === undefined && this.#resumeTs !== undefined) this.#recover(event.entries);
				return;
			case "run_start":
				this.#start();
				return;
			case "tool_execution_start":
				if (this.#run === undefined || event.parentToolCallId !== undefined) return;
				this.#run.steps.push(describeStep(event.toolName, event.args));
				this.#moved();
				this.#run.running = (this.#run.running ?? 0) + 1;
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
				this.#moved();
				delete this.#run.error;
				this.#run.text = text;
				this.#run.note = text;
				this.#schedule();
				return;
			}
			case "tool_execution_end":
				if (this.#run === undefined || event.parentToolCallId !== undefined) return;
				this.#run.running = Math.max(0, (this.#run.running ?? 0) - 1);
				// A command finishing is progress too.
				this.#moved();
				return;
			case "task_failed":
				if (this.#run !== undefined) this.#run.error = event.message;
				return;
			case "auto_retry_start":
				// The model call failed and will be tried again: say so as a colleague would, not as an error.
				if (this.#run === undefined) return;
				this.#run.status = say(SAYINGS.slow, this.#run.startedAt);
				this.#onSlow();
				this.#schedule();
				return;
			case "auto_retry_end":
				if (this.#run !== undefined) this.#moved();
				return;
			case "run_end":
				this.#finish();
				return;
		}
	}

	#start(): void {
		const now = this.#now();
		const run: Run = { startedAt: now, steps: [], movedAt: now };
		if (this.#mood?.() === true) run.status = say(SAYINGS.behind, now);
		this.#run = run;
		const resumed = this.#resumeTs;
		this.#resumeTs = undefined;
		this.#enqueue(async () => {
			if (resumed !== undefined) {
				run.ts = resumed;
				await this.#surface.update(this.#channel, resumed, progressMessage(run, this.#now()));
				// A queued request's message becomes this run's; remember it, so a restart picks the run up there.
				this.#onRunMessage(resumed);
				return;
			}
			run.ts = await this.#surface.post(this.#channel, this.#threadTs, progressMessage(run, this.#now()));
			this.#onRunMessage(run.ts);
		});
	}

	/** Someone's request is waiting its turn: say so in the message this run will use once it starts. */
	queued(text: string): void {
		const message = { text, blocks: [{ type: "markdown", text: `_${text}_` }] };
		this.#enqueue(async () => {
			if (this.#run !== undefined) return;
			// Remembered here only: after a restart, a queued request is delivered afresh, not mistaken for a run.
			if (this.#resumeTs !== undefined) await this.#surface.update(this.#channel, this.#resumeTs, message);
			else this.#resumeTs = await this.#surface.post(this.#channel, this.#threadTs, message);
		});
	}

	/**
	 * The watchdog, every minute or so: a run that hasn't moved on for `QUIET_MS` says what it's still doing; for
	 * `GIVE_UP_MS`, it should stop (returns true, and its final message says why).
	 */
	check(now = this.#now()): boolean {
		const run = this.#run;
		if (run === undefined) return false;
		const quiet = now - (run.movedAt ?? run.startedAt);
		// Only a run waiting on nothing gives up; a command still running (a long build) has its own timeout.
		if (quiet >= GIVE_UP_MS && (run.running ?? 0) === 0) {
			run.gaveUp = `I stopped: I hadn't got anywhere in ${Math.round(quiet / 60_000)} minutes.`;
			return true;
		}
		if (quiet >= QUIET_MS) {
			const last = run.steps.at(-1);
			const minutes = String(Math.round(quiet / 60_000));
			run.status = last === undefined ? say(SAYINGS.thinking, run.startedAt) : say(SAYINGS.longStep, run.startedAt).replace("%s", last).replace("%m", minutes);
			this.#schedule();
		}
		return false;
	}

	#moved(): void {
		const run = this.#run;
		if (run === undefined) return;
		run.movedAt = this.#now();
		delete run.status;
	}

	/** The final answer of a run that ended while Scout was down, into the message that still says "Working…". */
	#recover(entries: readonly { model?: readonly unknown[] }[]): void {
		const ts = this.#resumeTs;
		this.#resumeTs = undefined;
		if (ts === undefined) return;
		let text: string | undefined;
		for (const entry of [...entries].reverse()) {
			text = assistantText(entry.model);
			if (text !== undefined) break;
		}
		const answer = text ?? "I was restarted while working on this, and didn't get to an answer. Ask me again?";
		this.#enqueue(async () => {
			await this.#deliver(ts, answer, finalMessage({ startedAt: this.#now(), steps: [], text: answer, recovered: true }, this.#now()));
			this.#onRunMessage(undefined);
		});
	}

	/**
	 * Put a final message in Slack, never losing it: edit the run's message, or post a new one if that fails. A long
	 * answer's message shows its opening; the whole answer is attached as a file (or follows in messages, if it can't be).
	 */
	async #deliver(ts: string | undefined, answer: string, message: ChatMessage): Promise<string | undefined> {
		// Attached first, so the message can say so only if it is.
		let attached = false;
		if (answer.length > LONG_ANSWER && this.#surface.attach !== undefined) {
			try {
				await this.#surface.attach(this.#channel, this.#threadTs, { name: "answer.md", content: answer, title: "Scout's full answer" });
				attached = true;
			} catch (error) {
				console.error(`attaching the full answer in ${this.#channel}/${this.#threadTs} failed; it follows in messages:`, error);
			}
		}
		let shown = message;
		let rest: string[] = [];
		if (attached) shown = { ...message, blocks: [{ type: "markdown", text: `${opening(answer)}\n\n_The full answer is attached._` }, ...message.blocks.slice(1)] };
		else if (answer.length > MARKDOWN_LIMIT) {
			const [first, ...others] = parts(answer, MARKDOWN_LIMIT);
			shown = { ...message, blocks: [{ type: "markdown", text: first! }, ...message.blocks.slice(1)] };
			rest = others;
		}
		let posted = ts;
		try {
			if (ts === undefined) posted = await this.#surface.post(this.#channel, this.#threadTs, shown);
			else await this.#surface.update(this.#channel, ts, shown);
		} catch (error) {
			console.error(`updating ${this.#channel}/${ts} failed, posting the answer anew:`, error);
			posted = await this.#surface.post(this.#channel, this.#threadTs, shown);
		}
		for (const part of rest) await this.#surface.post(this.#channel, this.#threadTs, { text: clip(part, 3_000), blocks: [{ type: "markdown", text: part }] });
		return posted;
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
			const cost = this.#cost?.(run.startedAt);
			const message = finalMessage(cost === undefined ? run : { ...run, cost }, this.#now());
			const answer = (message.blocks[0] as { text: string }).text;
			const ts = await this.#deliver(run.ts, answer, message);
			this.#onRunMessage(undefined);
			const outcome: RunOutcome = run.stoppedBy !== undefined ? "stopped" : run.gaveUp !== undefined || run.error !== undefined ? "problem" : "answered";
			this.#onRunEnd(run.stoppedBy === undefined && run.gaveUp === undefined ? run.text : undefined, ts, outcome);
		});
	}

	#enqueue(work: () => Promise<void>): void {
		this.#queue = this.#queue.then(work).catch((error: unknown) => {
			console.error(`slack render failed in ${this.#channel}/${this.#threadTs}:`, error);
		});
	}
}

export function progressMessage(run: Pick<Run, "startedAt" | "steps" | "note" | "status">, now: number): ChatMessage {
	const lines = [`_Working… ${duration(now - run.startedAt)}_`];
	if (run.status !== undefined) lines.push(`_${run.status}_`);
	if (run.note !== undefined) lines.push("", quote(clip(run.note, 600)));
	const hidden = run.steps.length - VISIBLE_STEPS;
	if (run.steps.length > 0) lines.push("");
	if (hidden > 0) lines.push(`_…${hidden} earlier step${hidden === 1 ? "" : "s"}_`);
	for (const step of run.steps.slice(-VISIBLE_STEPS)) lines.push(`• ${step}`);
	const text = lines.join("\n");
	return { text: "Working…", blocks: [{ type: "markdown", text }] };
}

export function finalMessage(
	run: Pick<Run, "startedAt" | "steps" | "text" | "error" | "stoppedBy" | "notes" | "gaveUp"> & { cost?: string; recovered?: boolean },
	now: number,
): ChatMessage {
	const answer =
		run.gaveUp !== undefined
			? `${run.gaveUp}${stoppedAt(run)}`
			: run.stoppedBy !== undefined
			? `Stopped by ${run.stoppedBy}.${stoppedAt(run)}`
			: run.text === undefined
				? run.error === undefined
					? "Done."
					: `I ran into a problem and stopped: ${clip(run.error, 500)}`
				: run.error === undefined
					? run.text
					: `${run.text}\n\n_Then I ran into a problem and stopped: ${clip(run.error, 500)}_`;
	const steps = run.steps.length;
	const footer = run.recovered
		? "Finished while I was restarting."
		: [`${steps} step${steps === 1 ? "" : "s"}`, duration(now - run.startedAt), ...(run.cost === undefined ? [] : [run.cost])].join(" · ");
	return {
		text: clip(answer, 3_000),
		blocks: [
			{ type: "markdown", text: answer },
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

/** An answer's opening for its message when the whole of it is attached: its first paragraph, or as much as reads well. */
function opening(answer: string): string {
	const first = answer.trim().split(/\n\s*\n/)[0] ?? "";
	return clip(first, 1_500);
}

/** A long text in pieces of at most `max` characters, split at paragraph breaks where it can be. */
function parts(text: string, max: number): string[] {
	const out: string[] = [];
	let current = "";
	for (const paragraph of text.split(/\n\s*\n/)) {
		const next = current === "" ? paragraph : `${current}\n\n${paragraph}`;
		if (next.length <= max) current = next;
		else {
			if (current !== "") out.push(current);
			for (let i = 0; i < paragraph.length; i += max) out.push(paragraph.slice(i, i + max));
			current = "";
			if (out.at(-1)!.length < max && paragraph.length <= max) current = out.pop()!;
		}
	}
	if (current !== "") out.push(current);
	return out;
}
