#!/usr/bin/env bash
# Conductor run script: `pnpm dev` on this workspace's ports, with its own
# HelixDB, so several workspaces can run at once without sharing data or
# running two workers against one database.
#
#   CONDUCTOR_PORT     web app (open this one)
#   CONDUCTOR_PORT+1   API
#   CONDUCTOR_PORT+2   DuckDB executor
#   CONDUCTOR_PORT+3   HelixDB (container helix-foundry-dev-<workspace folder>)
set -eo pipefail
cd "$(dirname "$0")/.."
: "${CONDUCTOR_PORT:?Run this from Conductor, or use pnpm dev directly}"
. .conductor/node.sh
[ -f .env ] || ./scripts/setup.sh

web=$CONDUCTOR_PORT api=$((web + 1)) executor=$((web + 2)) helix=$((web + 3))
# Named after the workspace folder, which survives renames (the display name
# may contain spaces). archive.sh uses the same name.
name="helix-foundry-dev-$(basename "$PWD" | tr -c 'a-zA-Z0-9_.\n-' '-')"
image=ghcr.io/helixdb/helixdb:v0.0.6@sha256:94b29942658ebdca0a91bf15edffe921a46da3e26e1223ea333ccce58c6212dd

# Recreate the container (its volume and data stay) if it was published on
# another port, e.g. after Conductor assigned this workspace new ports.
if docker container inspect "$name" >/dev/null 2>&1 &&
  ! docker port "$name" 8080/tcp 2>/dev/null | grep -q ":$helix\$"; then
  docker rm -f "$name" >/dev/null
fi
if docker container inspect "$name" >/dev/null 2>&1; then
  docker start "$name" >/dev/null
else
  docker run -d --name "$name" -p "127.0.0.1:$helix:8080" \
    -e HELIX_DATA_DIR=/var/lib/helix -v "$name:/var/lib/helix" "$image" >/dev/null
fi
printf 'Waiting for HelixDB (%s) on %s' "$name" "$helix"
for _ in $(seq 1 60); do
  curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:$helix/readyz" 2>/dev/null && break
  printf .
  sleep 1
done
echo

# Shell variables win over .env, so the keys and DATA_DIR still come from it.
export HELIX_URL="http://127.0.0.1:$helix"
export PORT=$api EXECUTOR_PORT=$executor EXECUTOR_URL="http://127.0.0.1:$executor"
export APP_ORIGIN="http://localhost:$web" VITE_PORT=$web API_PROXY="http://127.0.0.1:$api"
echo "Helix Foundry: http://localhost:$web"
exec corepack pnpm dev
