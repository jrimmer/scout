import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { threadKey } from "../src/threads.ts";
import { type E2e, type E2eOptions, startScout } from "./e2e.ts";
import { ANN, BOB, ELSEWHERE_CHANNEL, SCOUT, SECRET_CHANNEL, TEAM_CHANNEL } from "./fake-slack.ts";
import { git, tempDir, until } from "./helpers.ts";

const toolUse = { stopReason: "toolUse" } as const;
const WAIT = 20_000;
const ENDINGS = new Set(["white_check_mark", "warning", "hand", "raising_hand"]);

/** Start Scout in front of the fakes, run `body`, and close everything even when it fails. */
async function withScout(options: E2eOptions, body: (e2e: E2e) => Promise<void>): Promise<void> {
	const e2e = await startScout(options);
	try {
		await body(e2e);
	} finally {
		await e2e.close();
	}
}

/** Files Scout reads at start (settings that name a path) live here; gone after `body`. */
async function withFiles<T>(files: Record<string, unknown>, body: (paths: Record<string, string>) => Promise<T>): Promise<T> {
	const dir = tempDir("scout-e2e-files-");
	const paths: Record<string, string> = {};
	for (const [name, content] of Object.entries(files)) {
		paths[name] = join(dir, name);
		writeFileSync(paths[name], typeof content === "string" ? content : JSON.stringify(content));
	}
	try {
		return await body(paths);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const bash = (command: string) => fauxAssistantMessage([fauxToolCall("bash", { command })], toolUse);
const commit = (file: string, text: string) => bash(`printf '${text}\\n' > ${file} && git add ${file} && git commit -qm 'Add ${file}'`);
const openPull = (title: string, body = "As asked.") => fauxAssistantMessage([fauxToolCall("open_pull_request", { title, body })], toolUse);

/**
 * A step in a script that holds a run until the test lets it go: once the model is asked for it, `started` says so,
 * and the run's shell waits for a file (30 s at most) until `open`.
 */
function gate(e2e: E2e, name = "go") {
	const file = join(e2e.root, name);
	let started = false;
	return {
		hold: () => {
			started = true;
			return bash(`for i in $(seq 600); do [ -f ${file} ] && break; sleep 0.05; done`);
		},
		started: () => until(() => started, WAIT, "the run to reach the held step"),
		open: () => writeFileSync(file, ""),
	};
}

const said = (e2e: E2e, text: string | RegExp) => e2e.said().some((t) => (typeof text === "string" ? t.includes(text) : text.test(t)));
const saidSoon = (e2e: E2e, text: string | RegExp) => until(() => said(e2e, text), WAIT, `Scout to say ${String(text)}`);
/** Messages Scout posted in a thread, in order. */
const inThread = (e2e: E2e, ts: string, channel = TEAM_CHANNEL) => e2e.slack.called("chat.postMessage").filter((c) => c.args.thread_ts === ts && c.args.channel === channel);
const idle = (e2e: E2e) => e2e.service.scout.harness.waitForIdle(context);
/** Each message that got a reaction, with the ones it got, in order. */
function reactionsByMessage(e2e: E2e): Map<string, string[]> {
	const by = new Map<string, string[]>();
	for (const c of e2e.slack.called("reactions.add")) by.set(String(c.args.timestamp), [...(by.get(String(c.args.timestamp)) ?? []), String(c.args.name)]);
	return by;
}
/**
 * Wait until `requests` messages have been marked as ended (✅, ⚠️, ✋, 🙋) and nothing is half-way: the last thing
 * Scout does for a request, and what lets a test close without a Slack call in flight.
 */
async function ended(e2e: E2e, requests: number): Promise<Map<string, string[]>> {
	await until(
		() => {
			const by = reactionsByMessage(e2e);
			return by.size >= requests && [...by.values()].every((names) => ENDINGS.has(names.at(-1) ?? ""));
		},
		WAIT,
		`${requests} request(s) to be marked as ended`,
	);
	return reactionsByMessage(e2e);
}

let replies = 0;
/** Someone posts in a thread without mentioning Scout (fixture: message-thread-reply); returns the message's timestamp. */
async function say(e2e: E2e, threadTs: string, user: string, text: string): Promise<string> {
	const envelope = e2e.slack.envelope("message-thread-reply");
	const ts = `1700000500.${String(100 + replies++ * 100).padStart(6, "0")}`;
	Object.assign(envelope.payload.event as object, { text, user, ts, event_ts: ts, thread_ts: threadTs, client_msg_id: `e2e-say-${ts}`, channel: TEAM_CHANNEL });
	Object.assign(envelope.payload, { event_id: `Ev-e2e-say-${ts}` });
	await e2e.slack.receiver.deliver(envelope);
	return ts;
}

/** A reaction on a message (fixture: reaction-added); returns what Slack's ack got. */
async function react(e2e: E2e, name: string, ts: string, user = ANN, channel = TEAM_CHANNEL): Promise<unknown> {
	const envelope = e2e.slack.envelope("reaction-added");
	const event = envelope.payload.event as { reaction: string; user: string; item: { channel: string; ts: string }; event_ts: string };
	Object.assign(event, { reaction: name, user, event_ts: `1700000900.${String(100 + replies++ * 100).padStart(6, "0")}` });
	Object.assign(event.item, { channel, ts });
	return e2e.slack.receiver.deliver(envelope);
}

/** Someone edits a message of theirs (fixture: message-changed). */
async function edit(e2e: E2e, ts: string, user: string, text: string, threadTs?: string): Promise<void> {
	const envelope = e2e.slack.envelope("message-changed");
	const event = envelope.payload.event as { message: Record<string, unknown>; previous_message: Record<string, unknown> };
	Object.assign(event.message, { ts, user, text: `<@${SCOUT}> ${text}`, thread_ts: threadTs });
	if (threadTs === undefined) delete event.message.thread_ts;
	Object.assign(event.previous_message, { ts, user, text: "an earlier version" });
	await e2e.slack.receiver.deliver(envelope);
}

/** Someone deletes a message (fixture: message-deleted). */
async function remove(e2e: E2e, ts: string): Promise<void> {
	const envelope = e2e.slack.envelope("message-deleted");
	Object.assign(envelope.payload.event as object, { deleted_ts: ts, channel: TEAM_CHANNEL });
	await e2e.slack.receiver.deliver(envelope);
}

/** What the model was last told, as one string (what a transcript's last message holds). */
const lastSaid = (transcript: { messages: unknown[] }) => JSON.stringify(transcript.messages.at(-1));

/**
 * The newcomer's core loop through Slack, as people use it: asking, steering, stopping, retrying, and being told no.
 * Each test starts Scout the way main.ts does (src/service.ts) in front of fake Slack, a fake code host and a scripted
 * model, sends Slack events through Bolt, and checks what Slack and the code host were shown.
 */
describe("e2e: requests", () => {
	it("steers a run in progress with what people say in its thread, without mentioning Scout", async () => {
		await withScout({}, async (e2e) => {
			const hold = gate(e2e);
			let seen = "";
			e2e.faux.setResponses([
				hold.hold,
				(transcript) => {
					seen = lastSaid(transcript);
					return fauxAssistantMessage("Docs updated, and the build step is mentioned too.");
				},
			]);
			const ts = await e2e.mention("update the docs");
			await hold.started();
			// Bob, not mentioning anyone, adds to the request while Scout is working: it steers that run.
			const bobTs = await say(e2e, ts, BOB, "also mention the build step");
			hold.open();
			await saidSoon(e2e, "the build step is mentioned too");
			await ended(e2e, 2);
			await idle(e2e);
			assert.match(seen, /Bob Example: also mention the build step/, "the model saw Bob's words with its next step");
			assert.equal(e2e.faux.getPendingResponseCount(), 0);
			assert.equal(reactionsByMessage(e2e).get(bobTs)?.at(-1), "white_check_mark", "Bob's message was marked as answered too");
		});
	});

	it("answers a follow-up after the run finished with a new run, which pushes to the same pull request", async () => {
		await withScout({}, async (e2e) => {
			const { host, faux, repo } = e2e;
			faux.setResponses([
				commit("ONE.md", "one"),
				openPull("Add notes"),
				fauxAssistantMessage("APPROVE\nFine."),
				fauxAssistantMessage("Opened it with ONE.md."),
				commit("TWO.md", "two"),
				openPull("Add notes"),
				fauxAssistantMessage("APPROVE\nFine too."),
				fauxAssistantMessage("Added TWO.md to the same pull request."),
			]);
			const ts = await e2e.mention("add ONE.md with a line");
			await saidSoon(e2e, "Opened it with ONE.md.");
			await ended(e2e, 1);
			await idle(e2e);
			assert.equal(host.opened().length, 1);
			const branch = git("--git-dir", repo.remote, "for-each-ref", "--format=%(refname:short)", "refs/heads/scout/");

			// Ann answers Scout in the thread, with no mention: she is the person it was answering, so it is for Scout.
			await say(e2e, ts, ANN, "thanks, now add TWO.md as well");
			await saidSoon(e2e, "Added TWO.md to the same pull request.");
			await ended(e2e, 2);
			await idle(e2e);
			assert.equal(host.opened().length, 1, "still one pull request");
			assert.equal(git("--git-dir", repo.remote, "show", `${branch}:ONE.md`), "one");
			assert.equal(git("--git-dir", repo.remote, "show", `${branch}:TWO.md`), "two", "the second run's commit went to the same branch");
			assert.equal(git("--git-dir", repo.remote, "rev-list", "--count", `main..${branch}`), "2");
			assert.equal(inThread(e2e, ts).length > 1, true, "both answers are in the one thread");
			assert.equal(faux.getPendingResponseCount(), 0);
		});
	});

	it("stops a run when someone says \"@Scout stop\" in its thread, and says who stopped it", async () => {
		await withScout({}, async (e2e) => {
			const hold = gate(e2e);
			e2e.faux.setResponses([hold.hold, fauxAssistantMessage("I should never get to say this.")]);
			try {
				const ts = await e2e.mention("rewrite everything");
				await hold.started();
				await e2e.mention("stop", { user: BOB, threadTs: ts });
				await saidSoon(e2e, "Stopped by Bob Example.");
				const marks = await ended(e2e, 1);
				assert.deepEqual(marks.get(ts)?.at(-1), "hand", "the request is marked as stopped");
				assert.equal(said(e2e, "I should never get to say this."), false);
				assert.equal(e2e.faux.getPendingResponseCount(), 1, "the model was not asked again");
			} finally {
				hold.open();
			}
			await idle(e2e);
		});
	});

	it("stops a run on a stop-sign reaction on the thread's first message", async () => {
		await withScout({}, async (e2e) => {
			const hold = gate(e2e);
			e2e.faux.setResponses([hold.hold, fauxAssistantMessage("I should never get to say this.")]);
			try {
				const ts = await e2e.mention("rewrite everything");
				await hold.started();
				await react(e2e, "octagonal_sign", ts, ANN);
				await saidSoon(e2e, "Stopped by Ann.");
				const marks = await ended(e2e, 1);
				assert.equal(marks.get(ts)?.at(-1), "hand");
				assert.equal(said(e2e, "I should never get to say this."), false);
			} finally {
				hold.open();
			}
			await idle(e2e);
		});
	});

	it("says plainly when a run hits a problem, and a 🔁 on that answer tries again", async () => {
		await withScout({}, async (e2e) => {
			let retried = "";
			e2e.faux.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "the model is down" }),
				(transcript) => {
					retried = JSON.stringify(transcript.messages);
					return fauxAssistantMessage("Back now: the answer is 42.");
				},
			]);
			const ts = await e2e.mention("what is the answer?");
			await saidSoon(e2e, /ran into a problem and stopped/);
			await ended(e2e, 1);
			await idle(e2e);
			assert.equal(reactionsByMessage(e2e).get(ts)?.at(-1), "warning");

			// Scout's answer is its run message, edited: the timestamp its last edit names.
			const latestAnswer = String(e2e.slack.called("chat.update").at(-1)?.args.ts);
			await react(e2e, "repeat", latestAnswer, BOB);
			await saidSoon(e2e, "Back now: the answer is 42.");
			await ended(e2e, 2);
			await idle(e2e);
			assert.match(retried, /Bob Example: @Scout 🔁 please try that again, picking up where it stopped\./);
		});
	});

	it("steers a run in progress when the person who asked edits their request", async () => {
		await withScout({}, async (e2e) => {
			const hold = gate(e2e);
			let seen = "";
			e2e.faux.setResponses([
				hold.hold,
				(transcript) => {
					seen = lastSaid(transcript);
					return fauxAssistantMessage("Updated both files.");
				},
			]);
			const ts = await e2e.mention("update the docs");
			await hold.started();
			await edit(e2e, ts, BOB, "update the docs and the changelog");
			await edit(e2e, ts, ANN, "update the docs and the changelog");
			hold.open();
			await saidSoon(e2e, "Updated both files.");
			await ended(e2e, 1);
			await idle(e2e);
			assert.match(seen, /Ann edited their request: @Scout update the docs and the changelog/, "only the person who asked can steer by editing");
			assert.equal(seen.match(/edited their request/g)?.length, 1);
		});
	});

	it("starts a waiting request with its edited text, and drops one whose message was deleted", async () => {
		await withScout({ env: { SCOUT_MAX_RUNS: "1", SCOUT_MAX_RUNS_PER_CHANNEL: "1" } }, async (e2e) => {
			const hold = gate(e2e);
			let seen = "";
			e2e.faux.setResponses([
				hold.hold,
				fauxAssistantMessage("First one done."),
				(transcript) => {
					seen = lastSaid(transcript);
					return fauxAssistantMessage("The edited one is done.");
				},
			]);
			try {
				await e2e.mention("first job");
				await hold.started();
				const edited = await e2e.mention("second job, as first written", { user: BOB });
				const deleted = await e2e.mention("a third job nobody wants any more", { user: ANN });
				await until(() => e2e.service.scout.threads.queued().length === 2, WAIT, "both requests to wait");
				await edit(e2e, edited, BOB, "second job, as corrected");
				await remove(e2e, deleted);
				assert.equal(e2e.service.scout.threads.queued().length, 1, "the deleted request no longer waits");
				hold.open();
				await saidSoon(e2e, "The edited one is done.");
				await ended(e2e, 2);
				await idle(e2e);
				assert.match(seen, /Bob Example: @Scout second job, as corrected/);
				assert.equal(e2e.faux.getPendingResponseCount(), 0, "the deleted request never reached the model");
			} finally {
				hold.open();
			}
		});
	});

	it("won't put a credential in a pull request: the change is refused and nothing is opened", async () => {
		await withScout({}, async (e2e) => {
			let refusal = "";
			e2e.faux.setResponses([
				commit("config.txt", "aws_key=AKIAIOSFODNN7EXAMPLE"),
				openPull("Add the config"),
				(transcript) => {
					refusal = lastSaid(transcript);
					return fauxAssistantMessage("I can't open that: the file has what looks like an AWS key. I'll leave it out.");
				},
			]);
			await e2e.mention("add config.txt with our key");
			await saidSoon(e2e, "I can't open that: the file has what looks like an AWS key.");
			await ended(e2e, 1);
			await idle(e2e);
			assert.match(refusal, /This change adds what looks like a credential: AWS access key in config\.txt/);
			assert.equal(e2e.host.opened().length, 0, "no pull request");
			assert.equal(git("--git-dir", e2e.repo.remote, "for-each-ref", "--format=%(refname:short)", "refs/heads/scout/"), "", "and nothing was pushed");
		});
	});
});

