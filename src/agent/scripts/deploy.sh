#!/usr/bin/env bash
# Deploy the agent, syncing the OpenAI key from ~/.codex-agent/auth.json
# into a Wrangler secret so the Worker can use it at runtime.
#
# Usage: ./scripts/deploy.sh

set -euo pipefail
cd "$(dirname "$0")/.."

AUTH_FILE="${CODEX_AGENT_HOME:-$HOME/.codex-agent}/auth.json"

# Sync OpenAI key from auth.json → Wrangler secret
if [ -f "$AUTH_FILE" ]; then
  API_KEY=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$AUTH_FILE','utf-8')).api_key)" 2>/dev/null || true)
  if [ -n "$API_KEY" ]; then
    echo "Syncing OPENAI_API_KEY from $AUTH_FILE..."
    echo "$API_KEY" | npx wrangler secret put OPENAI_API_KEY
  else
    echo "Warning: $AUTH_FILE exists but has no api_key field"
  fi
elif [ -n "${OPENAI_API_KEY:-}" ]; then
  echo "Syncing OPENAI_API_KEY from environment..."
  echo "$OPENAI_API_KEY" | npx wrangler secret put OPENAI_API_KEY
else
  echo "Warning: No OpenAI key found. Set OPENAI_API_KEY or run 'codex-agent login' first."
  echo "The agent will fall back to Workers AI."
fi

# Deploy
npx wrangler deploy
