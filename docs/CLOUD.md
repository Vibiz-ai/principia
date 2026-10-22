# Principia Cloud

Status: build spec, 21 October 2026. Branch `feat/company-portfolio`. Founder mockup: [cloud.html](cloud.html).
Contracts (frozen for the v1 build): `src/shared/cloud.ts` (HTTP API types and routes) and `src/cloud/contract.ts` (the
in-process seam between the control plane and the agent runtime).
Related: [STRATEGY.md](STRATEGY.md) §4.5, [FORUM.md](FORUM.md) §7, [PASSPORT.md](PASSPORT.md), [MCP-GATEWAY.md](MCP-GATEWAY.md),
[KEYS.md](KEYS.md), [VOICE.md](VOICE.md), `cloud/README.md` (the v1 self-hosted runner this replaces), and Open Passport
`SPEC.md` §11 (the hosted profile).

Principia Cloud is the **always-on body** of a Principia workspace. The desktop stays the cockpit. The cloud keeps your
agents working when the laptop is closed: schedules fire, webhooks land, connectors answer, the Forum stays open and
every company's Passport is served from one URL. You bring the Claude, Codex and Gemini accounts you already pay for.
We never resell tokens.

---

## 0. Decisions in one screen

| Topic | Decision |
|---|---|
| What goes online | **Agents, triggers, connectors, Forum and the Passport.** Not the UI. The desktop attaches to a cloud workspace the way Git attaches to a remote (§2). |
| Web surface | A **two-tab console** at `/console`, mobile first: **Needs you** and **Runs**, plus the Pause switch. No editors, no canvas, no terminals, no account linking, no Forum client (§13.2). |
| First five minutes | A founder outside the team does one of two things. **One button:** Deploy on Render (`render.yaml`): an always-on cloud with its own https address, nothing to type, and the connect link in its log. **One file:** `curl` the published `cloud/compose.yml` onto any always-on machine and `docker compose up -d`; no clone, no `.env`, images pulled from `ghcr.io`. Either way: paste the connect link into Principia → Cloud, click **Connect Claude** and **Sign in with ChatGPT** (each opens the browser once, nothing to copy), **Run in the cloud…** on a company, and watch **Run once now** finish right in the readiness sheet (§3, §12.1). |
| Process shape (v1) | One container `principia` (control plane plus agent runtime in one Node 24 process, separated by `src/cloud/contract.ts`) and one container `passport` (the unchanged Open Passport reference host), both published images. On one-container hosts (Render, Fly) the passport host runs inside `principia` on the cloud's own origin (`PRINCIPIA_PASSPORT=embedded`) (§4, §12.1). |
| Open Passport | **Connected by default, for real.** Moving a company creates its passport on the workspace's host, gives the desktop a `write:all` key for PassportSync, and attaches the passport to every cloud run. ChatGPT and Claude.ai reach it when the host is public https: automatic on Render, one flag (`--profile caddy`) on compose. The pane never copies a local Passport URL (§7.1). |
| Identity | Self-host v1: one owner per workspace. Desktop pairs with a **connect link** (`<url>/pair#K7QM-4XWD`: URL and 8-character code in one string) and gets a device token. The console signs in with a one-time link minted from the desktop. No passwords. OIDC and teams come later (§5). |
| Claude | **Connect Claude**: the desktop runs `claude setup-token` in a hidden pty, your browser opens once, and the desktop captures the printed token and sends it straight to the cloud. You never see or paste it. Fallbacks: paste a token, or a Console API key (§7.2). |
| Codex | **Sign in with ChatGPT**: the desktop runs `codex login` in a throwaway `CODEX_HOME`, your browser opens once, and the resulting `auth.json` (a sign-in separate from your Mac's own Codex) is uploaded and the temp folder deleted. Fallback: an OpenAI API key. The refreshed `auth.json` is written back after every run, and runs that share one sign-in are serialized. Server-side device login and Enterprise access tokens come later (§7.2). |
| Gemini | Gemini API key or a Vertex service account. Google sign-in cache: later. |
| Secrets | Envelope encryption: a master key (`PRINCIPIA_MASTER_KEY`, KMS on managed) wraps one data key per workspace, AES-256-GCM per secret with AAD. Write-only API. Redacted everywhere (§7.3). |
| Repos | GitHub over HTTPS with a fine-grained PAT, given to git through `GIT_ASKPASS`, never in argv or env. The checklist links straight to GitHub's token page for that repo. The GitHub App path comes later, through the one-click Manifest flow (§7.4). |
| Connectors | The existing MCP gateway, per company. The checklist lists the connections the company uses: header and API-key ones are ticked, named, and copied encrypted. OAuth ones show **Authorize** inline, which opens the browser right there through `/oauth/connectors/callback` (§7.5). |
| Ready check | After **Run in the cloud**, each company shows **Ready** or a short list of one-click fixes ("Morning brief uses Codex: Sign in with ChatGPT"). The control plane computes it (`CloudCompany.readiness`), so nothing fails silently at 09:00 (§7.9). |
| Not in v1 | Webhooks, GitHub App, server-side device login, Forum routes and console Forum/Accounts tabs, `codex_access_token`. They ship when they have a UI (§14). |
| Sandbox (v1) | `process` driver: every agent process runs as its own user (`agent`, uid 1001, no capabilities) and cannot read `/secrets`, `control.db` or the runtime's databases; a throwaway HOME per run, a scrubbed environment, cwd confined to the company folder, process-group kill, timeouts. Honest isolation between your own companies and from the control plane's secrets, **not** a multi-tenant boundary. Managed cloud adds a microVM per workspace (§7.8, §12.3). |
| Sync | Passport through Open Passport revisions (existing `PassportSync`). Workflows and schedules are pushed from the desktop with `baseRev` (409 on stale). Each schedule has a **placement**, `local` or `cloud`, and fires in exactly one place (§8). Cloud asks also appear in the app's own **Needs you** on Home: one inbox, not two. |
| Cost | Quotas per workspace and company (concurrency, runs/day, minutes/day, timeouts, webhook rate), a kill switch, and an optional USD cap for API-key providers (§10). |
| Self-host vs managed | Self-host is complete and free forever (MIT): one Render button, or one compose file. Managed Principia Cloud (its own GCP project) runs the same images and charges for uptime and compute, never tokens (§12, §16). |
| Billing | Usage ledger plus a no-op `BillingSink`. Not implemented (§10.3). |

### 0.1 Product review, 21 October 2026 (what changed from the first draft, and why)

The architecture was right and the product was engineer-shaped. A founder's first five minutes asked for three
`openssl` secrets, a `.env`, two pasted fields, a token copied out of a terminal, a ChatGPT security setting, a GitHub
App registration and a private key. Then the first scheduled run could fail at 09:00 because a key was never ticked.
The changes:

1. **Zero-config boot.** A one-shot `init` service generates the master key and the passport admin token into a
   volume. The server prints a **connect link** on first boot. Env vars still override everything (§12.1).
2. **One string to connect.** The connect link replaces "URL plus code" (§5).
3. **Accounts are linked from the Mac, in the browser, with one click.** No token is ever copied by hand. Pasting is a
   fallback, not the path (§7.2).
4. **The checklist is dependency-aware.** It shows only the keys and connections the chosen workflows use, ticked and
   named in plain words. Unused secrets are never offered (§3, §7.5).
5. **Ready check plus Run once now.** Moving a company ends with proof that it works, not with hope (§7.9).
6. **One inbox.** Cloud asks show in Home's Needs you. The Cloud pane is for the cloud's status and setup, not a second app (§13.1).
7. **Cut until it has a reason to exist:** webhooks (no UI to create one), GitHub App (needs the Manifest flow to be
   one click), server-side device login, Forum routes, the console's Forum and Accounts tabs, "Run a workflow" forms on
   the phone, and the pane's Devices card and runtime version text (moved to a Workspace menu) (§14).
8. **Launch blocker:** compose builds the passport host from the Open Passport repo. That repo must be public, and
   compose must default to its git URL, before anyone outside the team can run Principia Cloud (§12.1).
   *Round 2:* compose now pulls published images and builds nothing; what remains is publishing them (§16).
9. **Visual:** amber is a status tile only. The amber edge on the Needs-you card and on warnings is removed (VOICE.md §5.2).

### 0.2 Product review, round 2 (21 October 2026): the first five minutes, for real

The build was right; the first five minutes were broken for anyone outside the team, and two promises were half true.
What changed:

1. **Pulled, not built.** `cloud/compose.yml` pulls `ghcr.io/vibiz-ai/principia-cloud` and
   `ghcr.io/vibiz-ai/open-passport-host` (published by `.github/workflows/cloud-images.yml` here and `host-image.yml`
   in Open Passport) and needs no sibling checkout, no GitHub credentials and no clone: `curl` one file, `up -d`.
   Building is an override (`compose.build.yml`).
2. **One button.** `render.yaml` (Deploy to Render): one service, a disk, the passport embedded on the same https
   origin. `RENDER_EXTERNAL_URL`, `FLY_APP_NAME` and `RAILWAY_PUBLIC_DOMAIN` set the public URL with no setting.
3. **No useless links.** A `127.0.0.1` connect link printed on a server comes with one line: the tunnel command or
   the setting. Pasting one on another Mac says "This link only works on the machine running your cloud".
4. **Passport connected by default, for real.** `--profile caddy` makes both origins public https from two domains.
   "Copy Passport URL for ChatGPT and Claude" never copies a local URL; it says what is missing and the fix.
5. **Agents cannot read the keys.** Agents run as uid 1001 with no capabilities; `/secrets`, `control.db` and the
   runtime's databases are root-only. A Docker smoke runs `cat /secrets/master.key /data/control.db` as a real shell
   step and asserts permission denied (§7.8).
6. **Readiness tells the truth.** Keys named in prose (`Use FAL_KEY for images`) are detected, and the desktop
   declares every key a workflow uses, ticked or not. Real runs report account health (`ports.providerStatus`): an
   expired token turns the Accounts row Expired and the company not Ready; a usage limit shows its reset time (§7.9).
7. **No experimental wall at the last click.** The checklist shows "Turn on Passport" before Run in the cloud when the
   vault is off.
8. **Run now on a cloud schedule runs in the cloud.** Never locally.
9. **One inbox in portfolio mode too** (Home in All mode shows cloud asks).
10. **Taste:** Passport is a plain line, keys have human names and say who uses them; the readiness sheet has one title
    and Run once now in its footer with the result inline; "Passport r48" became "Passport · 3 new facts"; no raw URL
    in the header; no setup strip; no lecturing subtitles; run details show their log and the agent that ran; the
    phone shows the same busts as the desktop.

---

## 1. What we learned (research, October 2026)

**Mastra Cloud and Mastra Platform.** Mastra is an open-source TypeScript agent framework. *Studio* runs locally
(`mastra studio`). The Platform (announced 9 April 2026) adds three things. *Server* deploys agents and workflows as REST
endpoints from the CLI (`mastra server deploy`) or CI and returns a URL, with environment variable management and API keys
redacted from streaming responses. *Studio* can be hosted with auth and RBAC. *Observability* gives logs, traces and metrics
with cost and latency per run, stored in ClickHouse. Pricing has a free pay-as-you-go Starter tier (100K observability events,
24 CPU hours, 15-day retention) and Teams at $250 per month (1M events, 250 CPU hours, SSO). An "Always-On" add-on costs
$100 per project. Memory Gateway is billed separately. Commentary notes a gap between free and $250.
[1][2][3][4]
*Lessons:* the same artifact runs locally and hosted; the local studio is the main tool and the cloud mostly adds a URL,
always-on and shared observability; metering is on compute and events, not model tokens; secrets are managed and redacted
by default.

**Ratel and Ratel Cloud.** Ratel is an open-source *context gateway* for agents (Apache-2.0 engine, MIT elsewhere). It keeps
the tool and skill catalogue out of the prompt and retrieves what each turn needs. It runs in-process with BM25 and needs
no external service. It ships TypeScript and Python SDKs over a Rust core, plus a *Ratel Local* mode in front of existing MCP
servers for Claude Code and Codex. Ratel Cloud (cloud.ratel.sh) is not a runtime host. It is an OTLP-native analytics
product that shows what fills an agent's context window (skills, tools, history, memory) and what can be reclaimed. It is a
drop-in for Anthropic, OpenAI, OpenTelemetry and `@ratel-ai/sdk`. Public pricing and hosting details were not published
when we checked. [5][6][7]
*Lessons:* keep the open-source core fully useful offline; make the cloud an *optional attachment* fed by open standards
(OTLP there; Open Passport and MCP for us); a hosted product can be narrow and still valuable.

**Running Claude Code headless in the cloud.** Anthropic documents `claude setup-token` for CI and scripts. It runs the
browser authorization once and prints a one-year OAuth token for `CLAUDE_CODE_OAUTH_TOKEN`. It requires a Pro, Max,
Team or Enterprise plan. It can only make model requests: no Remote Control and no claude.ai connectors (locally configured
MCP servers still work). Bare mode does not read it. Precedence is: cloud provider vars, `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_API_KEY`, `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`, profiles, `/login`. `CLAUDE_CONFIG_DIR` separates accounts.
Credentials live in `~/.claude/.credentials.json` (0600) on Linux. [8] Community reports describe setup-token 401s in some
versions, so the runtime must test a credential and surface failures. [9]

**Running Codex headless.** OpenAI's Codex auth docs list device code login (`codex login --device-auth`, beta, must be
enabled in ChatGPT security settings or by a workspace admin), copying `~/.codex/auth.json` ("treat it like a password"),
and API keys (`printenv OPENAI_API_KEY | codex login --with-api-key`), which are "the recommended default for automation"
and bill at API rates. Enterprise has access tokens (`codex login --with-access-token`) for "trusted scripts, schedulers, and
private CI runners". ChatGPT sessions refresh automatically, and an advanced guide covers trusted runners that keep the
refreshed `auth.json` for the next job. `cli_auth_credentials_store` selects file, keyring or ephemeral storage under
`CODEX_HOME`. OpenAI warns: do not expose Codex execution in untrusted or public environments. [10][11]

