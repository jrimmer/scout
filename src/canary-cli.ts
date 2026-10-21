import { describeCanary, runCanary, slackApi } from "./canary.ts";
import { forgeFor } from "./forge.ts";

/**
 * `npm run canary`: ask Scout for a small change in Slack, as a person would, and check a pull request comes of it.
 * Exits 1 if it doesn't. See docs/operations.md, "The canary", for the settings and how to run it each night.
 */
const env = process.env;
const missing = ["SCOUT_CANARY_SLACK_TOKEN", "SCOUT_CANARY_CHANNEL", "SCOUT_CANARY_SCOUT_USER", "SCOUT_CANARY_REPO", "SCOUT_CANARY_CODEHOST_TOKEN"].filter((name) => !env[name]);
if (missing.length > 0) {
	console.log(`The canary needs ${missing.join(", ")}. See docs/operations.md, "The canary".`);
	process.exit(2);
}
const kind = env.SCOUT_CODEHOST === "github" ? "github" : "forgejo";
const apiUrl = (env.SCOUT_CODEHOST_API ?? (kind === "github" ? "https://api.github.com" : "")).replace(/\/$/, "");
if (apiUrl === "") {
	console.log("The canary needs SCOUT_CODEHOST_API for Forgejo: its API address, like https://forgejo.example.com/api/v1");
	process.exit(2);
}
const minutes = (name: string, fallback: number) => Number(env[name] ?? fallback) * 60_000;

const result = await runCanary({
	slack: slackApi(env.SCOUT_CANARY_SLACK_TOKEN!),
	forge: forgeFor({ kind, apiUrl, token: env.SCOUT_CANARY_CODEHOST_TOKEN! }),
	channel: env.SCOUT_CANARY_CHANNEL!,
	scout: env.SCOUT_CANARY_SCOUT_USER!,
	slug: env.SCOUT_CANARY_REPO!,
	replyWithinMs: minutes("SCOUT_CANARY_REPLY_MINUTES", 5),
	pullWithinMs: minutes("SCOUT_CANARY_PULL_MINUTES", 45),
	log: (line) => console.log(line),
});
const line = describeCanary(result);
console.log(line);

// A monitor to tell (Gatus's external endpoints take exactly this): success, the reason, and how long it took.
const report = env.SCOUT_CANARY_REPORT_URL;
if (report) {
	const url = new URL(report);
	url.searchParams.set("success", String(result.ok));
	if (!result.ok) url.searchParams.set("error", result.problem ?? "failed");
	if (result.pullMs !== undefined) url.searchParams.set("duration", `${Math.round(result.pullMs / 1000)}s`);
	const headers: Record<string, string> = env.SCOUT_CANARY_REPORT_TOKEN ? { authorization: `Bearer ${env.SCOUT_CANARY_REPORT_TOKEN}` } : {};
	const answer = await fetch(url, { method: "POST", headers }).catch((error: unknown) => error);
	if (!(answer instanceof Response) || !answer.ok) console.log(`Couldn't report to ${url.origin}: ${answer instanceof Response ? answer.status : String(answer)}`);
}
process.exit(result.ok ? 0 : 1);
