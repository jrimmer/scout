import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

const made: string[] = [];
process.once("exit", () => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/**
 * A new directory of its own under the system's temporary one, with symlinks resolved (macOS's /tmp is one). It is
 * removed when the test file's process exits, so tests never need to clean up after themselves (and a test that
 * fails halfway doesn't leave one behind). Close servers and databases in the test; this only deletes files.
 */
export function tempDir(prefix = "scout-test-"): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	made.push(dir);
	return dir;
}

/**
 * Wait until `check` holds, looking every 20 ms; fails after `ms` with `what` in the message. For waiting on what
 * Scout does in the background. To show something did NOT happen, wait for a signal that the work is over (an awaited
 * tick, `waitForIdle`) and then look, rather than sleeping.
 */
export async function until(check: () => boolean | Promise<boolean>, ms = 5000, what = "the condition"): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** A bare repository with one commit on `branch`, standing in for the code host. */
export function bareRepo(root: string, name: string, branch = "main"): string {
	return seedRepo(root, name, branch).remote;
}

/**
 * A bare repository (`remote`) and a working clone of it (`seed`) with one commit on `branch`, for tests that go on to
 * add commits and branches: `commit` returns the new commit's hash, `push` sends a branch to the remote.
 */
export function seedRepo(root: string, name: string, branch = "main", files: Record<string, string> = { "README.md": `${name}\n` }) {
	const remote = join(root, `${name}.git`);
	const seed = join(root, `${name}-seed`);
	git("init", "--quiet", "--bare", `--initial-branch=${branch}`, remote);
	git("init", "--quiet", `--initial-branch=${branch}`, seed);
	const commit = (changes: Record<string, string>, message: string): string => {
		for (const [file, text] of Object.entries(changes)) writeFileSync(join(seed, file), text);
		git("-C", seed, "add", ".");
		git("-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", message);
		return git("-C", seed, "rev-parse", "HEAD");
	};
	const push = (to = branch) => git("-C", seed, "push", "--quiet", remote, to);
	commit(files, "seed");
	push();
	return { remote, seed, commit, push, checkout: (to: string, create = false) => git("-C", seed, "checkout", "--quiet", ...(create ? ["-b"] : []), to) };
}
