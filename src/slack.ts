import { App, LogLevel } from "@slack/bolt";
import type { IncomingMessage } from "./bridge.ts";
import type { ChatMessage, ChatSurface } from "./render.ts";

/** Message subtypes that are still people talking; every other subtype (edits, joins, bots) is ignored. */
const SPOKEN_SUBTYPES = new Set([undefined, "thread_broadcast", "file_share"]);

const CREATE_CHANNEL_ACTION = "scout_create_channel";

export type SlackHandlers = {
	onMessage: (message: IncomingMessage) => Promise<void>;
	onReaction: (reaction: { channel: string; ts: string; name: string; user: string }) => Promise<void>;
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

	constructor(tokens: { botToken: string; appToken: string }) {
		this.app = new App({ token: tokens.botToken, appToken: tokens.appToken, socketMode: true, logLevel: LogLevel.WARN });
		const client = this.app.client;
		this.surface = {
			post: async (channel, threadTs, message) => {
				const posted = await client.chat.postMessage({
					channel,
					...(threadTs === undefined ? {} : { thread_ts: threadTs }),
					text: message.text,
					blocks: message.blocks as never,
					unfurl_links: false,
				});
				return posted.ts ?? "";
			},
			update: async (channel, ts, message) => {
				await client.chat.update({ channel, ts, text: message.text, blocks: message.blocks as never });
			},
		};
	}

	/** Scout's own Slack user ID, which mentions of it carry. */
	async identify(): Promise<string> {
		const auth = await this.app.client.auth.test();
		this.botUserId = auth.user_id ?? "";
		return this.botUserId;
	}

	async start(handlers: SlackHandlers): Promise<void> {

		this.app.event("message", async ({ event }) => {
			const e = event as unknown as Record<string, unknown>;
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
				});
			} catch (error) {
				console.error(`message ${e.channel}/${e.ts} failed:`, error);
			}
		});

		this.app.event("reaction_added", async ({ event }) => {
			if (event.item.type !== "message") return;
			try {
				await handlers.onReaction({ channel: event.item.channel, ts: event.item.ts, name: event.reaction, user: event.user });
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

	async nameOf(user: string): Promise<string> {
		const cached = this.#names.get(user);
		if (cached !== undefined) return cached;
		const info = await this.app.client.users.info({ user });
		const profile = info.user?.profile;
		const name = profile?.display_name || profile?.real_name || info.user?.name || user;
		this.#names.set(user, name);
		return name;
	}

	async channelName(channel: string): Promise<string> {
		const cached = this.#channels.get(channel);
		if (cached !== undefined) return cached;
		const info = await this.app.client.conversations.info({ channel });
		const name = info.channel?.name ?? channel;
		this.#channels.set(channel, name);
		return name;
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
