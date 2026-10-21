/**
 * Previews of code host links pasted in Slack: what the pull request or issue is, where it stands (state, CI,
 * reviewers), and whether Scout is on it, with its thread. The link itself says which repository and number.
 */
export type PreviewInfo = {
	url: string;
	slug: string;
	number: number;
	title: string;
	pull: boolean;
	state: "open" | "closed" | "merged";
	author: string;
	ci?: "passing" | "failing" | "pending";
	reviewers: string[];
	/** Scout's thread for it, and whether it's working there now. */
	scout?: { link?: string; working: boolean };
};

/** `owner/repo` and the number in a pull request or issue link, on Forgejo (`/pulls/12`, `/issues/12`) or GitHub (`/pull/12`). */
export function parseCodeLink(url: string): { slug: string; number: number; pull: boolean } | undefined {
	let path: string;
	try {
		path = new URL(url).pathname;
	} catch {
		return undefined;
	}
	const m = /^\/([^/]+)\/([^/]+)\/(pulls|pull|issues)\/(\d+)\/?$/.exec(path);
	return m === null ? undefined : { slug: `${m[1]}/${m[2]}`, number: Number(m[4]), pull: m[3] !== "issues" };
}

const STATE_ICONS = { open: "🟢", closed: "⚪", merged: "🟣" } as const;
const CI_WORDS = { passing: "✅ CI passing", failing: "❌ CI failing", pending: "⏳ CI running" } as const;

export function previewBlocks(p: PreviewInfo): unknown[] {
	const facts = [
		`${STATE_ICONS[p.state]} ${p.state}`,
		...(p.author === "" ? [] : [`by ${p.author}`]),
		...(p.ci === undefined ? [] : [CI_WORDS[p.ci]]),
		...(p.reviewers.length === 0 ? [] : [`waiting on review from ${p.reviewers.join(", ")}`]),
	];
	const scout =
		p.scout === undefined
			? []
			: [
					{
						type: "context",
						elements: [{ type: "mrkdwn", text: `${p.scout.working ? "⚙️ Scout is working on this" : "Scout has a thread on this"}${p.scout.link === undefined ? "" : `: <${p.scout.link}|open it>`}` }],
					},
				];
	return [
		{ type: "section", text: { type: "mrkdwn", text: `*<${p.url}|${p.slug}#${p.number}>* ${escape(p.title)}\n${facts.join(" · ")}` } },
		...scout,
	];
}

function escape(text: string): string {
	return text.replace(/[&<>]/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt" }[c]};`);
}
