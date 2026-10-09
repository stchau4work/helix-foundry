#!/usr/bin/env bash
# Conductor archive script: removes the workspace's HelixDB container (see
# run.sh); its volume and data are kept.
cd "$(dirname "$0")/.."
docker rm -f "helix-foundry-dev-$(basename "$PWD" | tr -c 'a-zA-Z0-9_.\n-' '-')" >/dev/null 2>&1 || true
