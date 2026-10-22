import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";
import { ConfigError, refusedToken, startupProblem } from "../src/startup.ts";

/** What Slack's client throws for an answer of `{ ok: false, error }`. */
function platformError(error: string): Error {
	return Object.assign(new Error(`An API error occurred: ${error}`), { code: "slack_webapi_platform_error", data: { ok: false, error } });
}

describe("start-up problems", () => {
	it("says which Slack token was refused, in a sentence", () => {
		for (const code of ["invalid_auth", "not_authed", "account_inactive", "token_revoked"]) {
			const bot = refusedToken(platformError(code), "SLACK_BOT_TOKEN");
			assert.ok(bot instanceof ConfigError);
			assert.match(bot.message, new RegExp(`^Slack refused SLACK_BOT_TOKEN \\(${code}\\)\\.`));
			assert.match(bot.message, /npm run doctor.*docs\/setup\.md step 2/);
		}
		// Socket Mode reports it in the message when there is no structured reply.
		const app = refusedToken(new Error("An API error occurred: invalid_auth"), "SLACK_APP_TOKEN");
		assert.match((app as Error).message, /refused SLACK_APP_TOKEN/);
	});

	it("leaves other errors as they were", () => {
		const down = new Error("getaddrinfo ENOTFOUND slack.com");
		assert.equal(refusedToken(down, "SLACK_BOT_TOKEN"), down);
		assert.equal(refusedToken(platformError("ratelimited"), "SLACK_BOT_TOKEN") instanceof ConfigError, false);
		assert.equal(refusedToken(undefined, "SLACK_BOT_TOKEN"), undefined);
	});

	it("prints the message for a configuration problem, and nothing for a bug", () => {
		assert.equal(startupProblem(new ConfigError("SCOUT_MODEL must look like provider/modelId")), "SCOUT_MODEL must look like provider/modelId");
		assert.equal(startupProblem(new TypeError("x is not a function")), undefined);
		assert.equal(startupProblem(new Error("plain")), undefined);
		assert.throws(() => loadConfig({}), (error: unknown) => startupProblem(error) !== undefined, "what config.ts words is a configuration problem");
	});
});
