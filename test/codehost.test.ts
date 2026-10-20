import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOrFindPull } from "../src/codehost.ts";

describe("code host", () => {
	it("brings an open pull request's title and description up to date when its branch moves on", async () => {
		const calls: { method: string; url: string; body?: unknown }[] = [];
		const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			calls.push({ method, url: String(url), ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) });
			if (method === "POST") return new Response("pull request already exists", { status: 409 });
			if (method === "GET") return Response.json([{ html_url: "https://forge/team/app/pulls/7", number: 7, head: { ref: "scout/t-1" } }]);
			return Response.json({});
		}) as typeof globalThis.fetch;

		const pull = { title: "Fix it, and the docs", body: "Now with docs.", head: "scout/t-1", base: "main" };
		const created = await createOrFindPull({ kind: "forgejo", apiUrl: "https://forge/api/v1", token: "t" }, "team/app", fetch, pull);
		assert.deepEqual(created, { url: "https://forge/team/app/pulls/7", number: 7 });
		assert.deepEqual(calls.at(-1), { method: "PATCH", url: "https://forge/api/v1/repos/team/app/pulls/7", body: { title: pull.title, body: pull.body } });
	});
});
