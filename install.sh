#!/usr/bin/env bash
# Scout's installer: gets this machine ready, fetches Scout, and hands over to `npm run setup`, which walks through the
# rest (Slack, the code host, sandboxes, the model) and checks each step. Run it again any time: it only does what's
# missing, and never touches an existing .env.
#
#   curl -fsSL https://raw.githubusercontent.com/jrimmer/scout/main/install.sh | bash
#
# To read it first: download it, look, then `bash install.sh`. Settings, all optional:
#   SCOUT_REPO=<git url>   where Scout is cloned from   (default: https://github.com/jrimmer/scout.git)
#   SCOUT_REF=<tag|branch> what to install             (default: the newest release tag)
#   SCOUT_DIR=<path>       where it goes                (default: /opt/scout as root, ~/scout otherwise)
#   SCOUT_USER=<name>      the account that runs it     (default: scout, made if root; else the current user)
#   SCOUT_DRY_RUN=1        say what would be done, change nothing
set -euo pipefail
export PATH="/usr/local/bin:$PATH" LC_ALL=C.UTF-8 LANG=C.UTF-8

REPO="${SCOUT_REPO:-https://github.com/jrimmer/scout.git}"
REF="${SCOUT_REF:-}"
DRY="${SCOUT_DRY_RUN:-0}"
NODE_MAJOR=24

have_tty() { ( : </dev/tty ) 2>/dev/null; }
say() { printf '%s\n' "$*"; }
step() { printf '\n── %s\n' "$*"; }
die() { printf '❌ %s\n' "$*" >&2; exit 1; }
do_() { if [ "$DRY" = 1 ]; then printf '   would run: %s\n' "$*"; else "$@"; fi; }

if [ "$(id -u)" = 0 ]; then SUDO=""; else SUDO="sudo"; fi
as_root() { do_ $SUDO "$@"; }

[ "$(uname -s)" = Linux ] || die "This installer is for Linux. On other systems: git clone, npm ci, npm run setup (docs/setup.md)."
OS_ID=""; [ -r /etc/os-release ] && OS_ID="$(. /etc/os-release; echo "${ID:-} ${ID_LIKE:-}")"
case "$OS_ID" in
	*debian*|*ubuntu*) PKG=apt ;;
	*fedora*|*rhel*|*centos*) PKG=dnf ;;
	*arch*) PKG=pacman ;;
	*) PKG="" ;;
esac

install_packages() { # names are Debian's; the other families get their own below
	[ -n "$PKG" ] || die "I don't know this system's package manager. Install $* yourself, then run this again."
	case "$PKG" in
		apt) as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq -o Dpkg::Use-Pty=0 "$@" >/dev/null ;;
		dnf) as_root dnf install -y -q "$@" ;;
		pacman) as_root pacman -S --noconfirm --needed --quiet "$@" ;;
	esac
}
ssh_pkg() { case "$PKG" in apt) echo openssh-client ;; dnf) echo openssh-clients ;; *) echo openssh ;; esac; }

step "This machine"
[ "$DRY" = 1 ] || [ -z "$SUDO" ] || command -v sudo >/dev/null || die "Not root and no sudo. Run as root, or install sudo."
[ "$DRY" = 1 ] || [ -z "$SUDO" ] || sudo -v || die "I need sudo to install packages and make the scout user."

need=()
command -v curl >/dev/null || need+=(curl)
command -v git >/dev/null || need+=(git)
command -v ssh-keygen >/dev/null && command -v ssh-keyscan >/dev/null || need+=("$(ssh_pkg)")
command -v xz >/dev/null || need+=(xz-utils)
[ ${#need[@]} -eq 0 ] || { [ "$PKG" = apt ] && do_ $SUDO apt-get update -qq >/dev/null || true; install_packages "${need[@]}"; }
for c in curl git ssh-keygen; do [ "$DRY" = 1 ] || command -v "$c" >/dev/null || die "$c is still missing after installing it."; done
say "✅ curl, git and ssh"

have_node() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge "$NODE_MAJOR" ]; }
if have_node; then
	say "✅ Node $(node -v)"
else
	arch="$(uname -m)"; case "$arch" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) die "No Node build for $arch." ;; esac
	base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
	say "Node ${NODE_MAJOR} is missing or too old. Fetching it from nodejs.org and checking its SHA-256."
	if [ "$DRY" = 1 ]; then say "   would download $base/node-v${NODE_MAJOR}.*-linux-$arch.tar.xz and unpack it into /usr/local"; else
		tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
		curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/sums" || die "Couldn't fetch $base/SHASUMS256.txt."
		line="$(grep -E " node-v[0-9.]+-linux-$arch\.tar\.xz\$" "$tmp/sums")" || die "No Node build for $arch listed at $base."
		file="${line##* }"
		curl -fsSL "$base/$file" -o "$tmp/$file" || die "Couldn't download $file."
		(cd "$tmp" && echo "$line" | sha256sum -c - >/dev/null) || die "$file doesn't match its published SHA-256. Not installing it."
		$SUDO tar -xJf "$tmp/$file" -C /usr/local --strip-components=1 --no-same-owner --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md
		have_node || die "Node is still missing or old after installing it."
		say "✅ Node $(node -v)"
	fi
