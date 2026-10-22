import assert from "node:assert/strict";
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ciVerdict, piMove, slugOn } from "../src/deploy.ts";

describe("deploying", () => {
	it("deploys a commit only once everything that reports CI on it has passed", () => {
		const status = (...states: [string, string][]) => ({ total_count: states.length, statuses: states.map(([context, status]) => ({ context, status })) });
		assert.deepEqual(ciVerdict(status(["ci / test", "success"], ["ci / docker", "success"]), []), { ok: true, say: "CI passed on it (ci / test, ci / docker)" });
		assert.deepEqual(ciVerdict(status(["ci / test", "success"], ["ci / docker", "failure"]), []), { ok: false, say: "CI failed on it: ci / docker" });
		assert.deepEqual(ciVerdict(status(["ci / test", "pending"]), []), { ok: false, say: "CI is still running on it (ci / test); try again once it's done" });
		assert.equal(ciVerdict(status(["ci / test", "error"]), []).ok, false);
		assert.deepEqual(ciVerdict({ total_count: 0, statuses: [] }, []), { ok: false, say: "nothing has reported CI on it yet" }, "no CI is no proof");
		// GitHub's commit statuses use `state`, and its own Actions report as check runs.
		assert.equal(ciVerdict({ statuses: [{ context: "deploy/preview", state: "success" }] }, []).ok, true);
		const run = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion });
		assert.deepEqual(ciVerdict({ total_count: 0, statuses: null }, [run("test", "completed", "success"), run("lint", "completed", "skipped")]), { ok: true, say: "CI passed on it (test, lint)" });
		assert.equal(ciVerdict({}, [run("test", "in_progress", null)]).ok, false);
		assert.equal(ciVerdict({}, [run("test", "completed", "cancelled")]).say, "CI failed on it: test");
	});

	it("knows when a change moves Pi Durable, which may convert pi.sqlite for good", () => {
		const pkg = (version?: string) => JSON.stringify({ dependencies: { "@slack/bolt": "^5.1.0", ...(version === undefined ? {} : { "@earendil-works/pi-durable": version }) } });
		assert.equal(piMove(pkg("1.4.0"), pkg("1.4.0")), undefined);
		assert.equal(piMove(pkg("1.4.0"), pkg("1.5.0")), "1.4.0 to 1.5.0");
		assert.equal(piMove(pkg(), pkg("1.4.0")), "nothing to 1.4.0");
	});

	it("finds Scout's own repository on the code host from the checkout's remote", () => {
		assert.equal(slugOn("ssh://git@git.example.org/acme/scout.git", "https://git.example.org/api/v1"), "acme/scout");
		assert.equal(slugOn("ssh://git@git.example.com:2222/team/scout.git", "https://git.example.com/api/v1"), "team/scout");
		assert.equal(slugOn("git@github.com:team/scout.git", "https://api.github.com"), "team/scout");
		assert.equal(slugOn("https://github.com/team/scout", "https://api.github.com"), "team/scout");
		assert.equal(slugOn("https://github.com/team/scout.git", "https://git.example.com/api/v1"), undefined, "another code host can't answer for it");
		assert.equal(slugOn("/srv/git/scout.git", "https://git.example.com/api/v1"), undefined);
	});
});

/**
 * scripts/deploy.sh for real, on a stand-in server: a checkout whose origin is a commit ahead, a code host that says
 * CI passed, stand-ins for `systemctl`, `npm` and `journalctl`, and a fake Scout under a supervisor that, like the
 * unit, starts it again whenever it stops, once it gets the deploy lock (ExecStartPre=flock). The fake Scout writes
 * down which code it sees when it starts and when its drain ends; npm writes down which Scout is running when it runs.
 */
