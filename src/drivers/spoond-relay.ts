/**
 * Runs the pi-env daemon in a spoond lease and joins it to this process's stdin and stdout, so pi-env's `Connection`
 * can use it as its command: `node spoond-relay.ts <url> <lease> <daemon> <home> serve --token <hex>`.
 *
 * It uses spoond's stream WebSocket in binary mode: our binary frames are the process's stdin; its binary frames carry
 * stdout (first byte 1) or stderr (2); control messages are JSON text. The bearer token comes from
 * SCOUT_SPOOND_TOKEN, so it never shows in a process listing.
 */
const [url, lease, daemon, home, ...rest] = process.argv.slice(2);
const token = process.env.SCOUT_SPOOND_TOKEN;
if (url === undefined || lease === undefined || daemon === undefined || home === undefined || token === undefined) {
	process.stderr.write("usage: spoond-relay.ts <url> <lease> <daemon> <home> [args…], with SCOUT_SPOOND_TOKEN set\n");
	process.exit(2);
}

const socket = new WebSocket(`${url.replace(/^http/, "ws")}/api/leases/${lease}/stream`, {
	headers: { authorization: `Bearer ${token}` },
} as unknown as string[]);
socket.binaryType = "arraybuffer";

let started = false;
const pending: Uint8Array<ArrayBuffer>[] = [];
let inputEnded = false;

socket.addEventListener("open", () => {
	socket.send(JSON.stringify({ args: [daemon, ...rest], cwd: home, binary: true, pty: false }));
});

socket.addEventListener("message", (event: MessageEvent) => {
	if (typeof event.data === "string") {
		const message = JSON.parse(event.data) as { stream?: string; exit_code?: number; error?: string };
		if (message.stream === "started") {
			started = true;
			for (const chunk of pending.splice(0)) socket.send(chunk);
			if (inputEnded) socket.send(JSON.stringify({ action: "eof" }));
		} else if (message.exit_code !== undefined) {
			finish(message.exit_code);
		} else if (message.error !== undefined) {
			process.stderr.write(`spoond: ${message.error}\n`);
			finish(1);
		}
		return;
	}
	const bytes = new Uint8Array(event.data as ArrayBuffer);
	const payload = bytes.subarray(1);
	if (bytes[0] === 1) process.stdout.write(payload);
	else if (bytes[0] === 2) process.stderr.write(payload);
});

socket.addEventListener("close", () => finish(started ? 0 : 1));
socket.addEventListener("error", () => {
	process.stderr.write("spoond: the stream connection failed\n");
	finish(1);
});

process.stdin.on("data", (chunk: Buffer) => {
	const bytes = new Uint8Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer);
	if (started) socket.send(bytes);
	else pending.push(bytes);
});
process.stdin.on("end", () => {
	inputEnded = true;
	if (started) socket.send(JSON.stringify({ action: "eof" }));
});

// Closing the socket doesn't stop the process in the lease; killing it does.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
	process.on(signal, () => {
		if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ action: "kill" }));
		setTimeout(() => finish(143), 200);
	});
}

let finished = false;
function finish(code: number): void {
	if (finished) return;
	finished = true;
	process.stdout.end(() => process.exit(code));
	try {
		socket.close();
	} catch {}
}
