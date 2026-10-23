import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Storage } from "@earendil-works/pi-durable";
import { loadConfig } from "../src/config.ts";
import type { SandboxDriver } from "../src/drivers/types.ts";
import type { McpConnection } from "../src/mcp.ts";
import { type Service, startService } from "../src/service.ts";
import { type FakeCodeHost, fakeCodeHost } from "./fake-codehost.ts";
import { type FakeSlack, fakeSlack, SCOUT } from "./fake-slack.ts";
import { seedRepo, tempDir } from "./helpers.ts";

/**
 * Scout as `main.ts` starts it (src/service.ts), in front of fakes: Slack (test/fake-slack.ts, through Bolt), a Forgejo
 * (test/fake-codehost.ts) serving the repository `acme/app` from a bare git repository on disk, a scripted model
 * (`faux`, as `faux/m`), local sandboxes, and sqlite in a temporary data directory, so `restart` finds what the last
 * start left. Nothing runs on a timer: `scout.service.tick` runs housekeeping, alerts, CI and the rest when the test
 * says. Channel #team (fake-slack's TEAM_CHANNEL) works in acme/app.
 */
export type E2eOptions = {
	/** Settings on top of the defaults below (SCOUT_* as in .env.example). */
	env?: Record<string, string>;
	/** Files in the profile directory besides system.md, by path (`channels/team/instructions.md`, say). */
	profile?: Record<string, string>;
	/** Fakes to share with other starts; made (and closed) here otherwise. */
	slack?: FakeSlack;
	host?: FakeCodeHost;
	mcp?: McpConnection[];
	driver?: SandboxDriver;
	storage?: Storage;
	/** The clock housekeeping goes by. */
	now?: () => number;
	/** Gives the code host, the alert sources and the doctor this `fetch`; slack.com goes to fake Slack either way. */
	fetch?: typeof fetch;
	/** More scripted models besides `faux/m` (`f` is `faux/f`), for SCOUT_FALLBACK_MODELS and the like. */
	models?: string[];
};

export async function startScout(options: E2eOptions = {}) {
	const root = tempDir("scout-e2e-");
	const repo = seedRepo(root, "app");
	const slack = options.slack ?? (await fakeSlack());
	const host = options.host ?? (await fakeCodeHost());
	host.repo("acme/app", { git: repo.remote });
	const profileDir = join(root, "profile");
	const profile = { "system.md": "You are Scout.", ...options.profile };
	mkdirSync(join(profileDir, "channels", "team"), { recursive: true });
	for (const [path, text] of Object.entries(profile)) {
		mkdirSync(dirname(join(profileDir, path)), { recursive: true });
		writeFileSync(join(profileDir, path), text);
	}
	const env = {
		SLACK_BOT_TOKEN: "xoxb-test",
		SLACK_APP_TOKEN: "xapp-test",
		SCOUT_MODEL: "faux/m",
		SCOUT_REPO_URL: repo.remote,
		SCOUT_REPO_SLUG: "acme/app",
		SCOUT_CODEHOST: host.kind,
		SCOUT_CODEHOST_TOKEN: "forge-token",
		SCOUT_CODEHOST_API: host.apiUrl,
		SCOUT_DATA_DIR: join(root, "data"),
		SCOUT_PROFILE_DIR: profileDir,
		SCOUT_SANDBOX_DRIVER: "local",
		SCOUT_DASH_ADDR: "off",
		...options.env,
	};
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }, ...(options.models ?? []).map((id) => ({ id }))] });
	const models = createModels();
	models.setProvider(faux.provider);
	// The doctor asks Slack itself, at slack.com: here, that's fake Slack.
	const outside = options.fetch ?? fetch;
	const routed = ((input: string | URL | Request, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		return url.startsWith("https://slack.com/api/") ? outside(url.replace("https://slack.com/api/", slack.apiUrl), init) : outside(input, init);
	}) as typeof fetch;
	/** What `exit` was called with: once a signal has stopped Scout (0), or when its harness failed (1). */
	const exits: number[] = [];
	let starts = 0;
	const start = (): Promise<Service> => {
		starts++;
		return startService({
			config: loadConfig(env),
			slack: { receiver: slack.receiver, apiUrl: slack.apiUrl },
			models,
			mcp: options.mcp ?? [],
			watchProfile: false,
			timers: false,
			fetch: routed,
			exit: (code) => void exits.push(code),
			...(options.driver === undefined ? {} : { driver: options.driver }),
			...(options.storage === undefined ? {} : { storage: options.storage }),
			...(options.now === undefined ? {} : { now: options.now }),
		});
	};
	let service = await start();
	let mentions = 0;

	return {
		root,
		/** The repository's bare git directory and a clone to add commits from. */
		repo,
		slack,
		host,
		faux,
		env,
		exits,
		get service(): Service {
			return service;
		},
		/** Close Scout and start it again on the same data directory, as a restart does. */
		restart: async (): Promise<Service> => {
			// Catching up on what was said while it was away goes on in the background: let it finish talking to Slack first.
			await service.caughtUp;
			await service.close();
			service = await start();
			return service;
		},
		/**
		 * Someone (Ann, by default) mentions Scout in #team; `threadTs` makes it a reply in that thread. Returns the
		 * message's timestamp, the thread's when it starts one.
		 */
		mention: async (text: string, at: { user?: string; threadTs?: string; channel?: string } = {}): Promise<string> => {
			const envelope = slack.envelope("message-mention");
			const ts = `1700000000.${String(100 + mentions++ * 100).padStart(6, "0")}`;
			Object.assign(envelope.payload.event as object, {
				text: `<@${SCOUT}> ${text}`,
				ts,
				event_ts: ts,
				client_msg_id: `e2e-${ts}`,
				...(at.user === undefined ? {} : { user: at.user }),
				...(at.channel === undefined ? {} : { channel: at.channel }),
				...(at.threadTs === undefined ? {} : { thread_ts: at.threadTs }),
			});
			Object.assign(envelope.payload, { event_id: `Ev-e2e-${ts}` });
			await slack.receiver.deliver(envelope);
			return ts;
		},
		/** What Scout said in Slack, posted or edited, in order. */
		said: (): string[] => slack.calls.filter((c) => c.method === "chat.postMessage" || c.method === "chat.update").map((c) => String(c.args.text)),
		/** Stop Scout, then the fakes this start made. */
		close: async () => {
			await service.caughtUp;
			await service.close();
			if (options.host === undefined) await host.close();
			if (options.slack === undefined) await slack.close(starts);
			// Repositories, sandboxes and data: thousands of files a run, which /tmp runs out of room for over a day.
			rmSync(root, { recursive: true, force: true });
		},
	};
}

export type E2e = Awaited<ReturnType<typeof startScout>>;
