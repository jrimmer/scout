import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, useScoutsKey } from "./config.ts";
import { resolveSecrets, rotate } from "./secrets.ts";
import { type Signal, startService } from "./service.ts";
import { ConfigError, startupProblem } from "./startup.ts";

// Secrets first: references (op://, file:, cred:, NAME_FILE) become values before anything reads them.
// A start-up that fails on a setting says so in a sentence; a bug keeps its stack.
process.on("uncaughtException", (error) => {
	const problem = startupProblem(error);
	console.error(problem ?? error);
	process.exit(1);
});
const secretSources = await resolveSecrets();
const config = loadConfig();
if (config.slack.botToken === "" || config.slack.appToken === "") {
	throw new ConfigError("SLACK_BOT_TOKEN and SLACK_APP_TOKEN are not set (see .env.example)");
}
mkdirSync(config.dataDir, { recursive: true });
checkPi(config.dataDir, config.piMigrate);
useScoutsKey(config.git.sshKey);
console.log(`sandboxes: ${config.sandbox.driver}, image ${config.sandbox.image}, network ${config.sandbox.network}`);
if (config.sandbox.network === "none") {
	console.log("sandbox network: none. Installs and downloads will fail; set SCOUT_SANDBOX_NETWORK=open, or give repositories an egress list.");
}

// Everything else is the service (service.ts), the same one the end-to-end tests start.
const service = await startService({ config, rotateSecrets: () => rotate(secretSources) });

// `kill -INT <pid>` drains for a restart and then stops; SIGTERM, or a second SIGINT, stops now. `kill -HUP <pid>` reads
// secrets again; `kill -USR2 <pid>` reflects now, if today's reflection hasn't run yet.
for (const name of ["SIGINT", "SIGTERM", "SIGHUP", "SIGUSR2"] satisfies Signal[]) process.on(name, () => service.signal(name));

/**
 * Pi Durable from main (`npm run pi -- main`) converts pi.sqlite to a schema its release can't open, so it does that
 * only when asked, and Scout on the release says why it can't open converted data instead of failing inside Pi.
 */
function checkPi(dataDir: string, migrate: boolean): void {
	const channel = new URL("../node_modules/.pi-channel", import.meta.url);
	const pi = existsSync(channel) ? readFileSync(channel, "utf8").trim() : "stable";
	console.log(`pi durable: ${pi}`);
	const db = join(dataDir, "pi.sqlite");
	const converted = join(dataDir, "pi-main");
	if (pi === "stable") {
		if (existsSync(converted)) {
			throw new ConfigError(
				`${db} was converted by Pi Durable ${readFileSync(converted, "utf8").trim()}, which the release can't open. ` +
					"Go back with `npm run pi -- main`, or restore a backup from before the switch.",
			);
		}
		return;
	}
	if (existsSync(db) && !existsSync(converted) && !migrate) {
		throw new ConfigError(
			`Pi Durable ${pi} converts ${db} for good: the release can't open it afterwards. Back it up (or use another ` +
				"SCOUT_DATA_DIR), then start once with SCOUT_PI_MIGRATE=1.",
		);
	}
	writeFileSync(converted, `${pi}\n`);
}