**Gemini CLI headless.** Uses cached credentials when present. Otherwise it needs an auth variable (`GEMINI_API_KEY`) or a
Vertex service account, and exits with code 41 when none is set. [12]

**Sandboxes.** E2B (Firecracker microVMs, pause/resume, 1-hour cap on Hobby), Modal (gVisor, 24 h cap, large concurrency),
Daytona (fast starts, no default cap; reported to have moved its core to a closed codebase in June 2026) and Fly Machines
(stop on exit, start in milliseconds, one VM per concurrent task) are the common substrates for running coding agents
unattended. Most comparisons come from vendors. [13][14][15][16]
*Lesson:* make the sandbox a driver behind one interface. Ship `process` now, and add a microVM driver for managed
multi-tenancy.

**GitHub access.** A GitHub App installation token is minted with a JWT signed by the app's private key, expires after one
hour, can be narrowed to specific repositories and permissions, and works as the HTTPS git password with user
`x-access-token`. [17]

---

## 2. The shape: a remote, not a web app

```
   your Mac (cockpit)                                   Principia Cloud workspace (always on)
 ┌──────────────────────────┐   device token (pdt_)  ┌────────────────────────────────────────────────┐
 │ Principia desktop         │ ─────────────────────▶ │ control plane  /v1  /hooks  /oauth  /console    │
 │  • companies, editor,     │   push workflows,      │  identity · vault · queue · quotas · sync · audit│
 │    canvas, terminals      │   schedules (baseRev)  │                  │ contract.ts                   │
 │  • Cloud pane             │ ◀───────────────────── │ agent runtime    ▼                               │
 │  • local runs keep working│   runs, asks, events   │  headless engine · claude/codex/gemini CLIs     │
 │  • PassportSync ──────────┼──────────┐  (SSE)      │  MCP gateway · Forum · triggers · repos          │
 └──────────────────────────┘          │             └───────────────┬────────────────────────────────┘
                                        │ Open Passport              │ passport grant per company
                                        ▼ revisions (§11.4)          ▼
                              ┌───────────────────────────────────────────────┐
   ChatGPT, Claude.ai, ──────▶│ Open Passport host (reference server)          │
   Cursor (OAuth 2.1, MCP)    │ /v1/passports/{id}  ·  /mcp  ·  /oauth          │
                              └───────────────────────────────────────────────┘
   phone ──▶ /console (Needs you · Runs · Pause), signed in with a QR login link from the desktop
```

**Why the UI stays local.** For an open-source project with a small team, this is the right call:

1. **The desktop is the product.** Interactive terminals, the canvas, the editor and local repos are what people install
   Principia for. A web clone doubles the surface we maintain and would always lag.
2. **Phones need two things:** answer (asks and proposals) and glance (runs, plus the Pause switch). That is the console.
3. **Security.** A web UI that can edit workflows and run code is the riskiest thing we could expose. A small console with
   no editing is a small attack surface.
4. **Local-first stays true.** Nothing in the desktop needs the cloud. Unlinking leaves every company working as before.
5. **It matches the references.** Mastra keeps Studio local and hosts the runtime. Ratel keeps the engine local and hosts
   only analytics. GitHub hosts the remote, not your editor.

---

## 3. Journeys

The first five minutes, measured in clicks. Each step has one primary button.

1. **Start a cloud.** Either **Deploy on Render** (one button, https included) or, on any always-on machine,
   `curl -fsSL https://raw.githubusercontent.com/Vibiz-ai/principia/main/cloud/compose.yml -o compose.yml` then
   `docker compose up -d`. No clone, no `.env`. The log prints `Connect link: https://cloud.example.com/pair#K7QM-4XWD
   (10 min)`, plus one line with the tunnel command when only that machine can open it. `principia-cloud pair` prints a
   fresh one later.
2. **Connect.** Cloud pane → paste the link → **Connect**. The device token is stored encrypted (safeStorage). The
   Accounts card and the Companies card hold the next buttons; there is no separate setup strip.
