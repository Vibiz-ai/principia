# Principia cloud runner

Run Principia on an always-on Linux VM or container and send it tasks from your phone through Telegram. The runner executes installed Claude and Codex CLIs, and reuses Principia's actual workflow engine for exported `.hive.json` workflows. Your laptop can be off. This is a self-hosted v1, not a managed hosting service or a browser version of the desktop UI.

Use a persistent machine/container rather than request-based serverless functions: CLI authentication, repositories, child processes and jobs need a durable filesystem and long lifetimes. No hosting account is provisioned by this repository.

## Docker setup

Requires Docker Compose on your own machine or VM.

```sh
cp cloud/.env.example cloud/.env
# Put output of openssl rand -hex 32 into PRINCIPIA_API_TOKEN in cloud/.env.
mkdir -p cloud/workspace
# On Linux give container UID 1000 write access to cloud/workspace.
docker compose -f cloud/compose.yml up --build -d
```

Clone repositories into `cloud/workspace` (or mount an existing dedicated workspace). The container runs as UID 1000. `/data` is a named volume containing CLI home/authentication, jobs, workflow SQLite database, artifacts and logs. Do not delete this volume unless you intend to remove that data. Container restarts mark interrupted jobs instead of silently replaying commands that may have side effects.

The image installs the official Claude/Codex npm CLIs. Authenticate inside the container once:

```sh
docker compose -f cloud/compose.yml exec principia codex login --device-auth
docker compose -f cloud/compose.yml exec principia claude auth login
```

Follow the CLI instructions; if a browser callback cannot reach a remote VM, use the provider's supported remote login or API-key method. Subscription access and cloud/headless support depend on your provider account. Optional `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` in `.env` use API billing; these are distinct from subscription logins. Never publish your CLI auth files or `.env`.

The API binds to localhost on the host. For remote access use a VPN or SSH tunnel:

```sh
ssh -L 8787:127.0.0.1:8787 your-vm
```

Keep it behind that tunnel/VPN or an authenticated HTTPS reverse proxy. API tokens authorize code execution as the container user. Workspace path confinement prevents accidental cwd traversal; it is not a sandbox against authorized tasks that execute code. Use a dedicated machine without unrelated credentials.

## API

All routes, including health, require `Authorization: Bearer <PRINCIPIA_API_TOKEN>`.

- `GET /health`
- `POST /jobs` with `{"harness":"codex","prompt":"Run the tests","cwd":"my-repo"}`; returns a queued/running job immediately.
- `GET /jobs`, `GET /jobs/:id`, `POST /jobs/:id/cancel`.
- `POST /workflows` with the full exported `.hive.json` object; imports and validates it with the desktop engine.
- `GET /workflows` to get IDs; `POST /workflows/:id/run` with `{"inputs":{}}`.
- `GET /runs`, `GET /runs/:id`, `POST /runs/:id/cancel`.

Example using a shell environment variable you set locally (avoid putting the token in shell history):

```sh
curl -H "Authorization: Bearer $PRINCIPIA_API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"harness":"codex","prompt":"Inspect the repository and report failing tests","cwd":"my-repo"}' \
  http://127.0.0.1:8787/jobs
```

Cloud workflow imports require literal node cwd paths within `/workspace`; null uses the workspace. Replace machine-specific exported profile IDs with `prof_claude` or `prof_codex` before import. Mac-only shell commands still need Linux equivalents. Worktree isolation, desktop memory, live approval UI, Slack and desktop schedules are not yet migrated to cloud. Claude runs with `dontAsk` so unapproved actions are denied promptly instead of waiting for an absent desktop approval UI. Gateway tools are explicitly allowed. Codex uses its workspace-write sandbox. Jobs needing broader permissions may fail; this v1 never silently bypasses permissions. Shared company MCP connections are supported by the cloud gateway described below. Desktop credentials are not copied to cloud; configure cloud connections once for both harnesses.

Prompt jobs have bounded concurrency (`PRINCIPIA_CONCURRENCY`, default 1), timeout (`PRINCIPIA_TIMEOUT_MS`, default 30 minutes), and process-group cancellation with escalation to SIGKILL. Workflow jobs use the existing engine's concurrency and per-node timeout controls; they currently have a separate capacity pool. Logs are capped and known environment secrets are redacted, but do not put secrets into prompts or workflow source. Persisted workflow definitions must be treated as sensitive source code.

## Shared MCP gateway

Both prompt and workflow jobs attach the same Principia gateway; upstream credentials stay in the runner and are never injected into Claude/Codex. Set `PRINCIPIA_MCP_MASTER_KEY` to an independent 64-character hex key and `PRINCIPIA_MCP_CONFIG` to a private JSON file path inside the container. Mount that file read-only through a Compose override, for example `/path/to/private-mcp.json:/run/secrets/principia-mcp.json:ro`. Set the config path to `/run/secrets/principia-mcp.json`.

```json
[
  {
    "id": "company",
    "name": "Company tools",
    "transport": "stdio",
    "command": "node",
    "args": ["/workspace/tools/company-mcp.mjs"],
    "enabled": true,
    "roots": ["/workspace"],
    "credentials": { "COMPANY_API_KEY": "replace-with-your-secret" }
  }
]
```

HTTP transport uses `"transport":"http"`, `"url":"https://your-server/mcp"`, and credentials as HTTP headers (for example `Authorization`). Remote URLs require HTTPS. Local stdio commands must be installed in your container. Roots grant access to the listed project directories and descendants and must stay inside the cloud workspace.

Configuration is authoritative at startup: omitted saved connections are removed. Credentials are encrypted at rest in `/data/mcp-connections.json` using AES-256-GCM; the source config file itself is sensitive and must not be committed. Keep both the key and persistent volume to retain access. After initial import you may unset the config path and retain the key to use encrypted saved connections. Set an empty config array to revoke all connections. Changing the key requires reimporting credentials. Cloud does not yet offer the desktop OAuth browser connection flow; use the upstream's supported API credentials or remotely authenticated MCP endpoint.

## Phone control

Create a bot through Telegram BotFather. Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, and `TELEGRAM_ALLOWED_CHAT_IDS` in `cloud/.env`, then restart Compose. Both allowlists are mandatory, contain numeric IDs, and both must match; usernames are not accepted. Obtain IDs through Telegram's official Bot API `getUpdates` after messaging your bot; avoid giving your token to third-party ID sites.

The bot uses outbound long polling, so no public webhook/domain is needed. Only enable a bot you control. Unauthorized messages are ignored without a reply. Update offsets persist before execution to prevent replay after restart. Task replies/output are sent through Telegram: use it only for data suitable for that service.

Commands:

```text
/run codex Inspect the project and run tests
/run claude Review the latest changes
/jobs
/job <job-id>
/cancel <job-id>
/workflows
/workflow <workflow-id> {"repo":"demo"}
/runs
/runstatus <run-id>
/stopworkflow <run-id>
```

No live bot credentials are configured or messages sent by tests.

## Local development and verification

```sh
npm run cloud:build
npm run cloud:start
node --test cloud/runner.test.mjs
```

Local standalone Node needs `better-sqlite3` built for your Node ABI. The desktop dependency is built for Electron; use the Docker image for a clean independent runtime, or `ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron cloud/server.mjs` against the existing desktop dependency. Do not rebuild the desktop module for Node unless you will rebuild it for Electron afterward.

`cloud/workflows.smoke.mjs` tests actual engine import, workspace validation, shell execution, output redaction and persistent run details. Run after the cloud build with the matching runtime:

```sh
ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron cloud/workflows.smoke.mjs
```
