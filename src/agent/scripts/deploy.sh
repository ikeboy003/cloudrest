#!/usr/bin/env bash
# Deploy the agent, syncing ~/.codex/auth.json as a secret
# so the Worker has the same credentials Codex CLI uses.
#
# Usage: ./scripts/deploy.sh

set -euo pipefail
cd "$(dirname "$0")/.."

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
AUTH_FILE="$CODEX_HOME/auth.json"

if [ -f "$AUTH_FILE" ]; then
  echo "Syncing $AUTH_FILE → CODEX_AUTH_JSON secret..."
  cat "$AUTH_FILE" | npx wrangler secret put CODEX_AUTH_JSON
else
  echo "Warning: $AUTH_FILE not found. Run 'codex login' first."
  echo "Deploying without Codex credentials — agent will use Workers AI."
fi

npx wrangler deploy
