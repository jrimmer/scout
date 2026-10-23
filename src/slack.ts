import { App, LogLevel, type Receiver, webApi } from "@slack/bolt";
import type { IncomingMessage, SharedFile } from "./bridge.ts";
import type { ChatMessage, ChatSurface } from "./render.ts";

/** Message subtypes that are still people talking; every other subtype (edits, joins, bots) is ignored. */
const SPOKEN_SUBTYPES = new Set([undefined, "thread_broadcast", "file_share"]);

const CREATE_CHANNEL_ACTION = "scout_create_channel";
/** The "Ask Scout about this" message shortcut (slack-manifest.yaml), and the form it opens. */
const ASK_SHORTCUT = "scout_ask";
const ASK_FORM = "scout_ask_form";
/** Buttons on the message that asks for approval of a change. */
export const APPROVE_BUTTON = "scout_approve";
export const DECLINE_BUTTON = "scout_decline";
/** Buttons on a request to let a repository's sandboxes reach a host. */
export const EGRESS_ALLOW = "scout_egress_allow";
export const EGRESS_DECLINE = "scout_egress_decline";
/** The Ask Scout step in Workflow Builder (slack-manifest.yaml `functions`). */
const WORKFLOW_STEP = "ask_scout";
const NOT_HERE = "I only work in public channels I'm in. Invite me here, or ask me in a channel I'm in.";
const WORKABLE_MS = 10 * 60_000;
/** 🔍 on any message: "Scout, look into this". */
const LOOK_REACTIONS = new Set(["mag", "mag_right"]);

export type SlackHandlers = {
	onMessage: (message: IncomingMessage) => Promise<void>;
	onReaction: (reaction: { channel: string; ts: string; name: string; user: string; eventTs: string }) => Promise<void>;
	/** Someone edited a message (its new text) or deleted one. */
	onEdit?: (edit: { channel: string; ts: string; threadTs?: string; user: string; text: string }) => Promise<void>;
	onDelete?: (deleted: { channel: string; ts: string }) => void;
	/** Someone used "Ask Scout about this" on a message: what they asked, and the message it's about. */
	onAsk?: (ask: { user: string; channel: string; channelName: string; ts: string; threadTs?: string; author?: string; text: string; request: string }) => Promise<void>;
	/** 🔍 on a message: look into it, as if they'd used Ask Scout about this with "look into this". */
	onLook?: (look: { user: string; channel: string; channelName: string; ts: string; threadTs?: string; author?: string; text: string }) => Promise<void>;
	/**
	 * Someone pressed Approve or Decline on a change waiting for approval; returns what the message should now say, or,
	 * with `final: false`, what to tell just whoever pressed while the buttons stay.
	 */
	onDecision?: (decision: { user: string; channel: string; conversationId: number; approve: boolean }) => Promise<string | { text: string; final: boolean }>;
	/** Someone pressed "Use" on one of a thread's approaches (approaches.ts): the comparison to show now, or a note why not. */
	onUseApproach?: (use: { user: string; channel: string; parentId: number; index: number }) => Promise<ChatMessage | string>;
	/**
	 * Someone pressed Allow or Decline on a network request: what to say. `final` replaces the message (it's decided);
	 * otherwise only they see the answer and the buttons stay for someone who may decide.
	 */
	onEgress?: (decision: { user: string; id: number; allow: boolean }) => Promise<{ text: string; final: boolean }>;
	/** `/scout …`: what to answer, just to them; `ask` starts a thread. */
	onCommand?: (command: { user: string; channel: string; channelName: string; text: string }) => Promise<string>;
	/** Links to the code host pasted in a channel: previews (Block Kit blocks) for the ones Scout knows. */
	onLinks?: (links: string[]) => Promise<Record<string, { blocks: unknown[] }>>;
	/** The Ask Scout step ran in a workflow: start a thread; returns its link. */
	onWorkflowAsk?: (ask: { channel: string; user: string; request: string; about?: string }) => Promise<string | undefined>;
	/** Someone opened Scout's App Home tab: the view to show them. */
	home?: (user: string) => Promise<{ type: "home"; blocks: unknown[] }>;
};

/**
 * Slack over Socket Mode: no public URL, no tunnel. Everything Slack-specific lives here; the bridge sees decoded
 * messages and a `ChatSurface`.
 */
