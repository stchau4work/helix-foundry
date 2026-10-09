# Sourced by the Conductor scripts: they run in non-interactive shells, which
# may not pick the Node version in .node-version on their own.
want=$(cat .node-version)
if [ "$(node -v 2>/dev/null | sed 's/^v//; s/\..*//')" != "$want" ]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh" --no-use && nvm use --silent "$want" >/dev/null
  elif command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env)" && fnm use --silent-if-unchanged "$want"
  fi
fi
if [ "$(node -v 2>/dev/null | sed 's/^v//; s/\..*//')" != "$want" ]; then
  echo "Node $want is required (found $(node -v 2>/dev/null || echo none)). Install it with nvm or fnm." >&2
  exit 1
fi
# Use the pnpm pinned in package.json without asking to download it.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
pnpm() { corepack pnpm "$@"; }
