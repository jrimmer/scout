import { rmSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { threadKey } from "../src/threads.ts";
import { type E2e, startScout } from "./e2e.ts";
import { TEAM_CHANNEL } from "./fake-slack.ts";
import { git, until } from "./helpers.ts";

const toolUse = { stopReason: "toolUse" } as const;
const SLUG = "acme/app";
/** #team works in acme/app (its profile names the repository), so a review's summary lands there. */
const TEAM_PROFILE = { "channels/team/instructions.md": "---\nrepo: app\n---\nSmall changes, tests first." };
const START: { env: Record<string, string>; profile: Record<string, string> } = { env: {}, profile: TEAM_PROFILE };

const branchExists = (e2e: E2e, name: string) => git("--git-dir", e2e.repo.remote, "for-each-ref", "--format=%(refname:short)", `refs/heads/${name}`) !== "";

/** A commit on a branch in the repository, pushed (the branch is made if new); the seed clone goes back to main. */
function branch(e2e: E2e, name: string, files: Record<string, string>, message: string): string {
	e2e.repo.checkout(name, !branchExists(e2e, name));
	const sha = e2e.repo.commit(files, message);
	e2e.repo.push(name);
	e2e.repo.checkout("main");
	return sha;
}

/** The Slack timestamp fake Slack gave the first chat.postMessage matching `text` (it numbers them in order). */
const tsOfPost = (e2e: E2e, text: RegExp): string => {
	const at = e2e.slack.called("chat.postMessage").findIndex((p) => text.test(String(p.args.text)));
	assert.ok(at >= 0, `a post matching ${text}`);
	return `1700000100.${String(at + 1).padStart(6, "0")}`;
};
/**
 * Slack calls Scout makes after an answer (permalinks for the code host and the list of its work) have gone out. Closing
 * Slack under one sends its client into retries that keep the process alive, so wait for the calls to stop, then close.
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

/**
 * A run's Slack calls that come after its answer (the ending reaction of a request made in Slack, a pull request's
 * notice) have gone out: `requests` is how many requests were made in Slack so far.
 */
async function runOver(e2e: E2e, requests = 1): Promise<void> {
	await e2e.service.scout.harness.waitForIdle(context);
	const endings = () => e2e.slack.called("reactions.add").filter((c) => ["white_check_mark", "raising_hand", "warning", "hand"].includes(String(c.args.name))).length;
	await until(() => endings() >= requests, 20_000, `the ending reactions of ${requests} request(s)`);
	const opened = e2e.host.opened().length;
	if (opened > 0) await until(() => e2e.slack.called("chat.postMessage").filter((c) => c.args.reply_broadcast === true).length >= opened, 20_000, "the pull request's notice");
}
const posted = (e2e: E2e, text: RegExp) => e2e.slack.called("chat.postMessage").some((p) => text.test(String(p.args.text)));
const hostReviews = (e2e: E2e, number: number) => e2e.host.get(SLUG, number)?.reviews ?? [];

const README = "app\nline two\nline three\n";

/** The model's four steps to a pull request: commit `file`, open it, pass the self-review, and say so. */
const pullSteps = (file: string, title: string, answer: string) => [
	fauxAssistantMessage([fauxToolCall("bash", { command: `printf '%s\\n' '${file}' > '${file}' && git add '${file}' && git commit -qm '${title}'` })], toolUse),
	fauxAssistantMessage([fauxToolCall("open_pull_request", { title, body: `Adds ${file}.` })], toolUse),
	fauxAssistantMessage("APPROVE\nSmall and right."),
	fauxAssistantMessage(answer),
];

/** Ann asks in #team, and Scout opens its pull request (reviewed, announced). Returns the thread's timestamp and the pull request. */
async function openOwnPull(e2e: E2e, file = "CONTRIBUTING.md"): Promise<{ ts: string; number: number; branch: string }> {
	const before = e2e.host.opened().length;
	e2e.faux.setResponses(pullSteps(file, `Add ${file}`, `I opened a pull request that adds ${file}.`));
	const ts = await e2e.mention(`please add ${file}`);
	await until(() => e2e.host.opened().length === before + 1, 20_000, "the pull request");
	await until(() => e2e.said().some((t) => t.includes(`adds ${file}.`)), 20_000, "the answer");
	await runOver(e2e, before + 1);
	const pull = e2e.host.opened()[before];
	return { ts, number: pull!.number, branch: pull!.pull!.head };
}

describe("end to end: Scout reviews pull requests it is asked to review", () => {
	it("posts a real review with a comment on a line, and says so in the repository's channel", async () => {
		const e2e = await startScout(START);
		let seen = "";
		try {
			const sha = branch(e2e, "feature", { "README.md": README }, "Add two lines");
			const number = e2e.host.pull(SLUG, { title: "Add two lines", head: "feature", author: "ann", reviewers: ["scout"] });
			e2e.faux.setResponses([
				(transcript) => {
					seen = JSON.stringify(transcript);
					return fauxAssistantMessage("CHANGES\nThe second line is not what the README promises.\n\n### README.md:2\nSay what this line is for.");
				},
			]);
			await e2e.service.tick.housekeeping();
			await until(() => hostReviews(e2e, number).length === 1 && posted(e2e, /asked for changes/), 20_000, "the review and its summary");

			assert.match(seen, /\+line two/, "the reviewer saw the diff");
			const [review] = hostReviews(e2e, number);
			assert.equal(review?.state, "COMMENT", "Scout's review never counts towards branch protection");
			assert.match(review?.body ?? "", /^I'd change these before merging\./);
			assert.equal(review?.commit_id, sha, "the review is of the commit it read");
			assert.match(review?.body ?? "", /second line is not what the README promises/);
			assert.match(review?.body ?? "", /ask me about it in #team/);
			const lines = e2e.host.get(SLUG, number)?.lines ?? [];
			assert.deepEqual(lines.map((l) => [l.path, l.line, l.body]), [["README.md", 2, "Say what this line is for."]]);

			const summary = e2e.slack.called("chat.postMessage").find((p) => /asked for changes/.test(String(p.args.text)));
			assert.equal(summary?.args.channel, TEAM_CHANNEL, "in the channel whose profile names the repository");
			assert.equal(summary?.args.thread_ts, undefined, "a message of its own, to start a thread");
			assert.match(String(summary?.args.text), new RegExp(`I asked for changes on <${e2e.host.webUrl}/acme/app/pulls/${number}\\|Add two lines> by ann \\(and 1 comment on lines\\)`));
			assert.match(String(summary?.args.text), /second line is not what the README promises/);
			assert.equal(e2e.faux.getPendingResponseCount(), 0);
		} finally {
			await finish(e2e);
		}
	});

	it("says a pull request that needs nothing looks good, without approving it, and with no comments on lines", async () => {
		const e2e = await startScout(START);
		try {
			branch(e2e, "feature", { "README.md": README }, "Add two lines");
			const number = e2e.host.pull(SLUG, { title: "Add two lines", head: "feature", author: "ann", reviewers: ["scout"] });
			e2e.faux.setResponses([fauxAssistantMessage("APPROVE\nSmall and clear.")]);
			await e2e.service.tick.housekeeping();
			await until(() => hostReviews(e2e, number).length === 1 && posted(e2e, /I found nothing blocking in/), 20_000, "the review and its summary");
			const [review] = hostReviews(e2e, number);
			assert.equal(review?.state, "COMMENT", "not an approval, which would count towards branch protection");
			assert.match(review?.body ?? "", /^Looks good to me\.\n\nSmall and clear\./);
			assert.deepEqual(e2e.host.get(SLUG, number)?.lines, []);
			assert.match(String(e2e.slack.called("chat.postMessage").find((p) => /I found nothing blocking in/.test(String(p.args.text)))?.args.text), /I found nothing blocking in <.*\|Add two lines> by ann\./);
		} finally {
			await finish(e2e);
		}
	});

	it("comments without a verdict when the reviewer gives none, and a comment on a line the diff does not show goes in the body", async () => {
		const e2e = await startScout(START);
		try {
			branch(e2e, "feature", { "README.md": README }, "Add two lines");
			const number = e2e.host.pull(SLUG, { title: "Add two lines", head: "feature", author: "ann", reviewers: ["scout"] });
			e2e.faux.setResponses([fauxAssistantMessage("COMMENT\nA question about the wording.\n\n### README.md:40\nThis line is not in the diff.")]);
			await e2e.service.tick.housekeeping();
			await until(() => hostReviews(e2e, number).length === 1 && posted(e2e, /I commented on/), 20_000, "the review and its summary");
			const [review] = hostReviews(e2e, number);
			assert.equal(review?.state, "COMMENT");
			assert.match(review?.body ?? "", /A question about the wording\./);
			assert.match(review?.body ?? "", /\*\*README\.md:40\*\*: This line is not in the diff\./);
			assert.deepEqual(e2e.host.get(SLUG, number)?.lines, [], "nothing pinned to a line the host would refuse");
		} finally {
			await finish(e2e);
		}
	});

	it("is not asked, so does not review: a pull request without Scout as a reviewer is left alone", async () => {
		const e2e = await startScout(START);
		try {
			branch(e2e, "feature", { "README.md": README }, "Add two lines");
			const number = e2e.host.pull(SLUG, { title: "Add two lines", head: "feature", author: "ann", reviewers: ["bob"] });
			await e2e.service.tick.housekeeping();
			assert.deepEqual(hostReviews(e2e, number), []);
			assert.equal(posted(e2e, /I (approved|asked for changes|commented)/), false);
			assert.equal(e2e.service.scout.pulls.latestReviews(5).length, 0);
		} finally {
			await finish(e2e);
		}
	});

	it("turns a request in the review's thread into a pull request into the reviewed branch, and never pushes to that branch", async () => {
		const e2e = await startScout(START);
		const transcripts: string[] = [];
		try {
			const sha = branch(e2e, "feature", { "README.md": README }, "Add two lines");
			const number = e2e.host.pull(SLUG, { title: "Add two lines", head: "feature", author: "ann", reviewers: ["scout"] });
			e2e.faux.setResponses([fauxAssistantMessage("CHANGES\nSay what line two is for.\n\n### README.md:2\nExplain this line.")]);
			await e2e.service.tick.housekeeping();
			await until(() => posted(e2e, /asked for changes/), 20_000, "the summary");
			const ts = tsOfPost(e2e, /asked for changes/);
			const scout = e2e.service.scout;
			await until(() => scout.threads.get(threadKey(TEAM_CHANNEL, ts)) !== undefined, 20_000, "the review's thread");

			// Ann asks, in that thread, for the fix.
			e2e.faux.setResponses([
				(transcript) => {
					transcripts.push(JSON.stringify(transcript));
					return fauxAssistantMessage([fauxToolCall("bash", { command: "printf 'line two says why.\\n' >> README.md && git add README.md && git commit -qm 'Explain line two'" })], toolUse);
				},
				fauxAssistantMessage([fauxToolCall("open_pull_request", { title: "Explain line two", body: "Fixes what I flagged in the review." })], toolUse),
				fauxAssistantMessage("APPROVE\nExplains it."),
				fauxAssistantMessage("I opened a pull request into feature that explains line two."),
			]);
			await e2e.mention("please fix what you flagged", { threadTs: ts });
			await until(() => e2e.host.opened().length === 1, 20_000, "the fix's pull request");
			await until(() => e2e.said().some((t) => t.includes("I opened a pull request into feature")), 20_000, "the answer");
			await scout.harness.waitForIdle(context);
			await runOver(e2e);

			assert.match(transcripts[0] ?? "", /Say what line two is for\./, "the thread knows its review");
			assert.match(transcripts[0] ?? "", /a fix you open with open_pull_request goes into that branch/);
			const [fix] = e2e.host.opened();
			assert.equal(fix?.pull?.base, "feature", "into the reviewed branch, as a pull request its author can merge or not");
			assert.match(fix?.pull?.head ?? "", /^scout\//, "from a branch of Scout's own");
			assert.equal(git("--git-dir", e2e.repo.remote, "rev-parse", "feature"), sha, "the author's branch was not pushed to");
			assert.equal(git("--git-dir", e2e.repo.remote, "show", `${fix?.pull?.head}:README.md`), `${README}line two says why.`, "it builds on their branch");
			assert.equal(e2e.host.get(SLUG, number)?.pull?.head, "feature");

			// Its own pull request is not reviewed as someone else's, however often the code host is looked at.
			await e2e.service.tick.housekeeping();
			await scout.harness.waitForIdle(context);
			assert.deepEqual(hostReviews(e2e, fix!.number), [], "Scout does not review its own pull request");
			assert.equal(hostReviews(e2e, number).length, 1, "and the reviewed one has no new push to review");
			assert.equal(e2e.faux.getPendingResponseCount(), 0);
		} finally {
			await finish(e2e);
		}
	});

	it("reviews again at each new push, and not otherwise", async () => {
		const e2e = await startScout(START);
		try {
			branch(e2e, "feature", { "README.md": README }, "Add two lines");
			const number = e2e.host.pull(SLUG, { title: "Add two lines", head: "feature", author: "ann", reviewers: ["scout"] });
			e2e.faux.setResponses([fauxAssistantMessage("CHANGES\nNeeds a heading.")]);
			await e2e.service.tick.housekeeping();
			await until(() => hostReviews(e2e, number).length === 1 && posted(e2e, /asked for changes/), 20_000, "the first review");

			// Looking again with nothing new does nothing.
			await e2e.service.tick.housekeeping();
			await e2e.service.scout.harness.waitForIdle(context);
			assert.equal(hostReviews(e2e, number).length, 1);

			// Ann pushes the heading.
			const second = branch(e2e, "feature", { "README.md": `# app\n${README}` }, "Add a heading");
			e2e.faux.setResponses([fauxAssistantMessage("APPROVE\nThe heading is there.")]);
			await e2e.service.tick.housekeeping();
			await until(() => hostReviews(e2e, number).length === 2 && posted(e2e, /I found nothing blocking in/), 20_000, "the second review");
			const reviews = hostReviews(e2e, number);
			assert.deepEqual(reviews.map((r) => r.state), ["COMMENT", "COMMENT"]);
			assert.equal(reviews[1]?.commit_id, second, "of the new commit");
			assert.equal(e2e.faux.getPendingResponseCount(), 0);
		} finally {
			await finish(e2e);
		}
	});

	it("reviews a pull request from a fork, whose thread gets the base branch rather than the fork's", async () => {
		const e2e = await startScout(START);
		const transcripts: string[] = [];
		try {
			// A fork's commits reach the mirror under a ref of the repository (as the hosts keep them for review).
			branch(e2e, "patch-1", { "README.md": README }, "A fork's change");
			const number = e2e.host.pull(SLUG, { title: "A fork's change", head: "patch-1", fork: "carol/app", author: "carol", reviewers: ["scout"] });
			e2e.faux.setResponses([fauxAssistantMessage("APPROVE\nFine.")]);
			await e2e.service.tick.housekeeping();
			await until(() => hostReviews(e2e, number).length === 1 && posted(e2e, /I found nothing blocking in/), 20_000, "the review");
			const ts = tsOfPost(e2e, /I found nothing blocking in/);
			const scout = e2e.service.scout;
			await until(() => scout.threads.get(threadKey(TEAM_CHANNEL, ts)) !== undefined, 20_000, "the review's thread");

			e2e.faux.setResponses([
				(transcript) => {
					transcripts.push(JSON.stringify(transcript));
					return fauxAssistantMessage("Their branch is in their fork, so I would open mine against main.");
				},
			]);
			await e2e.mention("can you fix what you would change?", { threadTs: ts });
			await until(() => e2e.said().some((t) => t.includes("in their fork")), 20_000, "the answer");
			await runOver(e2e);
			assert.match(transcripts[0] ?? "", /The pull request comes from a fork, so your sandbox has the repository's base branch, not its branch\./);
			assert.doesNotMatch(transcripts[0] ?? "", /a fix you open with open_pull_request goes into that branch/);
		} finally {
			await finish(e2e);
		}
	});
});

/** What the code host shows on an issue or pull request: its comments' bodies, oldest first. */
const comments = (e2e: E2e, number: number) => (e2e.host.get(SLUG, number)?.comments ?? []).map((c) => c.body);
const commentsBy = (e2e: E2e, number: number, who: string) => (e2e.host.get(SLUG, number)?.comments ?? []).filter((c) => c.user.login === who).map((c) => c.body);

describe("end to end: work asked on the code host", () => {
	it("answers a mention in an issue in a thread in the repository's channel, and on a private repository copies the answer back", async () => {
		const e2e = await startScout(START);
		const prompts: string[] = [];
		try {
			e2e.host.repo(SLUG, { private: true });
			const number = e2e.host.issue(SLUG, { title: "How do we release?", body: "@scout how do we cut a release?", author: "ann" });
			e2e.host.notify(SLUG, number);
			e2e.faux.setResponses([
				(transcript) => {
					prompts.push(JSON.stringify(transcript));
					return fauxAssistantMessage("Tag main, then run the deploy script. Ann knows the details.");
				},
			]);
			await e2e.service.tick.inbox();
			await until(() => commentsBy(e2e, number, "scout").length === 2, 20_000, "Scout's two comments");
			await runOver(e2e, 0);

			assert.deepEqual(e2e.host.reactions, [`${SLUG}#${number} eyes`], "👀 on the issue: picked up");
			const root = e2e.slack.called("chat.postMessage").find((p) => /asked me on/.test(String(p.args.text)));
			assert.equal(root?.args.channel, TEAM_CHANNEL, "in the channel whose profile names the repository");
			assert.equal(root?.args.thread_ts, undefined);
			assert.match(String(root?.args.text), new RegExp(`📥 \\*ann\\* asked me on <${e2e.host.webUrl}/acme/app/issues/${number}\\|acme/app#${number}>: How do we release\\?\\n> How do we release\\?\\n> \\n> @scout how do we cut a release\\?`));
			const ts = tsOfPost(e2e, /asked me on/);
			assert.ok(e2e.said().some((t) => t.includes("Tag main, then run the deploy script.")), "the answer is said in Slack");
			assert.ok(e2e.slack.called("chat.postMessage").every((p) => p.args.thread_ts === undefined || p.args.thread_ts === ts), "all in the one thread");
			assert.match(prompts[0] ?? "", /ann asked you in issue acme\/app#1/);
			assert.match(prompts[0] ?? "", /how do we cut a release\?/);

			const link = `https://acme.slack.com/archives/${TEAM_CHANNEL}/p${ts.replace(".", "")}`;
			assert.deepEqual(commentsBy(e2e, number, "scout"), [
				`On it, in the open: [#team](${link}). I'll answer here too.`,
				`Tag main, then run the deploy script. Ann knows the details.\n\n---\nFrom the thread: ${link}`,
			]);
			assert.equal(e2e.host.called("PATCH", /\/notifications\/threads\//).length, 1, "the notification is marked read");
			await e2e.service.tick.inbox();
			assert.equal(commentsBy(e2e, number, "scout").length, 2, "and the same comment is not a second request");
		} finally {
			await finish(e2e);
		}
	});

	it("copies the answer back to the issue even when Scout stops right after answering", async () => {
		const e2e = await startScout(START);
		try {
			e2e.host.repo(SLUG, { private: true });
			const number = e2e.host.issue(SLUG, { title: "How do we release?", body: "@scout how do we cut a release?", author: "ann" });
			e2e.host.notify(SLUG, number);
			e2e.faux.setResponses([fauxAssistantMessage("Tag main, then run the deploy script.")]);
			await e2e.service.tick.inbox();
			await until(() => commentsBy(e2e, number, "scout").length === 1, 20_000, "the pointer comment");
			// A slow code host: the copied answer is still on its way when Scout stops.
			e2e.host.slow("POST", /\/issues\/\d+\/comments$/, 1_500);
			// Wait for the copy itself to reach the host (and sit in its hold), not for the answer in Slack: Scout posts that a
			// moment before it starts the copy, and stopping in between is a different case than the one under test.
			await until(() => e2e.host.arrived("POST", /\/issues\/\d+\/comments$/).length === 2, 20_000, "the copy on its way to the issue");
			// Stop at once, as a drain or SIGTERM would right after an answer: the copy to the issue still lands.
			await e2e.service.close();
			assert.equal(commentsBy(e2e, number, "scout").length, 2, "the pointer and the copied answer");
			assert.match(commentsBy(e2e, number, "scout")[1] ?? "", /Tag main, then run the deploy script\./);
		} finally {
			await e2e.close();
		}
	});

	it("on a public repository answers the issue with a pointer to the thread and the pull request it opened, never the answer", async () => {
		const e2e = await startScout(START);
		const prompts: string[] = [];
		try {
			const number = e2e.host.issue(SLUG, { title: "Add a contributing guide", body: "@scout could you add CONTRIBUTING.md?", author: "ann" });
			e2e.host.notify(SLUG, number);
			const pullUrl = `${e2e.host.webUrl}/acme/app/pulls/${number + 1}`;
			const [commit, open, review] = pullSteps("CONTRIBUTING.md", "Add a contributing guide", "");
			e2e.faux.setResponses([
				(transcript) => {
					prompts.push(JSON.stringify(transcript));
					return commit!;
				},
				open!,
				review!,
				fauxAssistantMessage(`Opened ${pullUrl}. Bob said in #team that the guide should stay short, so it is.`),
			]);
			await e2e.service.tick.inbox();
			await until(() => commentsBy(e2e, number, "scout").length === 2, 20_000, "Scout's two comments");
			await runOver(e2e, 0);

			assert.match(prompts[0] ?? "", /Closes #1/, "the issue's pull request is asked to close it");
			const ts = tsOfPost(e2e, /asked me on/);
			const link = `https://acme.slack.com/archives/${TEAM_CHANNEL}/p${ts.replace(".", "")}`;
			const [, pointer] = commentsBy(e2e, number, "scout");
			assert.equal(pointer, `I've answered in the Slack thread: ${link}\n\nPull request: ${pullUrl}`);
			assert.doesNotMatch(comments(e2e, number).join("\n"), /Bob said in #team/, "what was said in Slack stays there");
			assert.equal(e2e.host.opened()[0]?.number, number + 1);
		} finally {
			await finish(e2e);
		}
	});

	it("also points instead of copying when the code host will not say whether the repository is private", async () => {
		const e2e = await startScout(START);
		try {
			e2e.host.repo(SLUG, { private: true });
			const number = e2e.host.issue(SLUG, { title: "Question", body: "@scout what does the build do?", author: "ann" });
			e2e.host.notify(SLUG, number);
			// The repository lookup is the one call to `/repos/acme/app` itself: the host is having a bad day.
			e2e.host.fail("GET", /^\/repos\/acme\/app$/, 500, 1);
			e2e.faux.setResponses([fauxAssistantMessage("It runs the tests, then the type check.")]);
			await e2e.service.tick.inbox();
			await until(() => commentsBy(e2e, number, "scout").length === 2, 20_000, "Scout's two comments");
			await runOver(e2e, 0);
			assert.match(commentsBy(e2e, number, "scout")[1] ?? "", /^I've answered in the Slack thread: https:\/\/acme\.slack\.com\/archives\//);
			assert.doesNotMatch(comments(e2e, number).join("\n"), /runs the tests/);
		} finally {
			await finish(e2e);
		}
	});

	it("starts a thread for an issue assigned to Scout, saying so", async () => {
		const e2e = await startScout(START);
		try {
			const number = e2e.host.issue(SLUG, { title: "Typo in the README", body: "The word 'teh' appears twice.", author: "ann", assignees: ["scout"] });
			e2e.host.notify(SLUG, number);
			e2e.faux.setResponses([fauxAssistantMessage("Both are in the README's second paragraph; I can fix them.")]);
			await e2e.service.tick.inbox();
			await until(() => commentsBy(e2e, number, "scout").length === 2, 20_000, "Scout's two comments");
			await runOver(e2e, 0);
			assert.match(String(e2e.slack.called("chat.postMessage").find((p) => /assigned me </.test(String(p.args.text)))?.args.text), /📥 \*ann\* assigned me <.*\|acme\/app#1>: Typo in the README\n> Typo in the README/);
		} finally {
			await finish(e2e);
		}
	});

	it("takes a mention in a comment on someone's pull request to a thread whose changes would go into that branch", async () => {
		const e2e = await startScout(START);
		const prompts: string[] = [];
		try {
			branch(e2e, "feature", { "README.md": README }, "Add two lines");
			const number = e2e.host.pull(SLUG, { title: "Add two lines", head: "feature", author: "ann" });
			e2e.host.comment(SLUG, number, "bob", "@scout does this handle an empty README?");
			e2e.faux.setResponses([
				(transcript) => {
					prompts.push(JSON.stringify(transcript));
					return fauxAssistantMessage("An empty README is fine: nothing reads it.");
				},
			]);
			await e2e.service.tick.inbox();
			await until(() => commentsBy(e2e, number, "scout").length === 2, 20_000, "Scout's two comments");
			await runOver(e2e, 0);
			assert.match(prompts[0] ?? "", /bob asked you in pull request acme\/app#1/);
			assert.match(prompts[0] ?? "", /Changes you make here go into the pull request's own branch, feature\./);
			assert.deepEqual(e2e.host.reactions, [`${SLUG} comment ${e2e.host.get(SLUG, number)!.comments[0]!.id} eyes`], "👀 on the comment that asked");
			assert.match(commentsBy(e2e, number, "scout")[1] ?? "", /^I've answered in the Slack thread: /);
			assert.match(String(e2e.slack.called("chat.postMessage").find((p) => /asked me on/.test(String(p.args.text)))?.args.text), /\*bob\* asked me on <.*\|acme\/app#1>/);
		} finally {
			await finish(e2e);
		}
	});

	it("keeps one thread per issue: a second mention goes to the same thread and is answered there", async () => {
		const e2e = await startScout(START);
		try {
			const number = e2e.host.issue(SLUG, { title: "Flaky test", body: "@scout the login test is flaky", author: "ann" });
			e2e.host.notify(SLUG, number);
			e2e.faux.setResponses([fauxAssistantMessage("It depends on the clock; I would freeze it.")]);
			await e2e.service.tick.inbox();
			await until(() => commentsBy(e2e, number, "scout").length === 2, 20_000, "the first answer");
			await runOver(e2e, 0);
			const ts = tsOfPost(e2e, /asked me on/);

			e2e.host.comment(SLUG, number, "bob", "@scout yes, please freeze it");
			e2e.faux.setResponses([fauxAssistantMessage("Frozen in the test's setup.")]);
			await e2e.service.tick.inbox();
			await until(() => commentsBy(e2e, number, "scout").length === 3, 20_000, "the second answer");
			await e2e.service.scout.harness.waitForIdle(context);
			const roots = e2e.slack.called("chat.postMessage").filter((p) => /asked me on/.test(String(p.args.text)));
			assert.equal(roots.length, 1, "no second thread");
			const inThread = e2e.slack.called("chat.postMessage").filter((p) => p.args.thread_ts === ts).map((p) => String(p.args.text));
			assert.ok(inThread.some((t) => /\*bob\* on <.*>:\n> @scout yes, please freeze it/.test(t)), "bob's words are quoted there");
			assert.ok(e2e.said().some((t) => t.includes("Frozen in the test's setup.")), "and answered there");
			assert.match(commentsBy(e2e, number, "scout")[2] ?? "", /^I've answered in the Slack thread: /);
		} finally {
			await finish(e2e);
		}
	});

	it("tells people on the code host when Scout is not set up for their repository", async () => {
		const e2e = await startScout(START);
		try {
			e2e.host.repo("acme/other");
			const number = e2e.host.issue("acme/other", { title: "Help", body: "@scout help", author: "ann" });
			e2e.host.notify("acme/other", number);
			await e2e.service.tick.inbox();
			assert.deepEqual(e2e.host.get("acme/other", number)?.comments.map((c) => c.body), ["I'm not set up to work in acme/other, so I can't take this on. Whoever runs me can add it."]);
			assert.equal(e2e.slack.called("chat.postMessage").length, 0, "nothing in Slack");
		} finally {
			await finish(e2e);
		}
	});

	it("tells someone who may not change the repository so, and starts no work", async () => {
		const e2e = await startScout({ ...START, env: { ...START.env, SCOUT_REQUESTER_CHECK: "enforce" } });
		try {
			e2e.host.collaborator(SLUG, "ann", "read");
			e2e.host.collaborator(SLUG, "bob", "write");
			const number = e2e.host.issue(SLUG, { title: "Please", body: "@scout rewrite everything", author: "ann" });
			e2e.host.notify(SLUG, number);
			await e2e.service.tick.inbox();
			assert.deepEqual(comments(e2e, number), ["@ann You (ann) can't change acme/app, so I can't change it for you. Someone who can could ask instead."]);
			assert.equal(e2e.slack.called("chat.postMessage").length, 0);
			assert.deepEqual(e2e.host.reactions, [], "not picked up");

			// Someone who can change it, asking in the same issue, is taken up.
			e2e.faux.setResponses([fauxAssistantMessage("Not everything; I would start with the build.")]);
			e2e.host.comment(SLUG, number, "bob", "@scout what would you start with?");
			await e2e.service.tick.inbox();
			await until(() => commentsBy(e2e, number, "scout").length === 3, 20_000, "the answer to bob");
			await runOver(e2e, 0);
		} finally {
			await finish(e2e);
		}
	});

	it("treats a comment on Scout's own pull request as context and a review asking for changes as work", async () => {
		const e2e = await startScout(START);
		const prompts: string[] = [];
		try {
			const { ts, number, branch: head } = await openOwnPull(e2e);

			// A friendly comment is quoted in the thread and known to it, but starts no run.
			e2e.host.comment(SLUG, number, "ann", "Nice, thanks!");
			await e2e.service.tick.inbox();
			const quoted = () => e2e.slack.called("chat.postMessage").filter((p) => p.args.thread_ts === ts).map((p) => String(p.args.text));
			await until(() => quoted().some((t) => t.includes("> Nice, thanks!")), 20_000, "the comment quoted in the thread");
			assert.equal(e2e.faux.getPendingResponseCount(), 0);
			assert.equal(e2e.host.reactions.length, 0, "no 👀: it was not a request");

			// A review asking for changes, with a comment on a line, is a request to the same thread.
			const [, , review, answer] = pullSteps("CONTRIBUTING.md", "Shorten it", "I shortened it.");
			e2e.faux.setResponses([
				(transcript) => {
					prompts.push(JSON.stringify(transcript));
					return fauxAssistantMessage([fauxToolCall("bash", { command: "printf 'Be brief.\\n' > CONTRIBUTING.md && git add CONTRIBUTING.md && git commit -qm 'Shorten it'" })], toolUse);
				},
				fauxAssistantMessage([fauxToolCall("open_pull_request", { title: "Add CONTRIBUTING.md", body: "Shorter now." })], toolUse),
				review!,
				answer!,
			]);
			e2e.host.review(SLUG, number, "bob", "REQUEST_CHANGES", "Too long.", [{ path: "CONTRIBUTING.md", line: 1, body: "Cut this." }]);
			e2e.host.notify(SLUG, number);
			await e2e.service.tick.inbox();
			await until(() => e2e.said().some((t) => t.includes("I shortened it.")), 20_000, "the answer");
			await runOver(e2e, 0);
			assert.ok(quoted().some((t) => /\*bob\* asked for changes on <.*>:\n> Too long\./.test(t)), "the review is quoted in the thread");
			assert.ok(quoted().some((t) => /\*bob\* asked for changes on CONTRIBUTING\.md:1 on <.*>:\n> Cut this\./.test(t)), "and its comment on the line, with the line");
			assert.match(prompts[0] ?? "", /make it and call open_pull_request again: it updates the same pull request/);
			assert.equal(e2e.host.opened().length, 1, "the same pull request, updated");
			assert.equal(git("--git-dir", e2e.repo.remote, "show", `${head}:CONTRIBUTING.md`), "Be brief.");
			// Scout's reply on the pull request is its answer in the thread, which for its own pull request needs no comment.
			assert.equal(e2e.host.reactions.length, 0, "reviews and comments on lines are nowhere both hosts let you react");
		} finally {
			await finish(e2e);
		}
	});
});

const DAY = 24 * 60 * 60 * 1000;
/** A clock that can be moved forward, for what Scout does after days of quiet. */
const clockStart = () => {
	const clock = { offset: 0, now: () => Date.now() + clock.offset };
	return clock;
};
const inThreadOf = (e2e: E2e, ts: string) => e2e.slack.called("chat.postMessage").filter((p) => p.args.thread_ts === ts).map((p) => String(p.args.text));
/** Wait for the answer to a run Scout started itself, then for the run to be over. */
async function answered(e2e: E2e, text: string): Promise<void> {
	await until(() => e2e.said().some((t) => t.includes(text)), 20_000, `Scout to say "${text}"`);
	await runOver(e2e, 0);
}

describe("end to end: CI on Scout's pull requests", () => {
	it("stays quiet while CI is pending, and says in the thread once, when it passes", async () => {
		const e2e = await startScout(START);
		try {
			const { ts, number } = await openOwnPull(e2e);
			const sha = e2e.host.headOf(SLUG, number);
			e2e.host.ci(sha, "pending");
			await e2e.service.tick.ci();
			assert.equal(inThreadOf(e2e, ts).filter((t) => t.includes("CI")).length, 0);

			e2e.host.ci(sha, "success");
			await e2e.service.tick.ci();
			await e2e.service.tick.ci();
			const passed = inThreadOf(e2e, ts).filter((t) => t.includes("CI passed"));
			assert.deepEqual(passed, [`✅ CI passed on <${e2e.host.webUrl}/acme/app/pulls/${number}|Add CONTRIBUTING.md> at \`${sha.slice(0, 7)}\`.`]);
		} finally {
			await finish(e2e);
		}
	});

	it("hands a red build back to the thread, which pushes a fix to the same pull request; the green after it is announced", async () => {
		const e2e = await startScout(START);
		const prompts: string[] = [];
		try {
			const { ts, number } = await openOwnPull(e2e);
			const red = e2e.host.headOf(SLUG, number);
			e2e.host.ci(red, "failure", "ci/test", { description: "2 tests failed", target_url: "/acme/app/actions/runs/7" });
			const [commit, open, review, done] = pullSteps("fix.txt", "Fix the build", "The guide broke the lint step; fixed.");
			e2e.faux.setResponses([
				(transcript) => {
					prompts.push(JSON.stringify(transcript));
					return commit!;
				},
				open!,
				review!,
				done!,
			]);
			await e2e.service.tick.ci();
			await answered(e2e, "The guide broke the lint step; fixed.");

			assert.match(prompts[0] ?? "", /CI failed on your pull request .*pulls\/1 \(acme\/app #1\) at /);
			assert.match(prompts[0] ?? "", new RegExp(`• ci/test: failure \\(${e2e.host.webUrl}/acme/app/actions/runs/7\\)`), "the failing check, with a link made absolute");
			assert.match(prompts[0] ?? "", /This is automatic attempt 1 of 2\./);
			assert.equal(e2e.host.opened().length, 1, "the fix updated the pull request");
			const green = e2e.host.headOf(SLUG, number);
			assert.notEqual(green, red, "with a new commit");

			// The fix is not announced until CI has said so for it.
			await e2e.service.tick.ci();
			assert.equal(inThreadOf(e2e, ts).filter((t) => t.includes("CI passed")).length, 0);
			e2e.host.ci(green, "success");
			await e2e.service.tick.ci();
			assert.ok(inThreadOf(e2e, ts).includes(`✅ CI passed on <${e2e.host.webUrl}/acme/app/pulls/${number}|Add CONTRIBUTING.md> at \`${green.slice(0, 7)}\`.`));
			assert.equal(e2e.faux.getPendingResponseCount(), 0);
		} finally {
			await finish(e2e);
		}
	});

	it("tries twice to fix a red build, then asks a person and stops", async () => {
		const e2e = await startScout(START);
		try {
			const { ts, number } = await openOwnPull(e2e);
			const first = e2e.host.headOf(SLUG, number);
			e2e.host.ci(first, "failure");
			e2e.faux.setResponses(pullSteps("fix1.txt", "Fix the build", "First try pushed."));
			await e2e.service.tick.ci();
			await answered(e2e, "First try pushed.");

			const second = e2e.host.headOf(SLUG, number);
			e2e.host.ci(second, "failure");
			e2e.faux.setResponses(pullSteps("fix2.txt", "Fix the build", "Second try pushed."));
			await e2e.service.tick.ci();
			await answered(e2e, "Second try pushed.");

			const third = e2e.host.headOf(SLUG, number);
			assert.equal(new Set([first, second, third]).size, 3);
			e2e.host.ci(third, "failure");
			await e2e.service.tick.ci();
			assert.deepEqual(
				inThreadOf(e2e, ts).filter((t) => t.includes("CI is still red")),
				[`CI is still red on <${e2e.host.webUrl}/acme/app/pulls/${number}|Add CONTRIBUTING.md> at \`${third.slice(0, 7)}\` after 2 tries at fixing it. <@U0ANN00001>, could you take a look? I'll stop retrying.`],
			);
			await e2e.service.tick.ci();
			assert.equal(inThreadOf(e2e, ts).filter((t) => t.includes("CI is still red")).length, 1, "once");
			assert.equal(e2e.faux.getPendingResponseCount(), 0, "and no third attempt");
		} finally {
			await finish(e2e);
		}
	});
});

describe("end to end: looking after Scout's pull requests", () => {
	it("asks the thread to bring a pull request that no longer merges up to date, twice, then asks a person", async () => {
		const e2e = await startScout(START);
		const prompts: string[] = [];
		try {
			const { ts, number } = await openOwnPull(e2e);
			const pull = e2e.host.get(SLUG, number)!.pull!;
			pull.mergeable = true;
			await e2e.service.tick.housekeeping();
			assert.equal(inThreadOf(e2e, ts).filter((t) => t.includes("merge")).length, 0, "a pull request that merges is left alone");

			pull.mergeable = false;
			for (const [attempt, say] of ["One.", "Two."].entries()) {
				e2e.repo.commit({ [`moved${attempt}.txt`]: "main moved\n" }, `Move main ${attempt}`);
				e2e.repo.push("main");
				e2e.faux.setResponses([
					(transcript) => {
						prompts.push(JSON.stringify(transcript));
						return fauxAssistantMessage(`Conflict ${say} I rebased and pushed.`);
					},
				]);
				await e2e.service.tick.housekeeping();
				await answered(e2e, `Conflict ${say}`);
				await e2e.service.tick.housekeeping();
				assert.equal(e2e.faux.getPendingResponseCount(), 0);
			}
			assert.match(prompts[0] ?? "", /no longer merges cleanly into main/);
			assert.match(prompts[0] ?? "", /This is automatic attempt 1 of 2\./);
			assert.match(prompts[1] ?? "", /This is automatic attempt 2 of 2\./);
			assert.equal(prompts.length, 2, "the same pair of commits is not asked about twice");

			e2e.repo.commit({ "moved2.txt": "main moved again\n" }, "Move main again");
			e2e.repo.push("main");
			await e2e.service.tick.housekeeping();
			assert.ok(
				inThreadOf(e2e, ts).includes(`<${e2e.host.webUrl}/acme/app/pulls/${number}|Add CONTRIBUTING.md> still doesn't merge cleanly into main after 2 tries at bringing it up to date. <@U0ANN00001>, could you take a look?`),
			);
		} finally {
			await finish(e2e);
		}
	});

	it("asks whoever wanted a quiet pull request if it is still wanted, then closes it with a note if nobody answers", async () => {
		const clock = clockStart();
		const e2e = await startScout({ ...START, now: clock.now });
		try {
			const { ts, number } = await openOwnPull(e2e);
			await e2e.service.tick.housekeeping();
			assert.equal(inThreadOf(e2e, ts).filter((t) => t.includes("no activity")).length, 0, "not while it is fresh");

			clock.offset = 15 * DAY;
			await e2e.service.tick.housekeeping();
			const nudge = (text: string) => /has had no activity for 1[45] days\. Is it still wanted\? If nothing changes, I'll close it in 7 days; it can be reopened for 30 days after that\./.test(text);
			assert.ok(inThreadOf(e2e, ts).some((t) => t.startsWith("<@U0ANN00001> <") && nudge(t)), "Ann is asked in the thread");
			assert.ok(commentsBy(e2e, number, "scout").some((t) => /^This has had no activity for 1[45] days\./.test(t)), "and on the pull request");
			assert.equal(e2e.host.get(SLUG, number)?.state, "open");

			await e2e.service.tick.housekeeping();
			assert.equal(commentsBy(e2e, number, "scout").length, 1, "once");

			clock.offset = 23 * DAY;
			await e2e.service.tick.housekeeping();
			assert.equal(e2e.host.get(SLUG, number)?.state, "closed");
			assert.ok(commentsBy(e2e, number, "scout").some((t) => /^Closing this: no activity for 2[23] days, including since I asked whether it's still wanted\./.test(t)));
			assert.ok(inThreadOf(e2e, ts).some((t) => /^I closed <.*\|Add CONTRIBUTING\.md> after 2[23] quiet days\. If it's still wanted, reopen it within 30 days, or ask me here\.$/.test(t)));
		} finally {
			await finish(e2e);
		}
	});

	it("deletes the branch of a merged pull request at once, and of a closed one only after the grace period", async () => {
		const clock = clockStart();
		const e2e = await startScout({ ...START, now: clock.now });
		try {
			const merged = await openOwnPull(e2e, "MERGED.md");
			e2e.host.merge(SLUG, merged.number);
			await e2e.service.tick.housekeeping();
			assert.deepEqual(e2e.host.deleted, [`${SLUG}:${merged.branch}`], "merged: gone at once");

			// The thread keeps one branch for all its pull requests, so a second thread makes the second.
			const closed = await openOwnPull(e2e, "CLOSED.md");
			e2e.host.closePull(SLUG, closed.number);
			await e2e.service.tick.housekeeping();
			assert.equal(e2e.host.deleted.length, 1, "closed: kept, in case it is reopened");
			clock.offset = 29 * DAY;
			await e2e.service.tick.housekeeping();
			assert.equal(e2e.host.deleted.length, 1);
			clock.offset = 31 * DAY;
			await e2e.service.tick.housekeeping();
			assert.deepEqual(e2e.host.deleted, [`${SLUG}:${merged.branch}`, `${SLUG}:${closed.branch}`]);
		} finally {
			await finish(e2e);
		}
	});

	it("reminds a channel once a working day about pull requests that have waited on review", async () => {
		const clock = clockStart();
		const e2e = await startScout({ ...START, now: clock.now });
		try {
			branch(e2e, "feature", { "README.md": README }, "Add two lines");
			const number = e2e.host.pull(SLUG, { title: "Add two lines", head: "feature", author: "ann", reviewers: ["bob"] });
			// Four days on, a weekday morning.
			const later = new Date(Date.now() + 4 * DAY);
			later.setHours(10, 0, 0, 0);
			while (later.getDay() === 0 || later.getDay() === 6) later.setDate(later.getDate() + 1);
			clock.offset = later.getTime() - Date.now();

			await e2e.service.tick.housekeeping();
			const reminders = () => e2e.slack.called("chat.postMessage").filter((p) => /waiting on review/.test(String(p.args.text)));
			await until(() => reminders().length === 1, 20_000, "the reminder");
			assert.equal(reminders()[0]?.args.channel, TEAM_CHANNEL);
			assert.match(String(reminders()[0]?.args.text), new RegExp(`A few pull requests have been waiting on review for a while:\\n• <${e2e.host.webUrl}/acme/app/pulls/${number}\\|acme/app#${number}> Add two lines by ann: waiting on <@U0BOB00001> for [3-7] days`));
			await e2e.service.tick.housekeeping();
			assert.equal(reminders().length, 1, "once a day");
		} finally {
			await finish(e2e);
		}
	});
});
