import { readFileSync } from "node:fs";
import type { CodeHost } from "./codehost.ts";
import type { Admission } from "./limits.ts";

/**
 * The person asking, not just Scout, must be able to change the repository. Scout's account can reach every
 * repository it was given; in a larger organization, someone in a public channel shouldn't get changes made where
 * they couldn't make them themselves.
 *
 * Slack users map to code host accounts through the identity provider (directory.ts: their Slack email, the person
 * with that email, whose username is their code host login), or a file the operator keeps (`{ "U0123ABC": "alice" }`),
 * which wins. Neither lets a person claim an account: Slack's email is the workspace's, the directory the operator's. A Slack user group can also gate who may use Scout at all.
 * With `SCOUT_REQUESTER_CHECK=enforce`, people without write access (or without a mapping) can talk in threads, but
 * their messages don't start or steer work.
 */
export type PermissionsConfig = {
	mode: "off" | "enforce";
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

	get enforcing(): boolean {
		return this.#config.mode === "enforce";
	}

	/** May `user` ask for work in the repository `slug`? */
	async admit(user: string, slug: string, now = Date.now()): Promise<Admission> {
		if (!this.enforcing) return { ok: true };
		const key = `${user} ${slug}`;
		const cached = this.#cache.get(key);
		if (cached !== undefined && now - cached.at < CACHE_MS) return cached.admission;
		const admission = await this.#check(user, slug, now);
		this.#cache.set(key, { at: now, admission });
		return admission;
	}

	async #check(user: string, slug: string, now: number): Promise<Admission> {
		if (this.#config.userGroup !== undefined) {
			if (this.#group === undefined || now - this.#group.at > CACHE_MS) this.#group = { at: now, members: await this.#groupMembers() };
			if (!this.#group.members.has(user)) {
				return { ok: false, reason: "I can only take work from people in the group set up for me. Ask whoever runs me to add you." };
			}
		}
		const login = this.#config.people[user] ?? (await this.#loginOf(user).catch(() => undefined));
		if (login === undefined) {
			return { ok: false, reason: `I don't know your ${hostName(this.#host)} account yet, so I can't check you can change ${slug}. Ask whoever runs me to link it.` };
		}
		return this.#canChange(login, slug);
	}

	/** May the code host account `login` ask for work in `slug`? For requests made on the code host itself. */
	async admitLogin(login: string, slug: string, now = Date.now()): Promise<Admission> {
		if (!this.enforcing) return { ok: true };
		const key = `login:${login} ${slug}`;
		const cached = this.#cache.get(key);
		if (cached !== undefined && now - cached.at < CACHE_MS) return cached.admission;
		const admission = await this.#canChange(login, slug);
		this.#cache.set(key, { at: now, admission });
		return admission;
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
