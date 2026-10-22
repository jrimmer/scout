import { loadConfig, useScoutsKey } from "./config.ts";
import { countMcpTools, doctor, fetchRunning, formatChecks } from "./doctor.ts";
import { modelsFor } from "./gateway.ts";
import { sourceReader } from "./scout.ts";
import { resolveSecrets } from "./secrets.ts";

/**
 * `npm run doctor`: is everything Scout depends on reachable and set up right? Prints one line per check, with how to
 * fix what isn't, and exits 1 if anything is broken. Reads the same settings as the service (.env).
 */
await resolveSecrets();
let config: ReturnType<typeof loadConfig>;
try {
	config = loadConfig();
} catch (error) {
	console.log(formatChecks([{ name: "Settings", status: "fail", detail: error instanceof Error ? error.message : String(error), fix: "See .env.example and docs/setup.md." }]));
	process.exit(1);
}
useScoutsKey(config.git.sshKey);
const mcpFile = config.mcpFile;
const directory = config.governance.directory;
const checks = await doctor(config, {
	models: modelsFor(config.gateway),
	...(mcpFile === undefined ? {} : { mcp: () => countMcpTools(mcpFile) }),
	...(directory === undefined ? {} : { directory: sourceReader(directory.source, config.codeHost, fetch) }),
	running: () => fetchRunning(config.dash, config.governance.metricsToken),
});
console.log(formatChecks(checks));
process.exit(checks.some((c) => c.status === "fail") ? 1 : 0);
