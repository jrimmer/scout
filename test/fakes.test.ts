import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gatusAlerts, grafanaAlerts } from "../src/alerts.ts";
import { forgeFor } from "../src/forge.ts";
import { fakeAlerts } from "./fake-alerts.ts";
import { fakeCodeHost } from "./fake-codehost.ts";
import { fakeSlack } from "./fake-slack.ts";
import { git, seedRepo, tempDir } from "./helpers.ts";

/** The shared fakes answer the way Scout's own clients read them, so end-to-end tests can trust them. */
describe("shared fakes", () => {
	for (const kind of ["forgejo", "github"] as const) {
		it(`the fake code host speaks ${kind}'s dialect to forge.ts`, async () => {
			const host = await fakeCodeHost({ kind });
			const repo = seedRepo(tempDir(), "app", "main", { "a.txt": "a\n" });
			repo.checkout("feature", true);
			const head = repo.commit({ "b.txt": "b\n" }, "add b");
			repo.push("feature");
			host.repo("acme/app", { git: repo.remote, private: true });
			const forge = forgeFor({ kind, apiUrl: host.apiUrl, token: "t" });
			try {
				assert.equal(await forge.me(), "scout");
				assert.equal(await forge.isPublic("acme/app"), false);

				const issue = host.issue("acme/app", { title: "The median is wrong", body: "It's off by one." });
				const pull = host.pull("acme/app", { title: "Add b", head: "feature", author: "bob", reviewers: ["scout"] });
				host.comment("acme/app", issue, "ann", "@scout can you fix this?");
				host.review("acme/app", pull, "carol", "REQUEST_CHANGES", "Needs a test.", [{ path: "b.txt", line: 1, body: "Name this better." }]);
				host.notify("acme/app", pull);

				const notices = await forge.unread();
				assert.deepEqual(notices.map((n) => `${n.slug}#${n.number}`), ["acme/app#1", "acme/app#2"]);
				for (const n of notices) await forge.markRead(n);
				assert.deepEqual(await forge.unread(), []);

				const asked = await forge.issue("acme/app", issue);
				assert.equal(asked.title, "The median is wrong");
				assert.equal(asked.pull, false);
				const remarks = await forge.remarks(asked);
				assert.deepEqual(remarks.map((r) => `${r.author}: ${r.body}`), ["ann: @scout can you fix this?"]);
				await forge.acknowledge("acme/app", issue, remarks[0]!.id);
				await forge.comment("acme/app", issue, "On it.");
				assert.equal(host.get("acme/app", issue)?.comments.at(-1)?.body, "On it.");
				assert.equal(host.reactions.length, 1);

				const reviewed = await forge.remarks(await forge.issue("acme/app", pull));
				assert.ok(reviewed.some((r) => r.author === "carol" && r.path === "b.txt" && r.line === 1), JSON.stringify(reviewed));

				const status = await forge.pullStatus("acme/app", pull);
				assert.equal(status.head, head, "the head commit comes from the repository");
				assert.equal(status.headRef, "feature");
				assert.deepEqual(status.reviewers, ["scout"]);
				assert.deepEqual(await forge.pullFiles("acme/app", pull), ["b.txt"]);
				assert.equal(await forge.headBranch("acme/app", pull), "feature");
				assert.equal(await forge.ciState("acme/app", head), undefined, "no CI yet");
				host.ci(head, "pending");
				assert.equal(await forge.ciState("acme/app", head), "pending");
				host.ci(head, "failure", "ci/test", { target_url: "/acme/app/actions/runs/1" });
				assert.equal(await forge.ciState("acme/app", head), "failing");

				await forge.requestReviewers("acme/app", pull, { users: ["dave"], teams: [] });
				assert.deepEqual((await forge.openPulls("acme/app")).map((p) => [p.number, p.reviewers]), [[pull, ["scout", "dave"]]]);
				await forge.closePull("acme/app", pull);
				assert.equal((await forge.pullStatus("acme/app", pull)).open, false);
				await forge.deleteBranch("acme/app", "feature");
				assert.deepEqual(host.deleted, ["acme/app:feature"]);
				assert.equal(git("--git-dir", repo.remote, "for-each-ref", "refs/heads/feature"), "", "the branch is gone from the repository");

				host.fail("GET", /^\/user$/, 503);
				await assert.rejects(forgeFor({ kind, apiUrl: host.apiUrl, token: "t" }).me(), /503/);
				assert.equal(await forgeFor({ kind, apiUrl: host.apiUrl, token: "t" }).me(), "scout", "a fault is used up");
			} finally {
				await host.close();
			}
		});
	}

	it("fake Slack goes down for a while, for some methods or all, and comes back", async () => {
		const slack = await fakeSlack();
		const post = (method: string) => fetch(`${slack.apiUrl}${method}`, { method: "POST", headers: { authorization: "Bearer xoxb-test" }, body: new URLSearchParams({ channel: "C1", text: "hi" }) });
		try {
			slack.down(60_000, { methods: ["chat.postMessage"] });
			assert.equal((await post("chat.postMessage")).status, 503);
			assert.equal((await post("chat.update")).status, 200, "only the methods named");
			slack.up();
			assert.equal((await post("chat.postMessage")).status, 200);
			slack.down(200, { hang: true });
			const started = Date.now();
			await assert.rejects(post("chat.update"), "no answer, then the connection drops");
			assert.ok(Date.now() - started >= 150);
			assert.equal((await post("chat.update")).status, 200, "and it's back once the outage is over");
			assert.equal(slack.called("chat.update").length, 3, "calls are recorded through an outage");
		} finally {
			await slack.close(0);
		}
	});

	it("the fake Gatus and Grafana fire and clear alerts as the alert sources read them", async () => {
		const alerts = await fakeAlerts();
		try {
			alerts.endpoint("core_api", "api", "core");
			assert.deepEqual(await gatusAlerts(alerts.gatusUrl), []);
			alerts.down("core_api");
			assert.deepEqual((await gatusAlerts(alerts.gatusUrl)).map((a) => a.title), ["core / api is down"]);
			alerts.up("core_api");
			assert.deepEqual(await gatusAlerts(alerts.gatusUrl), []);

			alerts.fire("f1", { alertname: "DiskFull", instance: "db1", severity: "critical" }, { summary: "Disk is 95% full" });
			const firing = await grafanaAlerts(alerts.grafanaUrl, alerts.grafanaToken);
			assert.deepEqual(firing.map((a) => a.title), ["DiskFull on db1 (critical)"]);
			await assert.rejects(grafanaAlerts(alerts.grafanaUrl, "wrong"), /401/);
			alerts.clear("f1");
			assert.deepEqual(await grafanaAlerts(alerts.grafanaUrl, alerts.grafanaToken), []);

			alerts.fail();
			await assert.rejects(gatusAlerts(alerts.gatusUrl), /502/);
			assert.equal(alerts.reads.gatus, 3);
		} finally {
			await alerts.close();
		}
	});
});
