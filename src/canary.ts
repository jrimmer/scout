import { randomBytes } from "node:crypto";
import type { Forge } from "./forge.ts";

/**
 * The canary: once a night, someone asks Scout for a small change in a channel kept for it, the way a person would,
 * and checks that a pull request comes of it. It runs outside Scout, as a person in Slack, so it notices whatever stops
 * Scout from working (Slack, the model, sandboxes, the code host, or Scout itself not running), which Scout can't
 * report about itself. It cleans up after itself: the pull request is closed and its branch deleted.
 */

/** The Slack Web API, as the canary's own user. */
export type SlackCall = (method: string, args: Record<string, string>) => Promise<Record<string, unknown>>;

export type CanaryOptions = {
	slack: SlackCall;
	forge: Forge;
	/** The channel's id, and Scout's user id (to mention it). */
	channel: string;
	scout: string;
	/** The repository the channel works in, `owner/name`. */
	slug: string;
	/** How long Scout has to answer at all, and to open the pull request. */
	replyWithinMs: number;
	pullWithinMs: number;
	pollMs?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	log?: (line: string) => void;
};

export type CanaryResult = {
	ok: boolean;
	/** What went wrong, for a person to read. */
	problem?: string;
	repliedMs?: number;
	pullMs?: number;
	pull?: string;
	thread?: string;
};

/** The file the canary's change goes in. */
export const CANARY_FILE = "CANARY.md";

type Message = { ts?: string; user?: string; bot_id?: string; text?: string };

export async function runCanary(options: CanaryOptions): Promise<CanaryResult> {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const log = options.log ?? (() => {});
	const pollMs = options.pollMs ?? 15_000;
	const nonce = `canary-${new Date(now()).toISOString().slice(0, 10)}-${randomBytes(3).toString("hex")}`;
	const text =
		`<@${options.scout}> nightly check (${nonce}): add a line saying \`${nonce}\` at the end of ${CANARY_FILE} ` +
		`(create the file if it isn't there), and open a pull request. Nothing else needs changing.`;

	const posted = await options.slack("chat.postMessage", { channel: options.channel, text, unfurl_links: "false" });
	if (posted.ok !== true || typeof posted.ts !== "string") return { ok: false, problem: `couldn't post the request in Slack (${String(posted.error ?? "no reason")})` };
	const thread = posted.ts;
	const started = now();
	log(`asked Scout in ${options.channel} (${thread})`);

	let repliedMs: number | undefined;
	const pullPattern = new RegExp(`${escape(options.slug)}/pulls?/(\\d+)`);
	for (;;) {
		const elapsed = now() - started;
		if (repliedMs === undefined && elapsed > options.replyWithinMs) return { ok: false, thread, problem: `Scout didn't answer within ${minutes(options.replyWithinMs)}` };
		if (elapsed > options.pullWithinMs) return { ok: false, thread, ...(repliedMs === undefined ? {} : { repliedMs }), problem: `no pull request within ${minutes(options.pullWithinMs)}` };
		await sleep(pollMs);
		const replies = await options.slack("conversations.replies", { channel: options.channel, ts: thread, limit: "100" });
		if (replies.ok !== true) {
			log(`couldn't read the thread (${String(replies.error)}); trying again`);
			continue;
		}
		const scouts = ((replies.messages as Message[] | undefined) ?? []).filter((m) => m.ts !== thread && m.user === options.scout);
		if (scouts.length > 0 && repliedMs === undefined) {
			repliedMs = now() - started;
			log(`Scout answered after ${seconds(repliedMs)}`);
		}
		const number = scouts.map((m) => pullPattern.exec(m.text ?? "")?.[1]).find((n) => n !== undefined);
		if (number === undefined) continue;

		const pullMs = now() - started;
		const pull = Number(number);
		log(`pull request #${pull} after ${seconds(pullMs)}`);
		const files = await options.forge.pullFiles(options.slug, pull);
		const branch = await options.forge.headBranch(options.slug, pull);
		await options.forge.closePull(options.slug, pull);
		if (branch !== undefined) await options.forge.deleteBranch(options.slug, branch).catch(() => {});
		const result = { thread, repliedMs: repliedMs ?? pullMs, pullMs, pull: `${options.slug}#${pull}` };
		if (!files.includes(CANARY_FILE)) return { ...result, ok: false, problem: `the pull request doesn't change ${CANARY_FILE} (it changes ${files.join(", ") || "nothing"})` };
		return { ...result, ok: true };
	}
}

/** One line for a person: what happened, and how long it took. */
export function describeCanary(result: CanaryResult): string {
	const times = [
		result.repliedMs === undefined ? undefined : `answered in ${seconds(result.repliedMs)}`,
		result.pullMs === undefined ? undefined : `pull request in ${seconds(result.pullMs)}`,
	].filter(Boolean);
	const what = result.ok ? `Scout is working: ${result.pull}` : `Scout's nightly check failed: ${result.problem}`;
	return `${what}${times.length > 0 ? ` (${times.join(", ")})` : ""}`;
}

/** The Slack Web API over fetch, with a user token. */
export function slackApi(token: string, doFetch: typeof fetch = fetch): SlackCall {
	return async (method, args) => {
		const response = await doFetch(`https://slack.com/api/${method}`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(args),
		});
		if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
		return (await response.json()) as Record<string, unknown>;
	};
}

function escape(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function seconds(ms: number): string {
	const s = Math.round(ms / 1000);
	return s < 120 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}`;
}

function minutes(ms: number): string {
	return `${Math.round(ms / 60_000)} minutes`;
}
