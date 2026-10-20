import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, watch } from "node:fs";
import { promisify } from "node:util";
import { basename, join, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import { type ConversationId, type DocumentReader, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { ThreadDoc } from "./docs.ts";

export type Skill = { name: string; description: string; body: string };

/**
 * Everything Scout knows that isn't in the repo, as plain files people can read, review, and change:
 *
 *     profile/
 *       system.md                       who Scout is and how it works with people
 *       reflect.md                      how Scout reviews its own threads each night (see reflect.ts)
 *       review.md                       how Scout reviews its own change before opening a pull request
 *       reviewer.md                     how Scout reviews other people's pull requests when asked (automation.ts)
 *       responder.md                    how Scout investigates an alert (alerts.ts)
 *       skills/<name>.md                know-how, loaded on demand (frontmatter: description)
 *       channels/<channel-name>/
 *         instructions.md               what this channel's team wants Scout to know
 *         skills/<name>.md              skills only this channel sees
 *
 * The repo's own AGENTS.md files still apply; Scout reads them from the workspace.
 */
/**
 * What one channel's team wants Scout to know. `instructions.md` may start with frontmatter naming the repository the
 * team works in and its zones, the parts of it the team owns:
 *
 *     ---
 *     repo: storefront
 *     zones: services/checkout, libs/payments
 *     model: anthropic/claude-sonnet-5-5
 *     ---
 */
export type ChannelProfile = {
	instructions?: string;
	repo?: string;
	/** `provider/modelId`, for a team that wants a different model than the default. */
	model?: string;
	zones: string[];
	/** Alerts this team owns: a Gatus group or endpoint name, or a Grafana label value (`alerts: Immich, vm1`). */
	alerts: string[];
	/** Whom to mention when one of its alerts fires: Slack user or group mentions, e.g. `<@U0123ABC>`. */
	oncall?: string;
	skills: Skill[];
};

export type Profile = {
	system: string;
	reflect?: string;
	review?: string;
	reviewer?: string;
	responder?: string;
	skills: Skill[];
	channels: Map<string, ChannelProfile>;
};

export function loadProfile(dir: string): Profile {
	const channels = new Map<string, ChannelProfile>();
	const channelsDir = join(dir, "channels");
	if (existsSync(channelsDir)) {
		for (const entry of readdirSync(channelsDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const text = readOptional(join(channelsDir, entry.name, "instructions.md"));
			const { meta, body } = frontmatter(text ?? "");
			const list = (value: string | undefined) => (value ?? "").split(",").map((z) => z.trim()).filter(Boolean);
			const zones = list(meta.zones);
			channels.set(entry.name, {
				...(body.trim() === "" ? {} : { instructions: body.trim() }),
				...(meta.repo ? { repo: meta.repo } : {}),
				...(meta.model ? { model: meta.model } : {}),
				zones,
				alerts: list(meta.alerts),
				...(meta.oncall ? { oncall: meta.oncall } : {}),
				skills: loadSkills(join(channelsDir, entry.name, "skills")),
			});
		}
	}
	const reflect = readOptional(join(dir, "reflect.md"));
	const review = readOptional(join(dir, "review.md"));
	const reviewer = readOptional(join(dir, "reviewer.md"));
	const responder = readOptional(join(dir, "responder.md"));
	return {
		system: readOptional(join(dir, "system.md")) ?? "",
		...(reflect === undefined ? {} : { reflect }),
		...(review === undefined ? {} : { review }),
		...(reviewer === undefined ? {} : { reviewer }),
		...(responder === undefined ? {} : { responder }),
		skills: loadSkills(join(dir, "skills")),
		channels,
	};
}

function loadSkills(dir: string): Skill[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith(".md"))
		.sort()
		.map((file) => {
			const { meta, body } = frontmatter(readFileSync(join(dir, file), "utf8"));
			return { name: basename(file, ".md"), description: meta.description ?? "", body };
		});
}

export function frontmatter(text: string): { meta: Record<string, string>; body: string } {
	const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
	if (match === null) return { meta: {}, body: text };
	const meta: Record<string, string> = {};
	for (const line of (match[1] ?? "").split("\n")) {
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		// `key: value   # a comment`, and `"quoted"` values (a leading @ or : reads better quoted).
		const value = line.slice(colon + 1).trim().replace(/\s+#.*$/, "");
		meta[line.slice(0, colon).trim()] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
	}
	return { meta, body: text.slice(match[0].length) };
}

function readOptional(path: string): string | undefined {
	return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
}

/** The profile as an extension. Reinstalling it under the same name swaps it in for every thread's next request. */
export type WorkspaceFacts = {
	/** The conversation's repository: its name and base branch. */
	repo: (id: ConversationId, context: Context) => Promise<{ name: string; base: string }>;
	branch: (id: number) => string;
	/** The sandbox has no network, so downloads fail. */
	offline?: boolean;
};

export function profileExtension(profile: Profile, workspace: WorkspaceFacts) {
	const channelOf = async (read: DocumentReader, conversationId: ConversationId, context: Context) =>
		(await read.snapshot(ThreadDoc, conversationId, context))?.channelName ?? "";
	const skillsFor = (channelName: string) => [...(profile.channels.get(channelName)?.skills ?? []), ...profile.skills];

	const loadSkill = defineTool({
		name: "load_skill",
		description: "Load a skill by name. Skills hold know-how the team wrote down; load one when it matches the task.",
		parameters: Type.Object({ name: Type.String() }),
		replay: "safe",
		execute: async (args, api, context) => {
			const skill = skillsFor(await channelOf(api, api.conversationId, context)).find((s) => s.name === args.name);
			if (skill === undefined) throw new Error(`No skill named ${args.name}`);
			return { output: [{ type: "text", text: skill.body }] };
		},
	});

	return defineExtension({
		name: "profile",
		tools: [loadSkill],
		sections: [
			section("scout", () => profile.system || undefined, { tag: false }),
			section("channel", async (input, context) => {
				const channelName = await channelOf(input.read, input.conversationId, context);
				const instructions = profile.channels.get(channelName)?.instructions;
				return instructions === undefined ? undefined : `From the people in #${channelName}:\n\n${instructions}`;
			}),
			section("skills", async (input, context) => {
				const skills = skillsFor(await channelOf(input.read, input.conversationId, context));
				if (skills.length === 0) return undefined;
				return [
					"Load a skill with load_skill when it matches what you are doing:",
					...skills.map((s) => `- ${s.name}: ${s.description}`),
				].join("\n");
			}),
			section("workspace", async (input, context) => {
				if (input.env === undefined) return undefined;
				const repo = await workspace.repo(input.conversationId, context);
				const zones = profile.channels.get(await channelOf(input.read, input.conversationId, context))?.zones ?? [];
				return [
							`Repository ${repo.name}: ${input.env.cwd} (your own clone, on branch ${workspace.branch(input.conversationId)}, from ${repo.base}).`,
							...(zones.length === 0 ? [] : [`This team mostly works in ${zones.join(", ")}. Start there.`]),
							"Read AGENTS.md files in the repository before changing code near them.",
							"Commit with git, then call open_pull_request. Nobody else can see your changes until you do.",
							...(workspace.offline
								? [
										"The sandbox has no network: installing packages and anything else that downloads will fail. " +
											"Work with what is installed. If that blocks you, say so plainly in the thread; whoever runs " +
											"Scout can turn the network on or add the dependencies to the sandbox image.",
									]
								: []),
						].join("\n");
			}),
		],
	});
}

const run = promisify(execFile);

/**
 * When the profile is a repository, `dir` is a clone the host keeps up to date: merged changes, including the ones
 * the nightly reflection proposed, reach Scout without a deploy. Only the host writes here.
 */
export async function cloneProfile(dir: string, repo: { gitUrl: string; base: string }): Promise<void> {
	if (existsSync(join(dir, ".git"))) return;
	if (existsSync(dir) && readdirSync(dir).length > 0) {
		throw new Error(`${dir} exists but is not a clone of ${repo.gitUrl}; move it or point SCOUT_PROFILE_DIR elsewhere`);
	}
	await run("git", ["clone", "--quiet", "--branch", repo.base, repo.gitUrl, dir]);
}

export async function pullProfile(dir: string): Promise<void> {
	await run("git", ["-C", dir, "pull", "--quiet", "--ff-only"], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

/** Watch the profile directory and call `onChange` with a fresh profile after edits settle. */
export function watchProfile(dir: string, onChange: (profile: Profile) => void): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const watcher = watch(dir, { recursive: true }, (_event, file) => {
		// A pull that brings nothing still touches .git (FETCH_HEAD); only the profile's own files are changes.
		if (file !== null && (file === ".git" || file.startsWith(`.git${sep}`))) return;
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(() => {
			try {
				onChange(loadProfile(dir));
			} catch (error) {
				console.error("profile reload failed:", error);
			}
		}, 300);
	});
	return () => watcher.close();
}
