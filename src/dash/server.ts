import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ModelScores } from "../bench.ts";
import { benchPage } from "./bench.ts";
import type { Running } from "../doctor.ts";
import { redact } from "../scan.ts";
import type { Collector, Snapshot } from "./collect.ts";
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
	/**
	 * Prometheus metrics at /metrics: with a token, only for that bearer token; without, behind the dashboard's login.
	 * The token also reads /status.json, but only the part the doctor checks a running Scout by (`forMonitors`).
	 */
	metrics?: { token?: string; render: () => Promise<string> };
	/** The nightly benchmark's scores, when it's on: a Benchmark page at /bench, linked from the footer. */
	bench?: () => { scores: ModelScores[]; lastRun?: string; keep: number; hour: number; tasks: number };
};

const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "static");
const STATIC = new Map([
	["dash.css", "text/css; charset=utf-8"],
	["dash.js", "text/javascript; charset=utf-8"],
	["fonts/jetbrains-mono.css", "text/css; charset=utf-8"],
	["fonts/jetbrains-mono.woff2", "font/woff2"],
	["fonts/jetbrains-mono-bold.woff2", "font/woff2"],
]);
/** Live views at once; each holds a connection and gets every change. */
const MAX_STREAMS = 20;

type Client = { res: ServerResponse; rows: string[]; behind: boolean };

