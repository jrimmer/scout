import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";

/**
 * Enough of spoond's lease API to drive the spoond driver for real, on this host: leases, keepalive, suspend, delete,
 * buffered and background exec (jobs with output by offset, an output cap, signals), the files API (with `Range` unless
 * `ranges: false`, like spoond before 3.11), and the stream WebSocket in binary mode, which runs the uploaded pi-env
 * daemon. Guest paths are host paths (the driver's `home` points into a temporary directory).
 */
export type FakeLease = { id: string; holder: string; state: string; body: Record<string, unknown> };

type Stream = { kept: Buffer; base: number; dropped: { bytes: number; newlines: number; ends_with_newline: boolean } };
type FakeJob = { child: ChildProcess; state: "running" | "exited"; exit: number | null; out: Stream; err: Stream; cap: number; exited: Promise<void> };

/** `ranges` and `codes` (default on) are spoond 3.11's ranged file reads and stable error codes; off, an older spoond. */
export async function fakeSpoond(token: string, options: { ranges?: boolean; codes?: boolean; maxRange?: number } = {}) {
	const leases = new Map<string, FakeLease>();
	const jobs = new Map<string, FakeJob>();
	const calls: string[] = [];
	let next = 1;

	/** A failed file route's answer, with spoond's code unless this fake plays an older spoond. */
	const coded = (error: string, code: string) => (options.codes === false ? { error } : { error, code });

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://spoond");
		calls.push(`${req.method} ${url.pathname}`);
		if (req.headers.authorization !== `Bearer ${token}`) {
			res.writeHead(401).end();
			return;
		}
		const body = await read(req);
		const json = (status: number, value: unknown) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(value));
		};
		const match = /^\/api\/leases(?:\/([^/]+))?(?:\/(.*))?$/.exec(url.pathname);
		if (match === null) return json(404, { error: "not found" });
		const [, id, rest] = match;
		if (id === undefined && req.method === "GET") return json(200, { sandboxes: leases.size === 0 ? null : [...leases.values()].map(({ body: _, ...l }) => l) });
		if (id === undefined && req.method === "POST") {
			const created = JSON.parse(body.toString()) as Record<string, unknown>;
			const lease = { id: `lease${next++}`, holder: String(created.holder), state: "running", body: created };
			leases.set(lease.id, lease);
			return json(201, { id: lease.id, holder: lease.holder });
		}
		const lease = id === undefined ? undefined : leases.get(id);
		if (lease === undefined) return json(404, { error: "no such lease" });
		if (rest === undefined && req.method === "DELETE") {
			leases.delete(lease.id);
			res.writeHead(204).end();
			return;
		}
		if (rest === "keepalive") return json(200, { id: lease.id });
		if (rest === "suspend") {
			lease.state = "suspended";
			return json(200, { id: lease.id, status: "suspended" });
		}
		if (rest === "exec") {
			const exec = JSON.parse(body.toString()) as { cmd: string; background?: boolean; env?: Record<string, string>; output_max_bytes?: number };
			if (!exec.background) {
				const ran = spawnSync("bash", ["-c", exec.cmd], { encoding: "utf8" });
				return json(200, { stdout: ran.stdout, stderr: ran.stderr, exit: ran.status ?? 128 });
			}
			const child = spawn("bash", ["-c", exec.cmd], { env: { ...process.env, ...exec.env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
			const stream = (): Stream => ({ kept: Buffer.alloc(0), base: 0, dropped: { bytes: 0, newlines: 0, ends_with_newline: false } });
			const job: FakeJob = { child, state: "running", exit: null, out: stream(), err: stream(), cap: exec.output_max_bytes ?? 0, exited: Promise.resolve() };
			const append = (s: Stream, data: Buffer) => {
				s.kept = Buffer.concat([s.kept, data]);
				if (job.cap > 0 && s.kept.length > job.cap) {
					const front = s.kept.subarray(0, s.kept.length - job.cap);
					s.dropped.bytes += front.length;
					for (const byte of front) if (byte === 10) s.dropped.newlines++;
					s.dropped.ends_with_newline = front[front.length - 1] === 10;
					s.base += front.length;
					s.kept = s.kept.subarray(front.length);
				}
			};
			child.stdout?.on("data", (data: Buffer) => append(job.out, data));
			child.stderr?.on("data", (data: Buffer) => append(job.err, data));
			job.exited = new Promise((resolve) =>
				child.on("close", (code, signal) => {
					job.state = "exited";
					job.exit = code ?? (signal === null ? null : 128 + (signal === "SIGKILL" ? 9 : 15));
					resolve();
				}),
			);
			const id = randomBytes(6).toString("hex");
			jobs.set(id, job);
			return json(202, { job_id: id, started_at: new Date().toISOString() });
		}
		const jobMatch = /^jobs\/([^/]+)(?:\/(output|signal))?$/.exec(rest ?? "");
		if (jobMatch !== null) {
			const [, jobId, what] = jobMatch;
			const job = jobs.get(jobId!);
			if (job === undefined) return json(404, { error: "no such job" });
			if (what === undefined && req.method === "DELETE") {
				if (job.state === "running") return json(409, { error: "job is running" });
				jobs.delete(jobId!);
				res.writeHead(204).end();
				return;
			}
			if (what === undefined) {
				const wait = Number(url.searchParams.get("wait") ?? 0);
				if (job.state === "running" && wait > 0) await Promise.race([job.exited, new Promise((r) => setTimeout(r, wait * 1000))]);
				const skipped = Object.fromEntries((["stdout", "stderr"] as const).flatMap((n) => {
					const s = n === "stdout" ? job.out : job.err;
					return s.dropped.bytes > 0 ? [[n, s.dropped]] : [];
				}));
				return json(200, {
					job: { job_id: jobId, state: job.state, exit_code: job.exit, ...(Object.keys(skipped).length === 0 ? {} : { skipped }) },
					stdout: job.out.kept.subarray(-65536).toString(),
					stderr: job.err.kept.subarray(-65536).toString(),
				});
			}
			if (what === "signal") {
				if (job.state !== "running") return json(409, { error: "job is not running" });
				const { signal } = JSON.parse(body.toString()) as { signal: string };
				process.kill(-job.child.pid!, signal === "KILL" ? "SIGKILL" : "SIGTERM");
				return json(200, { ok: true });
			}
			const s = url.searchParams.get("stream") === "stderr" ? job.err : job.out;
			const limit = Number(url.searchParams.get("limit") ?? 1048576);
			const start = Math.max(Number(url.searchParams.get("offset") ?? 0), s.base);
			const headers: Record<string, string> = { "content-type": "application/octet-stream" };
			if (s.dropped.bytes > 0) {
				headers["x-output-offset"] = String(start);
				headers["x-output-skipped"] = JSON.stringify(s.dropped);
			}
			res.writeHead(200, headers).end(s.kept.subarray(start - s.base, start - s.base + limit));
			return;
		}
		if (rest?.startsWith("files/")) {
			const path = decodeURIComponent(`/${rest.slice("files/".length)}`);
			if (req.method === "GET" && url.searchParams.get("list") === "1") {
				// spoond 3.11's listing, without .gitignore (the live conformance run checks that): depth first, siblings in
				// byte order, .git skipped, hidden and exclude honoured, bounded by max_entries.
				if (!existsSync(path)) return json(404, coded("no such file", "ENOENT"));
				if (!statSync(path).isDirectory()) return json(409, coded("not a directory", "ENOTDIR"));
				const hidden = url.searchParams.get("hidden") !== "0";
				const exclude = new Set((url.searchParams.get("exclude") ?? "").split(",").filter(Boolean));
				const max = Number(url.searchParams.get("max_entries") ?? 50_000) || 50_000;
				const entries: { kind: string; path: string }[] = [];
				let truncated = false;
				const walk = (dir: string, prefix: string): void => {
					for (const name of readdirSync(dir).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
						if (truncated || name === ".git" || exclude.has(name) || (!hidden && name.startsWith("."))) continue;
						if (entries.length >= max) {
							truncated = true;
							return;
						}
						const full = join(dir, name);
						const stat = lstatSync(full);
						const kind = stat.isSymbolicLink() ? "l" : stat.isDirectory() ? "d" : "f";
						entries.push({ kind, path: `${prefix}${name}` });
						if (kind === "d") walk(full, `${prefix}${name}/`);
					}
				};
				walk(path, "");
				return json(200, { entries, count: entries.length, truncated });
			}
			if (req.method === "GET" && url.searchParams.has("stat")) {
				if (!existsSync(path)) return json(404, coded("no such file", "ENOENT"));
				const stat = statSync(path);
				return json(200, { name: path, size: stat.size, mode: (stat.mode & 0o777).toString(8), is_dir: stat.isDirectory() });
			}
			if (req.method === "GET") {
				if (!existsSync(path)) return json(404, coded("no such file", "ENOENT"));
				if (statSync(path).isDirectory()) return json(409, coded("is a directory", "EISDIR"));
				const bytes = readFileSync(path);
				const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ""));
				if (range === null || options.ranges === false) {
					res.writeHead(200, { "content-type": "application/octet-stream" }).end(bytes);
					return;
				}
				const from = Number(range[1]);
				// spoond serves at most 256 MiB per answer; `maxRange` makes that limit small enough to test.
				const to = Math.min(range[2] === "" ? bytes.length - 1 : Number(range[2]), bytes.length - 1, from + (options.maxRange ?? Number.POSITIVE_INFINITY) - 1);
				if (from >= bytes.length) return json(416, { error: "range not satisfiable" });
				res.writeHead(206, { "content-range": `bytes ${from}-${to}/${bytes.length}`, "accept-ranges": "bytes" }).end(bytes.subarray(from, to + 1));
				return;
			}
			if (req.method === "PUT") {
				if (existsSync(path) && lstatSync(path).isDirectory()) return json(409, coded("a directory is in the way", "EISDIR"));
				mkdirSync(dirname(path), { recursive: true });
				// Into place by rename, as spoond does: an open file keeps its old content.
				const landing = `${path}.landing-${randomBytes(4).toString("hex")}`;
				writeFileSync(landing, body);
				chmodSync(landing, Number.parseInt(url.searchParams.get("mode") ?? "0644", 8));
				renameSync(landing, path);
				return json(201, { name: path });
			}
			if (req.method === "DELETE") {
				if (!existsSync(path)) return json(404, coded("no such file", "ENOENT"));
				rmSync(path, { recursive: url.searchParams.get("recursive") === "1" });
				res.writeHead(204).end();
				return;
			}
		}
		json(404, { error: "not here" });
	});

	server.on("upgrade", (req, socket) => {
		const match = /^\/api\/leases\/([^/]+)\/stream$/.exec(req.url ?? "");
		if (req.headers.authorization !== `Bearer ${token}` || match === null || !leases.has(match[1]!)) {
			socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
			return;
		}
		calls.push(`STREAM ${match[1]}`);
		leases.get(match[1]!)!.state = "running";
		const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
		socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
		stream(socket);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	return {
		url: `http://127.0.0.1:${port}`,
		leases,
		jobs,
		calls,
		close: () => {
			for (const job of jobs.values()) if (job.state === "running") process.kill(-job.child.pid!, "SIGKILL");
			server.closeAllConnections();
			return new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

/** One stream: the first text frame says what to run; binary frames are its stdin; its output goes back tagged 1/2. */
function stream(socket: Duplex): void {
	let child: ChildProcess | undefined;
	let buffer = Buffer.alloc(0);
	const send = (opcode: number, payload: Buffer) => {
		const head = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length]) : payload.length < 65536 ? Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 255]) : (() => {
			const h = Buffer.alloc(10);
			h[0] = 0x80 | opcode;
			h[1] = 127;
			h.writeBigUInt64BE(BigInt(payload.length), 2);
			return h;
		})();
		if (!socket.destroyed) socket.write(Buffer.concat([head, payload]));
	};
	const text = (value: unknown) => send(1, Buffer.from(JSON.stringify(value)));
	socket.on("data", (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		for (;;) {
			if (buffer.length < 2) return;
			const opcode = buffer[0]! & 0x0f;
			let length = buffer[1]! & 0x7f;
			let offset = 2;
			if (length === 126) {
				if (buffer.length < 4) return;
				length = buffer.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (buffer.length < 10) return;
				length = Number(buffer.readBigUInt64BE(2));
				offset = 10;
			}
			if (buffer.length < offset + 4 + length) return;
			const mask = buffer.subarray(offset, offset + 4);
			const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length).map((b, i) => b ^ mask[i % 4]!));
			buffer = buffer.subarray(offset + 4 + length);
			if (opcode === 8) {
				child?.kill("SIGKILL");
				socket.end();
				return;
			}
			if (opcode === 2) {
				child?.stdin?.write(payload);
				continue;
			}
			const message = JSON.parse(payload.toString()) as { args?: string[]; cwd?: string; action?: string };
			if (message.args !== undefined) {
				child = spawn(message.args[0]!, message.args.slice(1), { cwd: message.cwd, stdio: ["pipe", "pipe", "pipe"] });
				text({ stream: "started", pid: child.pid });
				child.stdout?.on("data", (data: Buffer) => send(2, Buffer.concat([Buffer.from([1]), data])));
				child.stderr?.on("data", (data: Buffer) => send(2, Buffer.concat([Buffer.from([2]), data])));
				child.on("exit", (code) => {
					text({ exit_code: code ?? 137 });
					socket.end();
				});
			} else if (message.action === "eof") {
				child?.stdin?.end();
			} else if (message.action === "kill" || message.action === "stop") {
				child?.kill(message.action === "kill" ? "SIGKILL" : "SIGTERM");
			}
		}
	});
	socket.on("close", () => child?.kill("SIGKILL"));
}

function read(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks)));
	});
}

export function readText(path: string): string {
	return readFileSync(path, "utf8");
}
