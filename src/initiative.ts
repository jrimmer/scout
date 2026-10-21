/**
 * How much Scout does on its own initiative, as opposed to when someone asks. One dial with three positions; each
 * proactive feature keeps its own setting too, and the dial is the ceiling over them:
 *
 * - `asked`: only what people ask for (mentions, replies, the code host, reactions, shortcuts, /scout, workflows),
 *   and schedules they set up.
 * - `own`: also looks after its own work: fixing CI on its pull requests, keeping them mergeable, asking about its
 *   quiet ones, deleting its branches, following up on its stalled threads, its sandbox images, reviewers for its
 *   pull requests, and the nightly reflection on its own profile.
 * - `team` (default): also acts on the team's work: watching and investigating alerts, reminding reviewers of
 *   anyone's pull requests, the weekly report and summaries, channel canvases, the list of its work, link previews.
 */
export type Initiative = "asked" | "own" | "team";

export const INITIATIVES: readonly Initiative[] = ["asked", "own", "team"];

export function parseInitiative(value: string | undefined): Initiative {
	const v = (value ?? "team").trim().toLowerCase();
	if (v === "asked" || v === "own" || v === "team") return v;
	throw new Error(`SCOUT_INITIATIVE must be asked, own or team (it's "${value}"). See docs/setup.md, "How much Scout does on its own".`);
}

/** Whether Scout at `level` does something that needs `needed`. */
export function allows(level: Initiative, needed: Exclude<Initiative, "asked">): boolean {
	return INITIATIVES.indexOf(level) >= INITIATIVES.indexOf(needed);
}

/** What the level means, in Scout's voice, for the log at start and its home channel on first start. */
export function describeInitiative(level: Initiative): string {
	const asked = "I do what people ask me to (and schedules they set up)";
	const own = "look after my own work: CI on my pull requests, keeping them mergeable, asking about quiet ones, cleaning up my branches, following up on my stalled threads";
	const team = "act on the team's work too: investigating alerts, reminding reviewers, weekly summaries, channel canvases, the list of my work, link previews";
	const how = "Whoever runs me can change this with SCOUT_INITIATIVE (asked, own or team).";
	if (level === "asked") return `Initiative: asked. ${asked}, and nothing on my own. ${how}`;
	if (level === "own") return `Initiative: own. ${asked}, and ${own}. I leave the team's work alone. ${how}`;
	return `Initiative: team. ${asked}, ${own}, and ${team}. ${how}`;
}