3. **Connect Claude.** One button and one confirm (the only place that says "use your own account: never share a
   subscription"). The desktop runs `claude setup-token` in a hidden pty and the browser opens on
   claude.ai. You approve. The desktop captures the token from the output, uploads it, runs **Test**, and the row turns
   *Connected · Subscription · expires Oct 2027*. If capture fails (an unknown CLI output, or no `claude` on this Mac), the
   row offers "Paste a token" with the one command to run. "Use an API key instead" is a quiet link.
4. **Sign in with ChatGPT.** One button. The desktop runs `codex login` with a throwaway `CODEX_HOME`, the browser opens
   on ChatGPT, and the new `auth.json` is uploaded and the folder deleted. This is a second sign-in, so your Mac's own
   Codex is untouched and the two never race on a refresh token. *Gemini* is under Accounts ⋯ → Add another provider (a key or a
   service account). Each account shows **Subscription** or **API billing**.
5. **Run a company in the cloud.** Companies → **Run in the cloud…** opens the checklist: a plain Passport line
   ("created on your cloud and kept in sync. Always on.", or "Turn on Passport" first when the vault is off), workflows (all ticked except refused ones, each refusal one plain sentence), schedules that
   fire in the cloud, the repo (detected from `origin`, with a field for a fine-grained token and a link to GitHub's
   token page), and **what these workflows need**: the keys and connections they actually use, ticked, named in words
   and with who uses them ("fal.ai key (FAL_KEY), used by Quest content"). Anything unticked shows as a fix later. OAuth connections have an inline
   **Authorize** button. Button: **Run in the cloud**. Schedules placed in the cloud show a cloud mark and stop firing
   locally.
6. **Ready.** The sheet (one title, no repeated heading) shows **Ready** with a pixel tile, or up to three one-click
   fixes. **Run once now** is its primary footer button, next to **Done**; the run's status, steps and first lines of
   output appear inline. That is the moment it feels real.
Then the payoff:

7. **Laptop closed.** At 09:00 the cloud fires "Morning brief" for Vibiz. Codex runs in the cloud with the Vibiz passport,
   the Vibiz connectors and the Vibiz repo. Marcus asks "Ship the launch post today or Thursday?".
8. **Answer from the phone.** On the Mac, **Open on your phone** shows a QR code (the one-time login link). The console's
   Needs you shows Marcus's question. Tap *Thursday*. The agent resumes.
9. **Open the laptop.** Home's Needs you and the Cloud pane show the night's runs, the answered ask and "Vibiz Passport:
   3 new facts from cloud agents", and PassportSync pulls them into the vault.

---

## 4. Architecture

### 4.1 Processes and files

| Unit | Code | Runs as |
|---|---|---|
| Control plane | `src/cloud/control/**` (BE). HTTP router, `node:sqlite` db, auth, vault, queue, sync, passport-host client, GitHub, connector OAuth, usage, audit, static console. | `out-cloud/control.mjs` in container `principia` |
| Agent runtime | `src/cloud/agent/**` (AI). Implements `CloudRuntime`: the existing engine headless (`createEngineWith`), per-run sandbox, provider logins, per-company gateway, Forum, Passport attachment, triggers, repos. | same process, created by the control plane's `main.ts` |
| Web console | `src/cloud/console/**` (FE). Static, built by `vite.console.config.ts` to `out-cloud/console/`. | served by the control plane at `/console` |
| Desktop link | `src/main/cloud/**` + `src/main/handlers/cloud.ts` + renderer Cloud pane (FE) | Electron main and renderer |
| Passport host | Open Passport `packages/server` (unchanged) | container `passport` |
| Legacy runner | `cloud/server.mjs`, `runner.mjs`, `telegram.mjs` | kept runnable (`npm run cloud:start`), marked legacy in `cloud/README.md` |

### 4.2 Why one process in v1

The runtime reuses the desktop engine, which uses `better-sqlite3`. The control plane uses `node:sqlite` (built into
Node 24, no native build, and testable under vitest, where the Electron-built `better-sqlite3` cannot load). The two never
share a database. They talk only through `CloudRuntime` and `ControlPorts` (`src/cloud/contract.ts`), so splitting the
runtime into its own worker per workspace (§12.3) is a transport change, not a redesign.

### 4.3 Data layout (`/data`, a volume)

```
/data/control.db               control plane (node:sqlite, WAL): workspace, devices, sessions, companies, credentials
                               (ciphertext), repos, connections, workflows, schedules, hooks, runs, asks, usage, audit
/data/runtime/engine.db        the engine's store (better-sqlite3): runs, steps
/data/runtime/forum.db         the cloud Forum (ForumStore)
/data/runtime/runs/<runId>/    home/ (0700, deleted at run end), logs/, artifacts/
/workspace/<companyId>/        company folder: repo clones, scratch
```

---

## 5. Identity, workspaces and tokens

- **Workspace.** v1 self-host: exactly one, created on first boot (`ws_…`, name from `PRINCIPIA_WORKSPACE_NAME`).
  Managed: one or more per account, later.
- **Owner bootstrap.** `principia-cloud pair` (a CLI in the image, `out-cloud/control.mjs pair`) or
  `POST /v1/pair/start` with `Authorization: Bearer $PRINCIPIA_ADMIN_TOKEN` prints a pairing code. Codes are 8 characters
  (`PAIRING_ALPHABET`), single use, valid for 10 minutes, stored hashed. 10 failed attempts per IP per 10 minutes return 429.
  On first boot, when no device is paired yet, the server mints a code itself and logs the **connect link**.
- **Connect link** (the only thing a person pastes): `<PRINCIPIA_PUBLIC_URL>/pair#<CODE>`, for example
  `https://cloud.example.com/pair#K7QM-4XWD`. The code is in the fragment, so it never reaches a proxy log. The desktop
  also accepts the URL and code separately (hidden under "Enter URL and code"). `GET /pair` serves a tiny static page that
  says "Open Principia on your Mac → Cloud and paste this link". The helpers `formatConnectLink(url, code)` and
  `parseConnectLink(text) → {url, code} | null` live in `src/shared/cloud.ts` (additive, BE). `parseConnectLink`
  tolerates whitespace, a missing `/pair`, a lowercase code and a missing dash.
- **Device token** (`pdt_`): returned once by `POST /v1/pair/complete`. Only its SHA-256 is stored. It can be revoked
  (`DELETE /v1/devices/:id`). Every request updates `lastSeenAt` (throttled to once a minute).
- **Console sign-in.** The desktop calls `POST /v1/login-links` and opens or copies `…/console/login?t=pll_…` (single use,
  10 minutes). That sets the `principia_session` cookie (`pss_`, HttpOnly, SameSite=Strict, Secure when the public URL is
  https, 12 hours). Writes need `x-principia-csrf` equal to `GET /v1/me`.csrf.
- **Run tokens** (`prt_`) are minted by the runtime for a step's local tools (Forum HTTP). They never leave the box.
- **Admin token** (`PRINCIPIA_ADMIN_TOKEN`, 32+ chars): pairing only. It never reads data.
- **Later:** OIDC sign-in (Google, GitHub), members and roles, Forum guests from other machines, passkeys.

---

## 6. API

The types and the full route table are in `src/shared/cloud.ts` (`CLOUD_ROUTES`, `routePath`). Rules every route follows:

- JSON in and out. Bodies are capped at 1 MB, except a company create with a passport bundle, which is capped at 20 MB.
  Errors use the `CloudError` shape.
- `Authorization: Bearer pdt_…` (desktop) or the session cookie plus CSRF (console). `/hooks/*` and
  `/oauth/connectors/callback` use their own checks. `GET /v1/health` is the only open route.
- **No route ever returns secret material.** Credentials, keys, PATs, private keys and connection credentials are
  write-only. Lists show names, kinds, dates and status. A test sets known secrets and greps every response, log line and
  db row for them.
- Every mutation writes an audit entry (`AuditEntry`).
- `GET /v1/events` is Server-Sent Events. A heartbeat comment is sent every 20 seconds. Pass `?runId=` to receive `log`
  events for one run.
- Company ids are the desktop's ids, so one id names the company everywhere: desktop, cloud, Forum and passport metadata.

---

## 7. Subsystems

### 7.1 Open Passport, connected by default

On `PUT /v1/companies/:cid` (first time), the control plane:

1. creates the passport on the workspace's host with `POST /v1/passports` (admin token, body = the desktop's bundle);
2. mints three grants with `POST /v1/passports/{id}/grants`:
   - `desktop`: `write:all`, returned once as `desktopPassportGrant`. The desktop writes it into its existing PassportSync
     config (`open-passport-sync.json`) and runs a sync.
   - `cloud-runtime`: `read:all write:proposals write:taste`. Its `trusted` flag follows the company setting
     `cloudAgentWrites: 'propose' | 'trusted'` (default `propose`).
   - `owner`: kept by the control plane to list and decide proposals.
3. stores the passport id and the encrypted grant tokens.

Every cloud run of the company gets:

- the **L0 card** (plus the department L1 when the step has one) as `passportContext`, fetched from
  `GET /v1/passports/{id}` and cached by revision;
- a built-in gateway connection **`passport`** (HTTP, the host's remote MCP endpoint, with the runtime grant as a
  header). The gateway holds the header and the agent never sees it, as with every other connection;
- harvested `<passport-notes>` posted as deltas (`POST /deltas`). With the default `propose`, they land as host proposals.
  The Cloud pane and console show "N new facts from cloud agents" with Accept and Reject (proxied with the owner grant).
  Accepted facts reach the desktop on its next PassportSync pull.

The passport's public MCP URL (`CloudPassportLink.mcpUrl`) is copied from the company's ⋯ menu for ChatGPT, Claude.ai
and Cursor, which connect through the host's own OAuth 2.1 consent (SPEC §11.3.1). Those apps need a public https origin,
so the pane copies the URL only when it is one (`isPublicHttpsUrl`). Otherwise it says "ChatGPT and Claude.ai need a public
HTTPS address" and the fix: Render (the passport is embedded on the cloud's https origin) or `--profile caddy` with
`PASSPORT_DOMAIN` (§12.1). Cloud runs use the passport either way.

### 7.2 Model accounts: Claude, Codex, Gemini

One credential per adapter per workspace in v1. Per company overrides come later. A credential is one human's account:
the managed cloud never pools or shares subscriptions. The pane says so next to every Subscription badge.

**Linking happens on the Mac, in the browser, with one click** (desktop: `src/main/cloud/logins.ts`, FE):

- **Connect Claude:** spawn `claude setup-token` in a `node-pty` with `HOME` and `CLAUDE_CONFIG_DIR` pointed at a fresh
  temp dir, so the Mac's own Claude login is untouched. The CLI opens the browser. Scan the output (ANSI stripped) for
  `sk-ant-oat01-[A-Za-z0-9_-]+`, then send it straight to `PUT /v1/providers/claude/credential` and run Test. The temp
  dir is deleted. The token never reaches the renderer, the logs or the clipboard. Timeout 10 minutes, with Cancel. If
  `claude` is missing, the row says "Install Claude Code on this Mac, or paste a token" and shows the install command.
- **Sign in with ChatGPT:** spawn `codex login` with `CODEX_HOME` set to a temp dir (0700) and
  `cli_auth_credentials_store="file"`. The browser opens and the CLI's localhost callback completes. On exit 0, read
  `auth.json` and upload it as `codex_auth_json`, then delete the dir. If port 1455 is busy, the row says "Close other
  Codex sign-ins and try again". This makes a separate ChatGPT session from the Mac's own `~/.codex`, so their refresh
  tokens never race.
- **Gemini:** paste an API key or a service-account JSON.
- Both CLI flows are pure functions plus a spawn seam, and are tested with fake `claude` and `codex` scripts.
- Server-side device login (`deviceLogin*` routes) and `codex_access_token` are **not in v1** (the routes return 501
  `not_in_v1`). They come back for the managed cloud's web onboarding.