fi

# Docker is for the sandboxes. A spoond server needs none of it, so ask.
WANT_DOCKER="${SCOUT_DOCKER:-}"
if [ -z "$WANT_DOCKER" ] && ! command -v docker >/dev/null; then
	if have_tty && [ "$DRY" != 1 ]; then
		printf 'Will sandboxes run in Docker on this machine (not on a spoond server)? [Y/n] ' >/dev/tty; read -r a </dev/tty || a=""
		case "$a" in n*|N*) WANT_DOCKER=no ;; *) WANT_DOCKER=yes ;; esac
	else WANT_DOCKER=no; fi
fi
if command -v docker >/dev/null; then say "✅ Docker $(docker --version 2>/dev/null | cut -d' ' -f3 | tr -d ,)"
elif [ "$WANT_DOCKER" = yes ]; then
	[ "$PKG" = apt ] || die "Install Docker for this system (docs.docker.com/engine/install), then run this again."
	install_packages docker.io; say "✅ Docker"
else say "· Docker skipped"; fi

step "Scout"
if [ "$(id -u)" = 0 ]; then
	RUN_USER="${SCOUT_USER:-scout}"; DIR="${SCOUT_DIR:-/opt/scout}"
	if id "$RUN_USER" >/dev/null 2>&1; then say "✅ user $RUN_USER"; else
		do_ useradd -m -s /bin/bash "$RUN_USER"; say "✅ made user $RUN_USER"
	fi
	getent group docker >/dev/null && do_ usermod -aG docker "$RUN_USER" || true
else
	RUN_USER="${SCOUT_USER:-$(id -un)}"; DIR="${SCOUT_DIR:-$HOME/scout}"
fi
as_user() { if [ "$(id -un)" = "$RUN_USER" ]; then do_ "$@"; elif [ "$(id -u)" = 0 ]; then do_ runuser -u "$RUN_USER" -- "$@"; else do_ sudo -u "$RUN_USER" -- "$@"; fi; }

if [ -z "$REF" ]; then
	REF="$(git ls-remote --tags --refs --sort=-v:refname "$REPO" 'v*' 2>/dev/null | head -1 | sed 's|.*refs/tags/||' || true)"
	[ -n "$REF" ] || { REF=main; say "· no release tags found at $REPO; using main"; }
fi
say "Installing $REF from $REPO into $DIR"
if [ -d "$DIR/.git" ]; then
	as_user git -C "$DIR" fetch --tags --quiet origin
	as_user git -C "$DIR" checkout --quiet "$REF"
	as_user git -C "$DIR" merge --ff-only --quiet "origin/$REF" 2>/dev/null || true
else
	[ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ] && die "$DIR exists and isn't a Scout checkout. Pick another place with SCOUT_DIR=…"
	[ "$(id -u)" = 0 ] && do_ install -d -o "$RUN_USER" -g "$RUN_USER" "$DIR"
	as_user git clone --quiet --branch "$REF" "$REPO" "$DIR"
fi
as_user sh -c "cd '$DIR' && npm ci --no-fund --no-audit --loglevel=error"
say "✅ Scout $REF is in $DIR"

step "Setting it up"
if [ "$DRY" = 1 ]; then say "   would run: npm run setup, as $RUN_USER, in $DIR"; exit 0; fi
if ! have_tty; then
	say "No terminal to ask questions on. Finish with:  sudo -iu $RUN_USER sh -c 'cd $DIR && npm run setup'"; exit 0
fi
# `curl | bash` has used up stdin, so the questions are asked on the terminal.
as_user sh -c "cd '$DIR' && npm run setup" </dev/tty || { say "Setup stopped. Run it again any time:  sudo -iu $RUN_USER sh -c 'cd $DIR && npm run setup'"; exit 1; }

step "Running it"
if command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then
	if [ -f /etc/systemd/system/scout.service ]; then say "✅ the scout service is installed"; else
		printf 'Install Scout as a service (starts at boot, restarts if it stops)? [Y/n] ' >/dev/tty; read -r a </dev/tty || a=""
		case "$a" in
			n*|N*) say "Start it yourself with:  cd $DIR && npm start" ;;
			*)
				NODE_BIN="$(command -v node)"
				as_root sh -c "cat > /etc/systemd/system/scout.service <<UNIT
[Unit]
Description=Scout, a coding teammate in Slack
After=network-online.target docker.service
Wants=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$DIR
ExecStartPre=/usr/bin/flock $DIR/.deploy.lock true
TimeoutStartSec=15min
ExecStart=$NODE_BIN --env-file=$DIR/.env src/main.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT"
				as_root systemctl daemon-reload; as_root systemctl enable --now scout
				say "Starting…"; for _ in $(seq 40); do curl -fsS http://127.0.0.1:8893/healthz >/dev/null 2>&1 && break; sleep 1; done
				step "The doctor, with Scout running"
				as_user sh -c "cd '$DIR' && npm run doctor" || say "The doctor's ❌ lines say what's left. Run it any time:  npm run doctor"
				;;
		esac
	fi
else
	say "No systemd here. Start it with:  cd $DIR && npm start"
fi
say ""
say "Next: invite Scout to a public channel (/invite @Scout) and mention it. Check it any time with:  npm run doctor"
