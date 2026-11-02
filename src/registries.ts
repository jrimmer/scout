/**
 * The package registries a sandbox may reach so it can install the tools a task needs (a Python library, a JDK, a
 * Terraform provider) without anyone approving each host. A repository gets them by ecosystem (`registries` in the
 * repos file, `SCOUT_REPO_REGISTRIES`), added to its own egress list: public repositories get all of them unless they
 * say otherwise; a private one gets none until someone allows `@python` (or `@all`) for it from Slack.
 *
 * Exact hosts only: nothing here is a wildcard, and nothing is a host where anyone can publish a page (GitHub, S3,
 * CloudFront). `cdn` lists the hosts a registry sends downloads to (a redirect): they're separate so
 * `SCOUT_REGISTRY_CDNS=off` can leave them out, and a host a registry starts using that isn't listed is asked for like
 * any other (egress.ts).
 */
export const REGISTRIES: Record<string, { about: string; hosts: string[]; cdn?: string[] }> = {
	python: { about: "pip, uv and PyPI", hosts: ["pypi.org", "files.pythonhosted.org"] },
	node: { about: "npm and Yarn", hosts: ["registry.npmjs.org", "registry.yarnpkg.com"] },
	rust: { about: "cargo and rustup", hosts: ["crates.io", "index.crates.io", "static.crates.io", "static.rust-lang.org"] },
	go: { about: "Go modules", hosts: ["proxy.golang.org", "sum.golang.org"] },
	jvm: { about: "Maven and Gradle", hosts: ["repo.maven.apache.org", "repo1.maven.org", "plugins.gradle.org", "services.gradle.org"], cdn: ["downloads.gradle.org"] },
	dotnet: { about: "NuGet and the .NET SDK", hosts: ["api.nuget.org", "builds.dotnet.microsoft.com"], cdn: ["globalcdn.nuget.org", "ci.dot.net"] },
	ruby: { about: "RubyGems", hosts: ["rubygems.org", "index.rubygems.org"] },
	php: { about: "Composer and Packagist", hosts: ["repo.packagist.org", "packagist.org"] },
	elixir: { about: "Hex", hosts: ["hex.pm", "repo.hex.pm", "builds.hex.pm"] },
	terraform: { about: "Terraform and OpenTofu providers", hosts: ["registry.terraform.io", "releases.hashicorp.com", "registry.opentofu.org"] },
	ansible: { about: "Ansible Galaxy (Ansible itself comes from python)", hosts: ["galaxy.ansible.com"] },
	apt: { about: "Debian and Ubuntu packages (a JDK, ImageMagick…)", hosts: ["deb.debian.org", "security.debian.org", "archive.ubuntu.com", "security.ubuntu.com"] },
};

/** `@all` stands for every ecosystem above. */
export const ALL_REGISTRIES = "all";

/** `python`, `@python`, `all`, `@all` → the name, if it is one. */
export function registryName(text: string): string | undefined {
	const name = text.trim().replace(/^@/, "").toLowerCase();
	return name === ALL_REGISTRIES || Object.hasOwn(REGISTRIES, name) ? name : undefined;
}

/** The hosts for these ecosystems (names, or `all`); unknown names are ignored. Each host once. */
export function registryHosts(names: string[], cdns = true): string[] {
	const wanted = names.map(registryName);
	const chosen = wanted.includes(ALL_REGISTRIES) ? Object.keys(REGISTRIES) : wanted.filter((n): n is string => n !== undefined);
	const hosts = chosen.flatMap((name) => [...REGISTRIES[name]!.hosts, ...(cdns ? (REGISTRIES[name]!.cdn ?? []) : [])]);
	return [...new Set(hosts)];
}

/** Names in a list that aren't ecosystems, so a typo is told at start. */
export function unknownRegistries(names: string[]): string[] {
	return names.filter((n) => registryName(n) === undefined);
}
