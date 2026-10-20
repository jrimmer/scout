import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { dirname } from "node:path";
import type { Duplex } from "node:stream";

/**
 * Enough of spoond's lease API to drive the spoond driver for real, on this host: leases, keepalive, suspend, delete,
 * buffered exec, the files API, and the stream WebSocket in binary mode, which runs the uploaded pi-env daemon. Guest
 * paths are host paths (the driver's `home` points into a temporary directory).
 */
export type FakeLease = { id: string; holder: string; state: string; body: Record<string, unknown> };

export async function fakeSpoond(token: string) {
	const leases = new Map<string, FakeLease>();
	const calls: string[] = [];
	let next = 1;

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
			const { cmd } = JSON.parse(body.toString()) as { cmd: string };
			const stdout = execFileSync("bash", ["-c", cmd], { encoding: "utf8" });
			return json(200, { stdout, stderr: "", exit: 0 });
		}
		if (rest?.startsWith("files/")) {
			const path = `/${rest.slice("files/".length)}`;
			if (req.method === "GET" && url.searchParams.has("stat")) {
				if (!existsSync(path)) return json(404, { error: "no such file" });
				return json(200, { name: path, size: statSync(path).size });
			}
			if (req.method === "PUT") {
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, body);
				chmodSync(path, Number.parseInt(url.searchParams.get("mode") ?? "0644", 8));
				return json(201, { name: path });
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
		calls,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
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