/** Who may ask, what it may cost, and how much runs at once: the ways Scout says no, or not yet. */
describe("e2e: declines", () => {
	const people = { [ANN]: "ann", [BOB]: "bob" };

	it("tells a requester without write access to the repository why not, and does no work for them", async () => {
		await withFiles({ "people.json": people }, async (files) => {
			await withScout({ env: { SCOUT_REQUESTER_CHECK: "enforce", SCOUT_PEOPLE_FILE: files["people.json"]! } }, async (e2e) => {
				e2e.host.collaborator("acme/app", "ann", "write");
				e2e.host.collaborator("acme/app", "bob", "read");
				const ts = await e2e.mention("please change the build", { user: BOB });
				await until(() => inThread(e2e, ts).length > 0, WAIT, "Scout's reply");
				assert.match(String(inThread(e2e, ts)[0]?.args.text), /^<@U0BOB00001> You \(bob\) can't change acme\/app, so I can't change it for you/);
				assert.equal(e2e.service.scout.threads.get(threadKey(TEAM_CHANNEL, ts)), undefined, "no thread was started");
				assert.equal(e2e.slack.called("reactions.add").length, 0, "nothing was picked up");

				// Someone not linked to a code host account at all is told that instead.
				const stranger = await e2e.mention("and me?", { user: "U0NOBODY01" });
				await until(() => inThread(e2e, stranger).length > 0, WAIT, "Scout's reply to the stranger");
				assert.match(String(inThread(e2e, stranger)[0]?.args.text), /I don't know your Forgejo account yet/);

				// Ann, who can change it, is served.
				e2e.faux.setResponses([fauxAssistantMessage("Done, nothing needed changing.")]);
				await e2e.mention("is the build fine?");
				await saidSoon(e2e, "Done, nothing needed changing.");
				await ended(e2e, 1);
			});
		});
	});

	it("lets someone without access talk in a thread, but their words don't steer a run", async () => {
		await withFiles({ "people.json": people }, async (files) => {
			await withScout({ env: { SCOUT_REQUESTER_CHECK: "enforce", SCOUT_PEOPLE_FILE: files["people.json"]! } }, async (e2e) => {
				e2e.host.collaborator("acme/app", "ann", "write");
				e2e.host.collaborator("acme/app", "bob", "read");
				const hold = gate(e2e);
				let seen = "";
				e2e.faux.setResponses([
					hold.hold,
					(transcript) => {
						seen = lastSaid(transcript);
						return fauxAssistantMessage("Done as Ann asked.");
					},
				]);
				const ts = await e2e.mention("tidy the readme");
				await hold.started();
				const bobTs = await say(e2e, ts, BOB, "delete the whole repository");
				await until(() => inThread(e2e, ts).some((c) => String(c.args.text).includes("<@U0BOB00001> You (bob) can't change acme/app")), WAIT, "Bob to be told no");
				hold.open();
				await saidSoon(e2e, "Done as Ann asked.");
				const marks = await ended(e2e, 1);
				await idle(e2e);
				// Kept as context for the thread, like anything said there, but not taken up as a request: no 👀 or ✅ on it.
				assert.match(seen, /Bob Example: delete the whole repository/);
				assert.equal(marks.has(bobTs), false, "Bob's message was not taken up as a request");
				assert.equal(
					inThread(e2e, ts).filter((c) => String(c.args.text).includes("can't change acme/app")).length,
					1,
					"and he was told why, once",
				);
			});
		});
	});

	it("declines a request in a channel that has used its weekly budget, and shows the cost on answers before that", async () => {
		await withFiles({ "limits.json": { weekly: { perChannel: 0.5 } }, "prices.json": { "faux/m": { input: 1_000_000, output: 1_000_000 } } }, async (files) => {
			await withScout({ env: { SCOUT_LIMITS_FILE: files["limits.json"]!, SCOUT_PRICES_FILE: files["prices.json"]! } }, async (e2e) => {
				e2e.faux.setResponses([fauxAssistantMessage("Short answer.")]);
				await e2e.mention("what's in the readme?");
				await saidSoon(e2e, "Short answer.");
				await ended(e2e, 1);
				await idle(e2e);
				const footer = JSON.stringify(e2e.slack.called("chat.update").at(-1)?.args.blocks);
				assert.match(footer, /\$\d+\.\d\d · \$\d+\.\d\d of \$0\.5 this week/, "the answer's footer says what it cost against the budget");

				const second = await e2e.mention("and the changelog?");
				await until(() => inThread(e2e, second).length > 0, WAIT, "Scout's reply");
				assert.match(String(inThread(e2e, second)[0]?.args.text), /^<@U0ANN00001> This channel has used its \$0\.5 of Scout for the week\. It resets on Monday/);
				assert.equal(e2e.service.scout.threads.get(threadKey(TEAM_CHANNEL, second)), undefined, "no work started");
				assert.equal(e2e.faux.getPendingResponseCount(), 0);
			});
		});
	});

	it("stops a single run that goes past its tool-call limit, and tells the model to say where it got to", async () => {
		await withFiles({ "limits.json": { perRun: { maxToolCalls: 1 } } }, async (files) => {
			await withScout({ env: { SCOUT_LIMITS_FILE: files["limits.json"]! } }, async (e2e) => {
				let afterSecond = "";
				e2e.faux.setResponses([
					bash("echo one"),
					bash("echo two"),
					(transcript) => {
						afterSecond = lastSaid(transcript);
						return fauxAssistantMessage("I got as far as the first step and stopped. Shall I keep going?");
					},
				]);
				await e2e.mention("run a long job");
				await saidSoon(e2e, "I got as far as the first step and stopped. Shall I keep going?");
				await ended(e2e, 1);
				assert.match(afterSecond, /This request has used its 1 tool calls\. Stop here: say what you've done and what's left, and ask whether to keep going\./);
				assert.equal(e2e.faux.getPendingResponseCount(), 0);
			});
		});
	});

	it("queues a request when Scout is at capacity, says so with a place in line, and starts it when a run finishes", async () => {
		await withScout({ env: { SCOUT_MAX_RUNS: "1", SCOUT_MAX_RUNS_PER_CHANNEL: "1" } }, async (e2e) => {
			const hold = gate(e2e);
			e2e.faux.setResponses([hold.hold, fauxAssistantMessage("First one done."), fauxAssistantMessage("Second one done, after waiting.")]);
			try {
				const first = await e2e.mention("first job");
				await hold.started();
				const second = await e2e.mention("second job", { user: BOB });
				await until(() => said(e2e, /⏳/), WAIT, "the waiting notice");
				assert.match(textsIn(e2e, second), /⏳ I'm working on 1 things? already\. I'll start on this as soon as one finishes\./);
				assert.equal(e2e.service.scout.threads.queued().length, 1);
				await until(() => reactionsByMessage(e2e).get(second)?.includes("hourglass_flowing_sand") === true, WAIT, "an hourglass on the waiting request");
				assert.equal(said(e2e, "Second one done, after waiting."), false, "it has not started");

				hold.open();
				await saidSoon(e2e, "First one done.");
				await saidSoon(e2e, "Second one done, after waiting.");
				const marks = await ended(e2e, 2);
				assert.equal(marks.get(first)?.at(-1), "white_check_mark");
				assert.equal(marks.get(second)?.at(-1), "white_check_mark");
				assert.equal(e2e.service.scout.threads.queued().length, 0, "the queue is empty");
			} finally {
				hold.open();
			}
		});
	});
});

/** Everything Scout posted in a thread and edited in the channel, as text to match against. */
function textsIn(e2e: E2e, ts: string): string {
	const edits = e2e.slack.called("chat.update").filter((c) => c.args.channel === TEAM_CHANNEL);
	return [...inThread(e2e, ts), ...edits].map((c) => JSON.stringify(c.args.blocks ?? c.args.text)).join("\n");
}

/** Ways in besides mentioning Scout: the Ask Scout shortcut and its form, 🔍 on a message, and `/scout`. */
describe("e2e: other ways in", () => {
	/** The form Ann's shortcut opens, submitted (fixture: view-submission-ask), with its channel, user and request changed. */
	async function submitForm(e2e: E2e, at: { channel?: string; user?: string; request?: string } = {}): Promise<unknown> {
		const envelope = e2e.slack.envelope("view-submission-ask");
		const payload = envelope.payload as { user: { id: string }; view: { private_metadata: string; state: { values: { request: { text: { value: string } } } } } };
		if (at.channel !== undefined) payload.view.private_metadata = JSON.stringify({ ...JSON.parse(payload.view.private_metadata), channel: at.channel });
		if (at.user !== undefined) payload.user.id = at.user;
		if (at.request !== undefined) payload.view.state.values.request.text.value = at.request;
		return e2e.slack.receiver.deliver(envelope);
	}

	/** `/scout <text>` from someone (fixture: slash-command); what Scout answered them with, privately. */
	async function slash(e2e: E2e, text: string, user = ANN): Promise<string> {
		const before = e2e.slack.responded.length;
		const envelope = e2e.slack.envelope("slash-command");
		Object.assign(envelope.payload, { text, user_id: user });
		await e2e.slack.receiver.deliver(envelope);
		await until(() => e2e.slack.responded.length > before, WAIT, "Scout's answer to the command");
		const answer = e2e.slack.responded.at(-1)!.body;
		assert.equal(answer.response_type, "ephemeral", "commands are answered to whoever asked");
		return String(answer.text);
	}

	it("opens a form from the Ask Scout shortcut, and the submitted form starts a thread on that message", async () => {
		await withScout({}, async (e2e) => {
			// The shortcut on Bob's message: Slack gets a form quoting it.
			const acked = await e2e.slack.receiver.deliver(e2e.slack.envelope("shortcut-ask"));
			assert.equal(acked, null);
			const [opened] = e2e.slack.called("views.open");
			const view = opened?.args.view as { callback_id: string; private_metadata: string; blocks: { text?: { text: string } }[] };
			assert.equal(opened?.args.trigger_id, "1.1700000007.trigger");
			assert.equal(view.callback_id, "scout_ask_form");
			assert.match(String(view.blocks[0]?.text?.text), /> the deploy failed again\n> see the log/);

			// Ann fills it in: a thread on Bob's message, started as if she had asked there.
			let seen = "";
			e2e.faux.setResponses([
				(transcript) => {
					seen = lastSaid(transcript);
					return fauxAssistantMessage("It failed because the disk was full.");
				},
			]);
			assert.equal(await submitForm(e2e), null, "the form is accepted");
			await saidSoon(e2e, "It failed because the disk was full.");
			await ended(e2e, 1);
			const thread = "1700000000.000100";
			assert.equal(inThread(e2e, thread)[0]?.args.text, "<@U0ANN00001> asked me about this: why did it fail?", "the thread says who asked, in the message's own thread");
			assert.match(seen, /Ann: @Scout why did it fail\?/);
			assert.match(seen, /About <@U0BOB00001>'s message:\\n> the deploy failed again/);
			assert.ok(e2e.service.scout.threads.get(threadKey(TEAM_CHANNEL, thread)), "Scout follows that thread now");
		});
	});

	it("refuses the form in a private channel or one Scout isn't in, inside the form", async () => {
		await withScout({}, async (e2e) => {
			for (const channel of [SECRET_CHANNEL, ELSEWHERE_CHANNEL]) {
				const acked = (await submitForm(e2e, { channel })) as { response_action: string; errors: { request: string } };
				assert.equal(acked.response_action, "errors");
				assert.match(acked.errors.request, /I only work in public channels I'm in\. Invite me here/);
			}
			assert.equal(e2e.slack.called("chat.postMessage").length, 0, "nothing was started or posted");
			assert.equal(e2e.service.scout.threads.get(threadKey(SECRET_CHANNEL, "1700000000.000100")), undefined);
		});
	});

	it("tells someone who may not ask for work, in the thread, when their form is submitted", async () => {
		await withFiles({ "people.json": { [ANN]: "ann", [BOB]: "bob" } }, async (files) => {
			await withScout({ env: { SCOUT_REQUESTER_CHECK: "enforce", SCOUT_PEOPLE_FILE: files["people.json"]! } }, async (e2e) => {
				e2e.host.collaborator("acme/app", "bob", "read");
				await submitForm(e2e, { user: BOB });
				const thread = "1700000000.000100";
				await until(() => inThread(e2e, thread).length > 1, WAIT, "Scout's refusal");
				assert.match(String(inThread(e2e, thread)[1]?.args.text), /^<@U0BOB00001> You \(bob\) can't change acme\/app/);
				assert.equal(e2e.faux.getPendingResponseCount(), 0);
				assert.equal(e2e.slack.called("reactions.add").length, 0, "no work was picked up");
			});
		});
	});

	it("looks into a message when someone reacts to it with 🔍, in public channels only", async () => {
		await withScout({}, async (e2e) => {
			e2e.slack.answer("conversations.history", () => ({ ok: true, messages: [{ type: "message", user: BOB, text: "the deploy failed again", ts: "1700000000.000200" }] }));
			let seen = "";
			e2e.faux.setResponses([
				(transcript) => {
					seen = lastSaid(transcript);
					return fauxAssistantMessage("Looked: the deploy ran out of disk.");
				},
			]);
			// In a channel Scout may not work in, the reaction does nothing.
			await react(e2e, "mag", "1700000000.000200", ANN, SECRET_CHANNEL);
			assert.equal(e2e.slack.called("chat.postMessage").length, 0);

			await react(e2e, "mag", "1700000000.000200", ANN);
			await saidSoon(e2e, "Looked: the deploy ran out of disk.");
			await ended(e2e, 1);
			const thread = "1700000000.000200";
			assert.equal(inThread(e2e, thread)[0]?.args.text, "<@U0ANN00001> asked me to look into this.");
			assert.match(seen, /Ann: @Scout Look into this\./);
			assert.match(seen, /About <@U0BOB00001>'s message:\\n> the deploy failed again/);
		});
	});

	it("answers /scout status with what Scout is doing, and /scout with anything else with what it can do", async () => {
		await withScout({}, async (e2e) => {
			assert.match(await slash(e2e, "status"), /^Not working on anything else right now\.\n0 request\(s\) waiting to start\./);
			const help = await slash(e2e, "what");
			for (const command of ["status", "doctor", "schedules", "waiting", "ask"]) assert.match(help, new RegExp(`\`/scout ${command}`));

			const hold = gate(e2e);
			e2e.faux.setResponses([hold.hold, fauxAssistantMessage("Done.")]);
			try {
				await e2e.mention("a long job");
				await hold.started();
				assert.match(await slash(e2e, "status"), /Working on 1 thing:\n- #team, \d+ min/);
			} finally {
				hold.open();
			}
			await saidSoon(e2e, "Done.");
			await ended(e2e, 1);
		});
	});

	it("runs the doctor from /scout doctor against the running service, and reports what is wrong", async () => {
		await withScout({ env: { SCOUT_BACKUP: "none" } }, async (e2e) => {
			e2e.faux.setResponses([fauxAssistantMessage("ok")]);
			const report = await slash(e2e, "doctor");
			assert.match(report, /✅ Forgejo: signed in as scout/, "it asked the code host");
			assert.match(report, /✅ Model: faux\/m/, "it asked the model");
			assert.match(report, /✅ Repository app/);
			assert.match(report, /⚠️ Slack: signed in as scout in Acme, but these are off for want of scopes/, "it asked Slack, and said what the scopes leave out");
			assert.doesNotMatch(report, /❌/, "nothing is broken");

			// With the model out of answers, the same command says so, and what to check.
			const broken = await slash(e2e, "doctor");
			assert.match(broken, /❌ Model: faux\/m didn't answer/);
			assert.match(broken, /Check the provider's status, the key/);
		});
	});

	it("lists a channel's schedules with /scout schedules, once Scout set one up in a thread", async () => {
		await withScout({}, async (e2e) => {
			assert.equal(await slash(e2e, "schedules"), "No schedules in this channel. Ask me in a thread for recurring work.");
			e2e.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("schedule", { cron: "0 9 * * 1", when: "every Monday at 9:00", task: "check for dependency updates" })], toolUse),
				fauxAssistantMessage("Set: every Monday at 9:00 I'll check for dependency updates."),
			]);
			await e2e.mention("every Monday at 9, check for dependency updates");
			await saidSoon(e2e, "Set: every Monday at 9:00");
			await ended(e2e, 1);
			assert.match(await slash(e2e, "schedules"), /^#1: every Monday at 9:00, check for dependency updates$/);
		});
	});

	it("lists what is waiting on someone with /scout waiting, once Scout asked them a question", async () => {
		await withScout({}, async (e2e) => {
			assert.equal(await slash(e2e, "waiting"), "Nothing's waiting on you.");
			e2e.faux.setResponses([fauxAssistantMessage("Which environment should I deploy to?")]);
			await e2e.mention("deploy the app");
			await saidSoon(e2e, "Which environment should I deploy to?");
			const marks = await ended(e2e, 1);
			assert.equal([...marks.values()][0]?.at(-1), "raising_hand", "the request is marked as waiting on someone");
			await idle(e2e);
			assert.match(await slash(e2e, "waiting"), /^• .*#team.*: /);
		});
	});

	it("starts a thread from /scout ask, links to it, and answers there", async () => {
		await withScout({}, async (e2e) => {
			assert.match(await slash(e2e, "ask"), /^What should I do\?/);
			let seen = "";
			e2e.faux.setResponses([
				(transcript) => {
					seen = lastSaid(transcript);
					return fauxAssistantMessage("Fixed the flaky test by seeding the clock.");
				},
			]);
			const reply = await slash(e2e, "ask fix the flaky login test");
			assert.match(reply, /^On it: <https:\/\/acme\.slack\.com\/archives\/C0TEAM0001\/p\d+\|the thread>\.$/);
			await saidSoon(e2e, "Fixed the flaky test by seeding the clock.");
			await ended(e2e, 1);
			const intro = e2e.slack.called("chat.postMessage")[0]!;
			assert.equal(intro.args.text, "<@U0ANN00001> asked me: fix the flaky login test");
			assert.match(seen, /Ann: @Scout fix the flaky login test/);
		});
	});
});

/** Several approaches at once (experimental): asked for in a thread, compared side by side, and one chosen. */
describe("e2e: approaches", () => {
	/**
	 * One model plays the thread and each approach, told apart by what it was asked: the thread tries a cache and a
	 * query fix; each approach commits its own file and reports; later the thread opens the pull request when asked.
	 */
	function plays(transcript: { messages: unknown[] }) {
		const all = JSON.stringify(transcript.messages);
		const last = lastSaid(transcript);
		const mine = /Yours: \*(Cache|Query)\*/.exec(all)?.[1];
		if (mine !== undefined) {
			if (/"role":"toolResult"/.test(last)) return fauxAssistantMessage(`Added ${mine.toLowerCase()}.txt.\nTrade-off: ${mine === "Cache" ? "stale data" : "a migration"}.\nTests: passed`);
			return commit(`${mine.toLowerCase()}.txt`, mine);
		}
		if (/"role":"toolResult"/.test(last)) return fauxAssistantMessage(/Pull request:/.test(last) ? "Opened the pull request with the query fix." : "Both are up; pick one.");
		if (/Ann: @Scout try/.test(last)) {
			return fauxAssistantMessage([fauxToolCall("try_approaches", { request: "make the page faster", approaches: [{ name: "Cache", plan: "cache results" }, { name: "Query", plan: "fix the query" }] })], toolUse);
		}
		if (/Ann: @Scout open the pull request/.test(last)) return openPull("Fix the slow query");
		return fauxAssistantMessage("APPROVE\nLooks right."); // the pull request's self-review
	}

	/** Ask for the approaches and wait for the comparison with its buttons; returns the thread and the Use 2 button's value. */
	async function askForBoth(e2e: E2e): Promise<{ ts: string; use2: string; comparison: string }> {
		e2e.faux.setResponses(Array.from({ length: 12 }, () => plays));
		const ts = await e2e.mention("try a cache, or fixing the query, to make the page faster");
		await saidSoon(e2e, "Both are up; pick one.");
		await ended(e2e, 1);
		await idle(e2e);
		const shown = [...e2e.slack.called("chat.postMessage"), ...e2e.slack.called("chat.update")].map((c) => JSON.stringify(c.args.blocks ?? []));
		const comparison = shown.filter((b) => b.includes("scout_use_approach_2")).at(-1);
		assert.ok(comparison !== undefined, "the thread has a comparison with a button per approach");
		const use2 = /"action_id":"scout_use_approach_2".*?"value":"(\d+:2)"/.exec(comparison)?.[1];
		assert.ok(use2 !== undefined);
		return { ts, use2, comparison };
	}

	/** Someone presses a "Use" button (fixture: action-use-approach). */
	async function use(e2e: E2e, value: string, user: string) {
		const before = e2e.slack.responded.length;
		const envelope = e2e.slack.envelope("action-use-approach");
		const payload = envelope.payload as { user: { id: string }; actions: { value: string; action_id: string }[] };
		payload.user.id = user;
		Object.assign(payload.actions[0]!, { value, action_id: "scout_use_approach_2" });
		await e2e.slack.receiver.deliver(envelope);
		await until(() => e2e.slack.responded.length > before, WAIT, "the answer to the button");
		return e2e.slack.responded.at(-1)!.body;
	}

	it("tries two approaches side by side, compares them in the thread, and carries the chosen one into the pull request", async () => {
		await withScout({}, async (e2e) => {
			const { ts, use2, comparison } = await askForBoth(e2e);
			assert.match(comparison, /🧪 _Experimental:_ trying 2 approaches side by side/);
			assert.match(comparison, /\*1\. Cache\*: tests passed/);
			assert.match(comparison, /\*2\. Query\*: tests passed/);
			assert.match(comparison, /Trade-off: stale data/);
			assert.match(comparison, /Use 2\. Query/);

			// Ann chooses the second: the buttons give way to who chose, and the thread says so.
			const replaced = await use(e2e, use2, ANN);
			assert.equal(replaced.replace_original, true);
			assert.match(JSON.stringify(replaced.blocks), /<@U0ANN00001> chose \*2\. Query\*/);
			assert.doesNotMatch(JSON.stringify(replaced.blocks), /scout_use_approach/, "no buttons any more");
			await until(() => inThread(e2e, ts).some((c) => /<@U0ANN00001> chose approach 2, \*Query\*\. Its commits are on this thread's branch now/.test(String(c.args.text))), WAIT, "the thread to be told");

			// The thread carries on from there: the pull request has the chosen approach's work and not the other's.
			await e2e.mention("open the pull request", { threadTs: ts });
			await saidSoon(e2e, "Opened the pull request with the query fix.");
			await ended(e2e, 2);
			await idle(e2e);
			const branch = git("--git-dir", e2e.repo.remote, "for-each-ref", "--format=%(refname:short)", "refs/heads/scout/");
			assert.equal(git("--git-dir", e2e.repo.remote, "show", `${branch}:query.txt`), "Query");
			assert.throws(() => git("--git-dir", e2e.repo.remote, "show", `${branch}:cache.txt`), "the approach that was not chosen is not in it");
			assert.equal(e2e.host.opened().length, 1);
		});
	});

	it("keeps someone who may not ask for work from choosing an approach, and says why only to them", async () => {
		await withFiles({ "people.json": { [ANN]: "ann", [BOB]: "bob" } }, async (files) => {
			await withScout({ env: { SCOUT_REQUESTER_CHECK: "enforce", SCOUT_PEOPLE_FILE: files["people.json"]! } }, async (e2e) => {
				e2e.host.collaborator("acme/app", "ann", "write");
				e2e.host.collaborator("acme/app", "bob", "read");
				const { ts, use2 } = await askForBoth(e2e);
				const refused = await use(e2e, use2, BOB);
				assert.equal(refused.response_type, "ephemeral");
				assert.match(String(refused.text), /^You \(bob\) can't change acme\/app/);
				assert.equal(inThread(e2e, ts).some((c) => /chose approach/.test(String(c.args.text))), false, "nothing was chosen");

				// Ann still can.
				const chosen = await use(e2e, use2, ANN);
				assert.match(JSON.stringify(chosen.blocks), /<@U0ANN00001> chose \*2\. Query\*/);
			});
		});
	});
});

