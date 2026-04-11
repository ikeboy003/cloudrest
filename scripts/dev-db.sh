#!/usr/bin/env bash
# Manage the local development Postgres container.
#
# Uses podman (or docker — set CONTAINER_CMD=docker) to run pgvector/pgvector:pg16
# on a non-default port so it doesn't collide with whatever you already have
# running on 5432. Loads examples/schema.sql on up.
#
# Commands:
#   up      Start the container (idempotent) and load the example schema
#   down    Stop and remove the container
#   reset   Down + up, giving you a clean DB
#   psql    Open a psql shell against the container
#   url     Print the connection string (useful for `$(./scripts/dev-db.sh url)`)
#
# Environment:
#   CONTAINER_CMD   podman (default) or docker
#   DB_PORT         host port (default 5433)
#   DB_PASSWORD     postgres password (default "cloudrest-dev")
#   DB_NAME         database name (default "cloudrest_dev")

set -euo pipefail

: "${CONTAINER_CMD:=podman}"
: "${DB_PORT:=5433}"
: "${DB_PASSWORD:=cloudrest-dev}"
: "${DB_NAME:=cloudrest_dev}"

CONTAINER_NAME="cloudrest-dev-pg"
IMAGE="pgvector/pgvector:pg16"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA_FILE="$REPO_ROOT/examples/schema.sql"

connection_string() {
  echo "postgres://postgres:${DB_PASSWORD}@localhost:${DB_PORT}/${DB_NAME}"
}

is_running() {
  "$CONTAINER_CMD" ps --filter "name=^${CONTAINER_NAME}$" --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_NAME}$"
}

exists() {
  "$CONTAINER_CMD" ps -a --filter "name=^${CONTAINER_NAME}$" --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_NAME}$"
}

wait_for_pg() {
  local tries=30
  while (( tries > 0 )); do
    if "$CONTAINER_CMD" exec "$CONTAINER_NAME" pg_isready -U postgres >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    tries=$(( tries - 1 ))
  done
  echo "postgres did not become ready in 30 seconds" >&2
  return 1
}

cmd_up() {
  if is_running; then
    echo "$CONTAINER_NAME is already running on port $DB_PORT"
  elif exists; then
    "$CONTAINER_CMD" start "$CONTAINER_NAME" >/dev/null
    echo "started existing $CONTAINER_NAME"
  else
    "$CONTAINER_CMD" run -d \
      --name "$CONTAINER_NAME" \
      -e POSTGRES_PASSWORD="$DB_PASSWORD" \
      -e POSTGRES_DB="$DB_NAME" \
      -p "${DB_PORT}:5432" \
      "$IMAGE" >/dev/null
    echo "created $CONTAINER_NAME"
  fi

  wait_for_pg

  if [[ -f "$SCHEMA_FILE" ]]; then
    echo "loading $SCHEMA_FILE"
    "$CONTAINER_CMD" exec -i "$CONTAINER_NAME" \
      psql -v ON_ERROR_STOP=1 -U postgres -d "$DB_NAME" < "$SCHEMA_FILE" >/dev/null
  else
    echo "warning: $SCHEMA_FILE not found, skipping schema load" >&2
  fi

  echo
  echo "ready: $(connection_string)"
}

cmd_down() {
  if exists; then
    "$CONTAINER_CMD" rm -f "$CONTAINER_NAME" >/dev/null
    echo "removed $CONTAINER_NAME"
  else
    echo "$CONTAINER_NAME is not running"
  fi
}

cmd_reset() {
  cmd_down
  cmd_up
}

cmd_psql() {
  if ! is_running; then
    echo "$CONTAINER_NAME is not running — run \`$0 up\` first" >&2
    exit 1
  fi
  exec "$CONTAINER_CMD" exec -it "$CONTAINER_NAME" psql -U postgres -d "$DB_NAME"
}

cmd_url() {
  connection_string
}

case "${1:-}" in
  up)    cmd_up ;;
  down)  cmd_down ;;
  reset) cmd_reset ;;
  psql)  cmd_psql ;;
  url)   cmd_url ;;
  *)
    echo "usage: $0 {up|down|reset|psql|url}" >&2
    exit 2
    ;;
esac
