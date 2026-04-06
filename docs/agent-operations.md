# Agent Operations

This document is for agent-runtime and operator setup details that should stay out of the product-facing README.

## Configure `.env`

Create your local env file:

```bash
cp .env.example .env
```

Set your LLM key in `.env`:

```bash
LLM_API_KEY=sk-proj-...
```

Optional: if you use a non-default endpoint/model, also set:

```bash
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL_NAME=gpt-4o-mini
```

Never commit `.env`.

## Network Proxy For Agent Fetchers

If external feeds or LLM endpoints are blocked on your network, set proxy env vars before starting services:

```bash
HTTP_PROXY=http://127.0.0.1:7890
HTTPS_PROXY=http://127.0.0.1:7890
ALL_PROXY=http://127.0.0.1:7890
NODE_USE_ENV_PROXY=1
```

`NODE_USE_ENV_PROXY=1` is important for Node.js `fetch` clients so services like `world-input`, `world-model`, `scenario-agent`, and `synthesis-agent` route outbound requests through the proxy.

You can place these in `.env` (recommended for this repo), or export them in your shell.

## Quick Validation

Validate key + network from your shell before launching:

```bash
set -a; source .env; set +a
curl -sS -o /tmp/models.json -w "%{http_code}\n" \
  https://api.openai.com/v1/models/gpt-4o-mini \
  -H "Authorization: Bearer $LLM_API_KEY"
```

Expected status code: `200`.

## Autonomous Runtime Start

Use the native autonomous runtime entrypoint for fully automatic loops:

```bash
pnpm dev:autonomous:native
```

This starts the Python simulation runtime and the TypeScript service mesh with polling/tick loops enabled.

Facts-layer components now run continuously as part of that mesh:

- `world-input`: real-source ingest + normalization into `world_signals`
- `event-builder`: deterministic clustering into `event_cases`

## Source Injection Behavior

`world-input` reconciles `WORLD_INPUT_BOOTSTRAP_SOURCES_JSON` at startup and upserts rows in `world_input_sources` by `key`.

- You do not need to create sources manually when using bootstrap config.
- If you add or change bootstrap sources in `.env`, restart `world-input` (or restart the stack) and rows are reconciled automatically.
- Existing rows with the same `key` are refreshed from bootstrap config and scheduled for immediate repoll.