export class Slack {
	readonly app: App;
	readonly surface: ChatSurface;
	botUserId = "";
	readonly #names = new Map<string, string>();
	readonly #channels = new Map<string, string>();
	/** Channels Scout found it can work in (public, and it's in them), and when: so the Ask Scout form needn't ask Slack. */
	readonly #workable = new Map<string, number>();
	/** For answers Slack wants within three seconds: two seconds, and no trying again. */
	readonly #quick: webApi.WebClient;
	readonly #botToken: string;
	/** In tests, the fake Slack's address, which serves files too. */
	readonly #filesOrigin: string | undefined;

	/** `receiver` and `apiUrl` are for tests: Slack's events from somewhere other than Socket Mode, its Web API elsewhere. */
	constructor(tokens: { botToken: string; appToken: string }, test: { receiver?: Receiver; apiUrl?: string } = {}) {
		this.#botToken = tokens.botToken;
		this.#filesOrigin = test.apiUrl === undefined ? undefined : new URL(test.apiUrl).origin;
		const api = test.apiUrl === undefined ? {} : { slackApiUrl: test.apiUrl };
		this.app = new App({
			token: tokens.botToken,
			logLevel: LogLevel.WARN,
			...(test.receiver === undefined ? { appToken: tokens.appToken, socketMode: true } : { receiver: test.receiver }),
			// Five minutes of trying again, not the default half hour: a thread shouldn't sit silent that long. A final
			// answer Slack still won't take is tried again by render.ts.
			clientOptions: { ...api, retryConfig: webApi.retryPolicies.fiveRetriesInFiveMinutes },
		});
		this.#quick = new webApi.WebClient(tokens.botToken, { ...api, logLevel: LogLevel.ERROR, timeout: 2_000, retryConfig: { retries: 0 } });
		const client = this.app.client;
		this.surface = {
			post: async (channel, threadTs, original) => {
				const message = await this.#withMentions(original);
				const posted = await client.chat.postMessage({
					channel,
					...(threadTs === undefined ? {} : { thread_ts: threadTs }),
					text: message.text,
					blocks: message.blocks as never,
					unfurl_links: false,
				});
				return posted.ts ?? "";
			},
			update: async (channel, ts, original) => {
				const message = await this.#withMentions(original);
				await client.chat.update({ channel, ts, text: message.text, blocks: message.blocks as never });
			},
			react: async (channel, ts, name, on) => {
				const call = on ? client.reactions.add({ channel, timestamp: ts, name }) : client.reactions.remove({ channel, timestamp: ts, name });
				await call.catch((error: { data?: { error?: string } }) => {
					// Already there, or already gone: the same outcome.
					if (!["already_reacted", "no_reaction"].includes(error.data?.error ?? "")) throw error;
				});
			},
			// Needs the files:write scope; without it this fails, and the answer follows in messages instead.
			attach: async (channel, threadTs, file) => {
				await client.filesUploadV2({ channel_id: channel, thread_ts: threadTs, filename: file.name, title: file.title, content: file.content });
			},
		};
	}

