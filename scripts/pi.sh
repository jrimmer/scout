#!/usr/bin/env bash
# Which Pi Durable Scout runs on: `stable` (the release package.json pins), or `main` (or any branch, tag or commit) of
# github.com/earendil-works/pi, built locally. Main is installed without saving, so `npm ci` or `npm install` goes back
# to stable. pi-env stays at its release: its daemon is Rust and isn't built here.
set -euo pipefail
cd "$(dirname "$0")/.."
ref=${1:-stable}

if [ "$ref" = stable ]; then
	npm ci --no-audit --no-fund
	echo "Pi Durable: stable ($(node -p 'require("@earendil-works/pi-durable/package.json").version'))"
	exit 0
fi

src=${SCOUT_PI_SRC:-$HOME/.cache/scout/pi}
if [ -d "$src/.git" ]; then
	git -C "$src" fetch --quiet origin
else
	git clone --quiet https://github.com/earendil-works/pi.git "$src"
fi
git -C "$src" checkout --quiet --detach "origin/$ref" 2>/dev/null || git -C "$src" checkout --quiet --detach "$ref"
sha=$(git -C "$src" rev-parse --short HEAD)
echo "building Pi $ref ($sha) in $src"
(cd "$src" && npm ci --ignore-scripts --no-audit --no-fund --silent && node scripts/pack-packages.mjs --out .artifacts/scout --force >/dev/null)

tarballs=()
for name in chord pi-ai pi-durable pi-telemetry pi-codemode; do
	tarballs+=("$src"/.artifacts/scout/tarballs/earendil-works-"$name"-[0-9]*.tgz)
done
npm ci --no-audit --no-fund --silent
npm install --no-save --no-audit --no-fund --silent "${tarballs[@]}"
# main.ts reads this: it decides whether pi.sqlite may be converted (see docs/operations.md).
echo "$ref $sha" > node_modules/.pi-channel
echo "Pi Durable: $ref ($sha). \`npm run pi -- stable\` goes back."
