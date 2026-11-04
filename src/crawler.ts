import type { Doc, History, Link } from "./history.ts";

/**
 * Keeping the session index (history.ts) current from the places its documents come from. A source knows how to ask
 * its system what changed since a cursor, and nothing about storage, chunking, redaction or retention; the crawler
 * pages through it, stores each page together with the cursor it reached, and backs off from a source that fails
 * without holding up the others. Delivery is at-least-once: a page that was stored but whose cursor wasn't (a crash)
 * comes again, and putting a document twice changes nothing.
 *
 * Slack also writes live (bridge.ts), so threads are searchable at once; its source here fills what was missed, and the
 * history from before the index existed. Adding a source (docs/session-index.md) is adding one of these.
 */
export type Page = { docs: Doc[]; links?: Link[]; cursor: string };

export type Source = {
	name: string;
	/** What to crawl separately, each with its own cursor (a repository, a pipeline); one unnamed scope when absent. */
	scopes?(): string[] | Promise<string[]>;
	/** What changed in `scope` since `cursor` (undefined: from the start), oldest first, in pages. */
	crawl(scope: string, cursor: string | undefined, signal: AbortSignal): AsyncIterable<Page>;
	/** How often to ask, in milliseconds; the crawler's default when absent. */
	everyMs?: number;
};

export type SourceStatus = {
	source: string;
	lastRun?: number;
	lastOk?: number;
	/** The last failure's message, until the source succeeds again. */
	error?: string;
	/** Failures in a row. */
	failures: number;
	/** Documents written by the last run. */
	written: number;
	/** When it is due next. */
	nextAt: number;
};

const MINUTE = 60_000;
/** A failing source is asked again after its interval doubled for each failure, but never more than this. */
const LONGEST_WAIT = 60 * MINUTE;

export class Crawler {
	readonly #history: History;
	readonly #sources: Source[];
	readonly #everyMs: number;
	readonly #now: () => number;
	readonly #log: (message: string) => void;
	readonly #status = new Map<string, SourceStatus>();
	readonly #abort = new AbortController();
	#running: Promise<unknown> = Promise.resolve();

	constructor(options: { history: History; sources: Source[]; everyMs?: number; now?: () => number; log?: (message: string) => void }) {
		this.#history = options.history;
		this.#sources = options.sources;
		this.#everyMs = options.everyMs ?? 5 * MINUTE;
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? ((m) => console.error(m));
		for (const s of options.sources) this.#status.set(s.name, { source: s.name, failures: 0, written: 0, nextAt: 0 });
	}

	/** Crawls every source that is due (all of them with `force`), one after another. One failing never stops the rest. */
	async runOnce(options: { force?: boolean } = {}): Promise<SourceStatus[]> {
		const run = this.#running.then(() => this.#runDue(options.force === true));
		this.#running = run.catch(() => {});
		return run;
	}

	async #runDue(force: boolean): Promise<SourceStatus[]> {
		for (const source of this.#sources) {
			if (this.#abort.signal.aborted) break;
			const status = this.#status.get(source.name)!;
			if (!force && this.#now() < status.nextAt) continue;
			status.lastRun = this.#now();
			try {
				status.written = await this.#crawl(source);
				if (status.error !== undefined) this.#log(`${source.name}: crawling works again`);
				delete status.error;
				status.failures = 0;
				status.lastOk = this.#now();
			} catch (error) {
				if (this.#abort.signal.aborted) break;
				const message = error instanceof Error ? error.message : String(error);
				if (status.error !== message) this.#log(`${source.name}: crawling failed (${message}); trying again later`);
				status.error = message;
				status.failures++;
			}
			const every = source.everyMs ?? this.#everyMs;
			status.nextAt = status.lastRun + Math.min(every * 2 ** Math.min(status.failures, 10), Math.max(every, LONGEST_WAIT));
		}
		return this.status();
	}

	async #crawl(source: Source): Promise<number> {
		let written = 0;
		let failure: unknown;
		for (const scope of (await source.scopes?.()) ?? [""]) {
			// One scope failing (a repository the token lost, say) doesn't hold up the others; the failure is reported after.
			try {
				for await (const page of source.crawl(scope, this.#history.cursor(source.name, scope), this.#abort.signal)) {
					written += this.#history.commit(source.name, scope, page, this.#now());
					if (this.#abort.signal.aborted) return written;
				}
			} catch (error) {
				if (this.#abort.signal.aborted) return written;
				failure ??= scope !== "" && error instanceof Error ? new Error(`${scope}: ${error.message}`) : error;
			}
		}
		if (failure !== undefined) throw failure;
		return written;
	}

	status(): SourceStatus[] {
		return [...this.#status.values()].map((s) => ({ ...s }));
	}

	/** Stops starting work and lets a page in flight finish. */
	async stop(): Promise<void> {
		this.#abort.abort();
		await this.#running;
	}
}
