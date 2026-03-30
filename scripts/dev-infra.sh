#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="infra/docker/docker-compose.yml"

if docker compose version >/dev/null 2>&1; then
  exec docker compose -f "$COMPOSE_FILE" up
fi

if command -v docker-compose >/dev/null 2>&1; then
  exec docker-compose -f "$COMPOSE_FILE" up
fi

echo "Neither 'docker compose' nor 'docker-compose' is available." >&2
echo "Install Docker Compose and retry." >&2
exit 1
