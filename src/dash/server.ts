import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Collector } from "./collect.ts";
import type { Grid } from "./grid.ts";
import { layout } from "./layout.ts";

/**
 * Scout's dashboard: a read-only, live view of what Scout is doing and how it's going, for watching rather than triage
 * (after spoond's). It runs inside the Scout process, on its own address, because only that process can read Scout's
 * conversations. One collector draws the grid every few seconds; each viewer's stream gets only the rows that changed.
 */
export type DashOptions = {
	/** `host:port`; loopback by default. */
	addr: string;
	/** Basic auth. Required on any address other than loopback. */
	auth?: { user: string; passwordHash: string };
	collector: Collector;
	intervalMs?: number;
	/** Prometheus metrics at /metrics: with a token, only for that bearer token; without, behind the dashboard's login. */
	metrics?: { token?: string; render: () => Promise<string> };
};

const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "static");
const STATIC: Record<string, string> = {
	"dash.css": "text/css; charset=utf-8",
	"dash.js": "text/javascript; charset=utf-8",
	"fonts/jetbrains-mono.css": "text/css; charset=utf-8",
	"fonts/jetbrains-mono.woff2": "font/woff2",
	"fonts/jetbrains-mono-bold.woff2": "font/woff2",
};

export async function startDashboard(options: DashOptions): Promise<{ port: number; close: () => Promise<void> }> {
	const { host, port } = parseAddr(options.addr);
	if (options.auth === undefined && !isLoopback(host)) {
		throw new Error(`the dashboard on ${options.addr} needs SCOUT_DASH_USER and SCOUT_DASH_PASSWORD_HASH (or a loopback address)`);
	}
	const clients = new Set<{ res: ServerResponse; rows: string[] }>();
	let current: Grid = layout(await options.collector.collect());

	const tick = setInterval(async () => {
		try {
			current = layout(await options.collector.collect());
		} catch (error) {
			console.error("dashboard collect failed:", error);
			return;
		}
		const rows = Array.from({ length: current.height }, (_, y) => current.rowHtml(y));
		for (const client of clients) {
			if (client.rows.length !== rows.length) {
				send(client.res, "grid", current.html());
			} else {
				const changed = rows.flatMap((html, y) => (html === client.rows[y] ? [] : [{ id: `r${y}`, html }]));
				if (changed.length > 0) send(client.res, "rows", changed);
			}
			client.rows = rows;
		}
	}, options.intervalMs ?? 5000);
	tick.unref();

	const server = createServer((req, res) => {
		const path = new URL(req.url ?? "/", "http://dash").pathname;
		if (path === "/healthz") return reply(res, 200, "text/plain", "ok");
		// For monitors: the metrics, and the dashboard's snapshot as JSON (what `npm run doctor` checks a running Scout by).
		if ((path === "/metrics" || path === "/status.json") && options.metrics !== undefined) {
			const { token, render } = options.metrics;
			const allowed = token === undefined ? authorized(req, options.auth) : safeEqual(req.headers.authorization ?? "", `Bearer ${token}`);
			if (!allowed) return reply(res, 401, "text/plain", "unauthorized");
			const answer = path === "/metrics" ? render().then((text) => ["text/plain; version=0.0.4", text]) : options.collector.collect().then((s) => ["application/json", JSON.stringify(s)]);
			void answer.then(
				([type, body]) => reply(res, 200, type!, body!),
				(error: unknown) => reply(res, 500, "text/plain", String(error)),
			);
			return;
		}
		if (!authorized(req, options.auth)) {
			res.writeHead(401, { "www-authenticate": 'Basic realm="scout", charset="UTF-8"' });
			return res.end();
		}
		if (req.method !== "GET") return reply(res, 405, "text/plain", "read-only");
		if (path === "/") return reply(res, 200, "text/html; charset=utf-8", page(current));
		if (path === "/stream") {
			res.writeHead(200, { ...HEADERS, "content-type": "text/event-stream", "cache-control": "no-store" });
			const client = { res, rows: Array.from({ length: current.height }, (_, y) => current.rowHtml(y)) };
			// The page was drawn from an earlier grid, perhaps: start the stream with the current one.
			send(res, "grid", current.html());
			clients.add(client);
			req.on("close", () => clients.delete(client));
			return;
		}
		const file = path.startsWith("/static/") ? path.slice("/static/".length) : undefined;
		if (file !== undefined && STATIC[file] !== undefined) {
			res.writeHead(200, { ...HEADERS, "content-type": STATIC[file], "cache-control": "max-age=3600" });
			return res.end(readFileSync(join(STATIC_DIR, file)));
		}
		reply(res, 404, "text/plain", "not found");
	});
	await new Promise<void>((resolve) => server.listen(port, host, resolve));
	const address = server.address();
	return {
		port: typeof address === "object" && address !== null ? address.port : port,
		close: async () => {
			clearInterval(tick);
			for (const client of clients) client.res.end();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

const HEADERS = {
	"content-security-policy": "default-src 'self'; frame-ancestors 'none'",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
};

function page(grid: Grid): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scout</title>
<link rel="stylesheet" href="/static/fonts/jetbrains-mono.css">
<link rel="stylesheet" href="/static/dash.css">
<script defer src="/static/dash.js"></script>
</head>
<body><main><pre id="grid" class="grid">${grid.html()}</pre></main></body>
</html>
`;
}

function reply(res: ServerResponse, status: number, type: string, body: string): void {
	res.writeHead(status, { ...HEADERS, "content-type": type, "cache-control": "no-store" });
	res.end(body);
}

function send(res: ServerResponse, event: string, data: unknown): void {
	res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function authorized(req: IncomingMessage, auth: DashOptions["auth"]): boolean {
	if (auth === undefined) return true;
	const header = req.headers.authorization ?? "";
	if (!header.startsWith("Basic ")) return false;
	const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
	const colon = decoded.indexOf(":");
	if (colon < 0) return false;
	const userOk = safeEqual(decoded.slice(0, colon), auth.user);
	const passwordOk = verifyPassword(decoded.slice(colon + 1), auth.passwordHash);
	return userOk && passwordOk;
}

/** `scrypt$<salt>$<hash>`, base64; `npm run dash-password -- '<password>'` prints one. */
export function hashPassword(password: string): string {
	const salt = randomBytes(16);
	return `scrypt$${salt.toString("base64")}$${scryptSync(password, salt, 32).toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
	const [scheme, salt, hash] = stored.split("$");
	if (scheme !== "scrypt" || salt === undefined || hash === undefined) return false;
	const expected = Buffer.from(hash, "base64");
	const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length);
	return timingSafeEqual(actual, expected);
}

function safeEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

function parseAddr(addr: string): { host: string; port: number } {
	const colon = addr.lastIndexOf(":");
	const host = addr.slice(0, colon).replace(/^\[|\]$/g, "") || "127.0.0.1";
	const port = Number(addr.slice(colon + 1));
	if (colon < 0 || !Number.isInteger(port)) throw new Error(`dashboard address ${addr} should look like host:port`);
	return { host, port };
}

function isLoopback(host: string): boolean {
	return host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
}

if (import.meta.main) {
	const password = process.argv[2];
	if (password === undefined) {
		console.error("usage: npm run dash-password -- '<password>'");
		process.exit(2);
	}
	console.log(hashPassword(password));
}