export async function startDashboard(options: DashOptions): Promise<{ port: number; close: () => Promise<void> }> {
	const { host, port } = parseAddr(options.addr);
	if (options.auth === undefined && !isLoopback(host)) {
		throw new Error(`the dashboard on ${options.addr} needs SCOUT_DASH_USER and SCOUT_DASH_PASSWORD_HASH (or a loopback address)`);
	}
	const clients = new Set<Client>();
	const login = gate(options.auth);
	const links = { bench: options.bench !== undefined };
	let current: Grid = layout(await options.collector.collect(), undefined, links);

	const tick = setInterval(async () => {
		try {
			current = layout(await options.collector.collect(), undefined, links);
		} catch (error) {
			console.error("dashboard collect failed:", error);
			return;
		}
		const rows = Array.from({ length: current.height }, (_, y) => current.rowHtml(y));
		for (const client of clients) {
			// A viewer still not done reading the last change won't keep up: let it go rather than hold its backlog.
			if (client.behind) {
				clients.delete(client);
				client.res.destroy();
				continue;
			}
			if (client.rows.length !== rows.length) {
				send(client, "grid", current.html());
			} else {
				const changed = rows.flatMap((html, y) => (html === client.rows[y] ? [] : [{ id: `r${y}`, html }]));
				if (changed.length > 0) send(client, "rows", changed);
			}
			client.rows = rows;
		}
	}, options.intervalMs ?? 5000);
	tick.unref();

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const path = new URL(req.url ?? "/", "http://dash").pathname;
		if (path === "/healthz") return reply(res, 200, "text/plain", "ok");
		// Without a login, only to loopback names: a web page that points its own name at 127.0.0.1 (DNS rebinding) gets nothing.
		if (options.auth === undefined && !loopbackHost(req.headers.host)) return reply(res, 403, "text/plain", "this dashboard answers to localhost only");
		// For monitors: the metrics, and the dashboard's snapshot as JSON (what `npm run doctor` checks a running Scout by).
		if ((path === "/metrics" || path === "/status.json") && options.metrics !== undefined) {
			const { token, render } = options.metrics;
			const bearer = token !== undefined && safeEqual(req.headers.authorization ?? "", `Bearer ${token}`);
			if (path === "/metrics") {
				if (token !== undefined && !bearer) return reply(res, 401, "text/plain", "unauthorized");
				if (token === undefined) {
					const verdict = await login(req);
					if (verdict !== "ok") return refuse(res, verdict);
				}
				return reply(res, 200, "text/plain; version=0.0.4", await render());
			}
			if (bearer) return reply(res, 200, "application/json", JSON.stringify(forMonitors(await options.collector.collect())));
		}
		const verdict = await login(req);
		if (verdict !== "ok") return refuse(res, verdict);
		if (req.method !== "GET") return reply(res, 405, "text/plain", "read-only");
		if (path === "/") return reply(res, 200, "text/html; charset=utf-8", page(current));
		if (path === "/status.json" && options.metrics !== undefined) return reply(res, 200, "application/json", JSON.stringify(await options.collector.collect()));
		if (path === "/bench" && options.bench !== undefined) {
			const { scores, ...meta } = options.bench();
			return reply(res, 200, "text/html; charset=utf-8", benchPage(scores, meta));
		}
		if (path === "/stream") {
			if (clients.size >= MAX_STREAMS) {
				res.writeHead(503, { ...HEADERS, "content-type": "text/plain", "retry-after": "30" });
				return void res.end("too many live views open; close one");
			}
			res.writeHead(200, { ...HEADERS, "content-type": "text/event-stream", "cache-control": "no-store" });
			const client: Client = { res, rows: Array.from({ length: current.height }, (_, y) => current.rowHtml(y)), behind: false };
			clients.add(client);
			req.on("close", () => clients.delete(client));
			// The page was drawn from an earlier grid, perhaps: start the stream with the current one.
			send(client, "grid", current.html());
			return;
		}
		const file = path.startsWith("/static/") ? path.slice("/static/".length) : undefined;
		const type = file === undefined ? undefined : STATIC.get(file);
		if (file !== undefined && type !== undefined) {
			res.writeHead(200, { ...HEADERS, "content-type": type, "cache-control": "max-age=3600" });
			return void res.end(readFileSync(join(STATIC_DIR, file)));
		}
		reply(res, 404, "text/plain", "not found");
	}

	// It runs inside Scout's process: no request may take that down, whatever goes wrong answering it.
	const server = createServer((req, res) => {
		handle(req, res).catch((error: unknown) => {
			console.error("dashboard request failed:", error);
			if (res.headersSent) res.destroy();
			else reply(res, 500, "text/plain", "something went wrong");
		});
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

/** An event to a live view; one whose connection won't take more (its buffer is full) is behind until it drains. */
function send(client: Client, event: string, data: unknown): void {
	if (client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) return;
	client.behind = true;
	client.res.once("drain", () => (client.behind = false));
}

/**
 * The dashboard's login. scrypt is slow on purpose, so it runs off the event loop and one check at a time (a request that
 * comes while one runs gets a 429), and the last login that passed is remembered by its hash: a browser that's logged in
 * doesn't pay for scrypt on every request, and bad logins can't stall Scout.
 */
function gate(auth: DashOptions["auth"]): (req: IncomingMessage) => Promise<"ok" | "no" | "busy"> {
	let passed: Buffer | undefined;
	let checking = false;
	return async (req) => {
		if (auth === undefined) return "ok";
		const header = req.headers.authorization ?? "";
		if (!header.startsWith("Basic ")) return "no";
		const digest = createHash("sha256").update(header).digest();
		if (passed !== undefined && timingSafeEqual(digest, passed)) return "ok";
		const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
		const colon = decoded.indexOf(":");
		if (colon < 0) return "no";
		if (checking) return "busy";
		checking = true;
		try {
			const userOk = safeEqual(decoded.slice(0, colon), auth.user);
			const passwordOk = await verifyPassword(decoded.slice(colon + 1), auth.passwordHash);
			if (!userOk || !passwordOk) return "no";
			passed = digest;
			return "ok";
		} finally {
			checking = false;
		}
	};
}

function refuse(res: ServerResponse, verdict: "no" | "busy"): void {
	if (verdict === "busy") res.writeHead(429, { "retry-after": "1" });
	else res.writeHead(401, { "www-authenticate": 'Basic realm="scout", charset="UTF-8"' });
	res.end();
}

/**
 * What the metrics token reads at /status.json: what the doctor checks a running Scout by (doctor.ts `Running`) and
 * which model is answering, without what people said or asked (memory notes, schedules, thread steps). A scrape
 * credential shouldn't read conversations.
 */
export function forMonitors(s: Snapshot): Running & Pick<Snapshot, "models"> {
	return {
		now: s.now,
		startedAt: s.startedAt,
		alerts: s.alerts.map((a) => ({ message: redact(a.message), since: a.since })),
		working: s.working.map(({ lastStep: _, ...w }) => w),
		...(s.capacity === undefined ? {} : { capacity: s.capacity }),
		...(s.backup === undefined ? {} : { backup: s.backup }),
		...(s.models === undefined ? {} : { models: { ...s.models, outages: s.models.outages.map((o) => (o.error === undefined ? o : { ...o, error: redact(o.error) })) } }),
	};
}

/** `scrypt$<salt>$<hash>`, base64; `npm run dash-password -- '<password>'` prints one. */
export function hashPassword(password: string): string {
	const salt = randomBytes(16);
	return `scrypt$${salt.toString("base64")}$${scryptSync(password, salt, 32).toString("base64")}`;
}

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, length: number) => Promise<Buffer>;

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [scheme, salt, hash] = stored.split("$");
	if (scheme !== "scrypt" || salt === undefined || hash === undefined) return false;
	const expected = Buffer.from(hash, "base64");
	if (expected.length < 16) return false;
	const actual = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length);
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

/** A `Host` header naming loopback, with or without a port: `localhost:8893`, `127.0.0.1`, `[::1]:8893`. */
function loopbackHost(header: string | undefined): boolean {
	if (header === undefined) return false;
	return isLoopback(header.toLowerCase().replace(/:\d*$/, "").replace(/^\[(.*)\]$/, "$1"));
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