	/** `@jason` in what Scout writes (or its profile tells it to write) becomes a real mention of that person. */
	async #withMentions(message: ChatMessage): Promise<ChatMessage> {
		if (!/@\w/.test(message.text) && !JSON.stringify(message.blocks).includes("@")) return message;
		const handles = await this.#handles();
		const blocks = message.blocks.map((block) => {
			const b = block as { type?: string; text?: unknown };
			return b.type === "markdown" && typeof b.text === "string" ? { ...b, text: mentionNames(b.text, handles) } : block;
		});
		return { text: mentionNames(message.text, handles), blocks };
	}

	#handleCache: { at: number; handles: Map<string, string> } | undefined;

	/** Everyone's Slack handle and display name, lowercased, to their user ID; refreshed hourly. Ambiguous ones are left out. */
	async #handles(): Promise<Map<string, string>> {
		if (this.#handleCache !== undefined && Date.now() - this.#handleCache.at < 60 * 60 * 1000) return this.#handleCache.handles;
		const seen = new Map<string, string | null>();
		const add = (name: string | undefined, id: string) => {
			const key = name?.trim().toLowerCase().replace(/\s+/g, "");
			if (!key) return;
			seen.set(key, seen.has(key) && seen.get(key) !== id ? null : id);
		};
		try {
			let cursor: string | undefined;
			do {
				const page = await this.app.client.users.list({ limit: 200, ...(cursor ? { cursor } : {}) });
				for (const user of page.members ?? []) {
					if (!user.id || user.deleted || user.is_bot) continue;
					add(user.name, user.id);
					add(user.profile?.display_name, user.id);
				}
				cursor = page.response_metadata?.next_cursor || undefined;
			} while (cursor !== undefined);
		} catch (error) {
			console.error("listing Slack users for mentions failed:", error instanceof Error ? error.message : error);
			return this.#handleCache?.handles ?? new Map();
		}
		const handles = new Map([...seen].flatMap(([name, id]) => (id === null ? [] : [[name, id] as const])));
		this.#handleCache = { at: Date.now(), handles };
		return handles;
	}

	/**
	 * What people said while Scout wasn't listening (a restart, a dropped connection), oldest first: top-level messages
	 * in the public channels it's in, and replies in `threads`, after `since` (ms). Socket Mode doesn't replay them.
	 */
	async missed(since: number, threads: readonly { channel: string; threadTs: string }[]): Promise<IncomingMessage[]> {
		const oldest = (since / 1000).toFixed(6);
		const client = this.app.client;
		const found = new Map<string, IncomingMessage>();
		const take = async (channel: string, m: Record<string, unknown>) => {
			if (!SPOKEN_SUBTYPES.has(m.subtype as string | undefined) || m.bot_id !== undefined) return;
			if (typeof m.user !== "string" || typeof m.ts !== "string" || Number(m.ts) <= Number(oldest)) return;
			found.set(`${channel}:${m.ts}`, {
				channel,
				channelType: "channel",
				channelName: await this.channelName(channel),
				user: m.user,
				text: typeof m.text === "string" ? m.text : "",
				ts: m.ts,
				...(typeof m.thread_ts === "string" && m.thread_ts !== m.ts ? { threadTs: m.thread_ts } : {}),
				...(Array.isArray(m.files) ? { files: sharedFiles(m.files) } : {}),
			});
		};
		const mine = await client.users.conversations({ types: "public_channel", limit: 200, exclude_archived: true });
		for (const channel of mine.channels ?? []) {
			if (channel.id === undefined) continue;
			const history = await client.conversations.history({ channel: channel.id, oldest, limit: 200 });
			for (const m of history.messages ?? []) await take(channel.id, m as Record<string, unknown>);
		}
		for (const t of threads) {
			const replies = await client.conversations.replies({ channel: t.channel, ts: t.threadTs, oldest, limit: 200 }).catch(() => undefined);
			for (const m of replies?.messages ?? []) await take(t.channel, m as Record<string, unknown>);
		}
		return [...found.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
	}

	/** An edited or deleted message, from a person (not a bot, and not just Slack adding a link preview). */
	async #changed(e: Record<string, unknown>, handlers: SlackHandlers): Promise<void> {
		const channel = typeof e.channel === "string" ? e.channel : undefined;
		if (channel === undefined) return;
		if (e.subtype === "message_deleted") {
			if (typeof e.deleted_ts === "string") handlers.onDelete?.({ channel, ts: e.deleted_ts });
			return;
		}
		const now = e.message as Record<string, unknown> | undefined;
		const before = e.previous_message as Record<string, unknown> | undefined;
		if (now === undefined || now.bot_id !== undefined || typeof now.user !== "string" || typeof now.ts !== "string" || typeof now.text !== "string") return;
		if (before?.text === now.text) return;
		await handlers.onEdit?.({ channel, ts: now.ts, user: now.user, text: now.text, ...(typeof now.thread_ts === "string" ? { threadTs: now.thread_ts } : {}) });
	}

	/** The scopes the app was granted, and the workspace's address and ID, from Slack's answer to `identify`. */
	scopes: string[] = [];
	teamUrl = "";
	teamId = "";

	/** Scout's own Slack user ID, which mentions of it carry; also learns the app's scopes. */
	async identify(): Promise<string> {
		const auth = await this.app.client.auth.test();
		this.botUserId = auth.user_id ?? "";
		this.scopes = auth.response_metadata?.scopes ?? [];
		this.teamUrl = auth.url ?? "";
		this.teamId = auth.team_id ?? "";
		return this.botUserId;
	}

	/** A message's author, text and thread, to act on it (🔍). */
	async messageAt(channel: string, ts: string): Promise<{ author?: string; text: string; threadTs?: string } | undefined> {
		const page = await this.app.client.conversations.history({ channel, latest: ts, inclusive: true, limit: 1 }).catch(() => undefined);
		let m = page?.messages?.[0] as Record<string, unknown> | undefined;
		if (m === undefined || m.ts !== ts) {
			// A reply: history only has top-level messages.
			const replies = await this.app.client.conversations.replies({ channel, ts, latest: ts, inclusive: true, limit: 1 }).catch(() => undefined);
			m = (replies?.messages ?? []).find((r) => (r as { ts?: string }).ts === ts) as Record<string, unknown> | undefined;
		}
		if (m === undefined) return undefined;
		return {
			...(typeof m.user === "string" ? { author: m.user } : {}),
			text: typeof m.text === "string" ? m.text : "",
			...(typeof m.thread_ts === "string" && m.thread_ts !== ts ? { threadTs: m.thread_ts } : {}),
		};
	}

	/** Make or refresh a channel's canvas with Markdown; returns its ID. */
	async channelCanvas(channel: string, canvasId: string | undefined, markdown: string): Promise<string> {
		const content = { type: "markdown" as const, markdown };
		if (canvasId !== undefined) {
			await this.app.client.canvases.edit({ canvas_id: canvasId, changes: [{ operation: "replace", document_content: content }] });
			return canvasId;
		}
		const made = await this.app.client.conversations.canvases.create({ channel_id: channel, document_content: content });
		return made.canvas_id ?? "";
	}

	/** The Slack List API, as the list of Scout's work uses it. */
	get lists() {
		return this.app.client.slackLists;
	}

	async start(handlers: SlackHandlers): Promise<void> {

		this.app.event("message", async ({ event }) => {
			const e = event as unknown as Record<string, unknown>;
			if (e.subtype === "message_changed" || e.subtype === "message_deleted") {
				await this.#changed(e, handlers).catch((error: unknown) => console.error(`edit in ${String(e.channel)} failed:`, error));
				return;
			}
			if (!SPOKEN_SUBTYPES.has(e.subtype as string | undefined) || e.bot_id !== undefined) return;
			if (typeof e.user !== "string" || typeof e.channel !== "string" || typeof e.ts !== "string") return;
			const channelType = e.channel_type as IncomingMessage["channelType"];
			try {
				await handlers.onMessage({
					channel: e.channel,
					channelType,
					channelName: channelType === "channel" ? await this.channelName(e.channel) : "",
					user: e.user,
					text: typeof e.text === "string" ? e.text : "",
					ts: e.ts,
					...(typeof e.thread_ts === "string" ? { threadTs: e.thread_ts } : {}),
					...(Array.isArray(e.files) ? { files: sharedFiles(e.files) } : {}),
				});
			} catch (error) {
				console.error(`message ${e.channel}/${e.ts} failed:`, error);
			}
		});

		// "Ask Scout about this", from any message's menu: a short form, then a thread on that message.
		this.app.shortcut(ASK_SHORTCUT, async ({ shortcut, ack, client }) => {
			await ack();
			const s = shortcut as unknown as { trigger_id: string; channel: { id: string }; message: { ts: string; thread_ts?: string; user?: string; text?: string } };
			const text = (s.message.text ?? "").slice(0, 2_000);
			await client.views.open({
				trigger_id: s.trigger_id,
				view: {
					type: "modal",
					callback_id: ASK_FORM,
					private_metadata: JSON.stringify({ channel: s.channel.id, ts: s.message.ts, threadTs: s.message.thread_ts, author: s.message.user, text }),
					title: { type: "plain_text", text: "Ask Scout" },
					submit: { type: "plain_text", text: "Ask" },
					close: { type: "plain_text", text: "Cancel" },
					blocks: [
						{ type: "section", text: { type: "mrkdwn", text: text === "" ? "_(a message with no text)_" : text.split("\n").map((l) => `> ${l}`).join("\n").slice(0, 2_900) } },
						{
							type: "input",
							block_id: "request",
							label: { type: "plain_text", text: "What would you like me to do?" },
							element: { type: "plain_text_input", action_id: "text", multiline: true, placeholder: { type: "plain_text", text: "Look into this, explain it, fix it…" } },
						},
					],
				},
			});
		});

		this.app.view(ASK_FORM, async ({ ack, view, body }) => {
			const meta = JSON.parse(view.private_metadata) as { channel: string; ts: string; threadTs?: string; author?: string; text: string };
			const request = view.state.values.request?.text?.value?.trim() ?? "";
			const user = body.user.id;
			// Scout works only in public channels it's in; say so in the form rather than failing afterwards. Slack closes
			// the form with an error after three seconds, so when it's slow to say, take the form and check afterwards.
			let workable = await this.#canWork(meta.channel, true);
			if (workable === false) {
				await ack({ response_action: "errors", errors: { request: NOT_HERE } });
				return;
			}
			await ack();
			try {
				workable ??= await this.#canWork(meta.channel);
				if (workable === false) {
					await this.app.client.chat.postMessage({ channel: user, text: `About your Ask Scout request in <#${meta.channel}>: ${NOT_HERE}` });
					return;
				}
				await handlers.onAsk?.({ user, channel: meta.channel, channelName: await this.channelName(meta.channel), ts: meta.ts, ...(meta.threadTs === undefined ? {} : { threadTs: meta.threadTs }), ...(meta.author === undefined ? {} : { author: meta.author }), text: meta.text, request });
			} catch (error) {
				console.error(`asking about ${meta.channel}/${meta.ts} failed:`, error);
			}
		});

		// "Use" on one of a thread's approaches: the comparison then says who chose which, without buttons.
		this.app.action(/^scout_use_approach_\d+$/, async ({ ack, body, respond }) => {
			await ack();
			const b = body as unknown as { user: { id: string }; channel?: { id: string }; actions: { value?: string }[] };
			const [parent, index] = (b.actions[0]?.value ?? "").split(":").map(Number);
			if (handlers.onUseApproach === undefined || b.channel === undefined || !Number.isFinite(parent) || !Number.isFinite(index)) return;
			try {
				const result = await handlers.onUseApproach({ user: b.user.id, channel: b.channel.id, parentId: parent!, index: index! });
				if (typeof result === "string") await respond({ response_type: "ephemeral", replace_original: false, text: result });
				else await respond({ replace_original: true, text: result.text, blocks: result.blocks as never });
			} catch (error) {
				console.error("choosing an approach failed:", error);
			}
		});

		// Approve or Decline on a change waiting for approval: the message then says who decided, without buttons.
		for (const [action, approve] of [[APPROVE_BUTTON, true], [DECLINE_BUTTON, false]] as const) {
			this.app.action(action, async ({ ack, body, respond }) => {
				await ack();
				const b = body as unknown as { user: { id: string }; channel?: { id: string }; actions: { value?: string }[] };
				const conversationId = Number(b.actions[0]?.value);
				if (handlers.onDecision === undefined || b.channel === undefined || !Number.isFinite(conversationId)) return;
				try {
					const decided = await handlers.onDecision({ user: b.user.id, channel: b.channel.id, conversationId, approve });
					// A press that doesn't count is answered just to whoever pressed, and the buttons stay.
					const said = typeof decided === "string" ? { text: decided, final: true } : decided;
					if (said.final) await respond({ replace_original: true, text: said.text, blocks: [{ type: "context", elements: [{ type: "mrkdwn", text: said.text }] }] });
					else await respond({ replace_original: false, response_type: "ephemeral", text: said.text });
				} catch (error) {
					console.error(`${action} failed:`, error);
				}
			});
		}

		for (const [action, allow] of [[EGRESS_ALLOW, true], [EGRESS_DECLINE, false]] as const) {
			this.app.action(action, async ({ ack, body, respond }) => {
				await ack();
				const b = body as unknown as { user: { id: string }; actions: { value?: string }[] };
				const id = Number(b.actions[0]?.value);
				if (handlers.onEgress === undefined || !Number.isFinite(id)) return;
				try {
					const said = await handlers.onEgress({ user: b.user.id, id, allow });
					if (said.final) await respond({ replace_original: true, text: said.text, blocks: [{ type: "section", text: { type: "mrkdwn", text: said.text } }] });
					else await respond({ replace_original: false, response_type: "ephemeral", text: said.text });
				} catch (error) {
					console.error(`${action} failed:`, error);
				}
			});
		}

		// /scout status | schedules | waiting | ask …: answered just to whoever asked (needs the commands scope).
		this.app.command("/scout", async ({ command, ack, respond }) => {
			await ack();
			if (handlers.onCommand === undefined) return;
			try {
				const name = await this.channelName(command.channel_id).catch(() => "");
				const text = await handlers.onCommand({ user: command.user_id, channel: command.channel_id, channelName: name, text: command.text });
				await respond({ response_type: "ephemeral", text });
			} catch (error) {
				console.error("/scout failed:", error);
				await respond({ response_type: "ephemeral", text: "Something went wrong on my side. Try again in a minute?" });
			}
		});

		// Previews of code host links (needs links:read and links:write, and the domain in the manifest's unfurl_domains).
		this.app.event("link_shared", async ({ event }) => {
			if (handlers.onLinks === undefined) return;
			try {
				const unfurls = await handlers.onLinks(event.links.map((l) => l.url));
				if (Object.keys(unfurls).length === 0) return;
				await this.app.client.chat.unfurl({ channel: event.channel, ts: event.message_ts, unfurls: unfurls as never });
			} catch (error) {
				console.error("link preview failed:", error);
			}
		});

		// The Ask Scout step in Workflow Builder (a custom step; needs a plan that allows them).
		this.app.function(WORKFLOW_STEP, async ({ inputs, complete, fail }) => {
			try {
				const channel = String(inputs.channel_id ?? "");
				const request = String(inputs.request ?? "").trim();
				const user = typeof inputs.user_id === "string" ? inputs.user_id : "";
				// A request is always someone's, checked like any other: never Scout's own, which would skip that check.
				if (channel === "" || request === "" || user === "" || handlers.onWorkflowAsk === undefined) {
					await fail({ error: "Ask Scout needs a channel, a request, and who's asking (usually “Person who used this workflow”)." });
					return;
				}
				const link = await handlers.onWorkflowAsk({ channel, user, request, ...(typeof inputs.about === "string" && inputs.about !== "" ? { about: inputs.about } : {}) });
				await complete({ outputs: { thread_link: link ?? "" } });
			} catch (error) {
				await fail({ error: error instanceof Error ? error.message : String(error) });
			}
		});

		// Needs the Home tab enabled and the app_home_opened event (slack-manifest.yaml).
		this.app.event("app_home_opened", async ({ event }) => {
			if (event.tab !== "home" || handlers.home === undefined) return;
			try {
				await this.app.client.views.publish({ user_id: event.user, view: (await handlers.home(event.user)) as never });
			} catch (error) {
				console.error(`App Home for ${event.user} failed:`, error);
			}
		});

		this.app.event("reaction_added", async ({ event }) => {
			// Scout's own (👀, ✅ on requests) are status, never instructions.
			if (event.item.type !== "message" || event.user === this.botUserId) return;
			if (LOOK_REACTIONS.has(event.reaction) && handlers.onLook !== undefined) {
				const found = await this.messageAt(event.item.channel, event.item.ts);
				const info = await this.app.client.conversations.info({ channel: event.item.channel }).catch(() => undefined);
				if (found === undefined || info?.channel?.is_channel !== true || info.channel.is_private === true) return;
				await handlers.onLook({ user: event.user, channel: event.item.channel, channelName: info.channel.name ?? "", ts: event.item.ts, ...found }).catch((error: unknown) => console.error("🔍 failed:", error));
				return;
			}
			try {
				await handlers.onReaction({ channel: event.item.channel, ts: event.item.ts, name: event.reaction, user: event.user, eventTs: event.event_ts });
			} catch (error) {
				console.error(`reaction ${event.item.channel}/${event.item.ts} failed:`, error);
			}
		});

		this.app.action(CREATE_CHANNEL_ACTION, async ({ ack, body, respond }) => {
			await ack();
			const user = body.user.id;
			try {
				const channel = await this.#createChannelFor(user);
				await respond({ replace_original: true, text: `Done: <#${channel}>. Mention me there and we'll get going.` });
			} catch (error) {
				console.error("channel creation failed:", error);
				await respond({ replace_original: false, text: "I couldn't create the channel. Could you make one and invite me?" });
			}
		});

		await this.app.start();
	}

	async stop(): Promise<void> {
		await this.app.stop();
	}

	/** What Scout says to a direct message: no, but here's a public channel for the two of us. */
	channelOffer(user: string): ChatMessage {
		const text =
			"I don't work in direct messages. I work in public channels, so anyone can see what we do, chip in, and " +
			"learn from it. Want a channel for the two of us?";
		return {
			text,
			blocks: [
				{ type: "section", text: { type: "mrkdwn", text } },
				{
					type: "actions",
					elements: [
						{
							type: "button",
							action_id: CREATE_CHANNEL_ACTION,
							text: { type: "plain_text", text: "Create our channel" },
							value: user,
							style: "primary",
						},
					],
				},
			],
		};
	}

	/**
	 * A file shared in Slack, up to `limit` bytes; private file URLs need the bot's token. A file's URL comes from the
	 * event, and a remote file's can point anywhere: the token goes only to Slack's own file host, over https.
	 */
	async download(url: string, limit: number): Promise<Uint8Array> {
		if (!this.#slackFile(url)) throw new Error(`not a Slack file URL: ${url}`);
		// Redirects are followed by hand, so the token goes only where the same rule allows (Slack's "Downloading files").
		let response = await fetch(url, { headers: { authorization: `Bearer ${this.#botToken}` }, redirect: "manual" });
		for (let hops = 0; response.status >= 300 && response.status < 400 && response.headers.has("location"); hops++) {
			if (hops === 3) throw new Error("Slack redirected the file too often");
			url = new URL(response.headers.get("location")!, url).href;
			if (!this.#slackFile(url)) throw new Error(`Slack redirected the file away from Slack: ${url}`);
			response = await fetch(url, { headers: { authorization: `Bearer ${this.#botToken}` }, redirect: "manual" });
		}
		if (!response.ok) throw new Error(`Slack answered ${response.status}`);
		// Counted as it arrives: the size the event claims is only a claim.
		const chunks: Uint8Array[] = [];
		let total = 0;
		for await (const chunk of response.body ?? []) {
			total += chunk.length;
			if (total > limit) throw new Error(`the file is over ${limit} bytes`);
			chunks.push(chunk);
		}
		return Buffer.concat(chunks);
	}

	#slackFile(url: string): boolean {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return false;
		}
		if (this.#filesOrigin !== undefined && parsed.origin === this.#filesOrigin) return true;
		return parsed.protocol === "https:" && parsed.port === "" && parsed.username === "" && parsed.hostname === "files.slack.com";
	}

	/** Members of a Slack user group (needs usergroups:read). */
	async groupMembers(group: string): Promise<Set<string>> {
		const members = await this.app.client.usergroups.users.list({ usergroup: group });
		return new Set(members.users ?? []);
	}

	async nameOf(user: string): Promise<string> {
		const cached = this.#names.get(user);
		if (cached !== undefined) return cached;
		const info = await this.app.client.users.info({ user });
		const profile = info.user?.profile;
		const name = profile?.display_name || profile?.real_name || info.user?.name || user;
		this.#names.set(user, name);
		return name;
	}

	/** A user's email, to find them in the identity provider; needs the `users:read.email` scope. */
	async emailOf(user: string): Promise<string | undefined> {
		const info = await this.app.client.users.info({ user }).catch(() => undefined);
		return info?.user?.profile?.email || undefined;
	}

	/**
	 * Whether Scout can work in a channel: public, and it's in it. A yes is remembered for ten minutes. `quick` gives
	 * Slack two seconds and one try, and is undefined when Slack didn't say in time.
	 */
	async #canWork(channel: string, quick = false): Promise<boolean | undefined> {
		const at = this.#workable.get(channel);
		if (at !== undefined && Date.now() - at < WORKABLE_MS) return true;
		let info;
		try {
			info = await (quick ? this.#quick : this.app.client).conversations.info({ channel });
		} catch (error) {
			if ((error as { code?: string }).code === "slack_webapi_platform_error") return false;
			if (quick) return undefined;
			throw error;
		}
		const ok = info.channel?.is_channel === true && info.channel.is_private !== true && info.channel.is_member === true;
		if (ok) this.#workable.set(channel, Date.now());
		if (info.channel?.name !== undefined) this.#channels.set(channel, info.channel.name);
		return ok;
	}

	async channelName(channel: string): Promise<string> {
		const cached = this.#channels.get(channel);
		if (cached !== undefined) return cached;
		const info = await this.app.client.conversations.info({ channel });
		const name = info.channel?.name ?? channel;
		this.#channels.set(channel, name);
		return name;
	}

	/** A public channel's ID from its name (without `#`), or undefined when there's none by that name. */
	async channelId(name: string): Promise<string | undefined> {
		for (const [id, known] of this.#channels) if (known === name) return id;
		let cursor: string | undefined;
		do {
			const page = await this.app.client.conversations.list({ types: "public_channel", exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}) });
			for (const channel of page.channels ?? []) if (channel.id && channel.name) this.#channels.set(channel.id, channel.name);
			const found = page.channels?.find((c) => c.name === name)?.id;
			if (found !== undefined) return found;
			cursor = page.response_metadata?.next_cursor || undefined;
		} while (cursor !== undefined);
		return undefined;
	}

	/**
	 * A reply that also shows in the channel ("Also send to #channel"), so people scanning the channel can see what came
	 * of a thread they'd otherwise have to open.
	 */
	async broadcast(channel: string, threadTs: string, text: string): Promise<void> {
		await this.app.client.chat.postMessage({ channel, thread_ts: threadTs, reply_broadcast: true, text, unfurl_links: false });
	}

	async permalink(channel: string, ts: string): Promise<string | undefined> {
		const link = await this.app.client.chat.getPermalink({ channel, message_ts: ts }).catch(() => undefined);
		return link?.permalink;
	}

	async #createChannelFor(user: string): Promise<string> {
		const base = slackChannelName(`${await this.nameOf(user)}_scout`);
		for (let attempt = 0; attempt < 5; attempt++) {
			const name = attempt === 0 ? base : `${base}-${attempt + 1}`;
			const created = await this.app.client.conversations
				.create({ name, is_private: false })
				.catch((error: { data?: { error?: string } }) => {
					if (error.data?.error === "name_taken") return undefined;
					throw error;
				});
			const channel = created?.channel?.id;
			if (channel === undefined) continue;
			await this.app.client.conversations.invite({ channel, users: user });
			await this.surface.post(channel, undefined, {
				text: `Hi <@${user}>. This channel is ours, and it's public, so anyone can follow along.`,
				blocks: [],
			});
			return channel;
		}
		throw new Error(`no free channel name like ${base}`);
	}
}

