import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { branchForDay, localDay } from "../src/reflect.ts";
import { type E2e, startScout } from "./e2e.ts";
import { fakeSlack, TEAM_CHANNEL } from "./fake-slack.ts";
import { git, seedRepo, tempDir, until } from "./helpers.ts";

const toolUse = { stopReason: "toolUse" } as const;
const HOME = "C0HOME0001";
const PROFILE_SLUG = "acme/profile";
const DAY = 24 * 60 * 60 * 1000;

/** Today at `hour`:`minute`, local time, in ms. */
const at = (hour: number, minute = 0, daysOn = 0) => {
	const d = new Date(Date.now() + daysOn * DAY);
	d.setHours(hour, minute, 0, 0);
	return d.getTime();
};

/**
 * Scout with a profile repository (a bare repository on disk and its pull requests on the fake code host) and a home
 * channel, #scout. `clock.time` is the time Scout goes by.
 */
async function start(options: { hour?: number } = {}) {
	const root = tempDir("scout-reflect-e2e-");
	const profileRepo = seedRepo(root, "profile", "main", { "system.md": "You are Scout.\n" });
	const slack = await fakeSlack();
	slack.channels.set(HOME, { id: HOME, name: "scout", is_channel: true, is_private: false, is_member: true });
	const clock = { time: at(12), now: () => clock.time };
	const profileDir = join(root, "profile-clone");
	const e2e = await startScout({
		slack,
		now: clock.now,
		env: {
			SCOUT_PROFILE_REPO_URL: profileRepo.remote,
			SCOUT_PROFILE_REPO_SLUG: PROFILE_SLUG,
			SCOUT_PROFILE_DIR: profileDir,
			SCOUT_REFLECT_CHANNEL: "scout",
			...(options.hour === undefined ? {} : { SCOUT_REFLECT_HOUR: String(options.hour) }),
		},
	});
	e2e.host.repo(PROFILE_SLUG, { git: profileRepo.remote });
	return {
		e2e,
		clock,
		profileRepo,
		profileDir,
		day: () => localDay(new Date(clock.time)),
		close: async () => {
			await finish(e2e);
			await slack.close(1);
			rmSync(root, { recursive: true, force: true });
		},
	};
}
type Reflecting = Awaited<ReturnType<typeof start>>;

/**
 * Slack calls Scout makes after an answer (permalinks, the list of its work) have gone out. Closing Slack under one
 * sends its client into retries that keep the process alive, so wait for the calls to stop, then close.
 */
async function finish(e2e: E2e, quietMs = 150): Promise<void> {
	let calls = -1;
	let since = Date.now();
	await until(() => {
		if (e2e.slack.calls.length !== calls) {
			calls = e2e.slack.calls.length;
			since = Date.now();
		}
		return Date.now() - since >= quietMs;
	}, 20_000, "Slack to go quiet").catch(() => {});
	await e2e.close();
	rmSync(e2e.root, { recursive: true, force: true });
}

const posts = (e2e: E2e) => e2e.slack.called("chat.postMessage").map((p) => ({ channel: String(p.args.channel), thread: p.args.thread_ts === undefined ? undefined : String(p.args.thread_ts), text: String(p.args.text) }));
const announcements = (e2e: E2e) => posts(e2e).filter((p) => p.text.includes("Could someone review it?"));

/** Ann asks a question in #team; Scout keeps a note about the answer. Returns once the request has been seen through. */
async function aThread(r: Reflecting, question = "how do I run the linter?", answer = "Run ./bin/lint. (Noted as [1].)"): Promise<void> {
	const { e2e } = r;
	const endings = () => e2e.slack.called("reactions.add").filter((c) => ["white_check_mark", "raising_hand", "warning", "hand"].includes(String(c.args.name))).length;
	const before = endings();
	e2e.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("remember", { note: "The linter is run with ./bin/lint, not npm run lint." })], toolUse),
		fauxAssistantMessage(answer),
	]);
	await e2e.mention(question);
	await until(() => e2e.said().some((t) => t.includes(answer)), 20_000, "the answer");
	await e2e.service.scout.harness.waitForIdle(context);
	await until(() => endings() > before, 20_000, "the request's ending reaction");
}

