import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The alert responder's ears. Scout watches what the monitoring already knows (Gatus's checks, Grafana's firing
 * alerts) rather than taking webhooks: it has no public address, and the alerts' existing destinations stay as they are.
 * Each new alert becomes a public thread in the channel that owns it, where Scout investigates (see service.ts).
 *
 * The first look records what is already firing without opening threads, so starting to watch doesn't open a dozen.
 */
export type Alert = {
	/** Stable across polls: `gatus:<endpoint key>` or `grafana:<fingerprint>`. */
	key: string;
	source: "gatus" | "grafana";
	title: string;
	/** What's wrong, for people and for the investigation. */
	detail: string;
	/** What routing matches against: a Gatus endpoint's group and name, or a Grafana alert's labels. */
	labels: Record<string, string>;
	/** Where to look at it in the monitoring tool, when there's a page for it. */
	url?: string;
};

/** How Scout looks into an alert, when the profile has no `responder.md`. */
export const DEFAULT_RESPONDER_INSTRUCTIONS =
	"An alert fired. Confirm whether it's still happening with the monitoring tools you have, find when it started and " +
	"what changed around then, and say what's broken, the likely cause, how sure you are, and the next step a person " +
	"should take. Don't change anything unless someone asks. Verdict first, then the evidence.";

export type OpenAlert = Alert & { openedAt: number; channel?: string; threadTs?: string; returns: number };

export const ALERT_SOURCES = ["gatus", "grafana"] as const;

/**
 * How Scout treats one source's alerts. It's the profile's to tune (`responder.md`'s frontmatter, parseAlertPolicy);
 * where alerts come from and how often Scout looks stay the operator's (config.ts).
 */
export type AlertPolicy = {
	/** Alerts never posted. */
	ignore: string[];
	/** When set, only these are investigated; the rest are posted with a thread to ask in. */
	investigate?: string[];
	/** Failed checks in a row before a Gatus check counts as down (Gatus's own alerts use 2). */
	downAfter: number;
	/** How long a cleared alert's thread stays its thread: if it fires again within this, it's the same incident. */
	returnsWithinMs: number;
};

export const DEFAULT_ALERT_POLICY: AlertPolicy = { ignore: [], downAfter: 2, returnsWithinMs: 6 * 60 * 60 * 1000 };

/** Whether `term` names this alert: `label=value` for one label, or a bare value for any label (any case). */
export function alertMatches(alert: Pick<Alert, "labels">, term: string): boolean {
	const equals = term.indexOf("=");
	const want = (equals < 0 ? term : term.slice(equals + 1)).trim().toLowerCase();
	if (want === "") return false;
	if (equals < 0) return Object.values(alert.labels).some((v) => v.toLowerCase() === want);
	return alert.labels[term.slice(0, equals).trim()]?.toLowerCase() === want;
}

/**
 * The alert policy in `responder.md`'s frontmatter: flat keys, each optionally for one source (`gatus.down_after`),
 * which then overrides the same key without one for that source.
 *
 *     ignore: name=Cloudflare OS                  # never posted
 *     grafana.investigate: severity=critical      # the rest are posted, not investigated
 *     gatus.down_after: 3
 *     returns_within: 6h
 *
 * What it can't read is a problem to report, never a silent default.
 */