| Kind | How it gets in | How a run uses it | Notes |
|---|---|---|---|
| `claude_oauth_token` | **Connect Claude** (captured on the Mac), or paste the `claude setup-token` output | env `CLAUDE_CODE_OAUTH_TOKEN`; HOME and `CLAUDE_CONFIG_DIR` are the run's own; never `--bare` | 1 year; `expiring` 30 days before; inference only (the gateway supplies connectors) |
| `anthropic_api_key` | paste | env `ANTHROPIC_API_KEY` | API billing; `usd` from stream-json `result` |
| `openai_api_key` | paste | `codex login --with-api-key` (stdin) into the run's `CODEX_HOME` before the step | OpenAI's recommended automation path |
| `codex_auth_json` | **Sign in with ChatGPT** on the Mac (a throwaway `CODEX_HOME`, then upload). Server-side device login comes later | written to `<runHome>/.codex/auth.json` (0600), `cli_auth_credentials_store="file"`; after the run, if the file changed, `ports.saveProviderCredential` re-encrypts it | runs sharing it are **serialized** (a refresh-token race would sign the user out); device auth must be enabled in ChatGPT settings, and the pane says where |
| `codex_access_token` | later (Enterprise) | `codex login --with-access-token` (stdin) | not in v1: `PUT` returns 501 `not_in_v1` |
| `gemini_api_key` | paste | env `GEMINI_API_KEY` | |
| `google_service_account` | paste JSON | file in run home, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_GENAI_USE_VERTEXAI=true` | |

**Test** (`POST /v1/providers/:adapter/test`) checks that the CLI runs (`--version`) and that the credential is
well-formed. With `live`, the user explicitly agrees to spend one tiny request on their plan. Failures map to
`failing`/`expired` with a redacted detail. **Real runs report too** (`ControlPorts.providerStatus`, additive): when a
run ends, the runtime classifies each attempt with the CLI's own words (`accountOutcome`: `classifyLimitText` and
`isHarnessAuthFailure`) and reports `expired` (a rejected sign-in or key: the row turns Expired with its Connect
button), `limited` (the usage limit and its reset time) or `ok` (a passed step, which clears a limit). A report about a
credential the user has replaced since is dropped.

Images pin CLI versions (`@anthropic-ai/claude-code`, `@openai/codex`, `@google/gemini-cli`). `cliVersion` is shown in the
pane. Cursor (`CURSOR_API_KEY`) comes later.

### 7.3 Secrets vault

- **KEK:** `PRINCIPIA_MASTER_KEY` (32-byte hex) on self-host. On managed, a Cloud KMS key wraps per-workspace DEKs.
- **DEK:** random per workspace, stored wrapped (AES-256-GCM). A secret row is `iv | tag | ciphertext`, with AAD
  `workspaceId:kind:id`, so a row moved to another workspace or kind fails to decrypt.
- **Kinds:** provider credential, company key, repo PAT, GitHub App private key, connection credentials, OAuth tokens
  and client registrations, passport grants, webhook secrets (hashed where only comparison is needed).
- **Use:** decrypted only when a run is dispatched (into `RunMaterials`, in memory), or for an outbound call the control
  plane makes itself (passport host, GitHub token minting, OAuth refresh).
- **Redaction:** `ports.knownSecrets()` feeds the runtime's redactor (the engine's `secrets.redact`), and the control
  plane's logger redacts the same set plus token patterns (`pdt_`, `pll_`, `pss_`, `whk_`, `opk_`, `sk-…`, `gh[pousr]_…`,
  `sk-ant-…`). Request bodies of credential routes are never logged.
- **Rotation:** `principia-cloud rotate-master-key` re-wraps DEKs (v1.1).

### 7.4 GitHub repos

- v1 accepts `https://github.com/<owner>/<repo>` only. Clones go to `/workspace/<companyId>/<repo-name>`.
- **PAT** (fine-grained, contents read/write, pull requests read/write) per repo. The checklist's repo row has one
  password field and a link, "Create a token for <owner>/<repo>", that opens
  `https://github.com/settings/personal-access-tokens/new`. After saving, `repoSync` clones once and the row shows
  *Cloned · main* or the plain error ("GitHub said the token cannot read vibiz-ai/quest").
- **Not in v1: the GitHub App.** Registering your own App and pasting a private key is not a founder task. It returns
  through the App Manifest flow (one click) and Principia's own App on managed. The `githubApp*` routes return 501
  `not_in_v1`.
- The runtime gives git the token through a per-run `GIT_ASKPASS` script that reads a 0600 file in the run home. The
  token is never in argv, env or the remote URL. The existing push guard (`installPushGuard`) applies: agents push
  branches, never the default branch.
- **Later:** the App Manifest flow for one-click App creation, GitLab, and per-repo deploy keys.

### 7.5 Connectors and OAuth in the cloud

- The runtime builds one `GatewayService` per company from `RunMaterials.connections`, with roots set to the company
  folder. Credentials stay in the gateway bridge process, never in the agent (unchanged design, MCP-GATEWAY.md).
- **Header and API-key connections:** copied from the desktop by the checklist, which lists only the connections the
  company uses. Each is ticked by default and named, with the plain line "Copied encrypted. Never shown again." Unticking
  one leaves the readiness check flagging what needs it. Credentials come from the gateway's encrypted store through an
  additive read accessor in the desktop main process. They never pass through the renderer.
- **OAuth connections:** `POST …/connections/:id/authorize` runs MCP SDK `auth()` with an `OAuthClientProvider` whose
  redirect URL is `<publicUrl>/oauth/connectors/callback`. `state` is bound to workspace, connection and the initiating
  device or session, is single use, and expires in 10 minutes. The callback stores tokens in the vault. Before dispatch,
  the control plane refreshes access tokens that are close to expiry and hands the runtime an `Authorization` header.
  Desktop OAuth tokens are never copied, because refresh tokens are bound to the desktop's client registration and
  loopback redirect.
- **SSRF guard:** connection URLs must be https and must not resolve to private, loopback or link-local addresses
  (an allowlist env exists for self-hosters with internal tools).
- **Slack in the cloud** (Socket Mode works from a container) comes later, v1.1. Desktop Slack keeps working meanwhile.

### 7.6 The Forum in the cloud

- The runtime hosts a `ForumService` over `/data/runtime/forum.db` (the same code as the desktop, which has no Electron
  imports). Each cloud company gets `#general`, its department channels and `#proposals` (FORUM.md §0).
- Cloud runs get the Forum exactly like desktop runs: the MCP server (`attachForum`), the HTTP transport on 127.0.0.1
  with a run token, the `forum` CLI, and fenced blocks.
- `forum_ask` on a cloud run opens a **CloudAsk** (`ports.openAsk`). It appears in Needs you in the console and the
  desktop pane. Answering it posts the answer in the thread and resumes the agent (`runtime.answerAsk`).
- **v1 has no Forum client in the cloud.** What an agent posts is never a black hole: the run's Forum posts are part of
  its run detail (`CloudRunDetail.forumPosts`, additive), shown in the desktop run sheet and the console. The
  `forumChannels`, `forumMessages` and `forumPost` routes return 501 `not_in_v1`.
- **Next (v1.1):** a one-way mirror of cloud Forum messages into the desktop Forum, then bidirectional sync following
  FORUM.md §7: global ids, an append-only outbox, and a watermark per side.

### 7.7 Schedules and webhooks

- **Schedules** placed in the cloud are evaluated by the runtime's trigger loop (every 15 s), reusing `nextFire` from
  `src/main/engine/scheduler.ts`: the same cron grammar, timezones and 5-minute floor. The runtime calls
  `ports.requestRun({ trigger: 'schedule', scheduleId, slot })`. The `(scheduleId, slot)` pair is unique, so a slot can
  never fire twice, even across restarts. A slot missed while the box was down is fired once if it is less than 12 hours
  old (same catch-up rule as the desktop).
- **Webhooks: not in v1.** No surface creates one, so none ship. The `hook*` routes return 501 `not_in_v1`. They come
  back in v1.1 with Slack in the cloud, with a "Trigger from a URL" row on the workflow. The design below stays the
  reference for that build.
- (v1.1) **Webhooks:** `PUT …/hooks/:hid` gives a URL. With `verify: 'secret'`, the secret is the last path segment and is
  compared in constant time. With `verify: 'github'`, the request is checked against `X-Hub-Signature-256` HMAC-SHA256.
  Payload fields map to workflow inputs by dotted path. Every mapped value is **untrusted**: the runtime wraps it with the
  same notice the Slack triggers use (`UNTRUSTED_SLACK_NOTE` pattern) and never puts it in a command field
  (`TRIGGER_IN_COMMAND` rule). Deliveries are rate limited per hook (`webhookPerMinute`). The body cap is 1 MB. Each
  delivery is audited.

### 7.8 Sandbox and isolation

The `process` driver (v1, `RuntimeOptions.sandbox`) gives each run:

