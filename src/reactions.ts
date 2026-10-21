/**
 * The request's reaction shows what Scout is doing right now, so a glance at the channel says it: 🧠 thinking, 📖
 * reading, ✏️ editing, 🧪 testing… and at the end ✅, ⚠️, ✋, or 🙋 when it's waiting on someone. One reaction at a time
 * per request, Scout's own (it never touches anyone else's).
 *
 * Phases flip every few seconds during a run, so they're smoothed: a phase shows once it has lasted `debounceMs`,
 * stays at least `minDwellMs` so it can be read, and the end of a run shows at once. Every change in the workspace goes
 * through one pace (`spacingMs` apart), and only the latest wanted phase of each message is sent, so a busy channel
 * sees fewer changes, never rate-limit errors.
 */
export const PHASES = [
	"picked",
	"queued",
	"thinking",
	"reading",
	"editing",
	"command",
	"testing",
	"building",
	"systems",
	"pull",
	"compacting",
	"slow",
	"approaches",
	"tool",
] as const;
export const ENDINGS = ["done", "problem", "stopped", "waiting"] as const;
export type Phase = (typeof PHASES)[number];
export type Ending = (typeof ENDINGS)[number];

/** Slack's emoji names (not the characters): reactions.add takes names. A profile's reactions.md can change them. */
export const DEFAULT_EMOJI: Record<Phase | Ending, string> = {
	picked: "eyes",
	queued: "hourglass_flowing_sand",
	thinking: "brain",
	reading: "book",
	editing: "pencil2",
	command: "computer",
	testing: "test_tube",
	building: "building_construction",
	systems: "bar_chart",
	pull: "twisted_rightwards_arrows",
	compacting: "compression",
	slow: "turtle",
	approaches: "scales",
	tool: "hammer_and_wrench",
	done: "white_check_mark",
	problem: "warning",
	stopped: "hand",
	waiting: "raising_hand",
};

const TESTS = /\b(npm (run )?test|pnpm (run )?test|yarn test|npx (jest|vitest|mocha|playwright)|pytest|python3? -m (unittest|pytest)|go test|cargo test|mix test|rspec|phpunit|dotnet test|make (test|check)|node --test|deno test|bun test)\b/;
const BUILDS = /\b(npm (ci|install|i|run build)|pnpm (i|install|build)|yarn (install|build)|pip3? install|uv (pip|sync)|go (build|mod download)|cargo (build|fetch)|mix (compile|deps\.get)|tsc\b|make\b|gradle|mvn|docker build|bundle install)/;
const READS = new Set(["read", "grep", "find", "ls", "search_threads", "search_code", "read_code"]);
const EDITS = new Set(["edit", "write"]);

/** What a tool call is, as a phase: from its name, and for commands from what they run. */
export function toolPhase(toolName: string, args: Record<string, unknown>): Phase {
	if (READS.has(toolName)) return "reading";
	if (EDITS.has(toolName)) return "editing";
	if (toolName === "open_pull_request") return "pull";
	if (toolName === "try_approaches") return "approaches";
	if (toolName.startsWith("mcp__")) return "systems";
	if (toolName === "bash") {
		const command = typeof args.command === "string" ? args.command : "";
		if (TESTS.test(command)) return "testing";
		if (BUILDS.test(command)) return "building";
		return "command";
	}
	return "tool";
}

type Entry = { channel: string; ts: string; shown?: string; shownAt: number; want?: string; wantSince: number; ending: boolean };

export class StatusReactions {
	readonly #react: (channel: string, ts: string, name: string, on: boolean) => Promise<void>;
	readonly #emoji: (phase: Phase | Ending) => string;
	readonly #debounceMs: number;
	readonly #minDwellMs: number;
	readonly #spacingMs: number;
	readonly #now: () => number;
	readonly #later: ((run: () => void, delayMs: number) => void) | undefined;
	readonly #entries = new Map<string, Entry>();
	#lastCall = Number.NEGATIVE_INFINITY;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#busy = false;

	constructor(options: {
		react: (channel: string, ts: string, name: string, on: boolean) => Promise<void>;
		emoji?: (phase: Phase | Ending) => string;
		debounceMs?: number;
		minDwellMs?: number;
		spacingMs?: number;
		now?: () => number;
		/** Tests drive the clock themselves; the service uses timers. */
		later?: (run: () => void, delayMs: number) => void;
	}) {
		this.#later = options.later;
		this.#react = options.react;
		this.#emoji = options.emoji ?? ((p) => DEFAULT_EMOJI[p]);
		this.#debounceMs = options.debounceMs ?? 1_500;
		this.#minDwellMs = options.minDwellMs ?? 3_000;
		this.#spacingMs = options.spacingMs ?? 1_500;
		this.#now = options.now ?? Date.now;
	}

	/** The request in message `ts` is now in `phase`. */
	set(channel: string, ts: string, phase: Phase): void {
		this.#want(channel, ts, this.#emoji(phase), false);
	}

	/** Its run ended: show how, as soon as the pace allows, and stop following it. */
	finish(channel: string, ts: string, ending: Ending): void {
		this.#want(channel, ts, this.#emoji(ending), true);
	}

	#want(channel: string, ts: string, emoji: string, ending: boolean): void {
		const key = `${channel}:${ts}`;
		const now = this.#now();
		const entry = this.#entries.get(key) ?? { channel, ts, shownAt: Number.NEGATIVE_INFINITY, wantSince: now, ending: false };
		if (entry.ending && !ending) return;
		if (entry.want !== emoji) entry.wantSince = now;
		entry.want = emoji;
		entry.ending = ending;
		this.#entries.set(key, entry);
		this.#schedule(0);
	}

	/** Apply the change that's due, one per `spacingMs` across the workspace, then plan the next. */
	async tick(): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		try {
			const now = this.#now();
			let next = Number.POSITIVE_INFINITY;
			let chosen: [string, Entry] | undefined;
			for (const [key, e] of this.#entries) {
				if (e.want === e.shown) {
					// An ended request is remembered a minute, so a late phase can't replace its ending.
					if (e.ending && now - e.shownAt > 60_000) this.#entries.delete(key);
					continue;
				}
				const ready = e.ending ? now : Math.max(e.wantSince + this.#debounceMs, e.shownAt + this.#minDwellMs);
				if (ready <= now && (chosen === undefined || e.ending)) chosen = [key, e];
				else next = Math.min(next, ready);
			}
			if (chosen !== undefined) {
				const pace = this.#lastCall + this.#spacingMs;
				if (pace > now) next = Math.min(next, pace);
				else {
					const [key, e] = chosen;
					const want = e.want!;
					const old = e.shown;
					this.#lastCall = now;
					e.shown = want;
					e.shownAt = now;
					await this.#react(e.channel, e.ts, want, true).catch(() => {});
					if (old !== undefined && old !== want) await this.#react(e.channel, e.ts, old, false).catch(() => {});
					next = Math.min(next, now + this.#spacingMs);
				}
			}
			if (next !== Number.POSITIVE_INFINITY && this.#entries.size > 0) this.#schedule(Math.max(0, next - now));
		} finally {
			this.#busy = false;
		}
	}

	#schedule(delayMs: number): void {
		if (this.#later !== undefined) {
			this.#later(() => void this.tick(), delayMs);
			return;
		}
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.tick();
		}, delayMs);
		this.#timer.unref?.();
	}

	/** Reactions still to change, for tests and shutdown. */
	get pending(): number {
		return [...this.#entries.values()].filter((e) => e.want !== e.shown).length;
	}

	stop(): void {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
	}
}