export function parseAlertPolicy(meta: Record<string, string>): { policy: Record<Alert["source"], AlertPolicy>; problems: string[] } {
	const problems: string[] = [];
	const general: Partial<AlertPolicy> = {};
	const bySource = Object.fromEntries(ALERT_SOURCES.map((s) => [s, {} as Partial<AlertPolicy>])) as Record<Alert["source"], Partial<AlertPolicy>>;
	for (const [name, value] of Object.entries(meta)) {
		const dot = name.indexOf(".");
		const source = dot < 0 ? undefined : name.slice(0, dot);
		const key = dot < 0 ? name : name.slice(dot + 1);
		if (source !== undefined && !(ALERT_SOURCES as readonly string[]).includes(source)) {
			problems.push(`${name}: no alert source called ${source} (there's ${ALERT_SOURCES.join(" and ")})`);
			continue;
		}
		const into = source === undefined ? general : bySource[source as Alert["source"]];
		const list = value.split(",").map((t) => t.trim()).filter(Boolean);
		switch (key) {
			case "ignore":
				into.ignore = list;
				break;
			case "investigate":
				into.investigate = list;
				break;
			case "down_after": {
				const n = Number(value);
				if (source === "grafana") problems.push(`${name}: Grafana decides when its own alerts fire (a rule's pending period)`);
				else if (!Number.isInteger(n) || n < 1) problems.push(`${name}: "${value}" isn't a whole number of checks`);
				else into.downAfter = n;
				break;
			}
			case "returns_within": {
				const ms = durationMs(value);
				if (ms === undefined) problems.push(`${name}: "${value}" isn't a duration like 30m, 6h or 1d`);
				else into.returnsWithinMs = ms;
				break;
			}
			default:
				problems.push(`${name}: not an alert setting (there's ignore, investigate, down_after and returns_within)`);
		}
	}
	const policy = Object.fromEntries(ALERT_SOURCES.map((s) => [s, { ...DEFAULT_ALERT_POLICY, ...general, ...bySource[s] }])) as Record<Alert["source"], AlertPolicy>;
	return { policy, problems };
}

function durationMs(value: string): number | undefined {
	const match = /^(\d+)\s*(m|h|d)$/.exec(value.trim());
	if (match === null) return undefined;
	return Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "m" | "h" | "d"];
}

type Check = { success: boolean; status?: number; timestamp: string; errors?: string[]; conditionResults?: { condition: string; success: boolean }[] };
type Endpoint = { key: string; name: string; group?: string; results: Check[] };

/** Gatus endpoints whose last `threshold` checks all failed (Gatus's own alerts use 2). */
export async function gatusAlerts(url: string, fetch: typeof globalThis.fetch = globalThis.fetch, threshold = 2): Promise<Alert[]> {
	const response = await fetch(`${url}/api/v1/endpoints/statuses?page=1&pageSize=${threshold}`);
	if (!response.ok) throw new Error(`Gatus answered ${response.status}`);
	const endpoints = (await response.json()) as Endpoint[];
	return endpoints.flatMap((e) => {
		const recent = e.results.slice(-threshold);
		if (recent.length < threshold || recent.some((c) => c.success)) return [];
		const last = recent.at(-1)!;
		const failed = (last.conditionResults ?? []).filter((c) => !c.success).map((c) => c.condition);
		const detail = [
			last.status ? `HTTP ${last.status}` : undefined,
			failed.length > 0 ? `failed: ${failed.join(", ")}` : undefined,
			last.errors && last.errors.length > 0 ? `errors: ${last.errors.join("; ")}` : undefined,
			`${threshold} checks in a row since ${recent[0]!.timestamp}`,
		]
			.filter(Boolean)
			.join("; ");
		return [
			{
				key: `gatus:${e.key}`,
				source: "gatus" as const,
				title: `${e.group ? `${e.group} / ` : ""}${e.name} is down`,
				detail,
				labels: { group: e.group ?? "", name: e.name, endpoint: e.key },
				url: `${url}/endpoints/${encodeURIComponent(e.key)}`,
			},
		];
	});
}

type GrafanaAlert = { fingerprint: string; labels: Record<string, string>; annotations?: Record<string, string>; startsAt: string; status: { state: string }; generatorURL?: string };