describe("deploying with scripts/deploy.sh", { skip: process.platform !== "linux" && "needs flock and /proc" }, () => {
	const repo = join(import.meta.dirname, "..");
	const supervisors: ChildProcess[] = [];
	const servers: Server[] = [];
	after(() => {
		for (const s of supervisors) if (s.pid !== undefined) process.kill(-s.pid, "SIGKILL");
		for (const s of servers) s.close();
	});
	const listen = async (handler?: RequestListener) => {
		const server = createServer(handler);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		return { server, port: (server.address() as AddressInfo).port };
	};
	const until = async (what: string, ok: () => boolean) => {
		for (const started = Date.now(); !ok(); await new Promise((resolve) => setTimeout(resolve, 100))) {
			if (Date.now() - started > 20_000) assert.fail(`timed out waiting for ${what}`);
		}
	};

	/**
	 * The server, with Scout running v1 and origin/main at v2, whose package-lock.json says `lock`. `wrapped`: the unit's
	 * main process is a wrapper with Scout as its child, as under `litestream replicate -exec`.
	 */
	async function server(lock: string, options: { execStartPre?: string; wrapped?: boolean } = {}) {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "scout-deploy-")));
		const [origin, seed, install, bin] = ["origin.git", "seed", "install", "bin"].map((d) => join(root, d)) as [string, string, string, string];
		const events = join(root, "events");
		const mainPid = join(root, "mainpid");
		const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
		const ci = await listen((req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(/\/repos\/team\/scout\/commits\/\w+\/status$/.test(req.url ?? "") ? { statuses: [{ context: "ci", status: "success" }] } : {}));
		});
		servers.push(ci.server);
		const free = await listen();
		await new Promise((resolve) => free.server.close(resolve));
		const dash = free.port;

		execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
		mkdirSync(join(seed, "scripts"), { recursive: true });
		copyFileSync(join(repo, "scripts", "deploy.sh"), join(seed, "scripts", "deploy.sh"));
		copyFileSync(join(repo, "package.json"), join(seed, "package.json"));
		symlinkSync(join(repo, "src"), join(seed, "src"));
		writeFileSync(join(seed, ".gitignore"), ".env\n.deploy.lock\n");
		const commit = (version: string, lockfile: string) => {
			writeFileSync(join(seed, "version.txt"), version);
			writeFileSync(join(seed, "package-lock.json"), lockfile);
			git(seed, "add", "-A");
			git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", version);
			return git(seed, "rev-parse", "HEAD");
		};
		git(root, "init", "--quiet", "--initial-branch=main", seed);
		const v1 = commit("v1", "lock v1");
		git(seed, "push", "--quiet", origin, "main");
		execFileSync("git", ["clone", "--quiet", origin, install]);
		const v2 = commit("v2", lock);
		git(seed, "push", "--quiet", origin, "main");
		// Scout's settings name its code host, and the checkout's origin is on it; git reaches it on disk.
		const url = `http://127.0.0.1:${ci.port}/team/scout.git`;
		git(install, "remote", "set-url", "origin", url);
		git(install, "config", `url.${origin}.insteadOf`, url);
		const env = {
			SCOUT_REPO_URL: "git@host:o/web.git",
			SCOUT_REPO_SLUG: "o/web",
			SCOUT_CODEHOST_TOKEN: "t",
			SCOUT_CODEHOST_API: `http://127.0.0.1:${ci.port}/api/v1`,
			SCOUT_DASH_ADDR: `127.0.0.1:${dash}`,
			SCOUT_DATA_DIR: join(root, "data"),
			SCOUT_DRAIN_MAX: "30",
		};
		writeFileSync(join(install, ".env"), Object.entries(env).map(([k, v]) => `${k}=${v}\n`).join(""));

		mkdirSync(bin);
		const script = (name: string, body: string) => writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
		const pre = options.execStartPre ?? `{ path=/usr/bin/flock ; argv[]=/usr/bin/flock ${install}/.deploy.lock true ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`;
		script("systemctl", `case "$3" in Restart) echo always ;; ExecStartPre) echo '${pre}' ;; MainPID) cat ${mainPid} ;; *) exit 1 ;; esac`);
		script("journalctl", "exit 0");
		script("npm", `echo "npm $1 on $(cat package-lock.json), Scout pid $(cat ${mainPid})" >> ${events}\n[ "$(cat package-lock.json)" != broken ]`);
		writeFileSync(
			join(root, "scout.mjs"),
			[
				`import { appendFileSync, readFileSync } from "node:fs";`,
				`import { createServer } from "node:http";`,
				`const say = (line) => appendFileSync(${JSON.stringify(events)}, line + "\\n");`,
				`const code = () => readFileSync("version.txt", "utf8");`,
				`say("Scout started on " + code());`,
				`const dash = createServer((req, res) => res.end("ok")).listen(${dash}, "127.0.0.1");`,
				`process.on("SIGINT", () => {`,
				`	say("Scout draining");`,
				`	setTimeout(() => { say("Scout drained, its code still " + code()); dash.close(); process.exit(0); }, 1000);`,
				`});`,
			].join("\n"),
		);
		// The unit: wait for the deploy's lock, start Scout, and start it again whenever it stops.
		writeFileSync(
			join(root, "supervise.sh"),
			[
				`cd ${install}`,
				"while true; do",
				`	flock ${install}/.deploy.lock true`,
				options.wrapped ? `	bash -c '${process.execPath} ${join(root, "scout.mjs")} src/main.ts; exit $?' &` : `	${process.execPath} ${join(root, "scout.mjs")} &`,
				`	echo $! > ${mainPid}`,
				"	wait $!",
				`	echo 0 > ${mainPid}`,
				"	sleep 0.2",
				"done",
			].join("\n"),
		);
		writeFileSync(mainPid, "0\n");
		supervisors.push(spawn("bash", [join(root, "supervise.sh")], { detached: true, stdio: "ignore" }));
		const said = () => (existsSync(events) ? readFileSync(events, "utf8").trim().split("\n") : []);
		await until("Scout to start", () => said().length === 1 && readFileSync(mainPid, "utf8").trim() !== "0");

		const deploy = () =>
			new Promise<{ code: number; output: string }>((resolve) => {
				execFile("bash", [join(install, "scripts", "deploy.sh")], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 60_000 }, (error, stdout, stderr) =>
					resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : -1, output: stdout + stderr }),
				);
			});
		return { install, v1, v2, said, deploy, main: readFileSync(mainPid, "utf8").trim(), head: () => git(install, "rev-parse", "HEAD") };
	}

	it("changes code and packages only once the draining Scout has stopped, then lets the new one start", async () => {
		const s = await server("lock v2");
		const { code, output } = await s.deploy();
		assert.equal(code, 0, output);
		assert.equal(s.head(), s.v2);
		assert.deepEqual(s.said(), ["Scout started on v1", "Scout draining", "Scout drained, its code still v1", "npm ci on lock v2, Scout pid 0", "Scout started on v2"]);
		assert.match(output, /Deployed \w+ v2\./);
	});

	it("drains Scout's own process under a wrapper, and waits for the wrapper to stop too", async () => {
		const s = await server("lock v1", { wrapped: true });
		const { code, output } = await s.deploy();
		assert.equal(code, 0, output);
		const drained = /Draining Scout \(pid (\d+)\)/.exec(output)?.[1];
		assert.ok(drained !== undefined && drained !== s.main, `Scout's node process, not the wrapper (${s.main}): ${output}`);
		assert.deepEqual(s.said(), ["Scout started on v1", "Scout draining", "Scout drained, its code still v1", "Scout started on v2"], "no npm ci: the lockfile didn't change");
	});

	it("puts the checkout back when npm ci fails, so Scout starts on what it ran before", async () => {
		const s = await server("broken");
		const { code, output } = await s.deploy();
		assert.equal(code, 1, output);
		assert.match(output, /npm ci failed/);
		assert.match(output, /Put the checkout back on \w+; Scout starts on that/);
		assert.equal(s.head(), s.v1);
		await until("Scout to start again", () => s.said().length === 6);
		assert.deepEqual(s.said(), [
			"Scout started on v1",
			"Scout draining",
			"Scout drained, its code still v1",
			"npm ci on broken, Scout pid 0",
			"npm ci on lock v1, Scout pid 0",
			"Scout started on v1",
		]);
	});

	it("refuses a unit that doesn't wait for the deploy lock, and says what to add", async () => {
		const s = await server("lock v2", { execStartPre: "{ path=/usr/bin/litestream ; argv[]=/usr/bin/litestream restore x ; ignore_errors=no }" });
		const { code, output } = await s.deploy();
		assert.equal(code, 1);
		assert.ok(output.includes(`ExecStartPre=/usr/bin/flock ${s.install}/.deploy.lock true`), output);
		assert.equal(s.head(), s.v1);
		assert.deepEqual(s.said(), ["Scout started on v1"], "Scout wasn't touched");
	});
});