- **Its own user** (`RuntimeOptions.agentUser`, `PRINCIPIA_AGENT_UID`, default 1001). The control plane runs as root
  inside the container with six capabilities (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID`, `SETGID`, `KILL`), a
  read-only root filesystem and `no-new-privileges`. Every agent process (engine step spawns through
  `EngineContext.spawnUser`, git for repos, the gateway bridge and the Forum CLI they start) starts as that user with no
  capabilities. `/secrets`, `/data/control.db*` and the runtime's `engine.db`/`forum.db` are root-only (0600, umask
  077); `/data`, `/data/runtime` and `/workspace` are traverse-only (0711). The runtime hands the agent exactly what it
  works in: the run home (after accounts and askpass are written), the company folder, the run's artifacts folder,
  its gateway grant folders and Forum shim. Connector credentials stay in the control plane's process.
  `cloud/isolation.smoke.mjs` runs `cat /secrets/master.key /data/control.db` as a real shell step in the container and
  asserts permission denied for each, and that the step still works in its company folder.

- `HOME=/data/runtime/runs/<runId>/home` (0700), with `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and the Gemini settings inside
  it. It is deleted at run end, after the Codex `auth.json` is read back.
- An environment built from an allowlist (`PATH`, `LANG`, `TZ`, `SHELL`, `TERM`, plus provider variables and the
  selected company keys). Nothing from the control plane's own environment leaks: the `PRINCIPIA_*` pattern from today's
  runner becomes a strict allowlist.
- A cwd confined to `/workspace/<companyId>`. Workflow cwds are resolved inside it, and a cwd that escapes it is refused
  at import.
- Process-group kill on cancel and timeout (SIGTERM, then SIGKILL after 3 s), the engine's reaper tags, a per-run
  wall-clock cap from quotas, and the existing stall monitor.
- Claude runs `--permission-mode dontAsk` unless the profile bypasses. Codex runs with `--sandbox workspace-write`.
  Unapproved actions fail fast rather than waiting for a UI that is not there. Asking a human goes through `forum_ask`.

**What this is not:** a hard boundary between tenants. All companies in a workspace belong to one owner, and a run's
agent can read that run's own provider token (inherent to running the CLI with it). What a prompt-injected agent cannot
do is read the master key or the credential store of the whole workspace. The container is the boundary to the host. The managed cloud runs **one microVM per workspace** (§12.3), and a `docker` or
microVM *per run* driver is on the roadmap behind the same interface.

### 7.9 Readiness: nothing fails silently at 09:00

`CloudCompany.readiness` (additive, BE) is `{ ready: boolean; fixes: CloudFix[] }` with
`CloudFix = { kind: 'account' | 'key' | 'connection' | 'repo' | 'passport' | 'workflow'; ref: string; message: string }`.
The control plane computes it from data it already has. It never runs an agent to compute it:

- **account:** every adapter that a cloud workflow or schedule uses has a provider credential with status `ok` or
  `expiring`. Message: "Morning brief uses Codex. Sign in with ChatGPT."
- **key:** every key a cloud workflow uses exists in the company's secrets. "Uses" is the union of what the cloud
  detects in the steps (`$NAME`, `${NAME}`, `process.env.NAME`, `os.environ`, and well-formed names in prose such as
  "Use FAL_KEY for images") and what the desktop declares on `PUT …/workflows/:wid {keys}` (its vault names found in the
  steps, ticked or not). Messages name the key in words: "Quest content uses the fal.ai key (FAL_KEY), which is not in
  the cloud yet. Copy it from your Mac." 
- **connection:** every connection that the company's workflows reference exists, and OAuth ones are authorized.
- **repo:** every repo is cloned and its last sync succeeded.
- **passport:** the passport host is reachable and the company has a passport.
- **workflow:** `problems[]` from `validateWorkflow` is empty.

- **account (from real runs):** `expired` shows "Your Claude sign-in expired. Connect Claude."; a usage limit shows its
  reset time with `action: 'wait'` (nothing to click).

Messages are plain sentences in the founder's words. The desktop maps each `kind` to the one-click action that fixes
it. The console shows `ready` only. **Run once now** is `POST …/runs {workflowId}` with the trigger `desktop`.

---

## 8. Desktop and cloud sync

| What | Source of truth | Mechanism |
|---|---|---|
| Passport | merged (three-way) | Open Passport revisions: the desktop's existing `PassportSync` against the host with the `desktop` grant; cloud agents write proposals or deltas (§7.1). The desktop syncs when `SyncChanges.passports` shows a newer revision. |
| Workflows | desktop | `PUT …/workflows/:wid {file, baseRev}`. The desktop rewrites the export for the cloud first (pure function `exportForCloud`): repo cwd paths become `<repo-name>` relative to the company folder, profile ids become `prof_<adapter>`, and worktree nodes are refused with a clear reason. Stale `baseRev` returns 409 with `rev`. The server answers with `problems[]` from `runtime.validateWorkflow`. |
| Schedules | desktop | `PUT …/schedules/:sid {schedule, placement, baseRev}`. **Placement decides who fires.** `cloud`: the desktop's scheduler skips it (`isScheduleActive` returns false for schedules the link owns) and Schedules shows a cloud mark. `local`: the cloud stores it but never fires it. |
| Runs, asks | cloud | the desktop polls `GET /v1/sync/changes?since=` every 30 s while linked, and immediately on `/v1/events`. |
| Keys, connections | each side | explicit copy with ticks; never automatic. |
| Forum | each side | separate in v1 (§7.6). |

**Later:** placement `auto`, meaning run where the machine is awake. The desktop heartbeats, and each slot is claimed
with `POST /v1/schedules/:id/claim {slot}`, first claim wins. The cloud fires only when no desktop heartbeat has arrived
for 2 minutes. This is STRATEGY §4.5's "Run this schedule where the machine is awake".

---

## 9. Runs, asks and observability

- **Queue.** `POST …/runs`, schedules, webhooks and answers become `cloud_runs` rows (`queued`). The dispatcher starts runs
  while `maxConcurrentRuns` allows, oldest first, with one Codex sign-in run at a time per credential (§7.2). Paused
  companies and workspaces queue nothing; their triggers are parked and audited.
- **Statuses:** `queued, running, passed, failed, canceled, needs_input` (an ask is open and the run ended waiting).
- **Logs:** the engine's step logs, redacted, tailed through `GET /v1/runs/:id/log?step=&tail=` and SSE `log` events.
  Retention is 30 days self-host by default (`PRINCIPIA_LOG_RETENTION_DAYS`). Artifacts are kept with the run.
- **Usage:** `usage` events from the parsers (Claude stream-json `result` usage and cost, Codex `--json` token counts,
  Gemini stream-json stats) go to the ledger (§10).
- **Process logs:** JSON lines on stdout (`level, msg, at, runId?, companyId?`), redacted.
  **Later:** OpenTelemetry export (`OTEL_EXPORTER_OTLP_ENDPOINT`): spans per run, step and tool call, so Ratel-style
  context analytics or any OTLP backend can attach. Mastra and Ratel both standardize on OTLP.

---

## 10. Cost controls, quotas and billing hooks

### 10.1 Quotas (`CloudQuotas`, `DEFAULT_QUOTAS`)

| Quota | Default | Where enforced |
|---|---|---|
| Concurrent runs per workspace | 2 (max 16) | dispatcher |
| Runs per company per 24 h | 200 | `requestRun` and `POST …/runs` (429 `quota_exceeded`) |
| Run minutes per company per 24 h | 600 | dispatcher (queued runs wait; new runs refused when exceeded) |
| Run timeout | 60 min (max 1440) | runtime |
| Webhook deliveries per hook per minute | 30 | ingress (429) |
| API spend per company per month (USD) | off | from usage; reaching it pauses the company and opens an ask |
| Schedule interval floor | 5 min | sync validation (same as desktop) |

**Kill switch:** `PATCH /v1/workspace {paused: true}` cancels running runs, refuses new ones and parks triggers. It is
one big button in the pane and the console. A company can be paused the same way.

Provider limits (Claude 5-hour windows, Codex rate limits) are detected with the existing `classifyLimitText`. The run
fails with the reset time, and the console offers "Retry at reset".

### 10.2 Usage ledger

`usage(runId, companyId, adapter, inputTokens, outputTokens, usd|null)` plus run minutes, recorded when each run ends.
`GET /v1/usage` aggregates it. Subscription runs report tokens with `usd: null`, because we never invent a dollar figure
for a plan.

### 10.3 Billing hooks (not implemented)

`BillingSink.record({workspaceId, metric: 'run_minutes'|'sandbox_cpu_seconds'|'storage_gb_day', quantity, at})` is
called by the ledger. The default sink does nothing. Managed later sends Stripe meter events. **Pricing proposal, not
decided:** self-host free forever. Managed *Hobby* free (1 workspace, 2 companies, 20 run-hours a month, 30-day logs).
*Pro* about $19 a month (200 run-hours, 10 companies, webhooks, 90-day logs, always-on). *Team* later (members, SSO,
guests). We charge for uptime and compute, never tokens, which fills the gap commentators point out between Mastra's
free and $250 tiers.

---

## 11. Security model

| Threat | Mitigation |
|---|---|
| Stolen device token | hashed at rest; revocable in pane and console; `lastSeenAt` shown; tokens scoped to one workspace; HTTPS required for non-local public URLs |
| Pairing brute force | 32^8 codes, 10 min, single use, 10 tries per IP per 10 min |
| Console XSS or CSRF | strict CSP (`default-src 'self'`, no inline script), SameSite=Strict cookie, CSRF double submit, no HTML rendering of agent text (text nodes only) |
| Secrets in logs, db or responses | write-only API; envelope encryption; redaction at every sink; a test asserts that seeded secrets appear nowhere |
| Agent reads the master key or the credential store | agents run as uid 1001 with no capabilities; `/secrets`, `control.db` and the runtime dbs are root-only 0600; connector credentials stay in the control plane's process; Docker smoke asserts permission denied (§7.8) |
| Agent reads provider token | inherent to running a CLI with a credential; mitigated by per-run HOME, deletion after the run, inference-only Claude tokens, short-lived GitHub tokens, gateway-held connector credentials; egress allowlist later |
| Prompt injection from webhooks, Forum guests, connector data | untrusted wrapping, never in command fields, `dontAsk` permissions, push guard, quotas |
| Cross-company leakage | company folder confinement, per-company gateway and passport grant, company-scoped routes (every id resolved to its own company) |
| SSRF through connector URLs | https only, private-range block, allowlist |
| Passport token misuse | grants per company with minimal scopes; runtime grant cannot `write:all`; host audit log; revocation on company removal |
| Supply chain | pinned CLI versions and lockfile; image rebuilt per release; no `curl \| sh` in the image |
| Host compromise | control plane root inside the container with six capabilities, agents uid 1001 with none, `no-new-privileges`, read-only root filesystem except the volumes and `/tmp`; API bound to 127.0.0.1 by default |
| Old credentials to a new host | a connection whose URL or command changes drops its stored headers unless they are resent |

Terms: subscription tokens authenticate the user's own account. Anthropic documents `setup-token` for CI and scripts.
OpenAI recommends API keys for automation and supports ChatGPT sign-in on trusted private runners. The pane links both
docs and never suggests sharing an account.

---

## 12. Deploy

### 12.1 Self-host (v1)

Three ways in, all ending with a connect link:

- **One button (Render).** `render.yaml` at the repository root: one web service from
  `ghcr.io/vibiz-ai/principia-cloud:latest`, a 10 GB disk at `/data`, `PRINCIPIA_PASSPORT=embedded`, and
  `PRINCIPIA_MASTER_KEY` generated by Render (32 bytes of base64, accepted by `parseMasterKey`, never written to the
  disk). `RENDER_EXTERNAL_URL` is the public URL, so the connect link, the console and the passport are one https origin.
  Deploy link: `https://render.com/deploy?repo=https://github.com/example-org/principia`. Fly (`FLY_APP_NAME`) and Railway
  (`RAILWAY_PUBLIC_DOMAIN`) are derived the same way; their templates come later.
- **One file.** `curl -fsSL https://raw.githubusercontent.com/Vibiz-ai/principia/main/cloud/compose.yml -o compose.yml`
  then `docker compose up -d`. Every service is an `image:` (no `build:`), every volume is named, the Caddyfile is
  inline: nothing else on disk, no clone of the hive repo, no sibling checkout, no GitHub credentials.
- **From source.** `docker compose -f cloud/compose.yml -f cloud/compose.build.yml up --build -d`. The principia image
  takes the Open Passport sources as the named build context `open-passport`
  (`${OPEN_PASSPORT_SRC:-https://github.com/Vibiz-ai/open-passport.git#main}`); the passport image builds from that
  repository's **root** with `dockerfile: packages/server/Dockerfile` (it copies `packages/js` and `packages/server`).
  The team uses `OPEN_PASSPORT_SRC=../../open-passport`.

**Zero-config first boot.** A one-shot service `init` (the principia image, `principia-cloud init`, root with `CHOWN`,
`DAC_OVERRIDE`, `FOWNER`) creates `/secrets/master.key` and `/secrets/passport-admin` (32 random bytes in hex, 0600,
root) in `principia-secrets`, and copies `passport-admin` into `passport-secrets` owned by the passport container's
user (1000). `principia` and `passport` both `depends_on: init` (`service_completed_successfully`) and mount their
volume read-only. The `passport` service keeps the unchanged host and overrides only its command, which runs
`node packages/server/src/main.ts` (working directory `/app`) with `OPEN_PASSPORT_ADMIN_TOKEN` from the file and
`OPEN_PASSPORT_PUBLIC_URL` from the env, else `https://$PASSPORT_DOMAIN`, else `http://127.0.0.1:8788`. A one-container
`serve` (Render, Fly, `docker run`) generates whatever the environment does not supply itself. Env vars always win.

- `principia`: root with six capabilities, agents as uid 1001 (§7.8); ports `127.0.0.1:8787`; volumes
  `principia-data:/data`, `principia-workspace:/workspace`, `principia-secrets:/secrets:ro`.
- `passport`: ports `127.0.0.1:8788`; volumes `passport-data:/data`, `passport-secrets:/secrets:ro`. Internal URL
  `http://passport:8787`.
- `caddy` (profile `caddy`, off by default): ports 80 and 443, `reverse_proxy` for `PRINCIPIA_DOMAIN` →
  `principia:8787` and `PASSPORT_DOMAIN` → `passport:8787`, certificates automatic. The same two variables set both
  public URLs, so public https is one flag: `PRINCIPIA_DOMAIN=… PASSPORT_DOMAIN=… docker compose --profile caddy up -d`.
- **Embedded passport** (`PRINCIPIA_PASSPORT=embedded`): the control plane starts the host from
  `PRINCIPIA_PASSPORT_SRC` (`/opt/open-passport` in the image) on 127.0.0.1:8788 as uid 1002, restarts it if it dies,
  and proxies only the host's own paths (`/v1/passports*`, `/v1/grants/*`, `/oauth/*` except `/oauth/connectors/*`,
  `/.well-known/oauth-*`, `/.well-known/openid-configuration`, `/p/*`) with `X-Forwarded-Proto/Host`. OAuth discovery
  and the MCP endpoint then live on the cloud's origin.
