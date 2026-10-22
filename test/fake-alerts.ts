import { createServer } from "node:http";

/**
 * Gatus and Grafana as the alert responder reads them, over HTTP: Gatus's endpoint statuses, and the alerts Grafana's
 * alertmanager says are firing (with the Viewer token it was given). Endpoints go down and up, and alerts fire and
 * clear, when a test says so; `fail` makes the next reads answer with an error, as a monitoring outage would.
 */
export async function fakeAlerts(options: { grafanaToken?: string } = {}) {
	const token = options.grafanaToken ?? "grafana-token";
	/** Gatus endpoints by key, each with its recent checks, oldest first. */
	const endpoints = new Map<string, { key: string; name: string; group: string; results: { success: boolean; status: number; timestamp: string; errors?: string[] }[] }>();
	/** Grafana alerts firing now, by fingerprint. */
	const firing = new Map<string, { fingerprint: string; labels: Record<string, string>; annotations: Record<string, string>; startsAt: string; status: { state: string } }>();
	const reads = { gatus: 0, grafana: 0 };
	let failing = 0;

	const check = (key: string, success: boolean, status = success ? 200 : 503) => {
		const endpoint = endpoints.get(key);
		if (endpoint === undefined) throw new Error(`no Gatus endpoint ${key}`);
		endpoint.results = [...endpoint.results, { success, status, timestamp: new Date().toISOString(), ...(success ? {} : { errors: [`answered ${status}`] }) }].slice(-20);
	};

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://alerts");
		const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
		if (failing > 0) {
			failing--;
			return json(502, { message: "bad gateway" });
		}
		if (url.pathname === "/gatus/api/v1/endpoints/statuses") {
			reads.gatus++;
			const size = Number(url.searchParams.get("pageSize") ?? 20);
			return json(200, [...endpoints.values()].map((e) => ({ ...e, results: e.results.slice(-size) })));
		}
		if (url.pathname === "/grafana/api/alertmanager/grafana/api/v2/alerts") {
			if (req.headers.authorization !== `Bearer ${token}`) return json(401, { message: "invalid API key" });
			reads.grafana++;
			return json(200, [...firing.values()]);
		}
		json(404, { message: "not found" });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

	return {
		/** SCOUT_ALERTS_GATUS_URL. */
		gatusUrl: `${base}/gatus`,
		/** SCOUT_ALERTS_GRAFANA_URL, with `grafanaToken` as SCOUT_ALERTS_GRAFANA_TOKEN. */
		grafanaUrl: `${base}/grafana`,
		grafanaToken: token,
		reads,
		/** A Gatus endpoint, healthy so far. */
		endpoint: (key: string, name: string, group = "") => {
			endpoints.set(key, { key, name, group, results: [] });
			check(key, true);
		},
		/** `times` failed checks in a row (Gatus alerts after two). */
		down: (key: string, times = 2, status = 503) => {
			for (let i = 0; i < times; i++) check(key, false, status);
		},
		up: (key: string) => check(key, true),
		/** A Grafana alert starts firing. */
		fire: (fingerprint: string, labels: Record<string, string>, annotations: Record<string, string> = {}) =>
			void firing.set(fingerprint, { fingerprint, labels, annotations, startsAt: new Date().toISOString(), status: { state: "active" } }),
		clear: (fingerprint: string) => void firing.delete(fingerprint),
		/** The next `times` reads, of either, answer 502. */
		fail: (times = 1) => {
			failing += times;
		},
		close: () => {
			server.closeAllConnections();
			return new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

export type FakeAlerts = Awaited<ReturnType<typeof fakeAlerts>>;
