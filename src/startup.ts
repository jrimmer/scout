/** A setting or secret Scout can't start with, worded for whoever installs it: start-up prints the message, not a stack. */
export class ConfigError extends Error {}

/** Slack's answers to a token it won't take (`error` in the API's reply). */
const REFUSED = /\b(invalid_auth|not_authed|account_inactive|token_revoked|token_expired|invalid_app_token|invalid_token)\b/;

/**
 * Slack refusing a token becomes a ConfigError that says which one and where to look; anything else comes back as it was.
 * `which` is the setting whose token was in use: the bot token for the Web API, the app token for Socket Mode.
 */
export function refusedToken(error: unknown, which: "SLACK_BOT_TOKEN" | "SLACK_APP_TOKEN"): unknown {
	const data = (error as { data?: { error?: unknown } } | null)?.data;
	const said = typeof data?.error === "string" ? data.error : error instanceof Error ? error.message : "";
	const code = REFUSED.exec(said)?.[1];
	if (code === undefined) return error;
	return new ConfigError(`Slack refused ${which} (${code}). Check it's the right token for this app and hasn't been revoked: \`npm run doctor\` will say, and docs/setup.md step 2 shows where each token comes from.`);
}

/** What to print for an error that ended start-up: just the message for a configuration problem, nothing for a bug (it keeps its stack). */
export function startupProblem(error: unknown): string | undefined {
	return error instanceof ConfigError ? error.message : undefined;
}