- **Reaching a local-only cloud:** when the public URL is this machine and the host is not Docker Desktop on the Mac
  itself (`host.docker.internal` does not resolve), the log prints one line under the link: "This link works only on
  this machine. From your Mac: ssh -N -L 8787:127.0.0.1:8787 you@this-server, then paste it. Or set
  PRINCIPIA_PUBLIC_URL to an address your Mac reaches." The desktop answers a failed loopback paste with "This link
  only works on the machine running your cloud…".

### 12.2 Environment

`PRINCIPIA_ADMIN_TOKEN`, `PRINCIPIA_MASTER_KEY`, `PRINCIPIA_PUBLIC_URL`, `PRINCIPIA_DOMAIN`, `PASSPORT_DOMAIN`,
`PRINCIPIA_PASSPORT` (`embedded`), `PRINCIPIA_PASSPORT_SRC`, `PRINCIPIA_AGENT_UID`/`_GID`, `PRINCIPIA_PASSPORT_UID`,
`PRINCIPIA_VERSION`, `OPEN_PASSPORT_VERSION`, `PRINCIPIA_WORKSPACE_NAME`,
`PRINCIPIA_LOG_RETENTION_DAYS`, `PRINCIPIA_CONNECTOR_ALLOW_PRIVATE` (comma-separated hosts), `OPEN_PASSPORT_INTERNAL_URL`,
`OPEN_PASSPORT_PUBLIC_URL`, `OPEN_PASSPORT_ADMIN_TOKEN`, `PRINCIPIA_SECRETS_DIR` (default `/secrets`, where `init` writes the generated keys), `PORT`, `HOST`. Every variable is optional on self-host except when you want to override a generated value. The legacy runner's variables
(`PRINCIPIA_API_TOKEN`, Telegram) still work with `cloud/server.mjs`.

### 12.3 Managed Principia Cloud (its own GCP project, later; nothing is provisioned by this build)

- **Control plane:** Cloud Run (min 1 instance), Cloud SQL Postgres behind a `ControlDb` adapter (v1's `node:sqlite`
  schema is plain SQL written for it), Cloud KMS for KEKs, Secret Manager for platform secrets, OIDC sign-in.
- **Passport hosts:** the reference host on Cloud Run with the GCS mirror (already built in `open-passport/packages/server/src/mirror.ts`),
  one instance per shard.
- **Runtime:** one microVM per workspace (Fly Machines or GCE with gVisor), with a persistent disk for `/workspace`.
  It stops after 15 idle minutes and is woken by the control plane on schedule, webhook or console action. The runtime
  speaks `CloudRuntime` and `ControlPorts` over mTLS HTTP instead of in-process.
- **Observability:** OTLP to Cloud Trace or a ClickHouse backend; per-workspace usage feeds billing.

---

## 13. Surfaces

### 13.1 Desktop Cloud pane (`ViewState {name: 'cloud'}`, sidebar entry and command palette "Cloud")

- **Not connected:** the arch-and-cloud line drawing, "Keep your agents working while your Mac sleeps", one field
  ("Paste your connect link") and **Connect**. URL plus code appears only after a paste fails. Below it: "No cloud yet?"
  with **Deploy on Render** (one button, https) and, for a machine you own, the two-line `curl` + `docker compose up -d`.
  Then: "Managed Principia Cloud is coming. Self-hosting is free forever." No `exec` command on this screen.
- **Connected**, in this order:
  - **Header:** workspace name (no raw URL), then one status: *Online* (green tile) or *Offline since 03:12* (red
    tile). Runtime version, sandbox driver, passport host and the last 24 h appear on hover only. A **Pause cloud**
    switch with a confirm dialog. A **Workspace ▾** menu holds the 24 h usage, Devices (with Revoke), Copy URL, **Open on
    your phone** (a QR code of a fresh login link plus Copy) and Disconnect.
  - **No setup strip.** Connect Claude and Sign in with ChatGPT live only in Accounts, Run in the cloud only in Companies.
  - **Needs you:** cloud asks (persona bust, question, option buttons, "Answer in thread") and passport proposals
    ("3 new facts", Review and Accept all). The same items also appear in Home's Needs you (a company, and All mode), marked with the cloud icon.
  - **Companies:** one row per company. A cloud company shows *Ready* (or the fixes, §7.9), "Passport · 3 new facts" or
    "Passport · in sync" (the revision on hover), **Run once now** and a **⋯** menu (Manage, Copy Passport URL for ChatGPT and Claude, Pause company, Bring back
    to this Mac). A local company shows **Run in the cloud…**.
  - **Cloud runs:** "While this Mac slept", the last 8 with status tesserae. Clicking one opens the run sheet with
    steps (labelled with the agent that ran them: Claude, Codex, Shell), the redacted log tail (kept by the control
    plane in `run_logs`, so a finished run always shows its output; "No log yet." only while it runs), Forum posts and
    Cancel.
  - **Accounts:** two rows, Claude and Codex (ChatGPT), with status, the Subscription or API billing badge, and expiry.
    Gemini is under the card's **⋯** (Add another provider) and gets a row once it has a key. Each row has one primary
    action (Connect Claude, Sign in with ChatGPT; or Test when connected) and a **⋯** menu (Replace, Remove, Use an API
    key instead). The one-account rule is said once, in the confirm before a browser sign-in.
- Visuals: VOICE.md line art (ArchFrame, Tesserae for status, MosaicEmpty for empty states). Amber is the Needs-you
  status tile and count pill only: never a card edge, never a warning border. No warm colours. Plain copy for anything
  about keys, money and permissions.

