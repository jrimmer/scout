import { readFileSync } from "node:fs";
import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * What a model response cost. pi-ai's catalog knows list prices; a local file can override them (negotiated rates, a
 * gateway's prices, models the catalog doesn't know). Dollars per million tokens:
 *
 *     { "anthropic/claude-opus-5-5": { "input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 6.25 } }
 */
export type Price = { input: number; output: number; cacheRead?: number; cacheWrite?: number };

export class Pricing {
	readonly #prices: Record<string, Price>;

	constructor(prices: Record<string, Price> = {}) {
		this.#prices = prices;
	}

	static load(path: string | undefined): Pricing {
		if (path === undefined) return new Pricing();
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, Partial<Price>>;
		const prices: Record<string, Price> = {};
		for (const [model, p] of Object.entries(raw)) {
			if (typeof p.input !== "number" || typeof p.output !== "number") {
				throw new Error(`${path}: ${model} needs numeric input and output prices (dollars per million tokens)`);
			}
			prices[model] = { input: p.input, output: p.output, ...(p.cacheRead === undefined ? {} : { cacheRead: p.cacheRead }), ...(p.cacheWrite === undefined ? {} : { cacheWrite: p.cacheWrite }) };
		}
		return new Pricing(prices);
	}

	/** Dollars for one response: the local price if there is one, otherwise pi-ai's. */
	cost(message: Pick<AssistantMessage, "provider" | "model" | "usage">): number {
		const price = this.#prices[`${message.provider}/${message.model}`];
		const usage = message.usage;
		if (price === undefined) return usage?.cost?.total ?? 0;
		return (
			((usage?.input ?? 0) * price.input +
				(usage?.output ?? 0) * price.output +
				(usage?.cacheRead ?? 0) * (price.cacheRead ?? price.input) +
				(usage?.cacheWrite ?? 0) * (price.cacheWrite ?? price.input)) /
			1_000_000
		);
	}
}
