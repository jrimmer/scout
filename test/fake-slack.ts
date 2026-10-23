import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import type { App, Receiver } from "@slack/bolt";

/**
 * Enough of Slack to run `src/slack.ts` for real: its Web API over HTTP (what `WebClient` calls, recorded, with answers
 * that can be changed per method), the `response_url` that `respond()` posts to, and a receiver that hands Bolt
 * Socket Mode envelopes (test/fixtures/slack) the way Socket Mode does. Bolt's own routing, middleware and client run
 * unchanged. IDs are made up: team T0ACME0001, Scout U0SCOUT001.
 */
export const TEAM = "T0ACME0001";
export const SCOUT = "U0SCOUT001";
export const ANN = "U0ANN00001";
export const BOB = "U0BOB00001";
export const TEAM_CHANNEL = "C0TEAM0001";
export const SECRET_CHANNEL = "C0SECRET01";
export const ELSEWHERE_CHANNEL = "C0ELSE0001";

/** `failed`: Slack was down for it (`down`), so it had no effect. */
export type Call = { method: string; args: Record<string, unknown>; token: string; failed?: true };
/** A message people wrote in a channel, which `conversations.history` and `conversations.replies` read back. */
export type Written = { channel: string; user: string; text: string; ts: string; thread_ts?: string };
/** An answer: Slack's JSON body (it always has `ok`), or a raw HTTP answer (a 429 with Retry-After, say). */
export type Answer = Record<string, unknown> | { status: number; headers?: Record<string, string>; body?: Record<string, unknown> };
type Channel = { id: string; name: string; is_channel: boolean; is_private: boolean; is_member: boolean; is_im?: boolean };

const SCOPES = ["chat:write", "channels:history", "channels:read", "reactions:read", "reactions:write", "users:read", "commands", "links:read", "links:write"];

/** Hands Bolt what Socket Mode would: an envelope's payload, and records what the listener acknowledged with. */
export class TestReceiver implements Receiver {
	#app: App | undefined;
	init(app: App): void {
		this.#app = app;
	}
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	/** Deliver one envelope; returns what `ack` was called with (`null` for a bare ack, `undefined` if never). */
	async deliver(envelope: { payload: Record<string, unknown> }): Promise<unknown> {
		let acked: unknown;
		await this.#app!.processEvent({
			body: envelope.payload,
			ack: async (response?: unknown) => {
				acked = response ?? null;
			},
		});
		return acked;
	}
}