function sharedFiles(files: unknown[]): SharedFile[] {
	return files.flatMap((f) => {
		const file = f as Record<string, unknown>;
		const url = file.url_private_download ?? file.url_private;
		if (typeof url !== "string") return [];
		return [
			{
				name: typeof file.name === "string" ? file.name : "file",
				mimetype: typeof file.mimetype === "string" ? file.mimetype : "application/octet-stream",
				size: typeof file.size === "number" ? file.size : 0,
				url,
			},
		];
	});
}

export function slackChannelName(text: string): string {
	return (
		text
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[\u0300-\u036f]/g, "")
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 70) || "scout"
	);
}

/**
 * `@name` → `<@ID>` for names in `handles` (lowercased Slack handles and display names), outside code spans and fences,
 * so `@scope/package` and decorators stay as written. A trailing `.` or `-` (end of a sentence) isn't part of the name.
 */
export function mentionNames(text: string, handles: ReadonlyMap<string, string>): string {
	return text
		.split(/(```[\s\S]*?```|`[^`\n]*`)/)
		.map((part, i) =>
			i % 2 === 1
				? part
				: part.replace(/(^|[^\w<`/])@([A-Za-z0-9][\w.-]*)(?![\w/])/g, (whole, before: string, name: string) => {
						const bare = name.replace(/[.-]+$/, "");
						const id = handles.get(bare.toLowerCase());
						return id === undefined ? whole : `${before}<@${id}>${name.slice(bare.length)}`;
					}),
		)
		.join("");
}
