import type { AgentEvent } from "@earendil-works/pi-durable";
import { type Phase, toolPhase } from "./reactions.ts";

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
/**
 * A final answer Slack won't take (after its client's own five minutes of trying) is tried again this often, for this
 * long. A restart in the meantime doesn't lose it either: the run's message is remembered until the answer is in.
 */
const REDELIVER_MS = 2 * 60_000;
const REDELIVER_FOR_MS = 6 * 60 * 60_000;
/** Slack's client's error codes for not reaching Slack, or Slack failing (a 5xx), after its own trying again. */
const DOWN_CODES = new Set(["slack_webapi_request_error", "slack_webapi_http_error"]);
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
	/** What it's waiting on right now (a sandbox, the model), said in Scout's voice; it outranks `status` while it lasts. */
	waiting?: string;
	/** Its model calls went to a fallback model, in Scout's words: said once, and kept with its answer. */
	fallback?: string;
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
	readonly #onRunEnd: (answer: string | undefined, ts: string | undefined, outcome: RunOutcome, durationMs: number) => void;
	readonly #pacer: ProgressPacer | undefined;
	readonly #now: () => number;
	readonly #onRunMessage: (ts: string | undefined) => void;
	readonly #cost: ((startedAt: number) => string | undefined) | undefined;
	readonly #mood: (() => boolean) | undefined;
	readonly #onPhase: (phase: Phase) => void;
	readonly #onSlow: () => void;
	readonly #wait: (ms: number) => Promise<void>;
	readonly #fallback: (() => Promise<string | undefined>) | undefined;
	#resumeTs: string | undefined;
	#run: Run | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#queue: Promise<void> = Promise.resolve();

	constructor(options: {
		surface: ChatSurface;
		channel: string;
		threadTs: string;
		/** After the run's final message is in Slack, with Scout's answer when it gave one. */
		/** The run's answer (none when it was stopped), the message it's in, how it ended, and how long it took. */
		onRunEnd?: (answer: string | undefined, ts: string | undefined, outcome: RunOutcome, durationMs: number) => void;
		/** Paces progress edits across every thread in the workspace (one per thread without it). */
		pacer?: ProgressPacer;
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
		/** What the run is doing now (thinking, reading, testing…), for the request's reaction (reactions.ts). */
		onPhase?: (phase: Phase) => void;
		/** Whether the thread's model calls went to a fallback model (its own is failing), in Scout's words. */
		fallback?: () => Promise<string | undefined>;
		now?: () => number;
		wait?: (ms: number) => Promise<void>;
	}) {
		this.#wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.#fallback = options.fallback;
		this.#cost = options.cost;
		this.#pacer = options.pacer;
		this.#mood = options.behind;
		this.#onSlow = options.onSlow ?? (() => {});
		this.#onPhase = options.onPhase ?? (() => {});
		this.#resumeTs = options.resumeTs;
		this.#onRunMessage = options.onRunMessage ?? (() => {});
		this.#surface = options.surface;
		this.#channel = options.channel;
		this.#threadTs = options.threadTs;
		this.#onRunEnd = options.onRunEnd ?? (() => {});
		this.#now = options.now ?? Date.now;
	}

	get #key(): string {
		return `${this.#channel}:${this.#threadTs}`;
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
				this.#onPhase("thinking");
				return;
			case "message_start":
				if (this.#run !== undefined) this.#onPhase("thinking");
				return;
			case "tool_execution_start":
				if (this.#run === undefined || event.parentToolCallId !== undefined) return;
				this.#onPhase(toolPhase(event.toolName, event.args));
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
				if (event.entry.model?.some((m) => m.role === "assistant") === true) this.#checkFallback(this.#run);
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
				// A command finishing is progress too; next, the model reads what it found.
				this.#moved();
				if (this.#run.running === 0) this.#onPhase("thinking");
				return;
			case "task_failed":
				if (this.#run !== undefined) this.#run.error = event.message;
				return;
			case "auto_retry_start":
				// The model call failed and will be tried again: say so as a colleague would, not as an error.
				if (this.#run === undefined) return;
				this.#run.status = say(SAYINGS.slow, this.#run.startedAt);
				this.#onSlow();
				this.#onPhase("slow");
				this.#schedule();
				return;
			case "auto_retry_end":
				if (this.#run !== undefined) this.#moved();
				return;
			case "run_end":
				this.#finish();
				return;
			default:
				// Pi's compactions (pi.live): Scout tidying its memory of a long thread.
				if ((event.type as string) === "compaction_start" && this.#run !== undefined) this.#onPhase("compacting");
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

	/**
	 * After a model call, once a run: if it went to a fallback model, say so. Asked in the run's queue, so the answer,
	 * queued after it, says so too.
	 */
	#checkFallback(run: Run): void {
		const fallback = this.#fallback;
		if (fallback === undefined || run.fallback !== undefined) return;
		this.#enqueue(async () => {
			if (run.fallback !== undefined) return;
			const text = await fallback().catch(() => undefined);
			if (text === undefined) return;
			run.fallback = text;
			if (this.#run === run) this.#schedule();
		});
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
		let posted: string | undefined;
		let sent = 0;
		const first = this.#now();
		for (;;) {
			try {
				if (posted === undefined) {
					try {
						if (ts === undefined) posted = await this.#surface.post(this.#channel, this.#threadTs, shown);
						else await this.#surface.update(this.#channel, ts, shown).then(() => (posted = ts));
					} catch (error) {
						console.error(`updating ${this.#channel}/${ts} failed, posting the answer anew:`, error);
						posted = await this.#surface.post(this.#channel, this.#threadTs, shown);
					}
				}
				for (; sent < rest.length; sent++) {
					const part = rest[sent]!;
					await this.#surface.post(this.#channel, this.#threadTs, { text: clip(part, 3_000), blocks: [{ type: "markdown", text: part }] });
				}
				return posted;
			} catch (error) {
				// Only Slack being unreachable or failing is worth waiting out; when it says no (the channel is gone, Scout
				// was removed), or something else broke, trying again won't change that.
				if (!DOWN_CODES.has((error as { code?: string }).code ?? "") || this.#now() - first >= REDELIVER_FOR_MS) throw error;
				console.error(`Slack won't take the answer in ${this.#channel}/${this.#threadTs}; trying again in ${REDELIVER_MS / 60_000} minutes:`, error);
				await this.#wait(REDELIVER_MS);
			}
		}
	}

	/** What the run is waiting on right now (undefined when it isn't): shown in its progress message. */
	waiting(text: string | undefined): void {
		const run = this.#run;
		if (run === undefined || run.waiting === text) return;
		if (text === undefined) delete run.waiting;
		else run.waiting = text;
		this.#schedule();
	}

	#schedule(): void {
		const pacer = this.#pacer;
		if (pacer !== undefined) {
			const run = this.#run;
			if (run === undefined) return;
			// The pacer sends the latest state when this thread's turn comes, never a stale one after the answer.
			pacer.want(this.#key, () => {
				if (this.#run !== run || run.ts === undefined) return;
				this.#enqueue(async () => {
					if (this.#run === run && run.ts !== undefined) await this.#surface.update(this.#channel, run.ts, progressMessage(run, this.#now()));
				});
			});
			return;
		}
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
		// The answer goes out now, never behind other threads' progress, and no queued progress edit can follow it.
		this.#pacer?.cancel(this.#key);
		this.#enqueue(async () => {
			const cost = this.#cost?.(run.startedAt);
			const message = finalMessage(cost === undefined ? run : { ...run, cost }, this.#now());
			const answer = (message.blocks[0] as { text: string }).text;
			const ts = await this.#deliver(run.ts, answer, message);
			this.#onRunMessage(undefined);
			const outcome: RunOutcome = run.stoppedBy !== undefined ? "stopped" : run.gaveUp !== undefined || run.error !== undefined ? "problem" : "answered";
			this.#onRunEnd(run.stoppedBy === undefined && run.gaveUp === undefined ? run.text : undefined, ts, outcome, this.#now() - run.startedAt);
		});
	}

	#enqueue(work: () => Promise<void>): void {
		this.#queue = this.#queue.then(work).catch((error: unknown) => {
			console.error(`slack render failed in ${this.#channel}/${this.#threadTs}:`, error);
		});
	}
}

