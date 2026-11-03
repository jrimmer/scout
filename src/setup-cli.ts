import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { EnvFile, STEPS, type Ctx, type Run, type Ui, walk } from "./setup.ts";

/**
 * `npm run setup`: walks through setting Scout up (setup.ts). Run it again any time: it only asks about what is missing
 * or broken. `--check` asks nothing and just reports every step, then the doctor. `--redo slack,model` goes through
 * those steps again whatever state they're in.
 */
const args = process.argv.slice(2);
const check = args.includes("--check");
const redo = (args[args.indexOf("--redo") + 1] ?? "").split(",").filter((s) => s !== "" && args.includes("--redo"));
const dir = process.cwd();

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
const lines: string[] = [];
let closed = false;
rl.on("close", () => (closed = true));
const waiting: ((line: string | undefined) => void)[] = [];
rl.on("line", (line) => (waiting.shift() ?? ((l) => lines.push(l as string)))(line));
const nextLine = (): Promise<string | undefined> => new Promise((resolve) => (lines.length > 0 ? resolve(lines.shift()) : closed ? resolve(undefined) : waiting.push(resolve)));

const ui: Ui = {
	say: (text) => console.log(text),
	async ask(question, options = {}) {
		process.stdout.write(`${question}${options.default === undefined || options.default === "" ? "" : ` [${options.default}]`}${options.secret === true ? " (hidden; Enter keeps what's set)" : ""}: `);
		const hide = options.secret === true && process.stdin.isTTY;
		if (hide) spawnSync("stty", ["-echo"], { stdio: "inherit" });
		const line = await nextLine();
		if (hide) {
			spawnSync("stty", ["echo"], { stdio: "inherit" });
			process.stdout.write("\n");
		}
		if (line === undefined) throw new Error("no more input: run `npm run setup` from a terminal to answer its questions");
		return line;
	},
	async choose(question, options, preferred) {
		console.log(question);
		options.forEach((o, i) => console.log(`  ${i + 1}. ${o.label}${o.value === preferred ? "  (suggested)" : ""}`));
		for (;;) {
			const answer = (await this.ask("Number", { default: String(Math.max(1, options.findIndex((o) => o.value === preferred) + 1)) })).trim();
			const picked = options[Number(answer === "" ? options.findIndex((o) => o.value === preferred) + 1 : answer) - 1];
			if (picked !== undefined) return picked.value;
			console.log(`Type a number from 1 to ${options.length}.`);
		}
	},
	async confirm(question, preferred = true) {
		const answer = (await this.ask(`${question} (${preferred ? "Y/n" : "y/N"})`)).trim().toLowerCase();
		return answer === "" ? preferred : answer.startsWith("y");
	},
};

const run: Run = (command, args, options = {}) =>
	new Promise((resolve) => {
		const child = spawn(command, args, { cwd: options.cwd ?? dir, env: { ...process.env, ...options.env }, stdio: [options.input === undefined ? "ignore" : "pipe", options.inherit === true ? "inherit" : "pipe", options.inherit === true ? "inherit" : "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d: Buffer) => (stdout += d));
		child.stderr?.on("data", (d: Buffer) => (stderr += d));
		if (options.input !== undefined) child.stdin?.end(options.input);
		child.on("error", (error) => resolve({ code: 127, stdout, stderr: error.message }));
		child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});

const ctx: Ctx = { env: new EnvFile(join(dir, ".env")), ui, fetch, run, dir, home: homedir(), slackApi: "https://slack.com/api" };

if (!existsSync(join(dir, "slack-manifest.yaml"))) {
	console.error("Run this from Scout's checkout (the folder with slack-manifest.yaml).");
	process.exit(2);
}
console.log(check ? "Checking Scout's setup (nothing is changed).\n" : "Setting Scout up. Run this again any time: it only asks about what is missing or broken.\n");
const fine = await walk(ctx, STEPS, { check, redo });

console.log("\n── The doctor");
const doctor = await run(process.execPath, ["--env-file-if-exists=.env", "src/doctor-cli.ts"], { inherit: true });
rl.close();
if (!check && !fine) console.log("\nSome steps were skipped or aren't working yet. Run `npm run setup` again when you've sorted them: it only asks about those.");
if (!check && fine && doctor.code !== 0) console.log("\nThe doctor's ❌ lines say what is left. Before Scout runs as a service, 'Running' and 'Backups' are expected to fail.");
process.exit(fine && doctor.code === 0 ? 0 : 1);
