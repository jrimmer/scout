import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { Audit } from "../src/audit.ts";
import { findSecrets, redact } from "../src/scan.ts";
import { fake, tempDir } from "./helpers.ts";

describe("more credential shapes", () => {
	const shapes: [text: string, kind: string][] = [
		[fake("npm", "_") + "aB3".repeat(12), "npm token"],
		[fake("pyp", "i-") + "AgEIcHlwaS5vcmc".padEnd(60, "x"), "PyPI token"],
		[fake("hf", "_") + "aBcDeFgHiJ".repeat(4), "Hugging Face token"],
		[fake("S", "G.") + "a".repeat(22) + "." + "b-_".repeat(14) + "c", "SendGrid key"],
		[fake("dop", "_v1_") + "0123456789abcdef".repeat(4), "DigitalOcean token"],
		[fake("S", "K") + "0123456789abcdef".repeat(2), "Twilio API key"],
		[fake("ke", "y-") + "0123456789abcdef".repeat(2), "Mailgun key"],
		[fake("https://hooks.", "slack.com/services/", "T0123ABCD/B0123ABCD/", "abcdefghijklmnopqrstuvwx"), "Slack webhook"],
		[fake("https://discord", ".com/api/webhooks/", "123456789012345678/", "abcDEF_ghi-JKLmnopQRSTuvwxyz0123456789"), "Discord webhook"],
		[fake("https://discord", "app.com/api/v10/webhooks/", "123456789012345678/", "abcDEF_ghi-JKLmnopQRSTuvwxyz0123456789"), "Discord webhook"],
		[fake("DefaultEndpointsProtocol=https;AccountName=x;Acc", "ountKey=") + "QUJD".repeat(22) + "==;EndpointSuffix=core.windows.net", "Azure storage key"],
	];
	for (const [text, kind] of shapes) {
		it(`finds and redacts a ${kind}`, () => {
			assert.ok(findSecrets(`see ${text} here`).some((f) => f.kind === kind), `${kind}: ${text}`);
			const out = redact(`see ${text} here`);
			assert.match(out, /\[redacted /);
			assert.ok(!out.includes(text.slice(8)), `${kind} is gone from: ${out}`);
		});
	}

	it("leaves ordinary prose and code alone", () => {
		for (const text of [
			"Bearer authentication-scheme is described in RFC 6750.",
			"Use the Bearer authentication scheme for the API.",
			"Send it as a Bearer token in the Authorization header, see the section on tokenization.",
			"npm_config_cache and npm_package_version are environment variables",
			"hf_hub_download(repo_id)",
			"Set pypi-mirror to your internal index",
			"SG.number of items, SK learning, key-value store",
			"discord webhooks are documented at https://discord.com/developers/docs/resources/webhook",
			"https://hooks.slack.com/ is Slack's incoming webhooks host",
			"AccountKey=<your key here>",
			"Mailgun's key-based auth: key-abc",
			"The doctor says: do the thing, then dop the cache",
		]) {
			assert.deepEqual(findSecrets(text), [], text);
			assert.equal(redact(text), text, text);
		}
	});

	it("still finds a bearer token", () => {
		assert.ok(findSecrets("curl -H 'Bearer 0123456789abcdefXYZ'").some((f) => f.kind === "bearer token"));
		assert.ok(findSecrets("Bearer abcdefGHIJKLmnopqrst").some((f) => f.kind === "bearer token"));
	});
});

describe("the audit trail redacts what it stores without breaking it", () => {
	const key = fake("-----BEGIN ", "RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA");

	it("stores valid JSON even for a private key with no end marker", () => {
		const dir = tempDir("scout-audit-");
		const path = `${dir}/audit.sqlite`;
		const audit = new Audit(path);
		audit.record("tool", { actor: "scout", detail: { args: { content: `before ${key}` }, after: "kept", list: [`x ${key}`, "y"] } });
		const [record] = audit.list();
		assert.deepEqual(record!.detail, { args: { content: "before [redacted private key]" }, after: "kept", list: ["x [redacted private key]", "y"] });
		audit.close();
	});

	it("lists a row that isn't JSON as it is, instead of throwing", () => {
		const dir = tempDir("scout-audit-");
		const path = `${dir}/audit.sqlite`;
		const audit = new Audit(path);
		audit.record("tool", { actor: "scout", detail: { ok: true } });
		audit.close();
		const db = new DatabaseSync(path);
		db.exec("DROP TRIGGER audit_no_update");
		db.prepare("UPDATE audit SET detail = ?").run('{"broken": "[redacted private key]');
		db.close();
		const again = new Audit(path);
		assert.deepEqual(again.list()[0]!.detail, { raw: '{"broken": "[redacted private key]' });
		again.close();
	});
});
