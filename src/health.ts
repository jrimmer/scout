/**
 * Things that need a person: a background job that keeps failing, a server that is unreachable. Each has a key, so a
 * later success clears it. The dashboard shows them; logs keep the details.
 */
export class Health {
	readonly #problems = new Map<string, { message: string; since: number }>();

	problem(key: string, message: string, now = Date.now()): void {
		const existing = this.#problems.get(key);
		this.#problems.set(key, { message, since: existing?.since ?? now });
	}

	ok(key: string): void {
		this.#problems.delete(key);
	}

	list(): { key: string; message: string; since: number }[] {
		return [...this.#problems].map(([key, p]) => ({ key, ...p })).sort((a, b) => a.since - b.since);
	}

	/** Run `work`, recording a problem under `key` while it fails and clearing it once it succeeds. */
	async watch<T>(key: string, describe: string, work: () => Promise<T>): Promise<T | undefined> {
		try {
			const result = await work();
			this.ok(key);
			return result;
		} catch (error) {
			console.error(`${describe}:`, error);
			this.problem(key, `${describe}: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}
}
