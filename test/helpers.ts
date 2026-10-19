import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

/** A bare repository with one commit on `branch`, standing in for the code host. */
export function bareRepo(root: string, name: string, branch = "main"): string {
	const remote = join(root, `${name}.git`);
	const seed = join(root, `${name}-seed`);
	git("init", "--quiet", "--bare", `--initial-branch=${branch}`, remote);
	git("init", "--quiet", `--initial-branch=${branch}`, seed);
	writeFileSync(join(seed, "README.md"), `${name}\n`);
	git("-C", seed, "add", ".");
	git("-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "seed");
	git("-C", seed, "push", "--quiet", remote, branch);
	return remote;
}
