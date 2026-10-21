/**
 * Scout's App Home tab, per person: what Scout is doing right now, their threads and what each is waiting on, what's
 * waiting on them, and the schedules they set up. Built from what Scout already keeps; Slack shows it when someone
 * opens the tab.
 */
export type HomeThread = { link?: string; channel: string; about: string; state: "working" | "queued" | "waiting on you" | "answered" };
export type HomeData = {
	/** What Scout is working on now, anywhere. */
	working: { link?: string; channel: string; minutes: number; lastStep?: string }[];
	queued: number;
	/** This person's recent threads (they started them or asked last). */
	threads: HomeThread[];
	/** What's waiting on this person: approvals Scout asked them for, questions it asked them. */
	waitingOnYou: { link?: string; channel: string; what: string }[];
	schedules: { id: number; channel: string; when: string; task: string; paused: boolean }[];
};

const STATE_ICONS: Record<HomeThread["state"], string> = { working: "⚙️", queued: "⏳", "waiting on you": "👋", answered: "✅" };

export function homeView(data: HomeData): { type: "home"; blocks: unknown[] } {
	const blocks: unknown[] = [];
	const section = (text: string) => blocks.push({ type: "section", text: { type: "mrkdwn", text } });
	const header = (text: string) => blocks.push({ type: "header", text: { type: "plain_text", text } });
	const link = (url: string | undefined, label: string) => (url === undefined ? label : `<${url}|${label}>`);

	header("Right now");
	if (data.working.length === 0) section(data.queued === 0 ? "Nothing on my plate. Mention me in a channel to start something." : `Nothing running, ${data.queued} waiting to start.`);
	else {
		section(
			data.working
				.map((w) => `⚙️ ${link(w.link, `#${w.channel}`)}, ${w.minutes} min${w.lastStep === undefined ? "" : `: ${w.lastStep}`}`)
				.concat(data.queued > 0 ? [`⏳ ${data.queued} more waiting to start`] : [])
				.join("\n"),
		);
	}

	if (data.waitingOnYou.length > 0) {
		blocks.push({ type: "divider" });
		header("Waiting on you");
		section(data.waitingOnYou.map((w) => `👋 ${link(w.link, `#${w.channel}`)}: ${w.what}`).join("\n"));
	}

	blocks.push({ type: "divider" });
	header("Your threads");
	section(
		data.threads.length === 0
			? "None yet. Threads you start with me, or ask me things in, show up here."
			: data.threads.map((t) => `${STATE_ICONS[t.state]} ${link(t.link, `#${t.channel}`)} ${clip(t.about, 80)} _(${t.state})_`).join("\n"),
	);

	if (data.schedules.length > 0) {
		blocks.push({ type: "divider" });
		header("Schedules you set up");
		section(data.schedules.map((s) => `${s.paused ? "⏸️" : "⏰"} #${s.id} in #${s.channel}: ${s.when}, ${clip(s.task, 80)}${s.paused ? " _(paused)_" : ""}`).join("\n"));
	}
	blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "Everything I do happens in public channels, so anyone can follow along. Ask me in any of them." }] });
	return { type: "home", blocks };
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