export async function fakeSlack() {
	const calls: Call[] = [];
	/** What `respond()` sent to a `response_url`, by the URL's path. */
	const responded: { path: string; body: Record<string, unknown> }[] = [];
	/** Bodies uploaded to the URLs `files.getUploadURLExternal` handed out. */
	const uploads: string[] = [];
	/** The next answers for a method, used up in order before the defaults apply again. */
	const queued = new Map<string, Answer[]>();
	const overrides = new Map<string, (args: Record<string, unknown>) => Answer>();
	/** How long to hold the next call(s) to a method before answering, in order. */
	const stalls = new Map<string, number[]>();
	/** While each lasts, calls to its methods (every method, without any) fail. */
	const outages: { until: number; methods: string[] | undefined; status: number; hang: boolean }[] = [];
	/** What people wrote (`wrote`), for reading back; Scout's own posts aren't in it. */
	const history: Written[] = [];
	/** The app's scopes, as auth.test reports them; tests add to it before Scout starts (`canvases:write`, say). */
	const scopes = [...SCOPES];
	const channels = new Map<string, Channel>([
		[TEAM_CHANNEL, { id: TEAM_CHANNEL, name: "team", is_channel: true, is_private: false, is_member: true }],
		[SECRET_CHANNEL, { id: SECRET_CHANNEL, name: "secret", is_channel: true, is_private: true, is_member: true }],
		[ELSEWHERE_CHANNEL, { id: ELSEWHERE_CHANNEL, name: "elsewhere", is_channel: true, is_private: false, is_member: false }],
	]);
	const users = new Map([
		[ANN, { id: ANN, name: "ann", profile: { display_name: "Ann", real_name: "Ann Example", email: "ann@example.com" } }],
		[BOB, { id: BOB, name: "bob", profile: { display_name: "", real_name: "Bob Example", email: "bob@example.com" } }],
	]);
	let ts = 0;
	/** Requests being answered: closing under one would send WebClient into its half-hour of retries. */
	let inFlight = 0;

	const defaults = (method: string, args: Record<string, unknown>, base: string): Record<string, unknown> => {
		switch (method) {
			case "auth.test":
				return { ok: true, url: "https://acme.slack.com/", team: "Acme", user: "scout", team_id: TEAM, user_id: SCOUT, bot_id: "B0SCOUT001", is_enterprise_install: false };
			case "chat.postMessage":
				return { ok: true, channel: args.channel, ts: `1700000100.${String(++ts).padStart(6, "0")}`, message: { text: args.text } };
			case "chat.getPermalink":
				return { ok: true, channel: args.channel, permalink: `https://acme.slack.com/archives/${String(args.channel)}/p${String(args.message_ts).replace(".", "")}` };
			case "conversations.info": {
				const channel = channels.get(String(args.channel));
				return channel === undefined ? { ok: false, error: "channel_not_found" } : { ok: true, channel };
			}
			case "conversations.list":
				return { ok: true, channels: [...channels.values()].filter((c) => !c.is_private), response_metadata: { next_cursor: "" } };
			case "conversations.create":
				return { ok: true, channel: { id: "C0NEW00001", name: args.name, is_channel: true, is_private: false } };
			case "users.info": {
				const user = users.get(String(args.user));
				return user === undefined ? { ok: false, error: "user_not_found" } : { ok: true, user };
			}
			case "users.list":
				return { ok: true, members: [...users.values()], response_metadata: { next_cursor: "" } };
			case "files.getUploadURLExternal":
				return { ok: true, upload_url: `${base}upload/F0FILE0001`, file_id: "F0FILE0001" };
			case "files.completeUploadExternal":
				return { ok: true, files: [{ id: "F0FILE0001" }] };
			case "conversations.canvases.create":
				return { ok: true, canvas_id: "F0CANVAS01" };
			case "users.conversations":
				return { ok: true, channels: [...channels.values()].filter((c) => c.is_channel && !c.is_private && c.is_member), response_metadata: { next_cursor: "" } };
			case "conversations.history": {
				// Top-level messages only, newest first, as Slack answers.
				const top = history.filter((m) => m.channel === args.channel && (m.thread_ts === undefined || m.thread_ts === m.ts));
				return { ok: true, messages: within(top, args).sort((a, b) => Number(b.ts) - Number(a.ts)).slice(0, Number(args.limit ?? 100)).map(slackMessage), has_more: false };
			}
			case "conversations.replies": {
				// The thread's first message, then its replies, oldest first.
				const thread = history.filter((m) => m.channel === args.channel && (m.ts === args.ts || m.thread_ts === args.ts));
				return { ok: true, messages: within(thread, args).sort((a, b) => Number(a.ts) - Number(b.ts)).slice(0, Number(args.limit ?? 100)).map(slackMessage), has_more: false };
			}
			default:
				return { ok: true };
		}
	};

	const server = createServer(async (req, res) => {
		inFlight++;
		res.on("close", () => inFlight--);
		const url = new URL(req.url ?? "/", "http://slack");
		const raw = await read(req);
		const base = `http://127.0.0.1:${port}/`;
		if (url.pathname.startsWith("/hooks/")) {
			responded.push({ path: url.pathname, body: JSON.parse(raw) as Record<string, unknown> });
			res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
			return;
		}
		if (url.pathname.startsWith("/upload/")) {
			uploads.push(raw);
			res.writeHead(200).end("OK");
			return;
		}
		if (url.pathname.startsWith("/files/")) {
			// A private file: only with the bot's token, as Slack serves url_private.
			if (req.headers.authorization !== "Bearer xoxb-test") res.writeHead(403).end();
			else res.writeHead(200).end("file contents");
			return;
		}
		if (!url.pathname.startsWith("/api/")) {
			res.writeHead(404).end();
			return;
		}
		const method = url.pathname.replace(/^\/api\//, "");
		const args = parseArgs(raw, String(req.headers["content-type"] ?? ""));
		const call: Call = { method, args, token: String(req.headers.authorization ?? "").replace(/^Bearer /, "") };
		calls.push(call);
		const stall = stalls.get(method)?.shift();
		if (stall !== undefined) await new Promise((resolve) => setTimeout(resolve, stall));
		if (res.destroyed) return;
		const outage = outages.find((o) => Date.now() < o.until && (o.methods === undefined || o.methods.includes(method)));
		if (outage !== undefined) call.failed = true;
		if (outage?.hang === true) {
			// No answer at all until it's over, then the connection drops: what a client sees as a timeout.
			await new Promise((resolve) => setTimeout(resolve, Math.max(0, outage.until - Date.now())));
			res.destroy();
			return;
		}
		if (outage !== undefined) {
			res.writeHead(outage.status, { "content-type": "text/html" }).end("<html>Slack is having trouble</html>");
			return;
		}
		const answer = queued.get(method)?.shift() ?? overrides.get(method)?.(args) ?? defaults(method, args, base);
		if (!("ok" in answer)) {
			const a = answer as { status: number; headers?: Record<string, string>; body?: Record<string, unknown> };
			res.writeHead(a.status, { "content-type": "application/json", ...a.headers }).end(JSON.stringify(a.body ?? { ok: false }));
			return;
		}
		res.writeHead(200, { "content-type": "application/json", ...(method === "auth.test" ? { "x-oauth-scopes": scopes.join(",") } : {}) }).end(JSON.stringify(answer));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	const apiUrl = `http://127.0.0.1:${port}/api/`;

	return {
		apiUrl,
		/** Where `url_private` files are served from, with the bot's token. */
		filesUrl: `http://127.0.0.1:${port}/files/`,
		receiver: new TestReceiver(),
		calls,
		responded,
		uploads,
		channels,
		users,
		scopes,
		history,
		/** Someone wrote this in a channel (a reply, with `thread_ts`); Scout learns of it only by reading history. */
		wrote: (message: Written) => void history.push(message),
		/** Calls to one method, in order. */
		called: (method: string) => calls.filter((c) => c.method === method),
		/** Answer the next call(s) to `method` with these, then go back to the default. */
		queue: (method: string, ...answers: Answer[]) => queued.set(method, [...(queued.get(method) ?? []), ...answers]),
		/** Hold the next call(s) to `method` this long (ms) before answering: a slow Slack. */
		stall: (method: string, ...ms: number[]) => stalls.set(method, [...(stalls.get(method) ?? []), ...ms]),
		/** Answer every call to `method` this way from now on. */
		answer: (method: string, answer: (args: Record<string, unknown>) => Answer) => overrides.set(method, answer),
		/**
		 * Slack is down for `ms`: calls to `methods` (every one, by default) answer `status` (503), or with `hang`, get no
		 * answer until it's over and then lose their connection. Calls are still recorded.
		 */
		down: (ms: number, options: { methods?: string[]; status?: number; hang?: boolean } = {}) =>
			void outages.push({ until: Date.now() + ms, methods: options.methods, status: options.status ?? 503, hang: options.hang ?? false }),
		/** Slack is back for calls from now on (ones already hanging still wait out their outage). */
		up: () => {
			for (const o of outages) o.until = 0;
		},
		/** A Socket Mode envelope from test/fixtures/slack, its response_url pointing here; a fresh copy each time. */
		envelope: (name: string): { type: string; payload: Record<string, unknown> } =>
			JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "slack", `${name}.json`), "utf8").replaceAll("https://hooks.slack.com/", `http://127.0.0.1:${port}/hooks/`)),
		/**
		 * Close once every Slack client made has been answered: Bolt calls auth.test as soon as an app is made, so
		 * `apps` is how many were made.
		 */
		close: async (apps = 1) => {
			const deadline = Date.now() + 5000;
			while ((calls.filter((c) => c.method === "auth.test").length < apps || inFlight > 0) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
			// A call Scout makes just after (a run's ending reaction, after its answer) is still answered: refused, Slack's
			// client would try it again for five minutes and hold the test's process open. Unref'd, the server doesn't.
			server.unref();
			server.closeIdleConnections();
		},
	};
}

export type FakeSlack = Awaited<ReturnType<typeof fakeSlack>>;

/** Messages after `oldest` (exclusive) and up to `latest` (inclusive with `inclusive`), as Slack filters them. */
function within(messages: Written[], args: Record<string, unknown>): Written[] {
	const oldest = args.oldest === undefined ? -Infinity : Number(args.oldest);
	const latest = args.latest === undefined ? Infinity : Number(args.latest);
	return messages.filter((m) => Number(m.ts) > oldest && (Number(m.ts) < latest || (args.inclusive === true && Number(m.ts) === latest)));
}

function slackMessage(m: Written): Record<string, unknown> {
	return { type: "message", user: m.user, text: m.text, ts: m.ts, ...(m.thread_ts === undefined ? {} : { thread_ts: m.thread_ts }) };
}

/**
 * WebClient sends form fields, with objects and arrays as JSON strings and booleans as `true`/`false`; this undoes
 * both. Numbers stay strings, as Slack receives them.
 */
function parseArgs(raw: string, contentType: string): Record<string, unknown> {
	if (raw === "") return {};
	if (contentType.includes("application/json")) return JSON.parse(raw) as Record<string, unknown>;
	const args: Record<string, unknown> = {};
	for (const [key, value] of new URLSearchParams(raw)) {
		args[key] = /^[[{]/.test(value) ? safeJson(value) : value === "true" ? true : value === "false" ? false : value;
	}
	return args;
}

function safeJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function read(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString()));
		req.on("error", reject);
	});
}
