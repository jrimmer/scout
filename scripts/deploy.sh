#!/usr/bin/env bash
# Deploy Scout on its server, as the user it runs as, from its install directory (docs/operations.md, "Deploying"):
#
#   scripts/deploy.sh [--pi-backed-up] [--unit NAME] [REF]        REF: origin/main unless given; NAME: scout
#
# Fetches; refuses unless the code host says CI passed on REF (and, when REF moves Pi Durable to another version,
# unless pi.sqlite is backed up: --pi-backed-up); fast-forwards; runs `npm ci` when package-lock.json changed; then
# drains Scout (the model calls and tool calls running finish, nothing new starts, then it stops) and waits for systemd
# to start it again on the new code and for its dashboard to say it's healthy. Runs carry on where they stopped.
set -euo pipefail
cd "$(dirname "$0")/.."

unit=scout
ref=origin/main
pi=()
while [ $# -gt 0 ]; do
	case "$1" in
		--pi-backed-up) pi=(--pi-backed-up) ;;
		--unit) unit=$2; shift ;;
		-h | --help) sed -n '2,9p' "$0"; exit 0 ;;
		*) ref=$1 ;;
	esac
	shift
done
say() { echo "$(date +%H:%M:%S) $*"; }
fail() { say "$*" >&2; exit 1; }
helper() { node --env-file-if-exists=.env src/deploy.ts "$@"; }

[ -z "$(git status --porcelain --untracked-files=no)" ] || fail "This checkout has changes of its own; deploy only from a clean one."
git fetch --quiet origin
from=$(git rev-parse HEAD)
to=$(git rev-parse --verify --quiet "$ref^{commit}") || fail "There's no $ref."
if [ "$from" = "$to" ]; then
	say "Already on $(git log -1 --format='%h %s' "$to"). Nothing to deploy."
	exit 0
fi
git merge-base --is-ancestor "$from" "$to" || fail "$ref ($(git rev-parse --short "$to")) isn't ahead of this checkout ($(git rev-parse --short "$from")); a deploy only fast-forwards."
lock_changed=false
git diff --quiet "$from" "$to" -- package-lock.json || lock_changed=true
if $lock_changed && [ -f node_modules/.pi-channel ] && [ "$(cat node_modules/.pi-channel)" != stable ]; then
	fail "This install runs Pi Durable $(cat node_modules/.pi-channel) (npm run pi), and npm ci would put it back to the release. Deploy by hand."
fi

# A drain ends with Scout stopping, so systemd has to start it again whatever the exit.
restart=$(systemctl show -p Restart --value "$unit")
[ "$restart" = always ] || fail "The $unit service has Restart=$restart. A drain stops Scout and needs Restart=always to start it again: update the unit from deploy/scout.service (docs/operations.md)."
main=$(systemctl show -p MainPID --value "$unit")
[ "$main" != 0 ] || fail "$unit isn't running. Start it, then deploy again."
# Scout's own process: under Litestream, its child. Litestream passes SIGINT on too, but then a second signal (to stop
# at once) wouldn't reach Scout.
pid=$(pgrep -P "$main" -f 'src/main\.ts' | head -n 1 || true)
pid=${pid:-$main}

say "Deploying $(git rev-parse --short "$from") → $(git rev-parse --short "$to"):"
git log --oneline --no-decorate "$from..$to" | sed 's/^/    /'
helper check "$from" "$to" "${pi[@]}" || fail "Not deploying."

git merge --ff-only --quiet "$to"
if $lock_changed; then
	say "package-lock.json changed: npm ci"
	npm ci --no-audit --no-fund
fi

since=$(date '+%Y-%m-%d %H:%M:%S')
say "Draining Scout (pid $pid): the steps running now finish, then it restarts on the new code."
kill -INT "$pid"
if ! helper restarted "$unit" "$main"; then
	fail "Deployed $(git rev-parse --short "$to"), but Scout isn't back."
fi
# What Scout said about the drain, where this user may read the journal.
journalctl -u "$unit" --since "$since" --no-pager -o cat -g 'drain|still busy' 2>/dev/null | sed 's/^/    /' || true
say "Deployed $(git log -1 --format='%h %s' "$to")."
