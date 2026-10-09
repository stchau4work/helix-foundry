#!/usr/bin/env bash
# Conductor setup script: dependencies and this workspace's own .env.
set -eo pipefail
cd "$(dirname "$0")/.."
. .conductor/node.sh
pnpm install
# Never overwrites an existing .env (it holds the encryption key).
./scripts/setup.sh