/** What the reflection model is scripted to do: write a skill, fold in note 1, open the pull request, and say so. */
function proposal(seen: { digest: string }, skill = "Run ./bin/lint.\n") {
	return [
		(transcript: unknown) => {
			seen.digest = JSON.stringify(transcript);
			return fauxAssistantMessage(
				[fauxToolCall("write", { path: "skills/linter.md", content: `---\ndescription: Linting\n---\n${skill}` }), fauxToolCall("consolidate_memories", { ids: [1] })],
				toolUse,
			);
		},
		fauxAssistantMessage([fauxToolCall("open_pull_request", { title: "Teach Scout the linter", body: "From #team: the linter is ./bin/lint." })], toolUse),
		fauxAssistantMessage("Proposed a linter skill."),
	];
}

/** The reflection has proposed: the pull request is on the host and its announcement is in the home channel. */
async function proposed(r: Reflecting): Promise<void> {
	await until(() => r.e2e.host.get(PROFILE_SLUG, 1) !== undefined && announcements(r.e2e).length > 0, 20_000, "the proposal and its announcement");
	await r.e2e.service.scout.harness.waitForIdle(context);
}

describe("end to end: the nightly reflection", () => {
	it("after the reflection hour reflects on the day's threads and proposes a profile pull request, then tells the home channel", async () => {
		const r = await start();
		const { e2e, clock } = r;
		const seen = { digest: "" };
		try {
			await aThread(r);

			// Before the hour (3 am by default), housekeeping leaves the night alone.
			clock.time = at(2, 0);
			await e2e.service.tick.housekeeping();
			assert.equal(e2e.service.scout.threads.reflection(r.day()), undefined);
			assert.equal(e2e.host.get(PROFILE_SLUG, 1), undefined);

			clock.time = at(3, 5);
			e2e.faux.setResponses(proposal(seen));
			await e2e.service.tick.housekeeping();
			await proposed(r);

			// What the reflection read: the thread, with its words, steps and the note kept.
			assert.match(seen.digest, /#team/);
			assert.match(seen.digest, /how do I run the linter\?/);
			assert.match(seen.digest, /Run \.\/bin\/lint\./);
			assert.match(seen.digest, /\[1\] #team: The linter is run with \.\/bin\/lint, not npm run lint\./, "and the notes kept since");
			assert.match(seen.digest, /Threads with new activity since the last reflection: 1\./);
			assert.match(seen.digest, /system\.md/, "it can see the profile's files");

			// The pull request: from the day's branch of the profile repository into its base, with the change in it.
			const branch = branchForDay(r.day());
			const pull = e2e.host.get(PROFILE_SLUG, 1);
			assert.equal(pull?.title, "Teach Scout the linter");
			assert.equal(pull?.pull?.head, branch);
			assert.equal(pull?.pull?.base, "main");
			assert.equal(git("--git-dir", r.profileRepo.remote, "show", `${branch}:skills/linter.md`), "---\ndescription: Linting\n---\nRun ./bin/lint.");
			assert.equal(git("--git-dir", r.profileRepo.remote, "log", "-1", "--format=%s", branch), "Teach Scout the linter");
			assert.throws(() => git("--git-dir", r.profileRepo.remote, "show", "main:skills/linter.md"), "main is for people to merge to");

			// The home channel is told, with the pull request's link.
			const [told] = announcements(e2e);
			assert.equal(told?.channel, HOME);
			assert.equal(told?.thread, undefined, "a message of its own, which becomes the reflection's thread");
			assert.equal(told?.text, `I went over yesterday's threads and wrote down what I learned. Could someone review it? ${e2e.host.webUrl}/acme/profile/pulls/1\nComment on the pull request, or ask me here, and I'll revise it.`);

			// Once a day: looking again changes nothing.
			await e2e.service.tick.housekeeping();
			assert.equal(announcements(e2e).length, 1);
			assert.equal(e2e.host.called("POST", /\/acme\/profile\/pulls$/).length, 1);
			assert.equal(e2e.faux.getPendingResponseCount(), 0);
		} finally {
			await r.close();
		}
	});

	it("reflects at once on SIGUSR2, and says nothing when nothing happened that day", async () => {
		const r = await start({ hour: 0 });
		const { e2e } = r;
		const seen = { digest: "" };
		try {
			e2e.service.signal("SIGUSR2");
			await e2e.service.reflect();
			assert.equal(e2e.service.scout.threads.reflection(r.day()), undefined, "no threads, no reflection");
			assert.equal(announcements(e2e).length, 0);

			await aThread(r);
			e2e.faux.setResponses(proposal(seen));
			e2e.service.signal("SIGUSR2");
			await proposed(r);
			assert.equal(e2e.host.get(PROFILE_SLUG, 1)?.title, "Teach Scout the linter");
			assert.equal(announcements(e2e).length, 1);
		} finally {
			await r.close();
		}
	});

	it("retires the notes a merged proposal covered, pulls the merged profile, and deletes the proposal's branch", async () => {
		const r = await start({ hour: 0 });
		const { e2e } = r;
		const seen = { digest: "" };
		try {
			await aThread(r);
			assert.equal(e2e.service.scout.memory.active().length, 1);
			e2e.faux.setResponses(proposal(seen));
			await e2e.service.reflect();
			await proposed(r);
			assert.equal(e2e.service.scout.memory.active().length, 1, "still kept while people have not decided");

			// A person merges it: the branch lands on main, and the code host says so.
			const branch = branchForDay(r.day());
			git("-C", r.profileRepo.seed, "fetch", "--quiet", r.profileRepo.remote, branch);
			git("-C", r.profileRepo.seed, "merge", "--quiet", "--ff-only", "FETCH_HEAD");
			r.profileRepo.push("main");
			e2e.host.merge(PROFILE_SLUG, 1);
			await e2e.service.tick.housekeeping();

			assert.deepEqual(e2e.service.scout.memory.active(), [], "the note is in the profile now");
			assert.equal(readFileSync(join(r.profileDir, "skills", "linter.md"), "utf8"), "---\ndescription: Linting\n---\nRun ./bin/lint.\n", "Scout's own copy of the profile is up to date");
			assert.deepEqual(e2e.host.deleted, [`${PROFILE_SLUG}:${branch}`]);
		} finally {
			await r.close();
		}
	});

	it("keeps the notes of a rejected proposal, and the next reflection hears what the reviewers said about it", async () => {
		const r = await start({ hour: 0 });
		const { e2e, clock } = r;
		const seen = { digest: "" };
		try {
			await aThread(r);
			e2e.faux.setResponses(proposal(seen));
			await e2e.service.reflect();
			await proposed(r);

			e2e.host.review(PROFILE_SLUG, 1, "bob", "COMMENT", "Too vague: name the command, not the tool.");
			e2e.host.closePull(PROFILE_SLUG, 1);
			await e2e.service.tick.housekeeping();
			assert.equal(e2e.service.scout.memory.active().length, 1, "nothing is lost to a no");
			assert.equal(e2e.service.scout.pulls.get(`${e2e.host.webUrl}/acme/profile/pulls/1`)?.state, "closed");

			// The next day has new activity, and the reflection starts from what people did with its last proposal.
			clock.time += DAY;
			await aThread(r, "and the formatter?", "Run ./bin/fmt.");
			const next = { digest: "" };
			e2e.faux.setResponses([
				(transcript) => {
					next.digest = JSON.stringify(transcript);
					return fauxAssistantMessage("Nothing worth changing today.");
				},
			]);
			await e2e.service.reflect();
			await until(() => next.digest !== "", 20_000, "the second reflection to start");
			await e2e.service.scout.harness.waitForIdle(context);
			assert.match(next.digest, /Your recent proposals to this profile, what people did with them, and what they said:/);
			assert.match(next.digest, new RegExp(`- Teach Scout the linter: closed \\(${e2e.host.webUrl}/acme/profile/pulls/1\\)`));
			assert.match(next.digest, /bob \(comment\): Too vague: name the command, not the tool\./);
			assert.match(next.digest, /\[1\] #team: The linter is run with/, "the rejected proposal's note is still offered");
			assert.equal(e2e.host.opened().filter((p) => p.slug === PROFILE_SLUG).length, 1, "a reflection with nothing to change proposes nothing");
		} finally {
			await r.close();
		}
	});

	it("revises the same pull request when a reviewer asks for changes on it, without announcing it again", async () => {
		const r = await start({ hour: 0 });
		const { e2e } = r;
		const seen = { digest: "" };
		const prompts: string[] = [];
		try {
			await aThread(r);
			e2e.faux.setResponses(proposal(seen));
			await e2e.service.reflect();
			await proposed(r);
			const [announcement] = announcements(e2e);
			assert.ok(announcement !== undefined);

			e2e.faux.setResponses([
				(transcript) => {
					prompts.push(JSON.stringify(transcript));
					return fauxAssistantMessage([fauxToolCall("write", { path: "skills/linter.md", content: "---\ndescription: Linting\n---\nRun ./bin/lint, never npm run lint.\n" })], toolUse);
				},
				fauxAssistantMessage([fauxToolCall("open_pull_request", { title: "Teach Scout the linter", body: "Now names the command that is not to be used." })], toolUse),
				fauxAssistantMessage("Revised: the skill now says never to use npm run lint."),
			]);
			e2e.host.review(PROFILE_SLUG, 1, "bob", "REQUEST_CHANGES", "Say which command not to use.");
			e2e.host.notify(PROFILE_SLUG, 1);
			await e2e.service.tick.inbox();
			await until(() => e2e.said().some((t) => t.includes("Revised: the skill now says")), 20_000, "the revision's answer");
			await e2e.service.scout.harness.waitForIdle(context);

			assert.match(prompts[0] ?? "", /bob asked you in pull request acme\/profile#1|commented on your pull request acme\/profile#1/);
			assert.match(prompts[0] ?? "", /Say which command not to use\./);
			assert.equal(git("--git-dir", r.profileRepo.remote, "show", `${branchForDay(r.day())}:skills/linter.md`), "---\ndescription: Linting\n---\nRun ./bin/lint, never npm run lint.");
			assert.equal(e2e.host.called("POST", /\/acme\/profile\/pulls$/).length, 2, "the second try found the open one...");
			assert.equal(e2e.host.opened().filter((p) => p.slug === PROFILE_SLUG).length, 1, "...so there is still one pull request");
			assert.equal(e2e.host.get(PROFILE_SLUG, 1)?.body, "Now names the command that is not to be used.");
			assert.equal(announcements(e2e).length, 1, "revisions do not announce again");
			// The request was quoted in the announcement's thread, where people can see it.
			assert.ok(
				posts(e2e).some((p) => p.channel === HOME && p.thread !== undefined && /\*bob\* asked for changes on <.*>:\n> Say which command not to use\./.test(p.text)),
				"in the reflection's thread",
			);
		} finally {
			await r.close();
		}
	});

	// The announcement thread (bridge.adopt in service.ts's reflectionProposed) is a thread like any other, added after
	// the reflection marked what it read: it mustn't count as new activity the next night, or a quiet day after any
	// proposal starts a reflection about nothing but Scout's own announcement (threads.ts unreflected).
	it("does not start another reflection the next day for its own announcement", async () => {
		const r = await start({ hour: 0 });
		const { e2e, clock } = r;
		const seen = { digest: "" };
		try {
			await aThread(r);
			e2e.faux.setResponses(proposal(seen));
			await e2e.service.reflect();
			await proposed(r);

			// A quiet day: nobody said anything anywhere.
			clock.time += DAY;
			e2e.faux.setResponses([fauxAssistantMessage("Reflecting on my own announcement.")]);
			await e2e.service.reflect();
			assert.equal(e2e.service.scout.threads.reflection(r.day()), undefined, "no reflection on a day nothing happened");
			assert.equal(e2e.faux.getPendingResponseCount(), 1);
		} finally {
			await r.close();
		}
	});
});
