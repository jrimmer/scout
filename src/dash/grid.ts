/**
 * A fixed-width character grid, the way spoond's dashboard draws: panels are box-drawing frames, meters and
 * sparklines are block glyphs, and every cell carries a style name. The page shows it as one `<span>` per row, so a
 * live update replaces only the rows that changed; the same grid prints as plain text for tests.
 */
export type Style = "" | "head" | "frame" | "title" | "dim" | "text" | "ok" | "warn" | "bad" | "state" | "id" | "spark";

type Cell = { ch: string; style: Style };

const SPARKS = "▁▂▃▄▅▆▇█";

/**
 * Only characters that are one cell wide in the grid's font. Text from people (names, notes, titles) may hold emoji
 * or wide scripts, which would push the rest of the row out of line, so they are shown as `·`.
 */
function narrow(text: string): string[] {
	return [...text.replace(/[\t\r\n]+/g, " ")].map((ch) => {
		const code = ch.codePointAt(0) ?? 0;
		return code < 0x1100 || (code >= 0x2000 && code < 0x2c00) ? ch : "·";
	});
}

export class Grid {
	readonly width: number;
	readonly #rows: Cell[][] = [];

	constructor(width: number) {
		this.width = width;
	}

	get height(): number {
		return this.#rows.length;
	}

	#row(y: number): Cell[] {
		while (this.#rows.length <= y) this.#rows.push(Array.from({ length: this.width }, () => ({ ch: " ", style: "" })));
		return this.#rows[y]!;
	}

	/** Write text from (x, y), cut at `max` cells (and the grid's edge). Returns the cells written. */
	put(x: number, y: number, text: string, style: Style = "text", max = this.width - x): number {
		const row = this.#row(y);
		const chars = narrow(text);
		const limit = Math.min(max, this.width - x);
		const shown = chars.length > limit ? [...chars.slice(0, Math.max(0, limit - 1)), "…"] : chars;
		shown.forEach((ch, i) => (row[x + i] = { ch, style }));
		return shown.length;
	}

	/** Write text so it ends at column `right` (exclusive). */
	putRight(right: number, y: number, text: string, style: Style = "text"): void {
		const length = narrow(text).length;
		this.put(Math.max(0, right - length), y, text, style);
	}

	/** A frame with its title in the top border. */
	box(x: number, y: number, w: number, h: number, title: string): void {
		this.put(x, y, `┌${"─".repeat(w - 2)}┐`, "frame");
		for (let i = 1; i < h - 1; i++) {
			this.put(x, y + i, "│", "frame");
			this.put(x + w - 1, y + i, "│", "frame");
		}
		this.put(x, y + h - 1, `└${"─".repeat(w - 2)}┘`, "frame");
		this.put(x + 2, y, ` ${title} `, "title", w - 4);
	}

	/** A dotted rule inside a panel. */
	rule(x: number, y: number, w: number): void {
		this.put(x, y, "┄".repeat(w), "frame");
	}

	/** `█` for the part of `fraction` that is filled, `░` for the rest; colored by thresholds. */
	meter(x: number, y: number, w: number, fraction: number, levels: { warn: number; bad: number; lowIsBad?: boolean }): void {
		const f = Math.max(0, Math.min(1, fraction));
		const filled = Math.round(f * w);
		const bad = levels.lowIsBad ? f <= levels.bad : f >= levels.bad;
		const warn = levels.lowIsBad ? f <= levels.warn : f >= levels.warn;
		this.put(x, y, "█".repeat(filled), bad ? "bad" : warn ? "warn" : "ok");
		this.put(x + filled, y, "░".repeat(w - filled), "dim");
	}

	/** The last `w` values as a sparkline, scaled to the largest. */
	spark(x: number, y: number, w: number, values: readonly number[]): void {
		const shown = values.slice(-w);
		const top = Math.max(...shown, 0);
		const line = shown
			.map((v) => (top === 0 ? SPARKS[0] : SPARKS[Math.min(SPARKS.length - 1, Math.floor((v / top) * (SPARKS.length - 1)))]))
			.join("");
		this.put(x + (w - shown.length), y, line, "spark");
	}

	text(): string {
		return this.#rows.map((row) => row.map((c) => c.ch).join("").trimEnd()).join("\n");
	}

	/** One row as HTML: runs of one style become one span. */
	rowHtml(y: number): string {
		const row = this.#rows[y] ?? [];
		let html = "";
		let style: Style | undefined;
		let run = "";
		const flush = () => {
			if (run === "") return;
			html += style === "" ? escape(run) : `<span class="g-${style}">${escape(run)}</span>`;
			run = "";
		};
		for (const cell of row) {
			if (cell.style !== style) {
				flush();
				style = cell.style;
			}
			run += cell.ch;
		}
		flush();
		return html;
	}

	/** Every row as `<span class="gr" id="rN">`, the unit a live update replaces. */
	html(): string {
		return this.#rows.map((_, y) => `<span class="gr" id="r${y}">${this.rowHtml(y)}</span>`).join("");
	}
}

function escape(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