export function progressMessage(run: Pick<Run, "startedAt" | "steps" | "note" | "status" | "waiting" | "fallback">, now: number): ChatMessage {
	const lines = [`_Working… ${duration(now - run.startedAt)}_`];
	const status = run.waiting ?? run.status;
	if (status !== undefined) lines.push(`_${status}_`);
	if (run.fallback !== undefined) lines.push(`_${run.fallback}_`);
	if (run.note !== undefined) lines.push("", quote(clip(run.note, 600)));
	const hidden = run.steps.length - VISIBLE_STEPS;
	if (run.steps.length > 0) lines.push("");
	if (hidden > 0) lines.push(`_…${hidden} earlier step${hidden === 1 ? "" : "s"}_`);
	for (const step of run.steps.slice(-VISIBLE_STEPS)) lines.push(`• ${step}`);
	const text = lines.join("\n");
	return { text: "Working…", blocks: [{ type: "markdown", text }] };
}

export function finalMessage(
	run: Pick<Run, "startedAt" | "steps" | "text" | "error" | "stoppedBy" | "notes" | "gaveUp" | "fallback"> & { cost?: string; recovered?: boolean },
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
			...(run.fallback === undefined ? [] : [{ type: "context", elements: [{ type: "mrkdwn", text: run.fallback }] }]),
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

/**
 * Progress edits for every thread in the workspace, paced so Slack never throttles them. Slack allows about one
 * chat.update a second per workspace; with a few threads working each still updates every `minIntervalMs`, and with
 * many, each updates less often, oldest change first, so the total stays under one edit per `spacingMs`. Only the
 * latest state of each message is ever sent. Answers don't go through here: they go out at once, and cancel any
 * progress edit still waiting for that thread.
 */
export class ProgressPacer {
	readonly #spacingMs: number;
	readonly #minIntervalMs: number;
	readonly #now: () => number;
	readonly #later: (run: () => void, delayMs: number) => void;
	readonly #wanted = new Map<string, { send: () => void; since: number }>();
	readonly #lastSent = new Map<string, number>();
	#lastAny = Number.NEGATIVE_INFINITY;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#scheduledFor = Number.POSITIVE_INFINITY;

	constructor(options: { spacingMs?: number; minIntervalMs?: number; now?: () => number; later?: (run: () => void, delayMs: number) => void } = {}) {
		this.#spacingMs = options.spacingMs ?? 1_000;
		this.#minIntervalMs = options.minIntervalMs ?? PROGRESS_INTERVAL_MS;
		this.#now = options.now ?? Date.now;
		this.#later = options.later ?? ((run, delayMs) => {
			if (this.#timer !== undefined) clearTimeout(this.#timer);
			this.#timer = setTimeout(run, delayMs);
			this.#timer.unref?.();
		});
	}

	/** A thread's progress changed: `send` shows its latest state, when its turn comes. */
	want(key: string, send: () => void): void {
		const existing = this.#wanted.get(key);
		this.#wanted.set(key, { send, since: existing?.since ?? this.#now() });
		this.#plan();
	}

	/** The thread's run ended: drop its waiting edit, so nothing stale lands after the answer. */
	cancel(key: string): void {
		this.#wanted.delete(key);
		this.#lastSent.delete(key);
	}

	/** Send the next edit that's due, oldest change first; then plan the next. */
	tick(): void {
		this.#scheduledFor = Number.POSITIVE_INFINITY;
		const now = this.#now();
		if (now < this.#lastAny + this.#spacingMs) return this.#plan();
		let chosen: [string, { send: () => void; since: number }] | undefined;
		for (const entry of this.#wanted) {
			const ready = (this.#lastSent.get(entry[0]) ?? Number.NEGATIVE_INFINITY) + this.#minIntervalMs;
			if (ready > now) continue;
			if (chosen === undefined || entry[1].since < chosen[1].since) chosen = entry;
		}
		if (chosen !== undefined) {
			this.#wanted.delete(chosen[0]);
			this.#lastSent.set(chosen[0], now);
			this.#lastAny = now;
			chosen[1].send();
		}
		this.#plan();
	}

	/** Edits waiting their turn, for gauges. */
	get waiting(): number {
		return this.#wanted.size;
	}

	#plan(): void {
		if (this.#wanted.size === 0) return;
		const now = this.#now();
		let at = Number.POSITIVE_INFINITY;
		for (const [key] of this.#wanted) at = Math.min(at, (this.#lastSent.get(key) ?? Number.NEGATIVE_INFINITY) + this.#minIntervalMs);
		at = Math.max(at, this.#lastAny + this.#spacingMs, now);
		if (at >= this.#scheduledFor) return;
		this.#scheduledFor = at;
		this.#later(() => this.tick(), at - now);
	}
}