### 13.2 Web console (`/console`, static, mobile first, installable as a PWA)

Two tabs. The phone does two jobs: **answer** and **glance**.

- **Needs you:** asks with the persona's line-art bust (the desktop's own `Bust`, generated into
  `src/cloud/console/busts.gen.ts` by a test that fails when the drawing drifts), option buttons and a free-text answer, and passport proposals with Accept and Reject. When it
  is empty: the mosaic empty state and "Nothing needs you. Agents are working."
- **Runs:** the list grouped by "Running", "Today" and "Earlier". The detail shows steps, the log tail (SSE `?runId`),
  Forum posts and Cancel.
- **Header:** the workspace name, the Online/Offline tile and the **Pause cloud** switch (with a confirm). That is the
  kill switch in your pocket.

There is no account linking, no Forum client and no "Run a workflow" form on the phone in v1. It uses the same dark
tokens and line art as the app, with no framework (`src/cloud/console`, vanilla TypeScript with a tiny view layer). The
view model is in pure modules with unit tests.

---

## 14. Scope

**v1 (this build, testable locally in one pass):** everything in §5 to §11 except the items below, plus zero-config
self-host compose, the connect link, Mac-side account linking, the dependency-aware checklist, readiness and Run once
now, the desktop pane, Home's Needs you integration and the two-tab console. Docker build and a local `compose up` smoke
with fake CLIs.

**Cut from v1 (they ship only when they have a surface).** The contract keeps these routes. The server answers
501 `{code: 'not_in_v1'}`, and a test asserts it:

- `hooks`, `hookPut`, `hookDelete`, `hookIngress`, `hookIngressSecret` (webhooks, v1.1 with Slack in the cloud);
- `githubApp`, `githubAppPut` (GitHub App, after the Manifest flow);
- `deviceLoginStart`, `deviceLoginStatus`, `deviceLoginCancel` (server-side Codex device login, managed onboarding);
- `forumChannels`, `forumMessages`, `forumPost` (Forum mirror and sync, v1.1);
- `PUT` of the `codex_access_token` kind (Enterprise).

**Later:**

- OIDC, teams, members and guests; per-company provider overrides.
- Placement `auto` and heartbeats; bidirectional Forum sync; Slack and Telegram on the new API (the legacy runner keeps
  Telegram).
- `docker` and microVM per-run sandbox drivers; egress allowlist; OTLP export.
- One-click Fly and Railway templates (Render and the caddy profile shipped).
- GitHub App Manifest flow; GitLab.
- Cursor CLI; Google sign-in cache for Gemini; capturing the setup-token from the terminal.
- Postgres and KMS (managed); billing sink and pricing; master key rotation command.

---

## 15. Work packages and contract change log

Three packages run in parallel in the same tree with **disjoint file ownership**. The two contract files are frozen for
the build; if a package needs a change, it adds optional fields only and records the change here.

- **BE** (backend): control plane, vault, identity, sync, queue and quotas, passport provisioning, GitHub, connector OAuth,
  usage and audit, compose, Dockerfile, build config, package scripts.
- **AI** (agent runtime): `CloudRuntime` over the existing engine, sandbox, provider logins, gateway, Forum, Passport
  attachment, triggers, repos, smoke scripts with fake CLIs.
- **FE** (frontend): desktop link (main), IPC, Cloud pane, the move-to-cloud checklist, console, QA screenshots.

| Path | Owner | Others |
|---|---|---|
| `src/shared/cloud.ts`, `src/cloud/contract.ts` | frozen (architect); BE for later additive changes | read only |
| `src/cloud/control/**`, `cloud/compose.yml`, `cloud/Dockerfile`, `cloud/.env.example`, `cloud/README.md`, `cloud/server.mjs`, `cloud/runner.mjs`, `cloud/telegram.mjs`, `cloud/runner.test.mjs`, `cloud/control.smoke.mjs`, `vite.cloud.config.ts`, `package.json` (scripts only, no new dependencies) | BE | read only |
| `src/cloud/agent/**`, `src/cloud/workflows.ts`, `src/cloud/gateway.ts`, `cloud/agent.smoke.mjs`, `cloud/workflows*.smoke.mjs`, `cloud/gateway-workflow.smoke.mjs`; additive edits only if essential in `src/main/engine/**`, `src/main/forum/**`, `src/main/gateway/**` except `service.ts` | AI | read only |
| `src/main/cloud/**`, `src/main/handlers/cloud.ts`, `src/renderer/src/views/CloudView.tsx`, `src/renderer/src/components/cloud/**`, `src/renderer/src/state/cloud.ts`, `src/renderer/src/lib/cloud*.ts`, `src/renderer/src/styles/cloud.css`, `src/cloud/console/**`, `vite.console.config.ts`, `docs/qa/cloud/**`; additive edits in `src/shared/ipc.ts`, `src/shared/types.ts`, `src/main/hive.ts`, `src/main/handlers/index.ts`, `src/renderer/src/App.tsx`, `src/renderer/src/shell/Sidebar.tsx`, `src/renderer/src/shell/CommandPalette.tsx`, `src/renderer/src/state/store.ts`, `src/preload/index.d.ts`, `tsconfig.web.json`; additive (review): `src/renderer/src/views/HomeView.tsx` (one `<CloudNeedsYou/>` that renders nothing when not linked), `src/main/gateway/service.ts` (one main-only method `exportCredentials(id): Record<string, string>`; AI does not edit this file) | FE | read only |

