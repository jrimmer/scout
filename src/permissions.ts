import { readFileSync } from "node:fs";
import type { CodeHost } from "./codehost.ts";
import type { Admission } from "./limits.ts";

/**
 * The person asking, not just Scout, must be able to change the repository. Scout's account can reach every
 * repository it was given; in a larger organization, someone in a public channel shouldn't get changes made where
 * they couldn't make them themselves.
 *
 * Slack users map to code host accounts through the identity provider (directory.ts: their Slack email, the person
 * with that email, whose username is their code host login when the code host signs people in through it), or a file
 * the operator keeps (`{ "U0123ABC": "alice" }`), which wins. Neither lets a person claim an account: Slack's email is
 * the workspace's, the directory the operator's. A Slack user group can also gate who may use Scout at all, and does
 * whatever the mode.
 * With `SCOUT_REQUESTER_CHECK=enforce` (the default), people without write access (or without a mapping) can talk in
 * threads, but their messages don't start or steer work. `warn` logs whom it would refuse and lets them through; `off`
 * checks nobody.
 */
export type PermissionsConfig = {
	mode: "off" | "warn" | "enforce";
	/** Slack user ID → code host login. */
	people: Record<string, string>;
	/** Only members of this Slack user group may ask Scout for work. */
	userGroup?: string;
};

const WRITE = new Set(["admin", "owner", "maintain", "write"]);
const CACHE_MS = 10 * 60 * 1000;

export function loadPeople(path: string | undefined): Record<string, string> {
	return path === undefined ? {} : (JSON.parse(readFileSync(path, "utf8")) as Record<string, string>);
}

export class Permissions {
	readonly #config: PermissionsConfig;
	readonly #host: CodeHost;
	readonly #fetch: typeof fetch;
	readonly #groupMembers: () => Promise<Set<string>>;
	readonly #loginOf: (user: string) => Promise<string | undefined>;
	readonly #cache = new Map<string, { at: number; admission: Admission }>();
	#group: { at: number; members: Set<string> } | undefined;

	constructor(options: {
		config: PermissionsConfig;
		codeHost: CodeHost;
		/** Members of `config.userGroup`, from Slack. */
		groupMembers?: () => Promise<Set<string>>;
		/** A Slack user's code host login, from the identity provider, when the people file doesn't say. */
		loginOf?: (user: string) => Promise<string | undefined>;
		fetch?: typeof fetch;
	}) {
		this.#loginOf = options.loginOf ?? (async () => undefined);
		this.#config = options.config;
		this.#host = options.codeHost;
		this.#fetch = options.fetch ?? fetch;
		this.#groupMembers = options.groupMembers ?? (async () => new Set());
	}

	get mode(): PermissionsConfig["mode"] {
		return this.#config.mode;
	}

	/** May `user` ask for work in the repository `slug`? */
	async admit(user: string, slug: string, now = Date.now()): Promise<Admission> {
		const member = await this.member(user, now);
		if (!member.ok || this.#config.mode === "off") return member;
		return this.#softened(`${user} in ${slug}`, await this.#cached(`${user} ${slug}`, now, () => this.#check(user, slug)));
	}

	/** Is `user` in the Slack user group that may use Scout (anyone is, when there's none)? Whatever the mode. */
	async member(user: string, now = Date.now()): Promise<Admission> {
		if (this.#config.userGroup === undefined) return { ok: true };
		if (this.#group === undefined || now - this.#group.at > CACHE_MS) this.#group = { at: now, members: await this.#groupMembers() };
		if (this.#group.members.has(user)) return { ok: true };
		return { ok: false, reason: "I can only take work from people in the group set up for me. Ask whoever runs me to add you." };
	}

	async #check(user: string, slug: string): Promise<Admission> {
		const login = this.#config.people[user] ?? (await this.#loginOf(user).catch(() => undefined));
		if (login === undefined) {
			return { ok: false, reason: `I don't know your ${hostName(this.#host)} account yet, so I can't check you can change ${slug}. Ask whoever runs me to link it.` };
		}
		return this.#canChange(login, slug);
	}

	/** May the code host account `login` ask for work in `slug`? For requests made on the code host itself. */
	async admitLogin(login: string, slug: string, now = Date.now()): Promise<Admission> {
		if (this.#config.mode === "off") return { ok: true };
		return this.#softened(`${login} in ${slug}`, await this.#cached(`login:${login} ${slug}`, now, () => this.#canChange(login, slug)));
	}

	async #cached(key: string, now: number, check: () => Promise<Admission>): Promise<Admission> {
		const cached = this.#cache.get(key);
		if (cached !== undefined && now - cached.at < CACHE_MS) return cached.admission;
		const admission = await check();
		this.#cache.set(key, { at: now, admission });
		return admission;
	}

	/** In `warn` mode a refusal is only logged: for trying the check out before turning it on. */
	#softened(who: string, admission: Admission): Admission {
		if (admission.ok || this.#config.mode !== "warn") return admission;
		console.warn(`requester check (warn): would refuse ${who}: ${admission.reason}`);
		return { ok: true };
	}

	async #canChange(login: string, slug: string): Promise<Admission> {
		const response = await this.#fetch(`${this.#host.apiUrl}/repos/${slug}/collaborators/${encodeURIComponent(login)}/permission`, {
			headers: {
				accept: this.#host.kind === "github" ? "application/vnd.github+json" : "application/json",
				authorization: this.#host.kind === "github" ? `Bearer ${this.#host.token}` : `token ${this.#host.token}`,
			},
		}).catch(() => undefined);
		if (response === undefined || (!response.ok && response.status !== 404)) {
			return { ok: false, reason: `I couldn't check your access to ${slug} just now. Try again in a minute.` };
		}
		const permission = response.ok ? ((await response.json()) as { permission?: string }).permission : "none";
		if (permission !== undefined && WRITE.has(permission)) return { ok: true };
		return { ok: false, reason: `You (${login}) can't change ${slug}, so I can't change it for you. Someone who can could ask instead.` };
	}
}

function hostName(host: CodeHost): string {
	return host.kind === "github" ? "GitHub" : "Forgejo";
}