/** Grafana's alerts that are firing now (not silenced or inhibited), with a Viewer service account's token. */
export async function grafanaAlerts(url: string, token: string, fetch: typeof globalThis.fetch = globalThis.fetch): Promise<Alert[]> {
	const response = await fetch(`${url}/api/alertmanager/grafana/api/v2/alerts?active=true&silenced=false&inhibited=false`, {
		headers: { authorization: `Bearer ${token}`, accept: "application/json" },
	});
	if (!response.ok) throw new Error(`Grafana answered ${response.status}`);
	const alerts = (await response.json()) as GrafanaAlert[];
	return alerts
		.filter((a) => a.status.state === "active")
		.map((a) => {
			const name = a.labels.alertname ?? "alert";
			// Alerts of one rule on one host differ by what they watch, such as a disk's mount point.
			const where = [a.labels.instance ?? a.labels.job, a.labels.mountpoint].filter(Boolean).join(" ");
			const notes = a.annotations ?? {};
			return {
				key: `grafana:${a.fingerprint}`,
				source: "grafana" as const,
				title: `${name}${where ? ` on ${where}` : ""}${a.labels.severity ? ` (${a.labels.severity})` : ""}`,
				detail: [notes.summary, notes.description, `firing since ${a.startsAt}`].filter(Boolean).join("; "),
				labels: a.labels,
				...(a.generatorURL ? { url: a.generatorURL } : {}),
			};
		});
}

