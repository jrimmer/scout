#!/usr/bin/env bash
# Deploy Scout on its server, as the user it runs as, from its install directory (docs/operations.md, "Deploying"):
#
#   scripts/deploy.sh [--pi-backed-up] [--unit NAME] [REF]        REF: origin/main unless given; NAME: scout
#
# Fetches; refuses unless the code host says CI passed on REF (and, when REF moves Pi Durable to another version,
# unless pi.sqlite is backed up: --pi-backed-up); takes the deploy lock, which Scout's unit waits on before it starts;
# drains Scout (the model calls and tool calls running finish, nothing new starts, then it stops) and waits for it to
# stop; fast-forwards and runs `npm ci` when package-lock.json changed; then lets go of the lock, so systemd starts Scout
# on the new code, and waits for its dashboard to say it's healthy. Runs carry on where they stopped.
set -euo pipefail
cd "$(dirname "$0")/.."

unit=scout
ref=origin/main
pi=()
while [ $# -gt 0 ]; do
	case "$1" in
		--pi-backed-up) pi=(--pi-backed-up) ;;
		--unit) unit=$2; shift ;;
		-h | --help) sed -n '2,10p' "$0"; exit 0 ;;
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

# A drain ends with Scout stopping, so systemd has to start it again whatever the exit; and it has to wait for the
# deploy's lock before it does, or the new process could start on half-updated code.
lock=$(pwd)/.deploy.lock
restart=$(systemctl show -p Restart --value "$unit")
[ "$restart" = always ] || fail "The $unit service has Restart=$restart. A drain stops Scout and needs Restart=always to start it again: update the unit from deploy/scout.service (docs/operations.md)."
case $(systemctl show -p ExecStartPre --value "$unit") in
	*"flock $lock "*) ;;
	*) fail "The $unit service doesn't wait for the deploy lock, so systemd could start Scout on half-updated code. Add these under [Service], then systemctl daemon-reload (deploy/scout.service, docs/operations.md):
    ExecStartPre=/usr/bin/flock $lock true
    TimeoutStartSec=15min" ;;
esac
main=$(systemctl show -p MainPID --value "$unit")
[ "$main" != 0 ] || fail "$unit isn't running. Start it, then deploy again."
# Scout's own node process: the main one, or, under a wrapper (an older unit ran it under `litestream replicate
# -exec`), the wrapper's child, since a wrapper may not pass a second signal (to stop at once) on.
pid=$main
case $(readlink "/proc/$main/exe" || true) in
	*/node) ;;
	*) pid=$(pgrep -P "$main" -f 'src/main\.ts' | head -n 1 || true) ;;
esac
[ -n "$pid" ] || fail "I can't find Scout's node process under $unit's main process ($main)."

say "Deploying $(git rev-parse --short "$from") → $(git rev-parse --short "$to"):"
git log --oneline --no-decorate "$from..$to" | sed 's/^/    /'
helper check "$from" "$to" "${pi[@]}" || fail "Not deploying."

# From here until it's let go, Scout can't start: neither the code nor node_modules changes under a running Scout.
exec 9>"$lock"
flock -n 9 || fail "Another deploy holds $lock. Wait for it to finish."
release() { flock -u 9; exec 9>&-; }
# Failing with the lock held: put the checkout back, so Scout starts on what it ran before, then let it start.
undo() {
	trap - EXIT
	if [ "$(git rev-parse HEAD)" != "$from" ]; then
		git reset --hard --quiet "$from"
		if $lock_changed && ! npm ci --no-audit --no-fund; then
			release
			fail "The checkout is back on $(git rev-parse --short "$from"), but npm ci failed there too, so node_modules is half-installed and Scout won't start cleanly. Run npm ci in $(pwd)."
		fi
		say "Put the checkout back on $(git rev-parse --short "$from"); Scout starts on that." >&2
	fi
	release
	exit 1
}
trap undo EXIT

since=$(date '+%Y-%m-%d %H:%M:%S')
say "Draining Scout (pid $pid): the steps running now finish, then it stops, and starts again once the new code is in place."
kill -INT "$pid" || { say "Scout (pid $pid) had already stopped. Nothing changed." >&2; undo; }
helper stopped "$main" || { say "Not deploying: nothing changed, and Scout starts on what it ran before once it stops." >&2; undo; }

git merge --ff-only --quiet "$to" || { say "Couldn't fast-forward to $(git rev-parse --short "$to")." >&2; undo; }
if $lock_changed; then
	say "package-lock.json changed: npm ci"
	npm ci --no-audit --no-fund || { say "npm ci failed." >&2; undo; }
fi
trap - EXIT
release

if ! helper restarted "$unit" "$main"; then
	fail "Deployed $(git rev-parse --short "$to"), but Scout isn't back."
fi
# What Scout said about the drain, where this user may read the journal.
journalctl -u "$unit" --since "$since" --no-pager -o cat -g 'drain|still busy' 2>/dev/null | sed 's/^/    /' || true
say "Deployed $(git log -1 --format='%h %s' "$to")."
