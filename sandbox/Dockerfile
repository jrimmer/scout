# The image every thread's commands run in. Make it look like your developers' machines:
# the toolchains your repo needs, nothing secret. It runs as the host user, with no network by default.
FROM debian:trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates coreutils curl git jq less procps ripgrep fd-find \
      build-essential python3 nodejs npm golang-go \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

CMD ["sleep", "infinity"]
