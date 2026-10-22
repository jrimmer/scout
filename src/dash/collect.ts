import type { MemoryNote } from "../memory.ts";
import { nextTime, type Schedule } from "../schedules.ts";
import type { PullRow, PullState, ReviewRow } from "../pulls.ts";
import type { ThreadRow } from "../threads.ts";

/** Everything the dashboard shows, read at one moment. Plain data, so layouts can be tested with fixtures. */
export type CapacitySnapshot = {
	active: number;
	maxRuns: number;
	queued: number;
	modelInFlight: number;
	modelWaiting: number;
	modelMax: number;
	sandboxes: number;
	sandboxWaiting: number;
	progressWaiting: number;
	loopLag: { mean: number; p99: number };
	waits: { kind: string; count: number; p50: number; p90: number }[];
	/** How long model calls took to start answering over the last day. */
	firstToken?: { count: number; p50: number; p90: number };
};

export type Snapshot = {
	now: number;
	startedAt: number;
	host: string;
	model: string;
	/** Since when Scout has been draining for a restart (drain.ts), if it is. */
	draining?: number;
	alerts: { message: string; since: number }[];
	working: { channel: string; startedAt: number; steps: number; lastStep?: string }[];
	threadsToday: number;
	threads: { channel: string; startedBy: string; runs: number; pulls: number; lastActivity: number; working: boolean }[];
	pulls: {
		week: { merged: number; closed: number };
		lastWeek: { merged: number; closed: number };
		openNow: number;
		latest: { title: string; slug: string; state: PullState; kind: PullRow["kind"]; openedAt: number }[];
	};
	learning: {
		reflectHour: number;
		profileRepo: boolean;
		last?: { day: string; threads: number; proposal?: { title: string; state: PullState } };
		proposals: { merged: number; closed: number };
		notes: MemoryNote[];
	};
	reviews: { latest: { slug: string; number: number; sha: string; posted: boolean }[] };
	/** Every channel's schedules, with when each runs next. */
	schedules: { id: number; channel: string; when: string; task: string; paused: boolean; next?: number; lastRun?: number }[];
	/** Runs, model calls and sandboxes against their limits, what's waiting, and how long waits have been (capacity.ts). */
	capacity?: CapacitySnapshot;
	spend: {
		total: number;
		byModel: { model: string; cost: number }[];
		/** This week, by channel, against its budget if it has one. */
		week?: { channel: string; cost: number; budget?: number }[];
	};
	history: { working: number[]; spendPerHour: number[] };
};

/** What the collector reads from. The service passes its live pieces; tests pass fixtures. */
export type Sources = {
	host: string;
	model: string;
	startedAt: number;
	reflectHour: number;
	profileRepo: boolean;
	threads: {
		recent(limit: number): ThreadRow[];
		countSince(since: number): number;
		lastReflection(): { day: string; conversationId: number; threads: number } | undefined;
	};
	pulls: {
		rate(from: number, to: number, kind?: PullRow["kind"]): { merged: number; closed: number };
		count(where: string, ...args: (string | number)[]): number;
		latest(limit: number): PullRow[];
		forConversation(conversationId: number): PullRow[];
		latestReviews(limit: number): ReviewRow[];
	};
	memory: { active(): MemoryNote[] };
	working(): { conversationId: number; startedAt: number; steps: number; lastStep?: string }[];
	channelOf(conversationId: number): Promise<string>;
	/** Model spend since start, by `provider/model`, in dollars. */
	spend(): Promise<Record<string, number>>;
	/** This week's spend by channel, with budgets. */
	week?(): { channel: string; cost: number; budget?: number }[];
	alerts(): { message: string; since: number }[];
	schedules?(): Schedule[];
	capacity?(): CapacitySnapshot;
	draining?(): number | undefined;
};

const DAY = 24 * 60 * 60 * 1000;
const HISTORY = 150;

