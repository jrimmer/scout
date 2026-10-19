import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, MemoryStorage, watchEvents } from "@earendil-works/pi-durable";
import { loadConfig, useScoutsKey } from "./config.ts";
import { describeStep } from "./render.ts";
import { openScout, type Scout } from "./scout.ts";

/**
 * Job mode: one task, no Slack, nothing kept. Provision a workspace, run, stream progress, clean up; for CI and batch
 * work ("upgrade this dependency", "fix this lint rule everywhere"). The same agent as a thread, including self-review
 * and pull requests, so a job's output is reviewed like anything else Scout does.
 *
 *     npm run job -- "Bump typescript to the latest 7.x and fix what breaks"
 *
 * Prints progress to stderr and the answer to stdout; exits 1 if the work did not finish.
 */
export async function runJob(
	scout: Scout,
	prompt: string,
	io: { progress: (line: string) => void },
): Promise<{ ok: boolean; answer: string; pullRequests: string[] }> {
	const context = BACKGROUND_CONTEXT;
	const conversation = await scout.harness.createConversation(
		{ ownership: { kind: "ownerless" }, agent: scout.workAgent },
		context,
	);
	const events = await watchEvents(scout.harness, conversation.id as ConversationId, context);
	let answer = "";
	events.start(async (batch) => {
		for (const event of batch) {
			if (event.type === "tool_execution_start" && event.parentToolCallId === undefined) {
				io.progress(describeStep(event.toolName, event.args).replaceAll("`", ""));
			}
			if (event.type === "message_end") {
				const message = event.entry.model?.[0];
				if (message?.role === "assistant") {
					const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
					if (text !== "") answer = text;
				}
			}
		}
	});
	try {
		const settled = await (await conversation.submit({ type: "input", content: prompt }, context)).wait(context);
		return {
			ok: settled.status === "done",
			answer,
			pullRequests: scout.pulls.forConversation(conversation.id).map((p) => p.url),
		};
	} finally {
		await events.stop();
		await scout.workspaces.remove(conversation.id);
	}
}

if (import.meta.main) {
	const prompt = process.argv.slice(2).join(" ").trim();
	if (prompt === "") {
		console.error('usage: npm run job -- "what to do"');
		process.exit(2);
	}
	const config = loadConfig();
	useScoutsKey(config.git.sshKey);
	const scout = await openScout({
		config,
		storage: new MemoryStorage(),
		dataDir: join(config.dataDir, "jobs"),
		instance: `job${randomBytes(3).toString("hex")}`,
		context: BACKGROUND_CONTEXT,
		watchProfile: false,
	});
	const result = await runJob(scout, prompt, { progress: (line) => console.error(`• ${line}`) });
	await scout.close();
	console.log(result.answer);
	for (const url of result.pullRequests) console.log(url);
	process.exit(result.ok ? 0 : 1);
}