Build seams: BE's `vite.cloud.config.ts` adds the entry `control: src/cloud/control/main.ts` and spreads
`CLOUD_AGENT_ENTRIES` from `src/cloud/agent/entries.ts` (AI owns this file: a plain `Record<string, string>` of extra
bundles the runtime needs, such as the forum CLI). BE's `package.json` adds `cloud:console:build`
(`vite build --config vite.console.config.ts`, FE's config, output `out-cloud/console`), and the Dockerfile runs it.
BE's `main.ts` imports `createCloudRuntime` from `src/cloud/agent/index.ts`. Until AI lands it, BE tests use its own
fake `CloudRuntime`, AI tests use a fake `ControlPorts`, and FE tests use a fake HTTP server that follows
`src/shared/cloud.ts`.

Change log:

- 2026-10-21: v1 contracts written (`src/shared/cloud.ts`, `src/cloud/contract.ts`).
- 2026-10-21 (product review, §0.1). Additive changes, all made by BE **first, before any other BE work**, so that FE and
  AI can build on them:
  - `src/shared/cloud.ts`: `formatConnectLink`, `parseConnectLink` (§5); `CloudFix` and
    `CloudCompany.readiness?: { ready: boolean; fixes: CloudFix[] }` (§7.9);
    `CloudRunDetail.forumPosts?: CloudForumMessage[]` (§7.6); `NOT_IN_V1_ROUTES: readonly CloudRouteName[]` (§14);
    `'not_in_v1'` added to `CloudErrorCode`.
  - `src/cloud/contract.ts`: `CloudRuntime.runDetail` fills `forumPosts` (the messages the run posted). Nothing else
    changes. The webhook, device-login and forum methods stay on the interface: AI implements them as thin stubs, and
    v1 never calls them.
- 2026-10-21 (BE, done). The review's additive changes landed in `src/shared/cloud.ts`: `'not_in_v1'` in `CloudErrorCode`;
  `CloudFix` and `CloudCompany.readiness?`; `CloudRunDetail.forumPosts?`; `NOT_IN_V1_ROUTES`, plus
  `NOT_IN_V1_CREDENTIAL_KINDS = ['codex_access_token']` (the PUT that also answers 501); `formatConnectLink(url, code)` and
  `parseConnectLink(text)` (accepts `http:` and `https:` origins, an optional path prefix before `/pair`, and the code with
  or without the dash in any case; tested in `src/shared/cloud.test.ts`). `CloudRuntime.runDetail`'s return type picks up
  `forumPosts` through `CloudRunDetail`, so `contract.ts` needs no edit. A 501 body is `{error: 'not_in_v1', message}`
  (the `CloudError` shape: the field is `error`, not `code`).
- 2026-10-21 (BE, control plane landed). More additive changes and the places the build differs from this document:
  - `src/shared/cloud.ts`: `CloudCompany.cloudAgentWrites?: 'propose' | 'trusted'`, `PutCompanyRequest.cloudAgentWrites?`
    (first create only) and `PatchCompanyRequest { paused?, cloudAgentWrites? }` (the console may send `paused` only).
    `POST /v1/pair/start` also returns `link` (the connect link) and accepts a device token as well as the admin token;
    `GET /v1/health` returns `{ok, api, workspaceId}`. A `paused` refusal is HTTP 409; `quota_exceeded` is 429.
  - The desktop grant has `read:all` as well as `write:all`: on the reference host `write:all` does not imply reads, and
    PassportSync pulls `/changes`. The runtime grant stays `read:all write:proposals write:taste`.
  - The built-in `passport` connection is listed by `GET …/connections` (read only), but it is not in
    `RunMaterials.connections`: the runtime builds it from `RunMaterials.passport` (URL plus runtime grant).
  - A company moved to the cloud again after removal gets a fresh passport id (`<cid>-<time>`): hosts never delete.
  - Compose: the passport build context is the Open Passport **repository root**
    (`${OPEN_PASSPORT_SRC:-https://github.com/Vibiz-ai/open-passport.git#main}`, `dockerfile: packages/server/Dockerfile`),
    because that Dockerfile copies `packages/js` and `packages/server`. A `#main:packages/server` context cannot build.
    Locally `OPEN_PASSPORT_SRC=../../open-passport`. The command override runs `node packages/server/src/main.ts`
    (the image's working directory is `/app`). The launch blocker stands: the repository must be public first.
  - `PRINCIPIA_RUNTIME=fake` starts the control plane with a runtime that runs nothing (smoke and tests only; logged
    as a warning). `PRINCIPIA_CONSOLE_DIR`, `PRINCIPIA_DATA_DIR` and `PRINCIPIA_WORKSPACE` exist too (the image sets them).
  - Readiness heuristics (no explicit declarations exist in `.hive.json`): adapters come from `prof_<adapter>`
    profile ids; key names are environment references (`$NAME`, `${NAME}`, `process.env.NAME`, `os.environ`/`getenv`)
    whose names look secret (`…KEY`, `…TOKEN`, `…SECRET`, `…PASSWORD`, `…_API_…`) and that the runtime does not supply
    itself; connection references are `connection: "<id>"` in step text. Every stored OAuth connection must be authorized.
  - The spend cap's ask (`agentName: 'Principia Cloud'`, options Resume / Keep paused) is answered by the control plane
    itself; it never reaches `runtime.answerAsk`.
- **BE QA round (additive, no contract change):**
  - The `passport` container mounts its own `passport-secrets` volume (init copies `passport-admin` there via
    `PRINCIPIA_PASSPORT_SECRETS_DIR`), so the internet-facing passport host never sees `master.key`.
  - `saveProviderCredential` with a `credentialId` that is no longer the adapter's current credential (the user
    replaced it during the run) is dropped as stale, so a run's write-back never overwrites a newer sign-in.
  - A run whose account is `expired` fails before starting with the readiness sentence.
  - A first-time `PUT /v1/companies/:cid` prepares the runtime folder before provisioning the passport (a failure
    leaves nothing behind, so the retry returns the desktop key); a concurrent first-time PUT for the same id is 409.
  - Schedule ids are unique in a workspace (409 otherwise): fire slots and `markScheduleFired` are keyed by id alone.
  - Login links from a device revoked since are refused; `usage.usd` that is not a finite, non-negative number is
    stored as null; malformed `%` escapes in a path are 404, not 500; `::/96` counts as private for the SSRF guard.

- **2026-10-21 (integration, product review round 2, §0.2).** Additive contract changes:
  - `src/cloud/contract.ts`: `ControlPorts.providerStatus?({credentialId, adapter, status: 'ok'|'expired'|'limited',
    detail})`; `RuntimeOptions.agentUser?: {uid, gid}`; `501` added to the `triggers.webhook` status union (the
    runtime's cast is gone).
  - `src/shared/cloud.ts`: `PutWorkflowRequest.keys?: string[]`; `CloudFix.action?: 'wait'`; `isLocalOnlyUrl`,
    `isLoopbackUrl`, `isPublicHttpsUrl`; `knownKey(name)` (plain names for well-known env vars).
  - `src/shared/engine.ts`: `EngineContext.spawnUser?()`; `src/main/engine/process.ts`: `ProcOptions.user`.
    `src/main/gateway/service.ts`: `fileOwner` option; `files.ts`: `writePrivateJson(file, value, owner?)`.
  - `src/shared/types.ts`: `CloudMovePlan.passport?: {ready, reason}`.
  - Control db migration 2: `run_logs` (the streamed log lines, 2,000 per run, swept with `run_steps`).
  - A connection PUT whose URL or command changes without credentials drops the stored ones.
  - The runtime is created with `dataDir: config.dataDir` (the contract's `/data`).
  - `HEAD` answers like `GET` for `/`, `/pair`, `/console` and `/console/*`.
  - The spend-cap ask says Resume works once the cap is raised.
  - Compose pulls images; `compose.build.yml`, `render.yaml` and the `caddy` profile are new; the workspace is a named
    volume (`principia-workspace`); the image runs as root and drops agents to uid 1001; `website/`, `docs/qa` and
    `docs/research` left the Docker build context.
  - The release exporter keeps `github.com/example-org/{principia,open-passport}` and
    `raw.githubusercontent.com/example-org/principia` addresses (the README, compose and the Render button point there).

---

## 16. Founder runbook

### Self-host, today (the team, before the repositories are public)

```sh
cd hive
OPEN_PASSPORT_SRC=../../open-passport docker compose -f cloud/compose.yml -f cloud/compose.build.yml up --build -d
docker compose -f cloud/compose.yml logs principia | grep -A1 "Connect link"
```

Principia → Cloud → paste the link → Connect Claude → Sign in with ChatGPT → Run in the cloud… on a company → Run once
now. Checks: `npm run cloud:control:smoke`, and against the running stack
`node cloud/control.smoke.mjs --url http://127.0.0.1:8787 --link '<link>' --passport` and
`node cloud/isolation.smoke.mjs --url http://127.0.0.1:8787 --link '<another link>'`.

### Before announcing (each is a founder action; nothing here was done by the build)

1. Make `github.com/example-org/open-passport` public (the image build and the from-source path fetch it).
2. Push `feat/company-portfolio`, export the public snapshot (`npm run release:prepare`) to `example-org/principia`, and
   tag `v0.1.0` in both repositories. The tag runs `cloud-images.yml` and `host-image.yml` (committed locally in Open
   Passport, not pushed), which publish `ghcr.io/vibiz-ai/principia-cloud` and `ghcr.io/vibiz-ai/open-passport-host`
   for linux/amd64 and arm64.
3. In GitHub → Packages, set both packages to **public** (GHCR packages start private).
4. From a clean machine with no GitHub login: `curl` the compose file, `docker compose up -d`, pair, run once.
5. Click the Render button from a fresh Render account (Starter plan for the disk); confirm the log's connect link is
   `https://….onrender.com/pair#…` and that ChatGPT can add `https://….onrender.com/v1/passports/<id>/mcp`.

### Managed Principia Cloud on its own GCP project (not provisioned)

What it takes, in order. Nothing below exists yet.

1. **Accounts and identity:** OIDC sign-in (Google, GitHub) in front of a workspaces service that creates one
   workspace per account and hands the desktop a connect link (the same pairing flow).
2. **Control plane:** Cloud Run (min 1 instance) running the same `principia-cloud` image with remote runtimes; a
   `ControlDb` adapter for Cloud SQL Postgres (the schema is plain SQL); Cloud KMS wrapping per-workspace DEKs (no
   `PRINCIPIA_MASTER_KEY`); Secret Manager for platform secrets.
3. **Runtime:** one microVM per workspace (Fly Machines or GCE with gVisor) with a persistent disk for `/workspace`, the
   same image, speaking `CloudRuntime`/`ControlPorts` over mTLS HTTP instead of in-process; stopped after 15 idle
   minutes and woken by schedules, asks and the console.
4. **Passport hosts:** the reference host on Cloud Run with its GCS mirror (Open Passport `deploy/gcp`, already built).
5. **Billing:** the usage ledger into a `BillingSink` that sends Stripe meter events (uptime and compute, never tokens).
6. **Operations:** OTLP traces to Cloud Trace, uptime checks on `/v1/health`, backups of Cloud SQL and the GCS mirror,
   an incident runbook, a status page; terms, DPA and a subprocessor list.

## 17. Later

- Fly (`fly.toml` with a volume) and Railway templates; Render's free tier has no disk, so Starter is the floor today.
- Master key rotation command (`vault.rewrap` exists); webhooks with Slack in the cloud; the GitHub App via the
  Manifest flow; server-side Codex device login; the cloud Forum mirror (all `501 not_in_v1` today).
- SSRF: pin the resolved address on connector fetches (check-then-fetch can be raced by DNS rebinding).
- Pairing rate limit behind a reverse proxy (trust `X-Forwarded-For` only when configured).
- Passport provisioning that fails after `host.create` leaves an orphan on the host (hosts never delete): a host-side
  cleanup API.
- A per-run sandbox driver (`docker` or microVM), an egress allowlist, and per-company agent users.
- When a step falls back to another harness, keep that harness's own cloud arguments (the fallback clears `extraArgs`,
  so a Codex fallback loses `--sandbox workspace-write`).
- Department L1 cards in the passport context; SSE streaming through `PassportRelay`.
- A fake-runtime ask generator so the console smoke covers the ask flow; CSRF token refresh in the console.
- "Started in the cloud" toasts on Home, Canvas and the dashboard (the run already starts in the cloud there).

---

## 18. Sources

1. Mastra, "Announcing Mastra Platform": https://mastra.ai/blog/announcing-mastra-platform
2. Mastra pricing: https://www.mastra.ai/pricing, and "How Mastra Platform Pricing Works": https://mastra.ai/blog/mastra-platform-pricing
3. Mastra Server: https://mastra.ai/cloud and https://mastra.ai/ai-agent-deployment
4. Mastra observability: https://mastra.ai/platform-observability, and the Product Hunt discussion on billing: https://www.producthunt.com/p/mastra/how-billing-works-on-mastra
5. Ratel Cloud: https://cloud.ratel.sh
6. Ratel docs: https://docs.ratel.sh
7. Ratel project notes (mirror of AGENTS.md): https://tomevault.io/tome/ratel-ai/ratel/AGENTS
8. Claude Code authentication: https://code.claude.com/docs/en/authentication
9. Community report on setup-token 401s: https://claudeissues.com/issue/84903-claude-code-oauth-token-from-claude-setup-token-returns-401-invalid-bearer-token
10. Codex authentication: https://learn.chatgpt.com/docs/auth (formerly developers.openai.com/codex/auth)
11. Codex CLI auth flows and CI credential management (third party): https://codex.danielvaughan.com/2026/04/01/codex-cli-authentication-flows-credential-management/
12. Gemini CLI authentication: https://geminicli.com/docs/get-started/authentication
13. Sandboxes compared: https://developertoolkit.ai/en/ecosystem/agent-tools/sandboxes/ and https://upstash.com/blog/best-e2b-alternatives
14. Self-hosted sandboxes (Daytona note): https://helix.ml/blog/self-hosted-agent-sandboxes
15. Modal on Claude Agent SDK sandboxes (vendor): https://modal.com/resources/best-sandbox-claude-agent-sdk
16. Fly Machines for ephemeral tasks: https://community.fly.io/t/ephemeral-fly-machine/6965 and https://fly.io/laravel-bytes/on-demand-compute.md
17. GitHub App installation tokens: https://docs.github.com/en/enterprise-cloud@latest/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