/** Which alerts Scout has seen open, and where it's talking about each. */
export class AlertLog {
	readonly #db: DatabaseSync;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.#db = new DatabaseSync(path, { timeout: 5000 });
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS alerts (
				key TEXT PRIMARY KEY,
				alert TEXT NOT NULL,
				opened_at INTEGER NOT NULL,
				channel TEXT,
				thread_ts TEXT,
				resolved_at INTEGER,
				returns INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS alert_watch (id INTEGER PRIMARY KEY CHECK (id = 1), started_at INTEGER NOT NULL);
		`);
		// Tables from before flapping alerts kept their thread.
		const columns = new Set(this.#db.prepare("PRAGMA table_info(alerts)").all().map((c) => (c as { name: string }).name));
		if (!columns.has("resolved_at")) this.#db.exec("ALTER TABLE alerts ADD COLUMN resolved_at INTEGER");
		if (!columns.has("returns")) this.#db.exec("ALTER TABLE alerts ADD COLUMN returns INTEGER NOT NULL DEFAULT 0");
	}

	/** Whether Scout has looked before; the first look only records what's firing. */
	get started(): boolean {
		return this.#db.prepare("SELECT 1 FROM alert_watch").get() !== undefined;
	}

	start(now = Date.now()): void {
		this.#db.prepare("INSERT OR IGNORE INTO alert_watch (id, started_at) VALUES (1, ?)").run(now);
	}

	/** Alerts firing as far as Scout knows. */
	open(): OpenAlert[] {
		return this.#db.prepare("SELECT * FROM alerts WHERE resolved_at IS NULL").all().map(toOpenAlert);
	}

	/** An alert that cleared since `since`: if it fires again, it's the same incident, in the same thread. */
	recentlyResolved(key: string, since: number): OpenAlert | undefined {
		const row = this.#db.prepare("SELECT * FROM alerts WHERE key = ? AND resolved_at >= ?").get(key, since);
		return row === undefined ? undefined : toOpenAlert(row);
	}

	reopened(key: string): void {
		this.#db.prepare("UPDATE alerts SET resolved_at = NULL, returns = returns + 1 WHERE key = ?").run(key);
	}

	opened(alert: Alert, where?: { channel: string; threadTs: string }, now = Date.now()): void {
		this.#db
			.prepare("INSERT OR REPLACE INTO alerts (key, alert, opened_at, channel, thread_ts) VALUES (?, ?, ?, ?, ?)")
			.run(alert.key, JSON.stringify(alert), now, where?.channel ?? null, where?.threadTs ?? null);
	}

	resolved(key: string, now = Date.now()): void {
		this.#db.prepare("UPDATE alerts SET resolved_at = ? WHERE key = ?").run(now, key);
	}

	/** Forget alerts that cleared before `before`. */
	prune(before: number): void {
		this.#db.prepare("DELETE FROM alerts WHERE resolved_at IS NOT NULL AND resolved_at < ?").run(before);
	}

	close(): void {
		this.#db.close();
	}
}

function toOpenAlert(row: unknown): OpenAlert {
	const r = row as { alert: string; opened_at: number; channel: string | null; thread_ts: string | null; returns: number };
	return {
		...(JSON.parse(r.alert) as Alert),
		openedAt: r.opened_at,
		returns: r.returns,
		...(r.channel ? { channel: r.channel } : {}),
		...(r.thread_ts ? { threadTs: r.thread_ts } : {}),
	};
}

export type AlertHandlers = {
	/**
	 * A new alert: say so where it belongs and, if `investigate`, look into it; where that conversation lives, if
	 * anywhere. Without `investigate`, the policy says it isn't worth an investigation unless someone asks.
	 */
	firing(alert: Alert, investigate: boolean): Promise<{ channel: string; threadTs: string } | undefined>;
	resolved(alert: OpenAlert): Promise<void>;
	/** It cleared and came back within the flap window: the same incident, in its thread, without a new investigation. */
	returned(alert: OpenAlert): Promise<void>;
	/** The first look: what was already firing when Scout started watching. */
	baseline(alerts: Alert[]): Promise<void>;
};

export type AlertSource = { source: Alert["source"]; read: () => Promise<Alert[]> };

export class AlertWatcher {
	readonly #log: AlertLog;
	readonly #sources: AlertSource[];
	readonly #handlers: AlertHandlers;
	readonly #policy: (source: Alert["source"]) => AlertPolicy;
	#polling = false;

	constructor(options: { log: AlertLog; sources: AlertSource[]; handlers: AlertHandlers; policy?: (source: Alert["source"]) => AlertPolicy }) {
		this.#log = options.log;
		this.#sources = options.sources;
		this.#handlers = options.handlers;
		this.#policy = options.policy ?? (() => DEFAULT_ALERT_POLICY);
	}

	async poll(now = Date.now()): Promise<void> {
		if (this.#polling) return;
		this.#polling = true;
		try {
			const firing = new Map<string, Alert>();
			// Ignored alerts are as good as not firing, but one that was open before it was ignored goes quietly.
			const ignored = new Set<string>();
			// A source that can't be read says nothing about its alerts: they stay open rather than resolve.
			const unread = new Set<Alert["source"]>();
			for (const { source, read } of this.#sources) {
				try {
					const { ignore } = this.#policy(source);
					for (const alert of await read()) {
						if (ignore.some((term) => alertMatches(alert, term))) ignored.add(alert.key);
						else firing.set(alert.key, alert);
					}
				} catch (error) {
					unread.add(source);
					console.error(`reading ${source} alerts failed:`, error instanceof Error ? error.message : error);
				}
			}
			if (!this.#log.started) {
				if (unread.size > 0) return;
				for (const alert of firing.values()) this.#log.opened(alert, undefined, now);
				this.#log.start(now);
				await this.#handlers.baseline([...firing.values()]);
				return;
			}
			this.#log.prune(now - Math.max(...ALERT_SOURCES.map((s) => this.#policy(s).returnsWithinMs)));
			const open = new Map(this.#log.open().map((alert) => [alert.key, alert]));
			for (const [key, alert] of firing) {
				if (open.has(key)) continue;
				const policy = this.#policy(alert.source);
				const back = this.#log.recentlyResolved(key, now - policy.returnsWithinMs);
				if (back !== undefined) {
					this.#log.reopened(key);
					await this.#handlers.returned({ ...back, returns: back.returns + 1 }).catch((error: unknown) => console.error(`${alert.title} came back, but saying so failed:`, error));
					continue;
				}
				const investigate = policy.investigate === undefined || policy.investigate.some((term) => alertMatches(alert, term));
				const where = await this.#handlers.firing(alert, investigate).catch((error: unknown) => {
					console.error(`raising ${alert.title} failed:`, error);
					return undefined;
				});
				this.#log.opened(alert, where, now);
			}
			for (const [key, alert] of open) {
				if (firing.has(key) || unread.has(alert.source)) continue;
				this.#log.resolved(key, now);
				if (ignored.has(key)) continue;
				await this.#handlers.resolved(alert).catch((error: unknown) => console.error(`resolving ${alert.title} failed:`, error));
			}
		} finally {
			this.#polling = false;
		}
	}
}
