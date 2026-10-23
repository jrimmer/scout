import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, MemoryStorage, watchEvents } from "@earendil-works/pi-durable";
import { loadConfig, useScoutsKey } from "./config.ts";
import { ThreadDoc } from "./docs.ts";
import { describeStep } from "./render.ts";
import { redact } from "./scan.ts";
import { openScout, type Scout } from "./scout.ts";
import { resolveSecrets } from "./secrets.ts";
import { startupProblem } from "./startup.ts";

/**
 * Job mode: one task, no Slack, nothing kept. Provision a workspace, run, stream progress, clean up; for CI and batch
 * work ("upgrade this dependency", "fix this lint rule everywhere"). The same agent as a thread, including self-review
 * and pull requests, so a job's output is reviewed like anything else Scout does.
 *
 *     npm run job -- "Bump typescript to the latest 7.x and fix what breaks"
 *     npm run job -- --repo storefront "Fix the flaky cart test"
 *
 * Prints progress to stderr and the answer to stdout; exits 1 if the work did not finish.
 */
export async function runJob(
	scout: Scout,
	prompt: string,
	io: { progress: (line: string) => void },
	options: { repo?: string } = {},
): Promise<{ ok: boolean; answer: string; pullRequests: string[]; problem?: string }> {
	const context = BACKGROUND_CONTEXT;
	const conversation = await scout.harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: scout.workAgent,
			init: async (tx, id) => {
				if (options.repo !== undefined) (await tx.doc(ThreadDoc, id)).repo = options.repo;
			},
		},
		context,
	);
	const events = await watchEvents(scout.harness, conversation.id as ConversationId, context);
	let answer = "";
	let failedCall: string | undefined;
	events.start(async (batch) => {
		for (const event of batch) {
			if (event.type === "tool_execution_start" && event.parentToolCallId === undefined) {
				io.progress(describeStep(event.toolName, event.args).replaceAll("`", ""));
			}
			if (event.type === "message_end") {
				const message = event.entry.model?.[0];
				const stop = message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
				failedCall = stop?.role === "assistant" && stop.stopReason === "error" ? (stop.errorMessage ?? "no reason given") : undefined;
				if (message?.role === "assistant") {
					const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
					if (text !== "") answer = text;
				}
			}
		}
	});
	try {
		const settled = await (await conversation.submit({ type: "input", content: prompt }, context)).wait(context);
		const ok = settled.status === "done";
		// A run that didn't finish says why: the last model call's error (a bad key, an unknown model), else the status.
		const problem = ok ? undefined : failedCall !== undefined ? `the model didn't answer: ${failedCall.slice(0, 300)}` : `the run ended as ${settled.status}`;
		return {
			ok,
			answer,
			pullRequests: scout.pulls.forConversation(conversation.id).map((p) => p.url),
			...(problem === undefined ? {} : { problem }),
		};
	} finally {
		await events.stop();
		await scout.workspaces.remove(conversation.id);
	}
}

/** The first line of what went wrong: what the command said on stderr, else the error's message. */
export function reportLine(error: unknown): string {
	const stderr = (error as { stderr?: unknown } | null)?.stderr;
	const text = typeof stderr === "string" && stderr.trim() !== "" ? stderr : error instanceof Error ? error.message : String(error);
	return redact(text.trim().split("\n")[0]!.replace(/^fatal: /, "")).slice(0, 300);
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const repoFlag = args.indexOf("--repo");
	const repo = repoFlag === -1 ? undefined : args.splice(repoFlag, 2)[1];
	const prompt = args.join(" ").trim();
	if (prompt === "") {
		console.error('usage: npm run job -- [--repo name] "what to do"');
		process.exit(2);
	}
	process.on("uncaughtException", (error) => {
		console.error(startupProblem(error) ?? error);
		process.exit(1);
	});
	// Secrets may be references, as for the service; a job never talks to Slack, so its tokens needn't resolve.
	delete process.env.SLACK_BOT_TOKEN;
	delete process.env.SLACK_APP_TOKEN;
	await resolveSecrets();
	const config = loadConfig();
	if (repo !== undefined && !config.repos.some((r) => r.name === repo)) {
		console.error(`no repository named ${repo}; configured: ${config.repos.map((r) => r.name).join(", ")}`);
		process.exit(2);
	}
	useScoutsKey(config.git.sshKey);
	// Nothing is kept: conversations live in memory and start at 1 each run, so the rest gets its own folder too.
	const instance = `job${randomBytes(3).toString("hex")}`;
	const dataDir = join(config.dataDir, "jobs", instance);
	// The harness's reports carry whole stacks; a job says what went wrong in one line, in its own closing line.
	let reported: string | undefined;
	const scout = await openScout({
		config,
		storage: new MemoryStorage(),
		dataDir,
		instance,
		context: BACKGROUND_CONTEXT,
		watchProfile: false,
		onReport: (error) => {
			reported = reportLine(error);
		},
	});
	const result = await runJob(scout, prompt, { progress: (line) => console.error(`• ${line}`) }, repo === undefined ? {} : { repo });
	await scout.close();
	rmSync(dataDir, { recursive: true, force: true });
	if (!result.ok) console.error(`Scout couldn't finish: ${result.problem ?? "the run failed"}${reported === undefined ? "" : ` (${reported})`}`);
	console.log(result.answer);
	for (const url of result.pullRequests) console.log(url);
	process.exit(result.ok ? 0 : 1);
}