/** Collects snapshots and keeps the short history the sparklines draw. */
export class Collector {
	readonly #sources: Sources;
	readonly #working: number[] = [];
	readonly #spendPerHour: number[] = [];
	#lastSpend: { at: number; total: number } | undefined;

	constructor(sources: Sources) {
		this.#sources = sources;
	}

	async collect(now = Date.now()): Promise<Snapshot> {
		const s = this.#sources;
		const working = s.working();
		const workingIds = new Set(working.map((w) => w.conversationId));
		const recent = s.threads.recent(12);
		const byModel = await s.spend();
		const total = Object.values(byModel).reduce((sum, cost) => sum + cost, 0);

		this.#push(this.#working, working.length);
		if (this.#lastSpend !== undefined && now > this.#lastSpend.at) {
			this.#push(this.#spendPerHour, ((total - this.#lastSpend.total) * 3_600_000) / (now - this.#lastSpend.at));
		}
		this.#lastSpend = { at: now, total };

		const last = s.threads.lastReflection();
		const proposal = last === undefined ? undefined : s.pulls.forConversation(last.conversationId)[0];
		const draining = s.draining?.();
		return {
			now,
			startedAt: s.startedAt,
			host: s.host,
			model: s.model,
			...(draining === undefined ? {} : { draining }),
			alerts: s.alerts(),
			working: await Promise.all(
				working.map(async (w) => ({
					channel: await s.channelOf(w.conversationId),
					startedAt: w.startedAt,
					steps: w.steps,
					...(w.lastStep === undefined ? {} : { lastStep: w.lastStep }),
				})),
			),
			threadsToday: s.threads.countSince(now - DAY),
			threads: await Promise.all(
				recent.map(async (t) => ({
					channel: await s.channelOf(t.conversationId),
					startedBy: t.startedBy,
					runs: t.runs,
					pulls: s.pulls.forConversation(t.conversationId).length,
					lastActivity: t.lastActivity,
					working: workingIds.has(t.conversationId),
				})),
			),
			pulls: {
				week: s.pulls.rate(now - 7 * DAY, now),
				lastWeek: s.pulls.rate(now - 14 * DAY, now - 7 * DAY),
				openNow: s.pulls.count("kind = 'work' AND state = 'open'"),
				latest: s.pulls.latest(8).map((p) => ({ title: p.title, slug: p.slug, state: p.state, kind: p.kind, openedAt: p.openedAt })),
			},
			learning: {
				reflectHour: s.reflectHour,
				profileRepo: s.profileRepo,
				...(last === undefined
					? {}
					: {
							last: {
								day: last.day,
								threads: last.threads,
								...(proposal === undefined ? {} : { proposal: { title: proposal.title, state: proposal.state } }),
							},
						}),
				proposals: s.pulls.rate(now - 30 * DAY, now, "profile"),
				notes: s.memory.active(),
			},
			...(s.capacity === undefined ? {} : { capacity: s.capacity() }),
			schedules: (s.schedules?.() ?? []).map((sc) => {
				const next = sc.paused ? undefined : nextTime(sc.cron, now);
				return { id: sc.id, channel: sc.channel, when: sc.when, task: sc.task, paused: sc.paused, ...(next === undefined ? {} : { next }), ...(sc.lastRun === undefined ? {} : { lastRun: sc.lastRun }) };
			}),
			reviews: {
				latest: s.pulls.latestReviews(5).map((r) => ({ slug: r.slug, number: r.number, sha: r.sha, posted: r.postedAt !== undefined })),
			},
			spend: {
				total,
				byModel: Object.entries(byModel)
					.map(([model, cost]) => ({ model, cost }))
					.sort((a, b) => b.cost - a.cost),
				...(s.week === undefined ? {} : { week: s.week() }),
			},
			history: { working: [...this.#working], spendPerHour: [...this.#spendPerHour] },
		};
	}

	#push(series: number[], value: number): void {
		series.push(value);
		if (series.length > HISTORY) series.shift();
	}
}
