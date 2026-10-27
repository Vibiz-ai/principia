# Hive — System Contract (v1, native macOS app)

The source of truth for all three builders: **Backend** (main process), **AI engineer** (engine), **Frontend** (renderer).
SPEC.md wins on scope; this document wins on interfaces. If code and this doc disagree, fix one of them in the same commit.

**Hive is a native Mac app.** Electron main <-> renderer talk over Electron IPC only. There is no persistent HTTP server or
localhost port (an explicit MCP OAuth sign-in may temporarily bind an expiring loopback callback), no WebSocket, no browser tab and no custom URL protocol in the shipped app (`hive-artifact://` was
deleted in SPEC A9; artifact thumbnails cross IPC as data URLs, previews are real Quick Look).
SPEC §0.1 amendments A1-A15 are binding and already reflected below.
The Vite dev server that `npm run dev` starts exists only in development, to serve the renderer bundle with HMR.

## Changes during build

**AI engineer (engine), additive or clarifying only. No change to `src/shared/*`.**
- E1 `src/main/engine/index.ts` also exports `seedWorkflows({claude, codex}) -> {seedKey, draft}[]`. Main calls it
  at first-launch seeding with the default profile ids (`codex: null` if not installed) and inserts each draft with its
  `seedKey`. It returns [] when there is no claude profile. Seeds: `build-until-tests-pass`, `build-codex-review`
  (reviewer falls back to Claude and is labeled), `debate-a-decision`, plus `morning-brief` (a shell step gathers 24 h of git
  activity under a folder input, then claude writes `morning-brief.md` into ARTIFACTS_DIR). Morning brief goes beyond
  SPEC §7.3's three seeds. Main may skip it.
- E2 Effective node dependencies = `after` ∪ nodes referenced by `{{id.output|transcript}}` ∪ (check: `target`).
  Validation cycle detection and the A4 loop body use these effective dependencies. A check whose criteria reads
  `{{fmt.output}}` therefore re-runs `fmt` on FAIL.
- E3 A check with `cwd: null` runs in its target's resolved cwd, not in `scratch/`. If the command reviewer times out,
  the verdict is FAIL and the feedback is the timeout notice plus the output tail.
- E4 Shell nodes and command checks have no profile. They get all secrets (`['*']`) and no auth stripping.
  `PromptTarget.secretNames` is ignored (A6: scoping is per profile only). Prompt runs time out after 60 min.
- E5 Headless adapter argv details: codex `exec --json --skip-git-repo-check …` (JSONL parsed); cursor-agent
  `-p --output-format stream-json …` (Claude-shaped parser); gemini plain text. Claude's `-p` result with
  `permission_denials` on a profile whose `permissionMode` is `default` fails the step with a "set bypass" message (A8).
  The real claude smoke run passed.
- E6 Workflow inputs whose value is a repo id render as that repo's absolute path everywhere (prompts and cwd).
- E7 Room summary turn: `round = null`, `participantLabel = participants[0].label`. Each turn's `sourceStepIds` =
  the previous turn's step, which gives the canvas its talk edges.
- E8 Scheduler: a tick that finds a slot more than 2 min late applies the missed-fire rule, which covers sleep with no
  `resume` event. `setPaused(false)` skips slots that passed while paused (no catch-up). A one-off that passed during the
  pause logs `missed` and disables itself. `runNow` logs a `fired` event ("Run now") and sets only `lastRunId`.
  `HIVE_NO_SCHEDULER=1` is honored inside `scheduler.start()`.

**Backend (main + preload).** Shared-file edits are add-only.
- B1 **Preload error shape (fix).** contextBridge copies only `message` from an `Error`, so `code`/`errors`/`name`
  never reached the renderer (verified in Electron 44). `window.hive.*` now rejects with a plain object
  `{name:'HiveError', code, message, errors?, stack, toString()}`. `e.code`, `e.errors`, `e.message` work as §4.1 says;
  `e instanceof Error` is **false**. Do not rely on `instanceof`.
- B2 **Request validation.** Every invoke and send payload is zod-validated in main (`src/main/ipcSchemas.ts`).
  A bad shape answers `bad_request` with `errors[]` (`path` = dotted field path). Send payloads that fail validation are
  dropped silently. Only the main window's webContents may call in (`forbidden` otherwise).
- B3 Shared additions used by main (added by the frontend, implemented here): `app:hideWindow`,
  `UiCommand` `newChat` / `closeSession` / `zoom {dir}`, `ConfirmRequest.suppressKey`. With `suppressKey`, main shows a
  "Don't ask again" checkbox and persists the choice in `meta` (`confirm_suppress:<key>`). Later confirms with that key
  resolve `true` without a dialog.
- B4 App menu routing: File > New Session `newSession`, New Chat ⌥⌘N `newChat`, Close Session ⌘W `closeSession`
  (renderer kills the focused session after confirm, or calls `app.hideWindow()`), Close Window ⇧⌘W hides in main,
  Import Workflow… runs the import dialog in main and then sends `navigate workflows`. View > Zoom In ⌘= / Out ⌘- /
  Actual Size ⌘0 send `zoom {dir}`, and the renderer owns `terminalFontSize` via `settings:update`. The Run menu has only
  "Pause All Schedules" (checkbox). Run Workflow / Cancel / Re-run are renderer shortcuts, not menu items, because no
  UiCommand exists for them. Help: Show Data Folder, Show Logs.
- B5 Tray "New Session ▸" lists 5 recent repos plus "Chat". A repo item sends `newSession {repoId}`, Chat sends
  `newChat`, so the renderer spawns with its pane size. Commands are queued until the renderer sends `ui:ready`.
- B6 Seeding persists the engine's drafts, skipping `morning-brief`, so exactly the three SPEC §7.3 workflows are
  seeded. Default profiles are seeded once per adapter when it is first detected as available, including later via
  `providers.updated` or Recheck. A deleted default is not re-seeded. `sessions:create {adapter}` creates that adapter's
  default profile on demand if none exists.
- B7 `providers:list {refresh:true}` re-resolves the login env (A14) before re-detecting, which is Settings "Recheck".
  `AppInfo.loginShellPath` is the PATH printed by the login shell.
- B8 `workflows:import` maps profile ids unknown on this Mac to the default claude profile (else the first agent
  profile) before validation. That way, files exported on another machine import cleanly.
- B9 `workflows:create/update/validate` normalize every check node's `after` to `[target]` before validation (A4).
- B10 `artifacts:*` handlers drop the row and answer `not_found` if the file vanished. `artifacts:openDir` requires
  the run or session to exist. `runs:openAsSession` without `stepId` opens the last failed agent step, else the last
  agent step. It uses cols/rows 120x32, and the renderer resizes on attach.
- B11 Sessions: the session title is `<repo> · <Adapter>` / `Chat · <Adapter>`, using the profile name when it is
  custom. `sessions:create` sets `settings.lastRepoId`. A PTY that ignores SIGHUP+SIGKILL for 2 s is marked exited
  (exit_code null), so there are no zombie rows.
- B12 Window bounds persist in `meta.window_bounds`. Notifications for runs and for `missed` / `caught_up` /
  `skipped_overlap` schedule events open the run (or Schedules) on click. `unseenFailures` counts only failures that
  end while the window is not focused.

**Integration.**
- I1 `openDatabase` heals columns added to the v1 DDL during the build (`profiles.use_api_key_auth`,
  `sessions.agent_session_id`, `run_steps.agent_session_id`) with an idempotent `ALTER TABLE … ADD COLUMN`, so dbs
  created by earlier builds open cleanly.
- I2 `scripts/e2e-smoke.cjs` is the Playwright end-to-end check. It passed 18/18 against both `out/` and the packaged
  `Hive.app` with a Finder-like minimal PATH.

**Frontend (renderer), add-only changes to `src/shared/ipc.ts`.** Main must handle F1. F2 and F3 degrade safely until main supports them.
- F1 New invoke channel `app:hideWindow` V -> V. It hides the main window, the same as the red button. The renderer calls it for ⌘⇧W, and for ⌘W when no session is focused. It is in `INVOKE_CHANNELS`, and until main registers it the call answers "not implemented".
- F2 `ConfirmRequest.suppressKey?: string`. When it is set, main shows a "Don't ask again" checkbox (`showMessageBox` `checkboxLabel`). After the user checks it, later confirms with the same key resolve `true` without a dialog, and main persists that choice. The renderer sends `suppressKey: 'killSession'` on "Kill session?" (SPEC A2). If main ignores the field, the dialog shows every time.
- F3 New `UiCommand` kinds: `{kind:'newChat'}` (⌥⌘N), `{kind:'closeSession'}` (⌘W menu item), `{kind:'zoom', dir:'in'|'out'|'reset'}` (⌘= / ⌘- / ⌘0). The renderer also handles every menu chord on keydown and calls `preventDefault`. It drops a duplicate of the same command that arrives within 250 ms, so the menu and the keydown can both fire safely.
- F4 The renderer follows E2: template references count as dependencies in the editor preview, the local validator and the `{{` autocomplete.
- F5 Renderer dependencies added to `package.json` (Backend owns this file): `@xterm/xterm` 6.0.0, `@xterm/addon-fit`, `@xterm/addon-search`, `@xterm/addon-webgl`, `@xyflow/react` 12.12.0, `@dagrejs/dagre` 3.1.1, `geist` 1.7.2. All are installed with `--ignore-scripts`. The Geist woff2 files are copied into `src/renderer/src/assets/fonts/` and bundled, so nothing loads from a CDN.

## 0. Typed mirror and ownership

The TypeScript files below are normative for field shapes. This doc gives semantics. Both change together.

| File | Contents | Importable by |
|---|---|---|
| `src/shared/types.ts` | domain types (Repo, Session, Workflow, Run, RunStep, Schedule, Secret, Artifact, Settings…), `EngineEvent`, error codes | main, engine, preload, renderer |
| `src/shared/ipc.ts` | `InvokeMap`, `SendMap`, `EventMap`, `UiCommand`, `HiveApi` (= type of `window.hive`), channel lists, `NativeMenuItem`, `ConfirmRequest` | main, preload, renderer |
| `src/shared/engine.ts` | `EngineContext`, `EngineStore`, `Engine`, `SpawnSpec`, `CreateEngine` | main, engine only |
| `src/shared/errors.ts` | `HiveError` class (`code`, `message`, `errors?`) | all |
| `src/shared/ids.ts` | `newId(kind)`, `ownerOfArtifactDir()` | all |
| `src/main/db/schema.ts` | exact SQLite DDL | main |

Rules for `src/shared/*`: no Node or DOM imports, no side effects. Alias `@shared/*` works in all three bundles.

| Area | Owner |
|---|---|
| `src/main/**` except `src/main/engine/**`, `src/preload/**`, `package.json`, `electron.vite.config.ts`, `electron-builder.yml`, `build/`, `resources/`, `scripts/` | Backend |
| `src/main/engine/**` (adapters, headless runner, workflow engine, scheduler) | AI engineer |
| `src/renderer/**` | Frontend |
| `src/shared/**`, `docs/CONTRACT.md` | co-owned; announce changes to the other two |

## 1. Process model and project layout

```
src/
  main/            Electron main (Node 24 in Electron 44). App lifecycle, window, Tray, menu, notifications,
                   SQLite, vault, PTY sessions (node-pty), artifacts indexer + thumbnail cache, IPC handlers.
    engine/        Engine (AI engineer). Imported by main ONLY via src/main/engine/index.ts -> createEngine().
    db/            schema.ts (DDL), index.ts (open + migrate), engineStore.ts (EngineStore impl), repositories.
  preload/         contextBridge -> window.hive (typed HiveApi). Sandboxed, CommonJS, requires only 'electron'.
  renderer/        React + TS (xterm.js, @xyflow/react). Talks ONLY through window.hive.
  shared/          Types + tiny pure helpers.
resources/         trayTemplate.png, trayTemplate@2x.png (copied to Contents/Resources/resources in the .app)
build/             icon.icns, icon.png (electron-builder buildResources)
scripts/           verify-native.cjs, make-icons.swift
```

BrowserWindow: `titleBarStyle: 'hiddenInset'`, `trafficLightPosition {x:16,y:16}`, min 1100x700, `backgroundColor #0d0d0f`,
`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. `will-navigate` blocked, `setWindowOpenHandler`
denies (https links -> `shell.openExternal`). Renderer CSP in `src/renderer/index.html`: `default-src 'self'`,
`img-src 'self' data:`, no `frame-src`. The renderer must put `-webkit-app-region: drag` on the top 44 px
of the sidebar and of the main header (traffic lights sit over the sidebar).

Scripts: `npm run dev` (electron-vite dev, renderer HMR + main/preload rebuild-and-restart), `npm run build`,
`npm run dist` (-> `release/mac-arm64/Hive.app` + `release/Hive-<ver>-arm64.dmg`, unsigned), `npm run typecheck`,
`npm test` (vitest, Node, no Electron), `npm run verify:native` (loads better-sqlite3 + node-pty + safeStorage inside
Electron), `npm run smoke` (builds, launches, calls `window.hive.app.info()` through the real bridge, exits).

Native modules: `better-sqlite3` and `node-pty` are rebuilt for Electron by `@electron/rebuild` in `postinstall`,
externalized by electron-vite and `asarUnpack`ed by electron-builder. `node:sqlite` also works in Electron 44 but is
NOT used — one SQLite driver only (better-sqlite3).

## 2. Paths and environment

### 2.1 Data directory
`userData = app.getPath('userData')` = `~/Library/Application Support/Hive/`, unless **`HIVE_USER_DATA`** is set
(absolute or relative path; applied with `app.setPath('userData', …)` before `ready`). Use it for tests, smoke runs and a
second dev instance. The single-instance lock lives in the userData dir and the override is applied before
`requestSingleInstanceLock()`, so a dev build with its own `HIVE_USER_DATA` can run next to the installed Hive.app.

```
<userData>/
  hive.db                         SQLite (WAL)                                      (dirs 0700)
  artifacts/<runId>/...           ARTIFACTS_DIR of a run       (created by engine before first spawn)
  artifacts/<sessionId>/...       ARTIFACTS_DIR of a session   (created by main before spawn)
  thumbs/<artifactId>-<size>.png  Quick Look thumbnail cache   (main; deleted with the artifact row)
  logs/runs/<runId>/<stepId>.log  raw step output, redacted    (engine writes)
  logs/sessions/<sessionId>.log   PTY scrollback, redacted, ring-capped 5 MB (main writes)
  logs/main.log                   main-process log
  scratch/                        cwd for Chat sessions and nodes with cwd = null
```
Ids are `<prefix>_<10 [0-9a-z]>` (`newId()`): `repo_ prof_ s_ wf_ r_ st_ sch_ sev_ art_`. The first path segment under
`artifacts/` therefore tells the owner: `r_…` = run, `s_…` = session.

### 2.2 Child process environment (sessions and every engine step)
Built in this order, later wins:
1. `ctx.baseEnv()` — Hive's process env after login-shell ENV resolution (SPEC A14: `$SHELL -ilc` printing `env -0`
   between markers, 3 s timeout, `TERM=dumb`; drop `PWD SHLVL _ OLDPWD`; PATH merged + de-duplicated, plus `~/.local/bin`,
   `/opt/homebrew/bin`, `/usr/local/bin` fallbacks), minus
   `ELECTRON_*`, `NODE_OPTIONS`, `VITE_*`; plus `TERM=xterm-256color`, `COLORTERM=truecolor`, `HIVE=1`. HOME is the
   user's real HOME, so CLIs read `~/.claude`, MCP config, skills etc. as usual.
2. Adapter `SpawnSpec.env` (if any).
3. Secrets: `ctx.secrets.resolve(profile.secretNames)` (`['*']` = all; seeded default). Nodes have no secretNames.
4. Delete every name in `SpawnSpec.stripEnv` / the adapter's auth list unless `profile.useApiKeyAuth` (claude:
   `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`; codex: `OPENAI_API_KEY`). SPEC A6.
5. Hive vars: `ARTIFACTS_DIR` (absolute, trailing slash, exists), `HIVE_RUN_ID` + `HIVE_NODE_ID` + `HIVE_STEP_ID`
   (steps) or `HIVE_SESSION_ID` (sessions), `HIVE_USER_DATA`, and the spawn tag `HIVE_SPAWN_ID=<step id | session id>`
   (§13.4). The login env never passes an inherited `HIVE_SPAWN_ID` through.

### 2.3 Environment variables Hive itself reads
| Var | Meaning |
|---|---|
| `HIVE_USER_DATA` | data dir override (tests, smoke, parallel dev) |
| `HIVE_NO_SCHEDULER=1` | `engine.scheduler.start()` is a no-op (tests) |
| `HIVE_SMOKE=1` | after the window loads, call `window.hive.app.info()` via the real bridge, print `HIVE_SMOKE {...}`, exit 0/1 |
| `ELECTRON_RENDERER_URL` | set by electron-vite in dev only; packaged app always `loadFile` |

## 3. SQLite schema (v1)

`<userData>/hive.db`, better-sqlite3 (synchronous), `PRAGMA journal_mode=WAL; foreign_keys=ON; busy_timeout=5000;
synchronous=NORMAL`. Exact DDL: `src/main/db/schema.ts` (`meta.schema_version = 1`; future migrations bump it and run
in `openDatabase`). Conventions: snake_case, TEXT ids, ISO-UTC TEXT timestamps, JSON in `*_json` TEXT columns,
booleans INTEGER 0/1. IPC/TS shapes are camelCase; main's repositories map rows <-> types.

| Table | Key columns | Writer | Maps to |
|---|---|---|---|
| `meta` | key, value | main | — |
| `settings` | key (a `Settings` field), value JSON | main | `Settings` (defaults in §4.3) |
| `repos` | id, name, path UNIQUE, added_at | main | `Repo` (+ computed `exists`, `isGit`, `liveSessions`) |
| `profiles` | id, name, adapter, model, extra_args_json, permission_mode, secret_names_json (default `["*"]`), use_api_key_auth, is_default | main | `AgentProfile` |
| `sessions` | id, title, profile_id, adapter, repo_id, cwd, status, pid, cols, rows, exit_code, started_at, ended_at, artifacts_dir, log_path, from_run_id, agent_session_id | main | `Session` |
| `workflows` | id, name, description, inputs_json, nodes_json, seed_key UNIQUE | main | `Workflow` |
| `runs` | id, kind, title, target_json, workflow_id, workflow_json (snapshot), schedule_id, parent_run_id, trigger, status, reason, created/started/ended_at, artifacts_dir | **engine** (via EngineStore) | `Run` (+ computed `artifactCount`) |
| `run_steps` | id, run_id FK CASCADE, seq, node_id, node_type, attempt, round, profile_id, participant_label, adapter, cwd, prompt, output, verdict, exit_code, pid, status, error, source_step_ids_json, agent_session_id, log_path, started/ended_at | **engine** | `RunStep` |
| `schedules` | id, name, target_json, when_json, preset_json, enabled, created/updated_at; **last_fire_at, last_run_id, next_fire_at** | main (config) / **engine** (bold fire-state, and `enabled=0` for a missed one-off) | `Schedule` (+ `sentence` = `engine.scheduler.describe(when)`, `lastRunStatus` joined from runs) |
| `schedule_events` | id, schedule_id FK CASCADE, kind, slot_at, run_id, message, created_at | **engine** | `ScheduleEvent` |
| `secrets` | name PK, label, cipher BLOB (`safeStorage.encryptString`), masked, created/updated/last_used_at | main | `SecretMeta` (never the value) |
| `artifacts` | id, run_id, session_id, path UNIQUE, rel_path, name, kind, mime, bytes, mtime, created_at | main | `Artifact` |

Company columns, `company_secrets` and the `COALESCE(company_id, 'co_personal')` read rule: see "Companies" (Co.1).

Anyone in main may READ any table. Engine never touches SQL: it writes through `EngineStore` (implemented by main in
`src/main/db/engineStore.ts`) and reads config through `EngineContext` getters.

Boot recovery (before the window shows): main marks `sessions.status='running'` -> `exited` (exit_code null,
ended_at = now). `engine.init()` marks runs `queued|running` -> `failed` reason `"Hive quit during run"` and steps
`pending|running` -> `failed`. Exited sessions older than 7 days are deleted (row + log + empty artifacts dir kept if
non-empty).

Seeds (first launch, `meta.seeded=1`): one default profile per *available* adapter (`is_default=1`, permission
`bypass`, name = adapter label) plus "Shell"; the three SPEC §7.3 workflows with `seed_key` (deleted seeds stay deleted).

## 4. IPC API — `window.hive`

### 4.1 Conventions
- Shape: `window.hive.<domain>.<verb>(req?) => Promise<res>` for every `InvokeMap` channel `'<domain>:<verb>'`.
  The preload builds this facade from `INVOKE_CHANNELS`; the type is `HiveApi` (`src/shared/ipc.ts`).
- Wire: `ipcMain.handle(channel)` returns `IpcResult<T> = {ok:true,data} | {ok:false,error:HiveErrorShape}`. The preload
  unwraps and rejects with an `Error` whose `name === 'HiveError'` and which carries `code` and optional `errors`
  (`ValidationError[]`). Renderer: `catch (e) { if (e.code === 'validation') show(e.errors) }`.
- Main registers handlers with `handle(channel, fn)` from `src/main/ipc.ts`. Channels without a handler answer
  `{code:'internal', message:'<channel> not implemented yet'}` (never hang).
- Fire-and-forget: `window.hive.send(channel, payload)` for `SendMap` (`ipcRenderer.send`).
- Events: `const off = window.hive.on(name, cb)`; main sends on `evt:<name>` to the main window's webContents.
- Error codes (`HiveErrorCode`): `bad_request`, `validation` (+ `errors[]`), `not_found`, `conflict`,
  `adapter_unavailable` (message = install hint), `vault_unavailable`, `forbidden` (path outside allowed roots),
  `canceled` (user dismissed a native dialog where null is not the contract), `internal`.
- Plaintext secret values cross IPC only in `secrets:reveal` responses and in user-typed `secrets:set` /
  `secrets:importEnv` / `secrets:parseEnv` requests. Everything else (logs, prompts, outputs, pty data) is redacted.

### 4.2 Invoke channels
`V` = no argument. Types are in `src/shared/types.ts` / `ipc.ts`. The optional `companyId` on lists and creates, the
company channels and the amended channel counts are in "Companies" (Co.3).

**app**
| Channel | Request | Response | Semantics |
|---|---|---|---|
| `app:info` | V | `AppInfo` | versions, paths, `safeStorageAvailable`, resolved login PATH |
| `app:status` | V | `StatusSnapshot` | same numbers the tray shows |
| `app:home` | V | `HomeData` | running sessions, active runs, runs ended last 24 h (≤50), next 5 fires |
| `app:canvas` | V | `CanvasSnapshot` | everything the canvas needs in one call; then live via events |
| `app:quit` | V | V | same path as Cmd+Q (native confirm if anything is running) |
| `app:openExternal` | `{url}` | V | `https://` only, else `forbidden` |
| `app:showItemInFolder` | `{path}` | V | path must be inside a repo or userData, else `forbidden` |

**settings** — `settings:get` V -> `Settings`; `settings:update` `Partial<Settings>` -> `Settings` (side effects:
`launchAtLogin` -> `app.setLoginItemSettings({openAtLogin, openAsHidden:true})`; `schedulesPaused` ->
`engine.scheduler.setPaused`; `keepAwake` -> powerSaveBlocker; emits `settings:changed` + `status:changed`).

**providers** — `providers:list` `{refresh?}` -> `ProviderInfo[]` (always all 5 adapters; unavailable have
`available:false` + `installHint`). Refresh re-runs detection (Settings "Recheck").

**repos**
| `repos:list` | V | `Repo[]` sorted by name |
|---|---|---|
| `repos:pick` | V | `Repo[]` newly added — native `dialog.showOpenDialog({properties:['openDirectory','multiSelections','createDirectory']})`; [] if canceled |
| `repos:add` | `{paths}` | `Repo[]` — Finder drop (renderer gets paths via `window.hive.pathForFile(file)`); non-dirs -> `bad_request`; existing path returns existing row |
| `repos:update` | `{id,name}` | `Repo` |
| `repos:remove` | `{id}` | V — DB row only, never touches files; running sessions keep running |
| `repos:siblings` | `{id}` | `{path,name}[]` git dirs next to the repo not yet added (first-run import list) |

**profiles** — `profiles:list` V -> `AgentProfile[]`; `profiles:create` `AgentProfileInput` -> `AgentProfile`;
`profiles:update` `{id,...partial}` -> `AgentProfile`; `profiles:remove` `{id}` -> V (`conflict` "Used by: …" if
referenced by a workflow node or schedule; seeded defaults can be removed only if unreferenced).

**sessions** (interactive PTY, owned by main)
| `sessions:list` | `{status?: 'running'\|'exited'\|'all'}` | `Session[]` newest first (default all, ≤7 days) |
|---|---|---|
| `sessions:create` | `SessionCreateRequest` | `Session` — spawns now. `adapter` -> that adapter's default profile. No repo + no cwd = Chat (`scratch/`). `adapter_unavailable` if CLI missing. |
| `sessions:attach` | `{id}` | `{session, scrollback}` — scrollback = redacted tail (≤5 MB) to write into xterm before live `pty:data` |
| `sessions:kill` | `{id}` | `Session` after exit (SIGHUP, then SIGKILL to the process group after 1.5 s; ≤2 s) |
| `sessions:remove` | `{id}` | V — exited only (`conflict` otherwise); deletes row + log |
| `sessions:rename` | `{id,title}` | `Session` |
| `sessions:restart` | `{id}` | `Session` — exited only; new session, same profile + cwd, `interactiveSpawn(profile, {resumeAgentSessionId})` (claude `--resume <uuid>`) |
Closing a running session in the UI = `ui:confirm` then `sessions:kill` (SPEC A2). There is no detached state.
Input and resize are `send` channels (§4.4). PTY lives in main; closing the window does not affect it.

**workflows**
| `workflows:list` | V | `Workflow[]` by updatedAt desc |
|---|---|---|
| `workflows:get` | `{id}` | `Workflow` |
| `workflows:create` | `WorkflowDraft` | `Workflow` — runs `engine.workflows.validate`; non-empty -> `validation` with `errors` |
| `workflows:update` | `{id, draft}` | `Workflow` (same validation) |
| `workflows:remove` | `{id}` | V (`conflict` if a schedule targets it) |
| `workflows:duplicate` | `{id}` | `Workflow` named "<name> copy" |
| `workflows:validate` | `WorkflowDraft` | `ValidationError[]` (live editor feedback) |
| `workflows:export` | `{id}` | `{path}` or null — native save dialog, writes `WorkflowFile` JSON `<name>.hive.json` |
| `workflows:import` | V | `Workflow` or null — native open dialog; invalid file -> `bad_request`; draft is validated |

**runs** (headless; engine executes, main persists via EngineStore)
| `runs:start` | `{target: RunTarget}` | `Run` (queued) — `engine.runs.start(target,{trigger:'manual'})` |
|---|---|---|
| `runs:list` | `RunListQuery` | `Run[]` newest first (default limit 100) |
| `runs:get` | `{id}` | `RunDetail` (run + steps ordered by seq + workflow snapshot) |
| `runs:cancel` | `{id}` | V — resolves after the process tree is gone (≤3 s) |
| `runs:rerun` | `{id}` | `Run` — trigger `rerun`, `parentRunId` |
| `runs:stepLog` | `{runId, stepId, tailBytes?}` | `{text, truncated}` redacted log (default tail 1 MB) |
| `runs:openAsSession` | `{runId, stepId?}` | `Session` — interactive session with the step's profile in the step's cwd, resuming `step.agentSessionId` when set (`fromRunId` set). Default step = last failed, else last. |

**schedules**
| `schedules:list` | V | `Schedule[]` |
|---|---|---|
| `schedules:create` | `ScheduleInput` | `Schedule` — main validates via `engine.scheduler.preview(when)` (`validation` if `!ok`), inserts config, then `engine.scheduler.upsert(id)` |
| `schedules:update` | `{id, input}` | `Schedule` (same) |
| `schedules:remove` | `{id}` | V — `engine.scheduler.remove(id)` then delete (events cascade; runs keep `scheduleId`) |
| `schedules:setEnabled` | `{id, enabled}` | `Schedule` — then `upsert(id)` |
| `schedules:runNow` | `{id}` | `Run \| null` — `engine.scheduler.fireNow(id)`; `conflict` if previous run still active; `null` when a task-mode schedule (DEPARTMENTS.md §8) commented on and woke its standing card instead |
| `schedules:preview` | `{when}` | `SchedulePreview` (sentence + next 3, or `error` e.g. "Minimum interval is 5 minutes") |
| `schedules:events` | `{scheduleId, limit?}` | `ScheduleEvent[]` newest first (default 50) |
| `schedules:pauseAll` | `{paused}` | `StatusSnapshot` — same as `settings.update({schedulesPaused})` |

**secrets** (vault)
| `secrets:list` | V | `SecretMeta[]` by name |
|---|---|---|
| `secrets:set` | `{name, value, label?}` | `SecretMeta` — upsert; name must match `^[A-Z_][A-Z0-9_]*$` (`validation`); `vault_unavailable` if `!safeStorage.isEncryptionAvailable()` |
| `secrets:remove` | `{name}` | V |
| `secrets:reveal` | `{name}` | `{value}` — only on an explicit user click |
| `secrets:copy` | `{name}` | V — main writes the clipboard (`clipboard.writeText`) |
| `secrets:parseEnv` | `{text}` | `EnvImportEntry[]` preview (comments/blank ignored, `export ` prefix and quotes stripped); stores nothing |
| `secrets:importEnv` | `{text, names}` | `SecretMeta[]` — stores the selected names from the parsed text |
| `secrets:pickEnvFile` | V | `{path, entries, text}` or null — native open dialog (shows dotfiles) |

**artifacts**
| `artifacts:list` | `ArtifactQuery` | `Artifact[]` newest first (default 500) |
|---|---|---|
| `artifacts:thumbnail` | `{id, size?}` | `{dataUrl}` — `nativeImage.createThumbnailFromPath(path,{width:size,height:size})` (default 320), cached in `thumbs/`; failure -> `app.getFileIcon(path)` |
| `artifacts:trash` | `{id}` | V — `shell.trashItem`; row removed, `artifact:removed` emitted |
| `artifacts:quickLook` | `{id}` | V — `BrowserWindow.previewFile(path)` (real Quick Look) |
| `artifacts:open` | `{id}` | V — `shell.openPath` |
| `artifacts:reveal` | `{id}` | V — `shell.showItemInFolder` |
| `artifacts:copyPath` | `{id}` | V — clipboard |
| `artifacts:openDir` | `{runId}` or `{sessionId}` | V — opens that ARTIFACTS_DIR in Finder |

**ui / clipboard** (native helpers; renderer never draws its own context menus or destructive confirms)
| Channel | Request | Response | Semantics |
|---|---|---|---|
| `ui:contextMenu` | `{items: NativeMenuItem[]}` | `string \| null` | `Menu.buildFromTemplate(...).popup()`; resolves the clicked item id, null on dismiss |
| `ui:confirm` | `ConfirmRequest` | `boolean` | `dialog.showMessageBox` sheet on the main window; Cancel is default |
| `ui:setEdited` | `{edited}` | V | `win.setDocumentEdited` (unsaved workflow) |
| `clipboard:writeText` | `{text}` | V | Copy Output / Copy Path; never used for secret values (use `secrets:copy`) |

### 4.3 Settings defaults
`launchAtLogin:false, notifyOnSuccess:'scheduled', notifyOnFailure:true,
notificationSound:true, keepAwake:true, concurrency:4, defaultAdapter:'claude', lastRepoId:null,
schedulesPaused:false, onboardingDone:false, sidebarCollapsed:false, terminalFontSize:13`, plus
`interactiveBypass:false, sessionMemory:'read-write'` (§12) and `autoRetryRateLimit:true, stallMinutes:10` (§13).
Nothing else is a setting (SPEC A11). `launchAtLogin` is read back from `app.getLoginItemSettings().openAtLogin` on every `settings:get` (System
Settings is the truth); toggling calls `app.setLoginItemSettings({openAtLogin})` (no `openAsHidden`, see A13).

### 4.4 Send channels (renderer -> main, fire-and-forget)
| Channel | Payload | Notes |
|---|---|---|
| `sessions:write` | `{id, data, typed?}` | keystrokes/paste to the PTY; ignored if exited. `typed:false` = bytes xterm generated itself (query replies, focus reports); only typed input that is not a pure terminal report resolves pty asks or idle (LIVE.md A4b) |
| `sessions:resize` | `{id, cols, rows}` | from xterm fit addon; main debounces 50 ms |
| `artifacts:startDrag` | `{id}` | send from `onDragStart` (and `preventDefault`); main calls `webContents.startDrag({file, icon})` |
| `ui:ready` | void | renderer mounted its listeners; main flushes a queued `ui:command` (notification click while window was closed) |

### 4.5 Events (main -> renderer)
| Event | Payload | Emitted when |
|---|---|---|
| `pty:data` | `{sessionId, data}` | PTY output, coalesced per session every ~16 ms, redacted. Sent for all running sessions (renderer filters). |
| `pty:exit` | `{sessionId, exitCode, signal}` | PTY exited |
| `session:updated` | `Session` | created, renamed, exited |
| `run:updated` | `Run` | any run field change (from `EngineEvent run.updated`) |
| `run:step` | `RunStep` | step created/changed (`step.updated`) |
| `run:output` | `{runId, stepId, chunk}` | live headless output (`step.output`), redacted, coalesced ~50 ms |
| `artifact:added` / `artifact:removed` | `Artifact` / `{id}` | indexer saw a file appear/disappear |
| `schedule:updated` | `Schedule` | config or fire-state change |
| `schedule:fired` | `{event, scheduleName}` | every `ScheduleEvent` (fired, skipped_overlap, missed, caught_up, error) |
| `status:changed` | `StatusSnapshot` | counts/next fire/paused changed (also refreshes tray) |
| `providers:changed` | `ProviderInfo[]` | detection result changed |
| `settings:changed` | `Settings` | any settings change |
| `window:state` | `{focused, fullscreen}` | main window focus/blur/enter-/leave-full-screen (focus also resets `unseenFailures`) |
| `data:changed` | `{domain}` | repos/profiles/workflows/secrets/schedules lists changed -> refetch |
| `ui:command` | `UiCommand` | app menu, tray, notification click, dock (navigate, openRun, openSession, newSession, newWorkflow, addRepo, toggleSidebar, commandPalette, openSettings) |

Renderer pattern: fetch a snapshot via invoke, then apply events; never poll.

## 5. Engine interface (`src/main/engine/index.ts`)

The engine is plain Node code inside the main process. It imports nothing from `electron` (so vitest can run it with
fakes) except where noted. Its single export main uses:

```ts
export const createEngine: (ctx: EngineContext) => Engine   // types in src/shared/engine.ts
```

### 5.1 What main gives the engine — `EngineContext`
| Member | Contract |
|---|---|
| `paths` | `{userData, artifactsRoot, runLogsDir, scratchDir}` (all exist) |
| `store: EngineStore` | synchronous persistence for engine-owned tables: `insertRun(run, workflowSnapshot)`, `updateRun(id, patch) -> Run`, `getRun`, `getRunDetail`, `listActiveRuns`, `insertStep`, `updateStep(id, patch) -> RunStep`, `listSchedules`, `getSchedule`, `setScheduleFireState(id, {lastFireAt?, lastRunId?, nextFireAt?, enabled?}) -> Schedule`, `insertScheduleEvent(e) -> ScheduleEvent` |
| `baseEnv()` | fresh copy of the login-shell env (§2.2 step 1) |
| `secrets.resolve(names)` | decrypted `{NAME: value}` for names (`['*']` = all); unknown names skipped; updates `last_used_at` |
| `secrets.redact(text)` | replaces every vault value (length ≥ 4) with `••••NAME`. Engine applies it to everything it persists or emits (prompt, output, error, reason, logs, `step.output` chunks) |
| `getSettings()`, `getProfile(id)`, `getRepo(id)`, `getWorkflow(id)` | current config (read-only) |
| `emit(event: EngineEvent)` | call AFTER persisting. Main fans out: renderer events (`run:updated`, `run:step`, `run:output`, `schedule:updated`, `schedule:fired`, `providers:changed`), tray, `status:changed`, native notifications, artifact rescan on run end |
| `log` | `info/warn/error(msg, meta)` -> `logs/main.log` |
| `now?()` | injectable clock (tests) |

### 5.2 What the engine returns — `Engine`
| Member | Contract |
|---|---|
| `init()` | detect providers; boot recovery of runs/steps (§3). Called once after DB open, before window. |
| `shutdown()` | cancel all runs, kill every child process group (SIGTERM, SIGKILL after 3 s). Called on quit; resolves when done. |
| `providers.list({refresh?})` | `ProviderInfo[]` for all 5 adapters; emits `providers.updated` on change |
| `providers.cached()` | last detection, sync |
| `providers.interactiveSpawn(profile, {resumeAgentSessionId?, artifactsDir})` | `SpawnSpec {file (absolute), args, env?, stripEnv?, agentSessionId?}` for a PTY session; throws `HiveError('adapter_unavailable', installHint)`. claude: `claude (--session-id <new uuid> \| --resume <id>) [--model M] [--dangerously-skip-permissions] --append-system-prompt <ARTIFACTS_DIR hint> [...extraArgs]` |
| `workflows.validate(draft)` | `ValidationError[]` (SPEC §7.3 rules; `path` = node id or field) |
| `runs.start(target, {trigger, scheduleId?, parentRunId?})` | sync: inserts queued `Run`, creates `artifacts/<runId>/`, returns it; executes async. Missing adapter -> run fails immediately with hint. Throws `validation` / `not_found`. |
| `runs.cancel(id)` | kill tree ≤3 s, status `canceled` |
| `runs.rerun(id)` | new Run, same target, trigger `rerun` |
| `runs.active()` | queued + running |
| `scheduler.start()` / `stop()` | 15 s tick on `next_fire_at`; `start` also runs `catchUp('launch')`; no-op if `HIVE_NO_SCHEDULER=1` |
| `scheduler.upsert(id)` | after main wrote config: recompute `nextFireAt`, persist, emit `schedule.updated`, return it |
| `scheduler.remove(id)` | forget it (main deletes the row after) |
| `scheduler.runNow(id)` | trigger `manual` run with `scheduleId`; `conflict` if previous still active |
| `scheduler.preview(when)` / `describe(when)` | validation (cron 5-field, min interval 5 min, `at` in future) + sentence + next 3 |
| `scheduler.nextRuns(limit)` | ascending `NextFire[]` across enabled schedules (empty while paused) |
| `scheduler.setPaused(b)` | no fires while paused; persisted by main in settings |
| `scheduler.catchUp('launch'|'resume')` | SPEC §8.2 missed-fire rule; main calls `'resume'` on `powerMonitor` `resume` |

Engine events (`EngineEvent` in types.ts): `run.updated`, `step.updated`, `step.output`, `schedule.updated`,
`schedule.event`, `providers.updated`.

Notifications are main's job, driven by events: `run.updated` to `failed` -> always (if `notifyOnFailure`);
to `passed` -> per `notifyOnSuccess` (`scheduled` = only runs with `scheduleId`); `schedule.event` `missed` /
`caught_up` -> always. Click -> show window + `ui:command {kind:'openRun'}`.

### 5.3 Secrets flow
Renderer never sees values except Reveal. Main stores `safeStorage.encryptString(value)` in `secrets.cipher`
(Keychain-backed key; `isEncryptionAvailable()` false -> `vault_unavailable`, nothing stored — no plaintext fallback,
ever). At spawn time the engine (or main for sessions) calls `ctx.secrets.resolve(names)`, which decrypts in main
memory and returns an env map merged into the child env (§2.2). Main keeps an in-memory `value -> NAME` list for
`redact()`, rebuilt on every vault change.

### 5.4 Headless adapters (SPEC A3, A7, A8)
- Every headless child: `stdio ['ignore','pipe','pipe']`, `detached: true` (own process group), node `timeoutMin`.
- claude: `claude -p <prompt> --output-format stream-json --verbose --session-id <uuid> [--dangerously-skip-permissions]
  --append-system-prompt <ARTIFACTS_DIR hint>`; retry of a check target: `claude -p <feedback> --resume <uuid> ...`
  (same uuid recorded on the new step). Output = last `result` event.
- codex: `codex exec --skip-git-repo-check [--dangerously-bypass-approvals-and-sandbox] <hint + prompt>`; gemini:
  `gemini -p <hint + prompt> [--yolo]`; cursor: `cursor-agent -p <hint + prompt> [--force]`. No resume: retries send
  original prompt + feedback.
- Check with `command`: run via `$SHELL -lc` in the node cwd; exit 0 = PASS; feedback = last 8 KB of stdout+stderr.
- Loop body on FAIL = target + every node on a path target -> check, re-run in topological order, `attempt` bumped.
  Nodes depending on the target outside the loop body become ready only when all checks on the target passed.

### 5.5 Logs and output
Engine writes `logs/runs/<runId>/<stepId>.log` (redacted, raw stdout+stderr) and puts the final text (redacted, ≤50 KB)
in `run_steps.output`. Claude headless: `claude -p <prompt> --output-format stream-json --verbose`; `step.output`
chunks should be human-readable text (assistant text / tool names), not raw JSON.

## 6. Sessions (main)
- Spawn: `node-pty.spawn(spec.file, spec.args, {name:'xterm-256color', cols, rows, cwd, env})`, where `spec` comes
  from `engine.providers.interactiveSpawn(profile)`; env per §2.2. `ARTIFACTS_DIR = artifacts/<sessionId>/` created first.
- Output: redacted, appended to `logs/sessions/<id>.log` (ring-capped 5 MB) and an in-memory 1 MB tail for attach,
  broadcast as `pty:data`.
- Exit: row -> `exited` with exit code, `pty:exit` + `session:updated`, artifacts rescan of its dir.
- Quit: if running sessions or active runs exist, native `dialog.showMessageBox` "N sessions and M runs will be
  stopped. Quit?"; on confirm kill all PTY process groups and `await engine.shutdown()`.
- `powerSaveBlocker.start('prevent-app-suspension')` while any session or run is active and `keepAwake` is on.

## 7. Artifacts
- Layout: `<userData>/artifacts/<runId|sessionId>/**`. Every run and session gets its own `ARTIFACTS_DIR`.
- Indexer (main): chokidar watch on the artifacts root (ignore dotfiles, `awaitWriteFinish` 300 ms) + full rescan of a
  run's dir when the run ends. Upserts `artifacts` rows, emits `artifact:added` / `artifact:removed`.
- Kind by extension: image `png jpg jpeg gif webp svg avif heic`; video `mp4 mov webm m4v`; audio `mp3 wav m4a ogg
  flac aac`; html `html htm`; markdown `md markdown`; pdf `pdf`; code `ts tsx js jsx mjs cjs json py rb go rs swift
  java kt c h cpp css scss sh zsh yaml yml toml sql txt csv log xml`; else other.
- Preview: there is no protocol and no in-app renderer. Tiles call `artifacts:thumbnail`; Space -> `artifacts:quickLook`;
  Enter -> `artifacts:open`. Every path-taking handler resolves the row by id and checks `realpath` is inside the
  artifacts root (else `forbidden`).

## 8. Native shell (main)
- Single instance lock; `second-instance` and `activate` show the window.
- Close button / Cmd+Shift+W hides the window (app keeps running, Dock icon stays). Cmd+W is a renderer action
  (close focused session, else hide) — the menu item sends `ui:command`.
- Tray: exactly SPEC A12. `resources/trayTemplate.png` template image. Rebuilt on `status:changed` (throttled 1 s).
- App menu per SPEC §5 (Cmd+N newSession, Cmd+Shift+N newWorkflow, Cmd+O addRepo, Cmd+1..6 navigate, Cmd+, settings,
  Cmd+B toggleSidebar, Cmd+K commandPalette) -> `ui:command`. Edit menu uses standard roles.
- `powerMonitor.on('resume')` -> `engine.scheduler.catchUp('resume')`.
- Startup order: `applyUserDataOverride` -> single-instance lock -> ready ->
  `resolvePaths` -> `resolveLoginShellPath` -> `openDatabase` -> boot recovery + seeds -> `createEngine(ctx)` ->
  `engine.init()` -> register IPC -> artifacts indexer -> tray + menu -> window (unless login launch per SPEC A13)
  -> `engine.scheduler.start()`.

## 9. Testing
- `npm test`: vitest in plain Node. Engine tests use a fake `EngineContext` (in-memory `EngineStore`, identity
  `redact`, fixed `now`). Main repository tests may open better-sqlite3 only if it was built for the local Node — the
  default build targets Electron, so prefer `HIVE_USER_DATA` + `npm run smoke`-style Electron runs for DB tests.
- `npm run verify:native` and `npm run smoke` must pass before any commit that touches dependencies or build config.
- QA listen check: `lsof -nP -iTCP -sTCP:LISTEN -a -p $(pgrep -d, -f Hive.app)` prints nothing.

## 10. Change process
Changing a shared type or channel: edit `src/shared/*`, update this doc, run `npm run typecheck`, and mention it in the
commit message (`contract:` prefix). Adding a channel = add to `InvokeMap` + `INVOKE_CHANNELS` (a compile-time check
fails if they diverge) + a handler in main + a row here.
A PR that adds, renames, moves or removes a user-facing feature (a page, a setting, a button, a shortcut, a principia://
link) updates its entry in `src/shared/help.ts` in the same PR (see "Principia help" below).

## 11. Memory

Design and rationale: `docs/MEMORY.md` (its "Product-owner amendments PO1–PO10" are binding). This section is the
interface. Every edit is add-only, so nothing that exists today changes behavior while memory is `off`, the default
everywhere. It amends §4.3 / SPEC A11 by adding one setting, `sessionMemory` (default `'read-write'` since §12 / LIVE.md A10;
workflow nodes without `memory` stay `off`).

### 11.1 Storage and processes
- **`<userData>/memory.db`.** A separate SQLite file (WAL, `busy_timeout 5000`). DDL: `src/main/memory/schema.ts`
  (`MEMORY_SCHEMA_VERSION = 1`, `PRAGMA user_version`). Tables: `mem_meta`, `mem_grant`, `mem_entity`, `mem_alias`,
  `mem_fact`, `mem_relation`, `mem_event`, and one porter FTS5 table `mem_fts` (`tokenchars '_'`). No layout table.
- **Writers.** main (page IPC, poller, grants) and each `hivemem` MCP server process (agent tool calls). Every write
  goes through `src/main/memory/store.ts` in one `BEGIN IMMEDIATE` transaction. Reads never write (PO4). The server
  never touches `hive.db`.
- **Migrations.** Only main migrates (`openMemoryDb(path, {migrate: true})`). The server opens with
  `migrate: false` and answers every tool call "Hive memory schema mismatch; restart Hive" on a version mismatch.
- **`<userData>/memory/`** (0700): `fp.json` (salted SHA-256 fingerprints of vault values, length ≥ 8, rewritten on
  every vault change, no plaintext) and `spawn/<grantId>.*` (per-spawn MCP configs written by the engine, 0600,
  deleted on release, swept at boot).
- **MCP server.** Second electron-vite main entry, built as `out/main/mcp-memory.js` (+ a shared `out/main/chunks/*`).
  - Spawned by the agent CLI as `command = process.execPath`, `args = [<main dir>/mcp-memory.js]`,
    `env = { ELECTRON_RUN_AS_NODE: '1', HIVE_MEM_DB, HIVE_MEM_GRANT, HIVE_MEM_FP }`.
  - **Packaged:** the script runs straight from `app.asar` (Electron-as-node reads asar; better-sqlite3's `.node` is
    already asar-unpacked, `zod` resolves from `app.asar/node_modules`). It is deliberately **not** asarUnpacked:
    an unpacked copy could not resolve its JS dependencies. Verified on a packaged `Hive.app`
    (`scripts/verify-memory-mcp.cjs --bin … --script …/app.asar/out/main/mcp-memory.js`).
  - Stdio JSON-RPC only. **No listener of any kind**, so the §9 lsof check is unchanged.
  - Server name `hivemem`. Tools (PO3): `memory_search`, `memory_get` (read) and `memory_write` (facts + optional
    `relations`), `memory_invalidate` (read-write with a repo only; absent from `tools/list` otherwise).
    Schemas: `docs/MEMORY.md` §5, implemented in `src/main/memory/server/tools.ts`.
- **Ids** (`ID_PREFIX`): `memEntity: 'ment'`, `memFact: 'mfa'`, `memRelation: 'mrel'`, `memGrant: 'mgr'`.

### 11.2 Shared types: `src/shared/memory.ts` (new)
Normative file; summary:
- Enums (`as const` lists): `MemoryMode = off|read|read-write`, `MemoryScope = project|global` (PO1),
  `MemoryFactKind = fact|decision|convention|gotcha`, `MemoryStatus = active|pending|invalid` (PO6),
  `MemoryTransport = mcp|inject`. `MEMORY_READ_TOOLS`, `MEMORY_WRITE_TOOLS`, `MEMORY_SERVER_NAME = 'hivemem'`.
- Rows: `MemoryProvenance` (denormalized grant labels), `MemoryEntity` (with `counts`, `degree`, `changedAt` for the
  7-day ring, `unattributed`), `MemoryFact` (`supersedes[]`, `supersededBy`, `invalidatedAt`, no world time),
  `MemoryRelation`, `MemoryGrantInfo`.
- Queries: `MemoryScopeFilter { scope: 'all'|'global'|{repoId}, kinds?, adapters?, actors?, statuses?,
  unreviewedOnly?, runId? }` (`runId` = the run filter), `MemoryGraphQuery` (+ `centerId`, `hops`, `limit ≤ 150`),
  `MemorySearchQuery`, `MemoryFactQuery` (always newest first).
- Results: `MemoryGraph { entities, relations, runTouched: Id[] | null, total, truncated }`,
  `MemorySearchHit { entity, facts, relations, score, why: { exact, bm25, scope, trust, recency } }`,
  `MemoryEntityDetail { entity, facts (all statuses = History), relations {out,in}, neighbors }`,
  `MemoryOverview { agentWritesPaused, counts, repos, defaultRepoId, lastSeq, dbPath, dbBytes }`.
- Edits: `MemoryMutation` (one union for `memory:mutate`): `create` entity|fact|relation, `edit` fact|entity|relation,
  `rename`, `pin`/`unpin`, `approve`, `invalidate` (reason), `restore`, `toGlobal`, `merge`. `MemoryFactInput.supersedes`
  implements "Replace with…". Result: `MemoryMutationResult { affected, entity?, fact?, relation? }`.
- `MemoryChangedEvent { seq, runIds, entityIds, pendingDelta }`.

### 11.3 Additions to existing shared types (add-only)
```ts
// src/shared/types.ts
interface NodeBase { /* … */ memory?: MemoryMode } // absent = 'off'
interface PromptTarget { /* … */ memory?: MemoryMode } // absent = 'read-write' (LIVE.md §7); writes go to the repo's project memory
interface Settings { /* … */ sessionMemory?: MemoryMode } // default 'read-write' (LIVE.md A10; optional in the type so older literals compile)
interface ProviderInfo { /* … */ memory?: MemoryTransport } // set by the engine
export const ID_PREFIX = { /* … */ memEntity: 'ment', memFact: 'mfa', memRelation: 'mrel', memGrant: 'mgr' }

// src/shared/ipc.ts
type View = /* … */ | 'memory'
interface SessionCreateRequest { /* … */ memory?: MemoryMode } // overrides Settings.sessionMemory
```
Validation (engine `validate.ts`, mirrored by renderer `lib/workflow.ts`): `memory` in `MemoryMode`; `shell` nodes and
command checks `off` only ("Shell steps cannot use memory"); agent-reviewer checks `off | read`. main's zod schemas
accept `memory` on every node, on prompt targets, on `sessions:create` and `sessionMemory` in `settings:update`.

### 11.4 Engine boundary: `src/shared/engine.ts` (add-only)
`McpServerSpec`, `MemoryGrantRequest` (no write scope: agents write `project` only, PO2), `MemoryGrant
{ grantId, server, toolNames, spawnDir, brief }`, `MemoryBridge { grant(req) → MemoryGrant | null; release(grantId) }`,
`EngineContext.memory?`, `InteractiveSpawnOptions.memory?`. Main implements the bridge in
`src/main/memory/service.ts`: repo = longest repo-path prefix of `cwd` (none → read-only on global, write tools not
listed); brief = pinned (≤ 1,500 chars) + ≤ 8 facts relevant to the whole prompt (stopword-stripped keywords, ≤ 2,500
chars) + ≤ 10 key project notes by importance × recency (≤ 1,500 chars), ≤ 5,600 chars total, redacted, marked PARTIAL
(agents must `memory_search` before saying memory has nothing); '' only when nothing is visible. Relations never link
entities of two repos (refused on write, filtered on every read); `memory_write` `similar` omits the same run's facts.
Rules:
- **Grant per spawn**; `release` in `finally` (fail, timeout, cancel). Sessions: main grants on create (mode =
  `req.memory ?? settings.sessionMemory` (store default `'read-write'`, LIVE.md A10), transport from `ProviderInfo.memory`, no grant when absent) and
  releases on PTY exit; Restart reuses the last grant's mode.
- **Brief placement.** Headless: `grant.brief + '\n\n' + prompt`, not repeated on a `--resume` retry. Interactive
  claude: appended to `--append-system-prompt`.
- **claude argv.** `--mcp-config <spawnDir>/<grantId>.mcp.json --allowedTools <mcp__hivemem__…>` after `--verbose`
  (headless) or first (interactive); each variadic list is followed by another `--flag`. Never `--strict-mcp-config`.
- **Child env** unchanged (§2.2). `ELECTRON_RUN_AS_NODE` appears only in the server env inside the MCP config.
- **v1 transports.** claude `mcp`; codex, gemini, cursor `inject` until their spikes pass (MEMORY.md §7).

### 11.5 IPC: invoke channels (`InvokeMap` + `INVOKE_CHANNELS`, PO10: 11 channels)
| Channel | Request | Response | Notes |
|---|---|---|---|
| `memory:overview` | V | `MemoryOverview` | header, scope picker (`defaultRepoId` = most recently changed repo, else `lastRepoId`), badges |
| `memory:graph` | `MemoryGraphQuery` | `MemoryGraph` | ≤ 150 entities ranked by degree + facts + recency; run-touched entities are kept in the cap |
| `memory:entity` | `{ id }` | `MemoryEntityDetail` | `not_found` if deleted |
| `memory:search` | `MemorySearchQuery` | `MemorySearchHit[]` | same ranking as the MCP tools, with `why` factors |
| `memory:facts` | `MemoryFactQuery` | `{ items: MemoryFact[]; total }` | newest first; `runId` filter |
| `memory:mutate` | `MemoryMutation` | `MemoryMutationResult` | `conflict` on duplicates/name clashes, `validation` on a vault value |
| `memory:delete` | `{ kind: entity\|fact\|relation; ids }` | `V` | hard delete + event scrub; renderer must `ui:confirm` first |
| `memory:revertRun` | `{ runId }` | `{ invalidated; restored }` | one-way: a second call is a no-op; restored rows skip any live duplicate |
| `memory:grants` | `{ runId?; sessionId? }` | `MemoryGrantInfo[]` | RunView / SessionView chips |
| `memory:setPaused` | `{ paused }` | `MemoryOverview` | "Pause agent writes" |
| `memory:export` | `{ scope }` | `{ path } \| null` | native save dialog, JSONL (`record`: entity/fact/relation, with provenance) |

Every response string that may hold agent text passes through `vault.redact` in main. Requests are zod-validated in
`ipcSchemas.ts` with the MEMORY.md §4.2 limits.

### 11.6 IPC: events (`EventMap` + `EVENT_NAMES`)
| Event | Payload | When |
|---|---|---|
| `memory:changed` | `MemoryChangedEvent` | main's 1 s `PRAGMA data_version` poll saw new `mem_event` rows from a server process, or a page write committed (handlers flush immediately). New agent facts that contain a vault value are moved to `pending` with the text redacted before the event. Renderer refetches, debounced 250 ms. |

`UiCommand` gains nothing: `{kind:'navigate', view:'memory'}`. App menu: View > Memory ⌘7.

### 11.7 Ownership (memory feature)
| Area | Owner |
|---|---|
| `src/shared/memory.ts` and the §11.3/§11.4 additions to `types.ts`, `ipc.ts` and `engine.ts` | Backend lands them first (`contract: memory`). Co-owned afterwards. |
| `src/main/memory/**` (schema, db, store, search, screen, service, `server/**`), `src/main/handlers/memory.ts`, `ipcSchemas.ts`, `index.ts` wiring, `sessions.ts` (session grants), `menu.ts` (⌘7), `electron.vite.config.ts` (second entry), `package.json` (`d3-force` 3.0.0, `@types/d3-force` 3.0.10), `scripts/verify-memory-mcp.cjs` | Backend |
| `src/main/engine/**`: adapter `mcpAttach` and the `MCP_VERIFIED` gates, executor grant/brief/release, `interactiveSpawn` pass-through, validation rules, readable `mcp__hivemem__*` chunks, codex and gemini spikes | AI engineer |
| `src/renderer/**`: `views/MemoryView.tsx`, `components/memory/**`, `lib/memoryLayout.ts`, store slice, Sidebar row and palette, WorkflowEditor memory control and `lib/workflow.ts` mirror, RunView, SessionView and Settings chips | Frontend |

## 12. Live agents

Design and rationale: `docs/LIVE.md` (binding for F1–F5). This section is the interface. All edits are add-only.
The LIVE.md **PO amendments A1–A10** apply here too (no interactive hook gate, `ask_user` headless only, idle counted only
while unseen, no stuck asks, MCP timeout env, one subagent one node, quiet notifications, scope cuts, guarded PTY replies,
memory default).
It **supersedes CONTRACT E5 and §5.4 for claude, gemini and cursor headless argv**, and it removes the "set bypass"
failure path (A8).
Strictly local: per-spawn files under `<userData>/live/<ownerId>/`, the child's stdio, and the existing `hivemem` stdio
MCP server. No listeners. No edits to `~/.claude`, `~/.gemini` or `~/.cursor`.

### 12.1 Shared types: `src/shared/live.ts` (new, normative)
```ts
export const AGENT_KINDS = ['session', 'step', 'subagent'] as const
export const AGENT_STATUSES = ['starting', 'working', 'needs_you', 'idle', 'done', 'failed', 'canceled'] as const
export const ASK_KINDS = ['permission', 'question', 'trust'] as const
export const ASK_CHANNELS = ['stdio', 'hook_gate', 'mcp', 'pty', 'acp'] as const
export type AgentKind = (typeof AGENT_KINDS)[number]
export type AgentStatus = (typeof AGENT_STATUSES)[number]
export type AskKind = (typeof ASK_KINDS)[number]
export type AskChannel = (typeof ASK_CHANNELS)[number]
export type NeedsKind = AskKind | 'idle'
export type Attribution = 'exact' | 'timing' | 'completion'

export interface ModelUsage { tokensIn: number; tokensOut: number; costUsd: number | null }
export interface AgentNode {
  id: Id; kind: AgentKind; parentId: Id | null; rootId: Id
  sessionId: Id | null; runId: Id | null; stepId: Id | null
  provider: AdapterId; repoId: Id | null; cwd: string
  title: string; agentType: string | null; externalId: string | null; toolUseId: string | null; model: string | null
  depth: number; background: boolean; attribution: Attribution
  status: AgentStatus; needs: NeedsKind | null; activity: string | null; lastTool: string | null
  toolCount: number; memReads: number; filesTouched: string[]
  tokensIn: number | null; tokensOut: number | null; costUsd: number | null
  modelUsage: Record<string, ModelUsage> | null
  report: string | null
  seen?: boolean             // A3: idle session root whose pane was seen; not counted as Needs you (persisted)
  startedAt: ISODate; updatedAt: ISODate; endedAt: ISODate | null
}
export interface AgentEvent {
  seq: number; agentId: Id; ts: ISODate
  kind: 'tool' | 'text' | 'thinking' | 'status' | 'ask' | 'answer' | 'error'
  toolUseId: string | null; name: string | null
  summary: string            // <= 200 chars
  detail: string | null      // <= 4 KB, redacted
  state: 'running' | 'ok' | 'error' | 'denied' | null
}
export interface AskOption { id: string; label: string; kind: 'allow' | 'allow_always' | 'allow_step' | 'deny' | 'choice' | 'focus' }
// 'allow_always' stays in the type for shape compatibility but is never offered (A1).
export interface Ask {
  id: Id; agentId: Id; rootId: Id; sessionId: Id | null; runId: Id | null; stepId: Id | null
  provider: AdapterId; kind: AskKind; channel: AskChannel
  title: string; detail: string | null; toolName: string | null; toolInput: unknown | null; question: string | null
  options: AskOption[]
  status: 'open' | 'answered' | 'expired' | 'canceled'
  answer: AskAnswer | null; answeredVia: 'hive' | 'terminal' | 'timeout' | null
  createdAt: ISODate; answeredAt: ISODate | null; expiresAt: ISODate | null
}
export interface AskAnswer { askId: Id; optionId?: string; text?: string; message?: string }
export interface AgentListQuery {
  status?: AgentStatus[]; runId?: Id; sessionId?: Id; rootsOnly?: boolean
  since?: ISODate          // include agents ended at/after since (with any status filter OR'ed for live ones)
  limit?: number           // default 200, max 1000
}
export interface AgentDetail { agent: AgentNode; descendants: AgentNode[]; events: AgentEvent[]; asks: Ask[] }

export interface RunCard {
  run: Run; durationMs: number | null; costUsd: number | null; tokens: { in: number; out: number } | null
  filesChanged: number; files: string[]; artifacts: Artifact[]
  failedStep: { stepId: Id; nodeId: string; error: string | null } | null
}
export interface LearnedFact { fact: MemoryFact; entityName: string; repoName: string | null; runId: Id | null; runTitle: string | null }
export interface ActivityDay {
  date: string             // YYYY-MM-DD, local
  runs: number; passed: number; failed: number
  tokens: number; costUsd: number | null
  byModel: { model: string; tokens: number; costUsd: number | null }[]
}
export interface ComingUp { scheduleId: Id; name: string; at: ISODate; sentence: string }
export interface DashboardData {
  since: ISODate; lastSeenAt: ISODate | null; status: StatusSnapshot
  needsYou: { asks: Ask[]; idle: AgentNode[] }
  done: RunCard[]                         // <= 20
  learned: LearnedFact[]                  // <= 10
  activity: { days: ActivityDay[]; successRate: number | null }   // 14 days
  live: AgentNode[]                       // live roots + descendants
  comingUp: ComingUp[]                    // <= 5
  morningBrief: Artifact | null
}
```

### 12.2 Additions to existing shared types (add-only)
```ts
// types.ts
ID_PREFIX: { /* … */ agent: 'ag', ask: 'ask' }
interface StatusSnapshot { /* … */ needsYou?: number }             // open asks + UNSEEN idle live session roots (A3); main always sets it
interface CanvasSnapshot { /* … */ agents?: AgentNode[] }          // <= 400
interface Schedule { /* … */ skipSlotAt?: ISODate | null }
type ScheduleEventKind = /* … */ | 'skipped'
type EngineEvent = /* … */
  | { type: 'agent.updated'; agent: AgentNode }
  | { type: 'agent.events'; agentId: Id; events: AgentEvent[] }
  | { type: 'ask.updated'; ask: Ask }
// memory.ts
interface MemoryGrantInfo { /* … */ reads?: number }
interface MemoryScopeFilter { /* … */ sessionId?: Id }
// ipc.ts
type View = /* … */ | 'agents'
type UiCommand = /* … */ | { kind: 'focusAgent'; agentId: Id } | { kind: 'nextNeedsYou' }
```
Settings default change (no new key): `sessionMemory` defaults to `'read-write'`.

### 12.3 Engine boundary (`src/shared/engine.ts`, add-only)
- `EngineContext.live?: LiveBridge`, where `LiveBridge.open({stepId, runId} | {sessionId}) → LiveChannel
  {dir, hookCommand, mcpEnv, onLine(cb), writeAnswer(gateId, payload), close()}` (LIVE.md §5). No `setMode` / `mode`
  file (A1).
- `InteractiveSpawnOptions.live?: {dir, hookCommand, mcpEnv} | null`.
- `MemoryBridge.askOnlyServer(): McpServerSpec`.
- `EngineStore` adds (declared optional `?` so older fakes still compile; main implements all of them):
  - `insertAgent`, `updateAgent`;
  - `appendAgentEvents`, `updateAgentEvent`;
  - `insertAsk` (accepts `gateId`), `updateAsk`, `listOpenAsks`;
  - `setScheduleFireState` also accepts `skipSlotAt`.
- `Engine` adds `asks?.answer(id, a) → Ask` (run-owned asks; `conflict` if not open) and `scheduler.skipNext?(id) →
  Schedule`. Main answers `internal` "not available yet" while the engine lacks them.
- `src/main/engine/index.ts` also exports the pure helpers main uses for sessions: `createAgentTracker`, `normalizeHook`,
  `detectPtyPrompt`, `ptyReplyKeys`, `summarizeTool`, `HOOKS_VERIFIED`, `LIVE_HOOKS`.
- The engine coalesces `agent.updated` (150 ms) and `agent.events` (100 ms) per agent, and emits after persisting.

### 12.4 Headless argv (supersedes E5 / §5.4 for these adapters)
- **claude**: `-p --input-format stream-json --output-format stream-json --verbose [--mcp-config F --allowedTools …,mcp__hivemem__ask_user] (--session-id|--resume) U [--model M] (--dangerously-skip-permissions | --permission-mode default --permission-prompt-tool stdio) --append-system-prompt <hint> [...extra]`.
  - `--append-system-prompt` is sent only with `--session-id`. A `--resume` turn (check retry, interactive Restart, Open
    as session) omits it, interactive too: the conversation already ran under the hint, `ARTIFACTS_DIR` is still in the
    env, and the memory brief is never repeated on resume.
  - The prompt goes on stdin as a stream-json user message, after the `initialize` control request.
  - Stdin closes after a `result` once no background tasks remain. The step ends on **process exit**.
  - Output = the last non-empty `result`. Cost = max `total_cost_usd`.
  - Spawn env adds `MCP_TOOL_TIMEOUT=3700000` (per spawn, never global config) so a blocking `ask_user` outlives the
    client's MCP timeout (A5).
- **gemini**: `-o stream-json [--yolo | --approval-mode default] [-m M] [...extra] -p <hint+prompt>`, plus env
  `GEMINI_CLI_SYSTEM_SETTINGS_PATH` (one merged file: hooks plus hivemem). `canResume` unchanged; no `--session-id` (A8).
- **cursor**: `-p --output-format stream-json [--force] [--model M] --plugin-dir <liveDir>/cursor-plugin [--approve-mcps] [...extra] <hint+prompt>`.
  `canResume` unchanged; no `create-chat` / `--resume` (A8).
- **Blocking hook gates** (gemini, cursor) and `--force`/`yolo` for `default`-permission profiles apply only when
  `HOOKS_VERIFIED[adapter]` is true. Today only claude is verified.
- **Interactive** claude adds `--settings <liveDir>/claude-settings.json` with observational (async) hooks only: no
  blocking `PermissionRequest` gate (A1). Interactive permission asks are channel `pty`; Allow/Deny are written to the
  PTY as keys only after main re-detects the prompt on the current screen (A9). gemini and cursor add the same
  observational injection as headless.

### 12.5 Persistence
`hive.db` schema v2 (`SCHEMA_VERSION = 2`; v1 → v2 migration in `openDatabase`):
- new tables `agents`, `agent_events` (≤ 500 per agent) and `asks`;
- `schedules.skip_slot_at`;
- `schedule_events.kind` gains `'skipped'` (table rebuild);
- `meta.home_last_seen_at`.

DDL is in LIVE.md §2. Writers: the engine for run-owned rows (via EngineStore); main for session-owned rows.

**Boot recovery:**
- live agents → `failed` ("Hive quit");
- open asks → `canceled`;
- `<userData>/live/` is swept.

**Root end (A4a):** when a root reaches `done | failed | canceled` (session PTY exit, step process exit), every open ask
in its tree becomes `canceled` at once. `agents.seen` (INTEGER 0/1) persists the A3 seen-state.

Retention: events 30 days after an agent ends; agent rows 90 days.

### 12.6 IPC
| Channel | Request | Response | Notes |
|---|---|---|---|
| `agents:list` | `AgentListQuery` | `AgentNode[]` | hub, canvas, run view |
| `agents:get` | `{id, eventsLimit?}` | `AgentDetail` | events newest 200 by default |
| `agents:events` | `{agentId, beforeSeq?, limit?}` | `AgentEvent[]` | paging older events |
| `agents:reply` | `{agentId, text}` | `V` | live session root with `needs='idle'`: PTY write `text`, then `'\r'` (separate write); otherwise `conflict` |
| `asks:list` | `{status?: 'open'\|'all', runId?, sessionId?, limit?}` | `Ask[]` | default open, oldest first |
| `asks:answer` | `AskAnswer` | `Ask` | run asks → `engine.asks.answer`; session asks → main (guarded PTY keys, A9). `conflict` if not open, or "The prompt changed; open the terminal" when the prompt is gone (the ask resolves `answered/terminal`); `bad_request` for an option not offered or a `focus` option |
| `app:dashboard` | `{since?}` | `DashboardData` | since = arg ?? `home_last_seen_at` ?? now-24 h, clamped ≥ now-7 d |
| `app:markSeen` | V | V | sets `home_last_seen_at = now` |
| `schedules:skipNext` | `{id}` | `Schedule` | skips the next slot; logs `skipped` |

| Send | Payload | Notes |
|---|---|---|
| `ui:visibleOwner` | `{sessionId?: Id \| null; runId?: Id \| null}` | what the user is looking at. Suppresses notifications for it, and (A3) marks an idle session `seen` once its pane is visible with the window focused. No gate mode (A1). |

| Event | Payload | When |
|---|---|---|
| `agent:updated` | `AgentNode` | any agent row change (coalesced 150 ms) |
| `agent:events` | `{agentId, events: AgentEvent[]}` | new or updated events (coalesced 100 ms) |
| `ask:updated` | `Ask` | ask opened, answered, expired or canceled |

**Lists and validation.**
- Add the invoke channels to `InvokeMap` + `INVOKE_CHANNELS`, the send to `SEND_CHANNELS`, and the events to `EVENT_NAMES`.
- zod-validate every request in `ipcSchemas.ts`: `text` ≤ 8 KB, `message` ≤ 2 KB, `limit` ≤ 1000.
- Every agent or ask string crossing IPC has already been redacted when it was persisted.

### 12.7 hivemem additions
- **`ask_user`.** Tool `ask_user {question, options?, allow_text?}`, listed when `HIVE_LIVE_DIR` is set.
  - It blocks on `<HIVE_LIVE_DIR>/answers/<gateId>.json` (≤ 3600 s) and returns `{answer}`.
  - On timeout or cancel it returns `{answer:null, note}`.
- **Async.** `callTool` may be async, and `ping` is still answered while an ask waits.
- **`server/discover`** is answered with `{}`.
- **Lazy DB.** The server opens `memory.db` only on the first memory tool call.
- **Attachment.** hivemem is attached to every **headless** claude step (A2). With memory off, `HIVE_MEM_GRANT` is empty,
  only `ask_user` is listed and `memory.db` is never opened. Interactive sessions attach hivemem only when memory is on,
  without `HIVE_LIVE_DIR` (no `ask_user`).
- **Cancel (A4c).** On `notifications/cancelled` for a pending `ask_user` the server appends
  `{"hive":"ask_user_cancelled","gate_id"}` and sends no response; Hive marks the ask `canceled`. stdin EOF cancels
  every pending ask the same way.

### 12.8 Notifications, tray, badge
- **Native notification** per new permission, question or trust ask, unless the window is focused and its owner is the
  visible owner. A7: at most one per root per 30 s ("n things need you" for a burst); none for an ask resolved within
  3 s; expired / auto-denied asks grouped into one notification per run.
- **Idle** notifications only when the window is unfocused and the turn took ≥ 20 s, at most 1 per session per 60 s;
  idle counts toward badge/tray/dock only while unseen (A3).
- **Click** → `ui:command {kind:'focusAgent'}`.
- **Tray** title adds `⚑ k`. The tray menu gets a "Needs you" section with up to 5 rows.
- **Dock badge** = `needsYou`.
- **App menu**: View > Agents ⇧⌘A; Go > Next Needs You ⌘J.

### 12.9 Ownership (live feature)
See LIVE.md §12.
- **Backend:** `src/shared/live.ts` and the shared additions (landed first, `contract: live`), the DB v2 migration,
  `src/main/live/**` (hook script entry, bridge, tailer, sessionLive, asks broker, dashboard), hivemem `ask_user`,
  handlers, preload lists, tray/menu/notify, `scripts/verify-live-hooks.cjs`.
- **AI engineer:** `src/main/engine/**`: parsers (claude fixes, gemini, cursor), `live/` (tracker, hooks, summary, pty,
  claudeControl), adapters and `hooksAttach`, process stdin + pausable timeout, executor asks/pause/resume, scheduler
  `skipNext`, fixture tests.
- **Frontend:** `src/renderer/**`: Agents hub, ask/reply components, RunView tree, Canvas child pills, SessionView
  banner, memory chip, new-node memory defaults, Home dashboard, `--status-needs` token.

## 13. Usage limits, Stalled?, spawn tagging + reaper

LANDSCAPE.md "Elon's cut" #4 and #5. Behaviour is in LIVE.md §16; this section is the interface. Add-only, strictly
local (only `/bin/ps`, `/usr/sbin/lsof` and kill(2); no listeners; no global CLI config edits).

### 13.1 Shared types (add-only)
```ts
// types.ts
export const STOP_REASONS = ['rate_limited'] as const
export type StopReason = (typeof STOP_REASONS)[number]
interface RunStep { /* … */ stopReason?: StopReason | null; resetAt?: ISODate | null }
interface Run {
  /* … */
  stopReason?: StopReason | null   // a step failed on a usage / rate limit
  resetAt?: ISODate | null         // latest reset among the limited steps, if the CLI said it
  retryAt?: ISODate | null         // pending one-off retry ("Retry at reset"), fired by Hive's scheduler
  retryRunId?: Id | null           // the run that retry started; a run is retried at most once this way
}
interface Settings { /* … */ autoRetryRateLimit: boolean /* default true */; stallMinutes: number /* default 10, 1..240 */ }
interface LeftoverProcess { pid: number; spawnId: string; command: string /* redacted, ≤ 300 */; cwd: string | null; startedAt: ISODate; ageMs: number }
// live.ts — AgentNode (roots)
stopReason?: StopReason | null; resetAt?: ISODate | null
retryAt?: ISODate | null        // step roots mirror run.retryAt until it fires; session roots: pending resume
stalledSince?: ISODate | null   // set while a working root shows no output and no hook line for stallMinutes
```

### 13.2 IPC
| Channel | Request | Response | Notes |
|---|---|---|---|
| `runs:retryAt` | `{id, when: 'reset' \| 'cancel'}` | `Run` | `reset`: `retryAt = resetAt + 1 min` (never in the past; unknown reset = now + 1 h). `conflict` while the run is active or once its retry fired. |
| `sessions:retry` | `{id, when: 'now' \| 'reset' \| 'cancel'}` | `V` | live rate-limited session: `now` types `continue` then Return (separate writes); `reset` does that at `resetAt + 1 min` (the root carries `retryAt`); `cancel` drops it. `conflict` when the session ended (or, for `reset`, is not limited). |
| `processes:leftovers` | V | `LeftoverProcess[]` | tagged processes of this userData whose owner is not live; never killed on their own |
| `processes:stop` | `{pids: number[]}` (1..500) | `{stopped}` | re-verified as leftovers first, then their whole trees (SIGTERM, SIGKILL after 1.5 s) |

| Event | Payload | When |
|---|---|---|
| `processes:changed` | `LeftoverProcess[]` | launch scan, after Stop / Stop all |

`settings:update` accepts `autoRetryRateLimit` (boolean) and `stallMinutes` (integer 1..240).

### 13.3 Engine boundary (`src/shared/engine.ts`, add-only)
- `EngineContext.reaper?: ProcessReaper` — main creates one `Reaper` (exported by `src/main/engine/index.ts`) and shares
  it with the engine; absent = group kill only (tests, older main).
- `ProcessReaper`: `userData`, `tag(spawnId)`, `register(spawnId, rootPid)`, `collect(spawnId, rootPids?)`,
  `reap(spawnId, {rootPids?, pre?})`, `reapAllSync()`, `leftovers(live)`, `stopLeftovers(pids, live)`.
- `InteractiveSpawnOptions.spawnTag?` — env the session's hivemem child gets.
- `EngineStore.listRetries?()` — runs with `retry_at` set and `retry_run_id` null.
- `Engine.runs.retryAt?(id, at | null) → Run`, `Engine.runs.liveSpawnIds?() → string[]` (running step ids).
- `src/main/engine/index.ts` also exports `classifyLimitText`, `classifyStopFailure`, `classifyStreamLine`,
  `parseResetTime`, `StallMonitor`, `stallThresholdMs`, `Reaper`, `collectTree`, `findLeftovers`, `retryTime`.

### 13.4 Spawn tagging
- Every step spawn and every PTY session gets `HIVE_SPAWN_ID=<step id | session id>` and `HIVE_USER_DATA=<userData>`
  (merged last). The hivemem MCP child the CLI starts gets the same two vars in its server env.
- Own process group: steps spawn `detached` (pgid = pid); node-pty sessions `setsid`.
- A process is "ours" only when its env carries `HIVE_SPAWN_ID` **and** this exact `HIVE_USER_DATA`, so a second Hive
  (another userData) is never touched. macOS hides the env of platform binaries (`/bin/sleep`, `/bin/zsh`) from
  `ps -E`; those are found through their process group and parent chain instead (LIVE.md §16.3).

### 13.5 Persistence
No version bump (`SCHEMA_VERSION` stays 2, so an older Hive still opens the db). `openDatabase` heals these nullable
columns idempotently on every open: `runs.stop_reason, reset_at, retry_at, retry_run_id`; `run_steps.stop_reason,
reset_at`; `agents.stop_reason, reset_at, retry_at, stalled_since`; index `runs_retry`. Boot recovery clears
`agents.stalled_since` everywhere and `agents.retry_at` of session roots (a pane's resume dies with the pane); a run's
retry survives restarts and catch-up fires it (dropped when found more than 12 h late).

### 13.6 Notifications
- Rate-limited run: one notification for the run ("<title> hit the usage limit", "Resets 15:00 · retry scheduled
  15:01"), instead of the failure notification, however many steps hit the limit.
- Rate-limited session: one per episode (until the user types, a new turn starts, or the pane exits).
- Stalled?: one per stall episode per root. Hive never kills a stalled agent.

### 13.7 Ownership
Engine: `live/limits.ts`, `live/stall.ts`, `reaper.ts`, executor / process / scheduler wiring. Main: `sessions.ts`,
`live/sessionLive.ts`, `hive.ts`, handlers, schema heal. Renderer: `components/agents/LimitBits.tsx` and the badges,
banners and lists in the hub, Home, Canvas, Sidebar, Run, Session and Settings views.


## 14. Authoring

Design and rationale: `docs/AUTHORING.md` (binding for A1–A3). This section is the interface. All edits are add-only.
**Updated to the PO amendments (PO1–PO10)** as built by Backend on 2026-10-16: no `hive_schedule_create` (PO2), no
headless attach / step owners / `author_wait`/`author_done` (PO1), claude only (PO7), run grants pinned to a content
hash (PO3). Where AUTHORING.md's body still shows the old shapes, the PO block and this section win.
Strictly local: the new `hive` stdio MCP server talks to main only through the owner's live dir mailbox
(`<userData>/live/<ownerId>/events.jsonl` + `answers/`); no listeners; no edits to `~/.claude`, `~/.gemini`,
`~/.cursor`; `~/.claude/projects/**` is read-only. Agents can never reach `secrets:*`, `settings:*`, `profiles:*` or repo
mutations: the broker dispatches only the tools listed in §14.1.

### 14.1 `hive` MCP server
- Entry `src/main/author/server/main.ts` → `out/main/mcp-hive.js` (4th electron-vite main entry, runs from `app.asar`).
  Spawned per agent with `command = process.execPath`, `args = [<main dir>/mcp-hive.js]`,
  `env = { ELECTRON_RUN_AS_NODE: '1', HIVE_LIVE_DIR, HIVE_SPAWN_ID, HIVE_USER_DATA }`. Opens no database.
- Tools (`AUTHOR_TOOLS` in `src/shared/authoring.ts`; JSON schemas in `src/main/author/server/tools.ts`):
  `hive_workflow_schema`, `hive_repos_list`, `hive_profiles_list`, `hive_workflow_list`, `hive_workflow_get`,
  `hive_workflow_validate` (read); `hive_workflow_create {workflow, summary, schedule?, run_now?, wait_s?}`,
  `hive_workflow_update {id, workflow, summary, schedule?, run_now?, wait_s?}` (approval always; PO2: one card, one click
  saves + schedules + starts the run); `hive_workflow_run {workflow_id, inputs?, reason?, wait_s?}` (approval unless a
  standing permission applies, PO3); `hive_draft_status`, `hive_run_get` (read, may wait). `hive_schedule_create` does
  not exist (PO2): scheduling an existing workflow = `hive_workflow_update` with the unchanged workflow + `schedule`.
  `schedule = {name?, when: {kind:'cron', cron, tz?} | {kind:'at', at}, inputs?}` (tz defaults to the Mac's zone; checked
  with `scheduler.preview` before the card opens). Write results: `approved {draft_id, workflow_id, edited, run_allowed,
  note, schedule_id?, sentence?, run_id?} | rejected {draft_id, note} | pending {draft_id} | expired | invalid {errors,
  warnings}`; runs: `started {run_id, approved_by: 'user'|'standing_permission'} | conflict` (max 3 active agent runs per owner).
- Mailbox: server appends `{"hive":"author_call","call_id":"hac_…","tool","args","agent_hint"}` and waits on
  `answers/<call_id>.json` = `{ok:true,result} | {ok:false,error}`; cancel appends `{"hive":"author_cancelled","call_id"}`.
  Main's LiveBridge (`LiveBridgeDeps.onAuthor`) intercepts these lines (never delivered to channel callbacks) and
  identifies the caller **only** by the channel's `LiveOwner`; a step owner is refused (PO1). Owner key =
  `<adapter>:<agentSessionId>` (survives Restart), else `session:<sessionId>`. Rate limits: 60 calls/min, 5 pending
  drafts per owner. No synthetic `author_wait`/`author_done` lines (PO1).
- Attachment (PO1, PO7): **interactive claude sessions only**. Headless steps and codex/gemini/cursor get no `hive`
  server. `InteractiveSpawnOptions.author` (+ `authorTools`, `authorSpawnDir` = the session's own live dir, so the
  config naming that live dir is never shared). claude: one per-spawn `--mcp-config` file holding `hivemem` (when
  granted) and `hive`; `--allowedTools` adds `mcp__hive__<tool>` for all tools; env `MCP_TOOL_TIMEOUT=3700000`.
  hivemem's `ask_user` stays headless-only (LIVE.md A2). Verified with a real `claude -p` (2.1.301):
  `scripts/verify-hive-mcp.cjs --claude` (`npm run verify:hive`).

### 14.2 Shared types (add-only)
```ts
// types.ts
export type NodeType = 'agent' | 'room' | 'check' | 'shell' | 'wait' | 'notify'
interface NodeBase { /* … */ isolate?: 'worktree' | null }
export interface WaitNode extends NodeBase {
  type: 'wait'; command: string; until: 'exit0' | 'match'; pattern: string | null
  intervalSec: number /* 5..3600 */; onTimeout: 'fail' | 'continue'
}
export interface NotifyNode extends NodeBase { type: 'notify'; title: string; message: string; imessage: boolean }
export type WorkflowNode = AgentNode | RoomNode | CheckNode | ShellNode | WaitNode | NotifyNode
export interface WorkflowWorktree { repo: string /* repo id | template */; base?: string | null }
interface WorkflowDraft { /* … */ worktree?: WorkflowWorktree | null }
interface Workflow { /* … */ origin?: WorkflowOrigin | null }      // not exported in WorkflowFile
export interface WorkflowOrigin {
  kind: 'agent'; adapter: AdapterId; ownerLabel: string; ownerKey: string
  sessionId: Id | null; runId: Id | null; stepId: Id | null; draftId: Id; approvedAt: ISODate; edited: boolean
  updatedBy?: { draftId: Id; ownerLabel: string; at: ISODate }[]
}
export type RunTrigger = 'manual' | 'schedule' | 'catchup' | 'rerun' | 'agent'
interface Run {
  /* … */
  outcome?: 'nothing_to_do' | null          // status 'passed' + a step emitted HIVE_STOP
  worktree?: RunWorktree | null
  startedBy?: { ownerLabel: string; ownerKey: string; draftId: Id | null } | null
}
interface RunStep { /* … */ halt?: string | null }
export interface RunWorktree {
  id: Id; runId: Id; repoId: Id | null; repoPath: string; path: string; branch: string; base: string
  status: 'creating' | 'active' | 'kept' | 'removed' | 'error'
  keptReason: 'pushed' | 'failed' | 'dirty' | 'canceled' | null; error: string | null
  createdAt: ISODate; removedAt: ISODate | null
}
interface Settings { /* … */ imessageHandle: string /* default '' */; claudeHistory: boolean /* default true */ }
ID_PREFIX: { /* … */ authorDraft: 'adr', worktree: 'wt', authorCall: 'hac' }

// live.ts
ASK_KINDS += 'approval'; ASK_CHANNELS += 'author'; interface Ask { /* … */ draftId?: Id | null }
// approval options: [{id:'approve', label: approveLabel(...) /* PO2: "Approve & schedule"… */, kind:'allow'}, {id:'reject', kind:'deny'}]

// authoring.ts (new): AuthorDraftKind, AuthorDraftStatus, AuthorFlags, AuthorDraft, AuthorDraftDetail, AuthorRunGrant,
// ClaudeHistorySession, ClaudeTranscriptEntry, ClaudeTranscript (shapes: AUTHORING.md §9), plus pure helpers
// normalizeAuthoredDraft, authorFlags, AUTHORING_SCHEMA, EXAMPLES.
```
`WorkflowInput.type` += `'boolean'` (value `'true'|'false'`, `src/shared/inputs.ts`; AUTHORING.md PO15). Step env adds
`HIVE_DRY_RUN` (`1` when a boolean `dry_run` input is true, else `0`) for workflow runs. `WorktreeBridge.ensure` req +=
`dryRun?: boolean`.
Templates add `{{WORKTREE_DIR}}` and `{{WORKTREE_BRANCH}}`. Step env adds `HIVE_WORKTREE`, `HIVE_WORKTREE_BRANCH` in
isolated nodes. Validation rules: AUTHORING.md §4.

### 14.3 Engine boundary (`src/shared/engine.ts`, add-only)
```ts
export interface WorktreeBridge {
  ensure(req: { runId: Id; workflowName: string; repo: string; base: string | null }): Promise<RunWorktree>
  finish(runId: Id, outcome: { status: RunStatus; nothingToDo: boolean }): Promise<RunWorktree | null>
}
export interface NotifyBridge {
  send(req: { runId: Id; stepId: Id; title: string; message: string; imessage: boolean }): Promise<NotifyResult>
}
export interface NotifyResult { notified: boolean; imessage: 'sent' | 'skipped' | 'failed' | 'not_requested'; note: string | null }
// WorktreeBridge also has guardEnv?(runId): Record<string,string> (PO5: GIT_CONFIG_COUNT/KEY_0/VALUE_0 -> core.hooksPath
// = <userData>/git-hooks/<runId>, + HIVE_WORKTREE*); merged last into every isolated node's env.
// No AuthorBridge (PO1: the engine never attaches `hive` to headless steps). McpServerSpec.name: 'hivemem' | 'hive'.
interface EngineContext { /* … */ worktrees?: WorktreeBridge; notifier?: NotifyBridge }
interface InteractiveSpawnOptions { /* … */ author?: McpServerSpec | null; authorTools?: string[]; authorSpawnDir?: string }
interface StartRunOptions { /* … */ startedBy?: { ownerLabel: string; ownerKey: string; draftId: Id | null } | null }  // trigger 'agent'
```
- stop-if: an `agent`, `shell` or `wait` step that ends passed with last non-empty output line
  `HIVE_STOP: <reason>` ends the run: step `halt` set; other running steps killed → `skipped`; no new nodes; run
  `passed` + `outcome 'nothing_to_do'`, `reason = '<node>: <halt>'`. Main never notifies for it.
- Worktree: `ensure` before the first `isolate:'worktree'` node (shared by all), `finish` on every run end. Branch
  `hive/<slug>-<runId>` created `--no-track` off `origin/<default>` (fetched; offline falls back to local). Keep rules
  (PO6, by work done in this run = commits with committer date after `ensure` not reachable from the recorded base
  sha): failed / canceled → kept; such a commit on a remote-tracking ref → kept `pushed`; uncommitted changes or such
  commits on no remote → kept `dirty`; else removed + every branch created during the run with no unpushed commit is
  deleted. Never runs checkout/reset/stash/clean/pull in the repo's own working tree; never writes its config/hooks.
- wait / notify: AUTHORING.md §7. Both persist steps with `adapter 'shell'`.

### 14.4 Persistence
`SCHEMA_VERSION` stays 2. `openDatabase` creates `author_drafts`, `author_run_grants (workflow_id, owner_key,
owner_label, content_hash, created_at)` (PO3: a grant applies only while the saved workflow hashes to `content_hash`),
`worktrees`, `claude_history` (IF NOT EXISTS) and heals `workflows.origin_json`, `workflows.worktree_json`,
`runs.outcome`, `runs.worktree_id`, `runs.started_by_json`, `run_steps.halt`, `run_steps.node_type_ext`, `asks.draft_id`.
Old CHECK constraints are not rebuilt; values they reject are stored compatibly and widened by the mappers:
`trigger 'agent'` → `'manual'` + `started_by_json`; `node_type 'wait'|'notify'` → `'shell'` + `node_type_ext`; ask
`'approval'/'author'` → `'question'/'mcp'` + `draft_id`. Approval asks stay open across session exit and boot recovery
(the draft is the source of truth); pending drafts expire after 7 days, decided ones are deleted after 90.
`worktrees.status 'creating'` → `error` and `'active'` → kept `failed` at boot; `git worktree prune` at most daily.

### 14.5 IPC
| Channel | Request | Response | Notes |
|---|---|---|---|
| `author:list` | `{status?: AuthorDraftStatus[]; limit?}` | `AuthorDraft[]` | newest first (default pending) |
| `author:get` | `{id}` | `AuthorDraftDetail` | card payload (draft, base, diff, flags incl. `shellInputs`, `unattended` (PO8), `imessageHandleMissing`; `scheduleRequest`, `runNow` (PO2)) |
| `author:decide` | `{id; decision: 'approve' \| 'reject'; note?: string; allowRun?: boolean; draft?: WorkflowDraft}` | `AuthorDraft` | `draft` = edited version from the editor (create/update only). `conflict` if not pending; `validation` if the (edited) draft is invalid (draft stays pending). Answers the approval Ask and the waiting tool call. |
| `author:grants` | V | `AuthorRunGrant[]` | standing run permissions (`contentHash`, `active: false` once the workflow changed) |
| `author:revokeRun` | `{workflowId; ownerKey}` | V | |
| `worktrees:list` | `{status?: RunWorktree['status'][]}` | `RunWorktree[]` | |
| `worktrees:remove` | `{id}` | `RunWorktree` | `git worktree remove --force` + delete Hive's own `hive/…` branch when it has no upstream |
| `notify:testIMessage` | V | `NotifyResult` | sends "Hive test message" to `settings.imessageHandle` (triggers the macOS Automation prompt) |
| `history:list` | `{query?; repoId?; since?; includeInHive?; limit?}` | `{items: ClaudeHistorySession[]; total; indexing: boolean}` | default last 7 days, excludes `inHive`, limit ≤ 500 |
| `history:get` | `{id}` | `ClaudeTranscript` | read-only preview, redacted, ≤ 300 KB |
| `history:resume` | `{id; profileId?; cols; rows}` | `Session` | `claude --resume <id>` in the transcript's cwd; `not_found` if the folder is gone |

`asks:answer` on an `approval` ask maps `optionId` + `message` to `author:decide`. Approving with `allowRun` (re)creates
the grant pinned to the saved workflow's hash, only when the workflow's `origin.ownerKey` is the asking owner. A
pre-allowed run that passes a non-default value to an input referenced in a shell/wait/check command gets a card (PO3).

| Event | Payload | When |
|---|---|---|
| `author:updated` | `AuthorDraft` | draft created, decided, expired |
| `worktree:updated` | `RunWorktree` | created, kept, removed, error |
| `history:changed` | `{total}` | index queue drained (debounced 1 s) |

`UiCommand` += `{kind:'openApproval'; draftId: Id}`. `settings:update` accepts `imessageHandle` (≤ 120 chars, phone
or email, or '') and `claudeHistory` (boolean). Add every channel to `InvokeMap` + `INVOKE_CHANNELS`, events to
`EVENT_NAMES`, zod schemas in `ipcSchemas.ts` (note ≤ 2 KB; draft ≤ 256 KB).

### 14.6 Notifications
- Approval asks follow §12.8 (A7 coalescing, suppressed for the visible owner); click → `openApproval`.
- Runs with `outcome 'nothing_to_do'`: never notified.
- Notify nodes: always post (ignore `notifyOnSuccess`, honor `notificationSound`); iMessage via `osascript` with values
  passed as argv; first iMessage use posts a one-time explainer about the macOS Automation permission.

### 14.7 Ownership
AUTHORING.md §11. Backend: `src/shared/authoring.ts` + shared additions (first, `contract: authoring`), `src/main/author/**`
(server, broker, drafts, grants), LiveBridge interception, `worktrees.ts`, `notifyNode.ts`, `history/**`, handlers,
db heals, preload lists, session attach. AI: `src/main/engine/**` (wait/notify nodes, stop-if, worktree + notifier
wiring, combined MCP config for interactive claude only (PO1, PO7), validation, tests). Frontend: `src/renderer/**` (ApprovalCard in
pane/hub/run, provenance, wait/notify/isolate editors and canvas, nothing-to-do styling, History on Home and Canvas,
Settings for iMessage, run permissions, worktrees, history toggle).

## Slack

Design and rationale: `docs/SLACK.md` (binding, including the product-owner amendments PO-S1..PO-S10 in its §0.3). This
section is the interface as built. Amendments: SLACK.md SA1 (outbound HTTPS/WSS to `slack.com` only; still zero TCP
listeners), SA2 (headless claude steps may get the `hive` server with the `slack` toolset only), SA3 (iMessage removed).
Supersedes §14.2 `NotifyNode.imessage` / `Settings.imessageHandle`, §14.3 `NotifyBridge`/`NotifyResult`, §14.5
`notify:testIMessage`, §14.6 iMessage notes (AUTHORING.md §7.2 is superseded by SLACK.md §10 the same way).

**Removal (done in the integration commit).** `NotifyNode.imessage`, `NotifyResult.imessage`, `AuthorFlags.imessage` /
`imessageHandleMissing`, `Settings.imessageHandle` and `notify:testIMessage` are gone from the types and IPC. The only
legacy readers left are the one-time db migration (§7.2), the import path (`workflows:*` converts a legacy
`imessage: true` to `slack: {kind:'me'}`), and the executor's `notifyTarget` for old run snapshots.

### Slack.1 Shared types: `src/shared/slack.ts` (normative)
```ts
export type SlackConnState = 'disabled' | 'connecting' | 'connected' | 'reconnecting' | 'paused' | 'error'
export interface SlackStatus {
  state: SlackConnState; error: string | null
  warnings: string[]                       // missing scopes, "Another Hive is connected…" (num_connections > 1), rate-limit notice
  since: ISODate | null; nextRetryAt: ISODate | null; lastEventAt: ISODate | null
  workspace: { teamId: string; name: string; domain: string | null; botUserId: string; botName: string } | null
  tokens: { bot: string | null; app: string | null }      // masked only ("xoxb-…a1b2")
  missingScopes: string[]
  sync: { state: 'idle' | 'running' | 'error'; channelsDone: number; channelsTotal: number; threadsPending: number;
          rateLimitedUntil: ISODate | null; days: number }
  alertSuggestion: { userId: string; name: string } | null  // PO-S1: first human DM while no alert user is set
  fake?: boolean                                            // dev fake build only
}
export interface SlackTestResult { ok: boolean; botToken: 'ok' | string; appToken: 'ok' | string; socket: 'ok' | string; scopes: string[]; missingScopes: string[] }
export type SlackChannelKind = 'channel' | 'private' | 'dm' | 'group_dm'
export interface SlackChannel {              // no `hidden` (PO-S9)
  id: string; teamId: string; kind: SlackChannelKind; name: string; dmUserId: string | null
  topic: string | null; isMember: boolean; isArchived: boolean; memberCount: number | null
  lastMessageTs: string | null; unread: boolean; sync: 'pending' | 'running' | 'done' | 'error' | 'skipped'
}
export interface SlackUser { id: string; name: string; realName: string | null; displayName: string | null; isBot: boolean; deleted: boolean; avatarUrl: string | null; tz: string | null }
export interface SlackFile { name: string; mimetype: string | null; size: number | null; permalink: string | null }
export interface SlackMessage {
  teamId: string; channelId: string; ts: string; threadTs: string | null
  userId: string | null; botId: string | null; subtype: string | null
  text: string /* raw mrkdwn */; plain: string; files: SlackFile[]; reactions: { name: string; count: number }[]
  replyCount: number; latestReply: string | null; editedTs: string | null; deleted: boolean
  fromHive: boolean; isMention: boolean
}
export interface SlackMessagePage { messages: SlackMessage[]; hasMoreLocal: boolean; oldestLocalTs: string | null; backfillOldestTs: string | null }
export interface SlackThread { channel: SlackChannel; parent: SlackMessage | null; replies: SlackMessage[]; fetchedAt: ISODate | null; drafts: SlackDraft[] }
export interface SlackSearchQuery { query: string; channelId?: string; userId?: string; after?: ISODate; before?: ISODate; limit?: number /* ≤ 100 */ }
export interface SlackSearchHit { message: SlackMessage; channelName: string; snippet: string /* match wrapped in «» */ }

export type SlackDraftStatus = 'pending' | 'sending' | 'sent' | 'discarded' | 'failed' | 'expired'
export type SlackDraftReason = 'draft_mode' | 'not_allowlisted' | 'other_thread' | 'interactive' | 'auto_limit' | 'auto_paused' | 'no_trigger' | 'manual'
export interface SlackDraft {
  id: Id; status: SlackDraftStatus; channelId: string; channelName: string; threadTs: string | null
  text: string; originalText: string; edited: boolean; reason: SlackDraftReason; note: string | null
  ownerLabel: string; sessionId: Id | null; runId: Id | null; stepId: Id | null; triggerId: Id | null; askId: Id | null
  sentTs: string | null; error: string | null; createdAt: ISODate; decidedAt: ISODate | null; expiresAt: ISODate
}
export interface SlackDraftDetail { draft: SlackDraft; context: SlackMessage[] /* last 3 */; newSinceDraft: number }

export type SlackReplyMode = 'draft' | 'auto' | 'none'
// Placement is fixed (channels: the triggering thread; DMs: top-level, PO-S4); one auto-post per run is fixed (PO-S3b)
export interface SlackReplyPolicy { mode: SlackReplyMode; autoChannels: string[] /* ids + 'dm' */; replyNode: string | null }
export type SlackTriggerOn = 'mention' | 'dm' | 'message'
export interface SlackTriggerMatch { on: SlackTriggerOn[]; channels: string[]; keywords: string[]; regex: string | null; fromUsers: string[] }  // no `threads` (PO-S9)
export interface SlackTriggerLimits { debounceSec: number /* default 3 for mention/dm, 15 with message */; maxRunsPerThreadPerHour: number /* default 4, 1..30 */ }
export interface SlackTriggerInput {
  name: string; workflowId: Id; enabled?: boolean
  match: SlackTriggerMatch
  reply: Omit<SlackReplyPolicy, 'replyNode'> & { replyNode?: string | null }   // omitted = last agent node (PO-S10)
  limits?: Partial<SlackTriggerLimits>; inputs?: Record<string, string>
}
export interface SlackTrigger {
  id: Id; name: string; workflowId: Id; enabled: boolean; match: SlackTriggerMatch; reply: SlackReplyPolicy
  limits: SlackTriggerLimits; inputs: Record<string, string>; origin: WorkflowOrigin | null; createdAt: ISODate; updatedAt: ISODate
  sentence: string; lastFiredAt: ISODate | null; lastRunId: Id | null; lastRunStatus: RunStatus | null
  note?: string | null                     // "Slack disconnected" / "Connect Slack to enable"
}
export type SlackTriggerEventKind = 'fired' | 'debounced' | 'coalesced' | 'skipped_own' | 'skipped_bot' | 'skipped_limit' | 'skipped_stale' | 'skipped_paused' | 'error'
export interface SlackTriggerEvent { id: Id; triggerId: Id; kind: SlackTriggerEventKind; channelId: string | null; threadTs: string | null; ts: string | null; runId: Id | null; message: string | null; createdAt: ISODate }
export interface SlackTriggerTestResult { fires: boolean; reasons: string[]; inputs: Record<string, string> }
export interface SlackRunContext {        // persisted on the Run (runs.slack_json)
  triggerId: Id; teamId: string; channelId: string; channelName: string; channelKind: SlackChannelKind
  threadTs: string; messageTs: string[]; userId: string; userName: string; text: string; permalink: string
  isMention: boolean; isDm: boolean; catchup: boolean
}
export interface SlackInboundMessage {     // main -> engine, live only (never backfill)
  teamId: string; channelId: string; channelKind: SlackChannelKind; channelName: string
  ts: string; threadTs: string | null; userId: string | null; userName: string | null; botId: string | null
  subtype: string | null; plain: string; isMention: boolean; isDmToBot: boolean
  isOwn: boolean; fromBot: boolean; eventTime: number /* s */; receivedAt: number /* ms */
  source: 'event' | 'gapfill'; catchup: boolean
}
export type NotifySlackTarget = { kind: 'me' } | { kind: 'channel'; channel: string }
export const SLACK_TOOLS = ['slack_list_channels', 'slack_read_thread', 'slack_search', 'slack_draft_reply', 'slack_post'] as const
export const SLACK_REQUIRED_SCOPES = ['app_mentions:read', 'channels:history', 'channels:read', 'channels:join', 'groups:history',
  'groups:read', 'im:history', 'im:read', 'im:write', 'mpim:history', 'mpim:read', 'chat:write', 'users:read', 'reactions:read',
  'files:read'] as const
export const SLACK_BOT_EVENTS = ['app_mention', 'message.channels', 'message.groups', 'message.im', 'message.mpim', 'member_joined_channel'] as const
export const SLACK_AUTO_LIMITS = { perChannelPerHour: 6, perRun: 1, maxUserMentions: 3, runsPerTriggerPerHour: 30 } as const   // PO-S3, not settings
export const dmThreadKey = (channelId: string) => `dm:${channelId}`                                                          // PO-S4
export function autoModeProblem(match): string | null      // PO-S3c save rule
export const defaultDebounceSec = (on) => (on.includes('message') ? 15 : 3)                                                  // PO-S9
```

### Slack.2 Changes to existing shared types (add-only)
```ts
// types.ts
export type RunTrigger = 'manual' | 'schedule' | 'catchup' | 'rerun' | 'agent' | 'slack'
interface Run { /* … */ slack?: SlackRunContext | null }
interface WorkflowDraft { /* … */ slackTools?: boolean }          // headless claude steps get the slack toolset
interface NotifyNode { /* … */ slack?: NotifySlackTarget | null; migratedFrom?: 'imessage' | null }   // iMessage removed
interface Settings {
  slackAlertUserId?: string | null      // default null; "Send my alerts to" (only the user sets it)
  slackMirrorNeedsYou?: boolean         // default false
  slackBackfillDays?: number            // default 7, 0..90
  slackTriggerCatchupMin?: number       // default 10, 0..120
  slackAutoPaused?: boolean             // default false; PO-S3e "Pause auto-replies" (Slack page header + tray)
}
ID_PREFIX: { /* … */ slackDraft: 'sdr', slackTrigger: 'stg', slackOutbox: 'sob', slackTriggerEvent: 'ste' }
EngineEvent += { type: 'slackTrigger.updated'; trigger: SlackTrigger }

// authoring.ts
interface NotifyResult { notified: boolean; slack: 'sent' | 'skipped' | 'failed' | 'not_requested'; note: string | null }
interface AuthorFlags {
  slackAlerts?: string[] | null          // ["your Slack DM", "#eng"]
  slackAlertUserMissing?: boolean; slackNotConnected?: boolean; slackReads?: boolean
  slackTrigger?: { sentence: string; replyMode: SlackReplyMode; autoChannels: string[] } | null   // its own row on the card
}
interface AuthorDraftDetail { /* … */ slackTrigger?: SlackTriggerInput | null }

// live.ts
ASK_KINDS += 'slack_reply'; ASK_CHANNELS += 'slack'; interface Ask { /* … */ slackDraftId?: Id | null }
// slack_reply options: [{id:'send', kind:'allow', label:'Send'}, {id:'discard', kind:'deny', label:'Discard'}]; answer.message = edited text
```
Templates add `{{trigger.text|thread|channel|channel_id|ts|thread_ts|user|user_id|permalink}}` ('' outside Slack runs).
Validation: `{{trigger.*}}` in a shell/wait/check `command` is an error for every workflow; a trigger input template may
reference only `{{trigger.*}}`. Step env adds `HIVE_SLACK_CHANNEL`, `HIVE_SLACK_THREAD_TS`, `HIVE_SLACK_PERMALINK` in
Slack runs (ids only; never a token). Agent-authored notify nodes with `imessage` are `invalid` ("imessage was removed;
use slack: {"kind":"me"}").

### Slack.3 Engine boundary (`src/shared/engine.ts`)
```ts
export interface SlackBridge {
  connected(): boolean
  onMessage(cb: (m: SlackInboundMessage) => void): () => void
  threadTranscript(q: { channelId: string; threadTs: string }): string      // ≤ 50 msgs, 20,000 chars; DMs: the recent DM conversation
  permalink(channelId: string, ts: string): Promise<string>
  resolveUserName(userId: string): string
  reply(req: { runId: Id; stepId: Id | null; channelId: string; threadTs: string | null; text: string; origin: 'reply_node' }):
    Promise<{ status: 'posted' | 'drafted' | 'refused'; draftId?: Id; ts?: string; reason?: string }>   // main applies §8.2
  repliesForRun(runId: Id): number                                            // drafts + posts the run made itself
  toolServer(owner: { stepId: Id; runId: Id }): McpServerSpec | null          // `hive` with HIVE_TOOLSETS=slack, or null
  message?(q: { channelId: string; ts: string }): { userId: string | null; userName: string | null; plain: string } | null
  alert?(a: { triggerId: Id; title: string; message: string }): void
}
export interface NotifyBridge {
  send(req: { runId: Id; stepId: Id; title: string; message: string; imessage: boolean /* legacy */; slack?: NotifySlackTarget | null }): Promise<NotifyResult>
}
interface EngineContext { /* … */ slack?: SlackBridge }
interface EngineStore {   // implemented by main (db/engineStore.ts -> connectors/slack/triggerStore.ts)
  listSlackTriggers?(): SlackTrigger[]
  getSlackTriggerState?(triggerId: Id, channelId: string, threadKey: string): SlackTriggerState | null
  putSlackTriggerState?(s: SlackTriggerState): void      // an empty state (no pending, window, run, fires) is deleted
  listSlackTriggerStates?(): SlackTriggerState[]
  insertSlackTriggerEvent?(e: Omit<SlackTriggerEvent, 'id' | 'createdAt'>): SlackTriggerEvent
}
interface SlackTriggerState { triggerId: Id; channelId: string; threadKey: string /* thread_ts ?? ts; 'dm:<C>' for DMs */; pending: string[]; windowEndsAt: ISODate | null; activeRunId: Id | null; firedAt: ISODate[] }
interface StartRunOptions { /* … */ slack?: SlackRunContext | null }       // with trigger 'slack'
interface InteractiveSpawnOptions { /* … */ initialPrompt?: string | null } // claude: positional prompt (Ask an agent)
interface Engine { /* … */ slackTriggers?: { start(): void; stop(): void; reload(): void; test(t: SlackTriggerInput, sample: SlackInboundMessage): SlackTriggerTestResult } }
```
`engine.slackTriggers.start()` is called with `scheduler.start()` (honors `HIVE_NO_SCHEDULER=1`; `schedulesPaused` read
live). Main calls `reload()` after any `slackTriggers:*` write and on disconnect.

### Slack.4 Persistence
No `SCHEMA_VERSION` bump. `openDatabase` creates `connector_secrets`, `slack_workspaces`, `slack_users`,
`slack_channels` (no `hidden`), `slack_messages` (+ `slack_messages_fts` FTS5 with insert/update/delete sync triggers),
`slack_sync_state`, `slack_thread_sync`, `slack_event_log` (`event_id`, `received_at` only, PO-S8), `slack_triggers`
(+ `note`), `slack_trigger_state`, `slack_trigger_events`, `slack_drafts`, `slack_outbox` (DDL: `db/schema.ts`
`DDL_SLACK`, from SLACK.md §7.1). Healed columns: `runs.trigger_ext`, `runs.slack_json`, `asks.slack_draft_id`,
`workflows.slack_tools`, `author_drafts.slack_trigger_json`. Widening: `trigger 'slack'` → `'manual'` + `trigger_ext`;
ask `'slack_reply'/'slack'` → `'question'/'mcp'` + `slack_draft_id`. One-time `meta.slack_migrated` (in one transaction)
rewrites notify nodes (`imessage:true` → `slack:{kind:'me'}, migratedFrom:'imessage'`; false → `slack:null`) in
`workflows` and pending `author_drafts`, deletes `settings.imessageHandle` and `meta.imessage_explained`. Run snapshots
are never rewritten; the mappers (and `normalizeDraft` for saves/imports) read legacy `imessage` the same way. Slack
tokens live only in `connector_secrets` (vault Cipher; never `secrets`, never any child env) and are added to the vault
redaction table (`Vault.addRedactions/removeRedactions`, add-only). Slack draft Asks are excluded from run-end, session-end
and boot ask cancellation.

### Slack.5 IPC
| Channel | Request | Response | Notes |
|---|---|---|---|
| `slack:status` | V | `SlackStatus` | |
| `slack:manifest` | `{name?: string}` \| V | `{json: string; yaml: string; createUrl: string}` | name ≤ 35; `createUrl` pre-fills api.slack.com (PO-S1) |
| `slack:connect` | `{botToken: string; appToken: string}` | `SlackStatus` | PO-S1 one Connect button: shape check, auth.test, apps.connections.open, store, start. `validation` with `errors[].path` `botToken`/`appToken` (nothing stored); `vault_unavailable`; switching workspace asks a native confirm (`canceled` if declined). Plaintext crosses IPC only in this request |
| `slack:test` | V | `SlackTestResult` | stored tokens |
| `slack:retry` | V | `SlackStatus` | reconnect now (also after link_disabled is fixed) |
| `slack:disconnect` | `{purge: boolean}` | `SlackStatus` | renderer confirms first; triggers are disabled with note "Slack disconnected" |
| `slack:channels` | `{query?: string}` \| V | `SlackChannel[]` | |
| `slack:join` | `{channelId: string}` | `SlackChannel` | PO-S2, explicit click (`conversations.join`); starts that channel's backfill |
| `slack:joinAll` | V | `{joined: number; failed: number}` | public channels the bot is not in |
| `slack:markRead` | `{channelId: string; ts: string}` | V | Hive-local read marker |
| `slack:users` | `{query?: string; includeBots?: boolean}` \| V | `SlackUser[]` | |
| `slack:messages` | `{channelId: string; beforeTs?: string; limit?: number /* ≤ 200 */}` | `SlackMessagePage` | local mirror; the newest page also triggers an interactive freshness fetch |
| `slack:thread` | `{channelId: string; threadTs: string}` | `SlackThread` | refreshes via replies if older than 60 s (waits ≤ 3 s) |
| `slack:search` | `SlackSearchQuery` | `SlackSearchHit[]` | local FTS5 |
| `slack:backfill` | `{channelId?: string; days: number}` | `SlackStatus` | queued (background lane) |
| `slack:askAgent` | `{channelId; threadTs; profileId?; repoId?; cols; rows}` | `Session` | claude only (`adapter_unavailable` otherwise); transcript saved under `<userData>/scratch/slack/` |
| `slack:drafts` | `{status?; channelId?; threadTs?; runId?}` \| V | `SlackDraft[]` | default pending + sending + failed |
| `slack:draftGet` | `{id: Id}` | `SlackDraftDetail` | |
| `slack:draftDecide` | `{id: Id; decision: 'send' \| 'discard'; text?: string /* 1..3000 */}` | `SlackDraft` | `conflict` unless pending/failed; a failed send returns status `failed` + `error` (card keeps Retry) |
| `slack:testAlert` | V | `NotifyResult` | replaces `notify:testIMessage` |
| `slack:permalink` | `{channelId: string; ts: string}` | `{url: string}` | |
| `slackTriggers:list` | `{workflowId?: Id}` \| V | `SlackTrigger[]` | |
| `slackTriggers:create` | `SlackTriggerInput` | `SlackTrigger` | `validation` (channels, regex probe, inputs mapping, `auto` needs autoChannels, PO-S3c); created disabled with a note when Slack is not connected |
| `slackTriggers:update` | `{id: Id; input: SlackTriggerInput}` | `SlackTrigger` | |
| `slackTriggers:remove` | `{id: Id}` | V | |
| `slackTriggers:setEnabled` | `{id: Id; enabled: boolean}` | `SlackTrigger` | enabling needs Slack connected |
| `slackTriggers:test` | `{input; sample: {permalink} \| {channelId; ts}}` | `SlackTriggerTestResult` | never starts a run (engine `slackTriggers.test`) |
| `slackTriggers:events` | `{triggerId: Id; limit?: number}` | `SlackTriggerEvent[]` | |

There is no `slack:saveTokens`, `slack:setHidden` or `slack:draftCreate` (PO-S1, PO-S9). `settings:update` accepts
`slackAlertUserId` (`^[UW][A-Z0-9]{2,20}$` or null), `slackMirrorNeedsYou`, `slackBackfillDays` (0..90),
`slackTriggerCatchupMin` (0..120), `slackAutoPaused`; `imessageHandle` is rejected (`bad_request`). `author:decide`
creates an approved draft's `slackTrigger` (disabled with a note if Slack is not connected; an existing trigger of the
workflow with the same name is updated). `asks:answer` on a `slack_reply` ask maps `optionId 'send'|'discard'` +
`message` to `slack:draftDecide`. Workflow notify nodes accept `slack` + `migratedFrom` (and a legacy `imessage`,
converted on save/import); `WorkflowDraft.slackTools` is accepted.

| Event | Payload | When |
|---|---|---|
| `slack:status` | `SlackStatus` | any state/sync/warning change (deduped) |
| `slack:channels` | `SlackChannel[]` | list refresh, membership change, unread change |
| `slack:messages` | `{channelId: string; messages: SlackMessage[]}` | after persist (batched 250 ms) |
| `slack:draft` | `SlackDraft` | created, decided, sent, failed, expired |
| `slackTrigger:updated` | `SlackTrigger` | config change |

`UiCommand += {kind:'openSlack'; channelId?: string; threadTs?: string} | {kind:'openSlackDraft'; draftId: Id}`.

### Slack.6 `hive` MCP server additions
Env `HIVE_TOOLSETS` (`author`, `slack`; absent = `author`) selects the listed tools only; main enforces every call by
owner: interactive claude session → author (+ slack once Slack is configured; its `--allowedTools` gains the five
`mcp__hive__slack_*` names); headless claude step whose run has `slack` or `workflow.slackTools` → slack only (the
engine attaches `SlackBridge.toolServer`); any authoring tool from a step owner → "Unknown tool". Tools and JSON schemas:
SLACK.md §11.2. Post-or-draft rule: SLACK.md §8.2 (`connectors/slack/core/policy.ts`, decided from the owner's run and the
trigger re-read at decision time; args never grant auto; serialized so concurrent posts never both pass the counters).
`hive_workflow_create` / `hive_workflow_update` / `hive_workflow_validate` take optional `slack_trigger` (SLACK.md §9.5;
`#name` / `@handle` resolved from the local mirror; PO-S3c violations return `invalid` and never reach a card).

### Slack.7 Notifications
- Notify nodes: Mac notification always; Slack DM to `slackAlertUserId` (`{kind:'me'}`) or a channel; ≤ 10 per run,
  ≤ 60 per hour; failures, "not connected" and "no alert person" pass the step with a note. A legacy `imessage: true`
  is read as `{kind:'me'}`.
- `slack_reply` Asks: one Mac notification per card (suppressed while its pane is visible); click → `openSlackDraft`.
  A draft with no live owner (no Ask) still posts one notification.
- `slackMirrorNeedsYou`: open Asks also DM the alert user (title + owner only, ≤ 1 per 2 min, coalesced).
- Connector `error` (revoked, link disabled) posts one Mac notification per hour; trigger limit/start errors are the
  engine's `SlackBridge.alert`.
- Tray: "Pause Slack Auto-Replies" checkbox (`slackAutoPaused`) once Slack is configured.

### Slack.8 Ownership and build
SLACK.md §14. Backend: contract + migration, `src/main/connectors/slack/**` (core is Electron-free and tested for it),
db, vault, IPC handlers, preload lists, MCP slack tools + broker enforcement, notify sending (iMessage removal),
FakeSlack. AI: `src/main/engine/**`. Frontend: `src/renderer/**`. The production transport has no base-URL override;
the dev-only fake exists only in `npm run build:fakeslack` (`__HIVE_FAKE_SLACK__` define) and
`scripts/verify-no-fake-slack.cjs` (run by `npm run dist`) fails if it reaches `out/main`.

## Principia shared MCP gateway (2026-10-19)

`docs/MCP-GATEWAY.md` specifies the additive shared connection manager. Desktop IPC: `gateway:list`, `gateway:save`, `gateway:remove`, `gateway:test`; shapes are in `src/shared/gateway.ts`, strictly validated in `ipcSchemas.ts`. `EngineContext.gateway.attachment(cwd)` returns a scoped stdio `McpServerSpec` for Claude/Codex spawns. `McpServerSpec.name` additionally accepts `principia`. It uses file IPC and maintains the desktop no-listener invariant. Upstream credentials are encrypted with safeStorage, held only by main/upstream clients, and never included in harness config. External tool use retains harness-native approval policy. Restricted Slack agents and shell steps do not receive this attachment. Tools support stdio and Streamable HTTP static headers. Desktop also supports managed browser OAuth through `gateway:connect` / `gateway:disconnect`, the official MCP SDK, encrypted tokens/client registration, PKCE, exact state/issuer verification, expiry and refresh. The only desktop listener exception is the explicitly initiated, temporary loopback OAuth callback; see MCP-GATEWAY.md.

## Companies (COMPANY.md, 2026-10-20)

`docs/COMPANY.md` makes the company the boundary for data and execution, and `docs/PASSPORT.md` gives each company a
vault. This section amends §3 (schema), §4 (IPC), §5 (engine boundary) and §5.3 (secrets). Everything is additive:
still `schema_version = 2`, every new column is nullable, and every list without `companyId` answers exactly what it
answered before.

### Co.1 Persistence (`src/main/db/schema.ts`, `db/companyMigration.ts`)
- `DDL_COMPANY` moves `company_passports`, `company_repos`, `company_tasks` and `company_task_activity` out of
  `CompanyStore`'s lazy `CREATE` (kept as a no-op) and adds `company_secrets`. `healV2Columns` runs it after
  `DDL_SLACK`, then `COMPANY_ADDED_COLUMNS`, then `DDL_COMPANY_INDEXES`.
- `company_passports` gains `slug` (unique through `company_passports_slug`, fixed at creation), `color`, `sort_order`,
  `system` (`'personal'` on the reserved row), `archived_at` (archive replaces delete), `vault_path` (NULL =
  `<userData>/companies/<slug>/Passport`). `data` keeps the shape older builds parse.
- `company_id TEXT` (nullable) on `sessions`, `runs`, `workflows`, `schedules`, `artifacts`, `agents`, `asks`,
  `slack_workspaces`, `author_drafts`. Indexes: `sessions_company`, `runs_company(company_id, created_at)`,
  `agents_company`, `asks_company`, `artifacts_company(company_id, created_at)`.
- **Reads `COALESCE(company_id, 'co_personal')`.** A NULL (a row written by an older build) reads as Personal.
  Companies are never deleted (archive only), so every stamp names a company that still exists, and the backfill only
  stamps companies it finds in `company_passports` (a task or repo row naming a missing company falls through to the
  next rule). Nothing is ever hidden.
- `company_secrets(company_id, name, label, cipher, masked, created_at, updated_at, PRIMARY KEY (company_id, name))`.
  `secrets` stays the **Shared** namespace with `name` as its key, so older builds' `ON CONFLICT(name)` still works.
- Reserved row `co_personal` (`system = 'personal'`, slug `personal`): it can be renamed and recoloured but never
  archived, and it always sorts last. Repos with no `company_repos` row are Personal's; no rows are written for them.
- Repo order: `meta.repo_order:<companyId>` per company. The legacy `meta.repo_order` stays in place and in sync, so
  older builds and the unfiltered `repos:list` keep their order.
- One-time backfill (COMPANY.md §9), guarded by `meta.company_migrated = 1`, in one transaction, after a
  `VACUUM INTO <hive.db dir>/Hive-backups/hive.pre-company.<ts>.db` copy (normally `<userData>/Hive-backups/`). The copy
  is made once, before any company table or column exists, and only when the db holds user data (fresh installs and
  later opens make none); if it fails, a warning is logged and the db still opens. It is idempotent and deletes nothing. The
  report goes to `meta.company_migration_report` (counts plus workflows flagged for using repos of several companies).
  `seed_key` stays globally UNIQUE; profiles and settings stay global.

### Co.2 Shared types (add-only)
- `src/shared/company.ts`: `PERSONAL_COMPANY_ID`, `CompanyPassport` (+ `slug`, `color`, `sortOrder`, `system?`,
  `archivedAt?`, `vaultPath?`), `CompanyCreateInput`, `CompanyUpdateInput`, `CompanyOverview`.
- `src/shared/types.ts`: `CompanyFilter { companyId? }` (the list filter; absent = all companies) and
  `CompanyStamped { companyId? }` on `Repo`, `Session`, `Workflow`, `Run`, `Schedule`, `Artifact`, agents, asks and
  Slack triggers. `RunListQuery` and `ArtifactQuery` take `companyId`. `Settings` gains `activeCompanyId` (UI state
  only, default `'all'`; main never reads it), `expandedCompanies`, and `experimental: { companies, vault, vaultAI }`.
- `src/shared/gateway.ts`: `GatewayConnection.companyIds?: Id[]` (absent = every company, the behaviour before).
- `src/shared/passport.ts`: every Passport request and response type (PASSPORT.md §11).

### Co.3 IPC
- Every list channel takes an optional `companyId` (`repos`, `sessions`, `runs`, `workflows`, `schedules`,
  `artifacts`, `agents`, `asks`, `secrets`, `slackTriggers`, `tasks`, `author:list` (drafts), `memory:*`). Absent = all
  companies. Every returned row carries `companyId`.
- `app:dashboard {since?, companyId?}` and `app:canvas {companyId?}`: with a company, Home's done runs, learned facts
  and 14-day activity, and the Canvas runs (the 40-run cap applies per company), schedules and sessions are that
  company's only. `history:resume {…, companyId?}`: a transcript whose folder no repo owns lands in that company (a
  repo's folder always decides by its repo).
- Create paths take the caller's company: `repos:pick` / `repos:add` (assign the new repos), `workflows:create` /
  `workflows:import` / `marketplace:install` (else Personal), `workflows:duplicate {id, companyId?}` ("Duplicate to
  company…", new row, no seed key), `runs:start {target, companyId?}` (the last link of the inheritance chain),
  `schedules:create` (stamped from its workflow, else the prompt's repo, else `companyId`, else Personal).
- `secrets:*` take `companyId: Id | null` (null or absent = Shared). `secrets:list {companyId}` answers that company's
  keys followed by the Shared keys it inherits. New `secrets:move {name, from, to}` ("Move to company…" / "Make
  shared"; `conflict` if the name is taken there). Plaintext still never crosses IPC outside §4.1's exceptions.
- New company channels (`handlers/company.ts`):

| Channel | Request | Response | Notes |
|---|---|---|---|
| `company:list` | `{includeArchived?}` \| V | `CompanyPassport[]` | `sort_order`, Personal last; archived only on request |
| `company:create` | `CompanyCreateInput` | `CompanyPassport` | creates `<userData>/companies/<slug>/workspace` |
| `company:update` | `{id, patch: CompanyUpdateInput}` | `CompanyPassport` | name, colour, sort, vault path (a path overlapping another company's folders, the home dir or the disk root is refused) |
| `company:archive` | `{id, archived?}` | `CompanyPassport` | `bad_request` for Personal; data stays |
| `company:reorder` | `{ids}` | `CompanyPassport[]` | |
| `company:assignRepo` | `{repoId, companyId}` | `CompanyPassport` | future runs and sessions only (prompt schedules on the repo move with it; workflows, sessions and past runs keep their stamp); refused with open tasks or anything live on the repo; `co_personal` unassigns |
| `company:overview` | V | `CompanyOverview[]` | one grouped query per domain; memory counts from the Passport index |

- `slack:company` V → `{teamId, companyId} | null` and `slack:setCompany {companyId}` re-home the connected workspace.
- Passport channels (PASSPORT.md §11): `memory:note`, `memory:links`, `memory:proposals`, `memory:vault`, plus the
  `global` / `local` / `layout` requests of `memory:graph`. With `experimental.vault` off they answer `not_implemented`
  (error code `not_implemented`: the renderer falls back to the v1 pages); `memory:vault {op:'migrate'}` answers it when
  no migrator is registered. `memory:vault` also has `aiSettings {companyId}` and `setAi {companyId, optedIn?,
  dailyCap?}` (PASSPORT.md §12 "Suggest with AI": opt-in, daily cap 0-500, calls today, recent activity).
- `company:create`, `company:save` and `company:import` change repo ownership, so they emit
  `data:changed {domain:'repos'}` as well as `{domain:'company'}` (as `company:assignRepo` does).
- **Channel counts (amended).** `memory:*` invoke channels: 11 → **15**, under MEMORY.md PO10's limit, which is
  raised from 12 to **17**. The company feature adds 13 invoke channels in all (`company:create`, `company:update`,
  `company:archive`, `company:reorder`, `company:assignRepo`, `company:overview`, `secrets:move`, `slack:company`,
  `slack:setCompany` and the four Passport channels). No new send channels. No new events:
  `data:changed {domain: 'company'}` reports company changes, and the existing agent, ask, run and session events carry
  `companyId`, so badges need no extra IPC. There is no `company:switch` (main keeps no current company).

### Co.4 Stamping and guards (one resolver: `src/main/company/scope.ts`)
- `resolveCompany({companyId?, taskId?, runId?, sessionId?, workflowId?, scheduleId?, teamId?, repoId?, cwd?})`:
  the explicit id first, then the owning entity, then the repo, then the cwd (longest realpath repo match, then a
  `companies/<slug>` or custom vault folder), else Personal. Executor, sessions, scheduler, Slack, gateway, the
  memory grant and the authoring grant all call it (through `companyBridge.ts` for the engine and sessions).
- Stamps on insert: sessions from the explicit id, then the repo, then Personal; runs inherit from task, then workflow,
  then schedule, then Slack trigger, then target repo, then the explicit id; schedules from their workflow; artifacts
  from their run, else session; root agents from their session or run, subagents from their root; asks from their
  agent; authoring drafts from the authoring session.
- Guards (`assertSameCompany` → `bad_request` "That repository belongs to B; open it from B"):
  - sessions: the cwd may not be inside another company's repo or folder;
  - runs: every step's repo target and realpath cwd (templates and symlinks included) must be the run's company's,
    and a conflicting explicit id is refused;
  - workflows: node repo targets and the worktree repo must be the workflow's company's;
  - schedules: the workflow and the repo target must be in the schedule's company (also checked when a schedule
    fires, so a schedule whose workflow moved is caught);
  - Slack: a team's message never starts another company's workflow (dropped with a `slack_trigger_events` note, at
    most one per trigger per hour), and `slackTriggers:create/update` refuse a mismatch;
  - gateway: a connection with `companyIds` reaches only spawns of those companies (the spawn's company, else its
    cwd's);
  - authoring: the `hive` MCP server gets `HIVE_COMPANY_ID`; list, read, run, draft and push are filtered and stamped
    by it, and a call line naming another `company_id` is refused. With guards enforced, a proposal whose nodes name
    another company's repo is `invalid` when proposed (approval runs the save guard again either way).
- `settings.experimental.companies` (removed at GA): on, guards throw; off, they log a warning and still stamp. Key
  scoping (Co.5) never depends on the flag.
- Repo-less spawns run in `<userData>/companies/<slug>/workspace/`, never the shared `scratchDir`; the Claude trust
  pre-seed covers these folders.

### Co.5 Engine boundary (`src/shared/engine.ts`, add-only) and secrets
- `EngineContext.company?: CompanyBridge` (`resolve`, `crossCompany`, `enforced`, `workspaceDir`, `repoIds`). Absent =
  no companies: nothing is stamped or checked.
- `EngineContext.secrets.resolve(names, companyId?)` and `names(names, companyId?)`: a company value overrides a
  shared one of the same name; `'*'` means every Shared key plus this company's keys, **never another company's**.
  `vault.ts` implements it over `secrets` + `company_secrets`. Redaction stays global over every Shared and company
  key: a key of company A is masked in company B's output too, as `••••NAME` (vault.ts reads `company_secrets` itself
  and re-reads it on every company-key change, which also refreshes memory's secret fingerprints).
- `EngineContext.passportContext(cwd, companyId?)`: with a company id, that company's Passport only
  (`CompanyStore.passportContextFor`, through the renderer the memory service registers). `HIVE_REPOS` lists only the
  run's company's repos while guards are enforced.
- `EngineContext.gateway.attachment(cwd, companyId?)`; `StartRunOptions.companyId`; `InteractiveSpawnOptions.companyId`;
  `MemoryGrantRequest.companyId`; `StepOutputEvent.companyId`.

### Co.6 Tests
- `src/main/__tests__/companyIsolation.test.ts`: the isolation matrix over the real modules (hive.db, CompanyStore,
  vault + `company_secrets`, the engine with its db-backed store and scheduler, SessionManager, the gateway, the
  Slack service and the authoring wiring). For sessions, runs, schedules, Slack triggers, the gateway, keys and the
  authoring tools, company A's spawn can neither see nor change company B's rows, keys, connections or workflows, and
  shared keys are inherited.
- `src/main/__tests__/upgrade.test.ts`: a pre-company hive.db (a live-shaped snapshot, plus a scrubbed real copy when
  `HIVE_UPGRADE_DB` or `src/main/__tests__/fixtures/upgrade/hive-scrubbed.db` exists) opens with every row listed
  under All and under exactly its company or Personal, deletes nothing, and keeps every schedule's rule and next fire
  time. `fixtures/upgrade/scrub-hive-db.mjs` makes the scrubbed copy from a backup, never from the live file (it
  refuses the app's data folder and an already-upgraded db); the snapshot also runs through it, so the script is
  tested too.

### Co.7 Ownership
COMPANY.md §11 (C1-C7) and PASSPORT.md §12 (P1-P8); file ownership is disjoint across both documents.

## Departments (DEPARTMENTS.md, 2026-10-20)

`docs/DEPARTMENTS.md` puts departments and agents inside a company and gives each company one task board. This section
amends §3, §4, §5 and "Companies". Everything is additive: still `schema_version = 2`, every new column is nullable,
and everything sits behind `settings.experimental.departments`, which only takes effect with `experimental.companies`
on (`departmentsEnabled` in `src/shared/company.ts`). With it off, the Tasks page and every task channel behave as
before.

### De.1 Persistence (`src/main/db/schema.ts`, `db/companyMigration.ts`)
- `DDL_COMPANY` gains `company_departments(id, company_id, key, name, color, icon, sort_order, archived_at, created_at,
  updated_at, data)` (`UNIQUE(company_id, key)`) and `company_agents(id, company_id, department_id, kind
  'profile'|'workflow', ref_id, name, archived_at, paused_at, created_at, updated_at, data)` (index
  `company_agents_dept(company_id, department_id)`). Archive replaces delete for both.
- `COMPANY_ADDED_COLUMNS`: `company_tasks.status / department_id / agent_id` (query mirrors written with the JSON in one
  statement), `runs.task_id / agent_id`, `sessions.task_id`, `asks.task_id`, `workflows / schedules /
  slack_triggers.department_id`. Indexes `company_tasks_status(company_id, status)`, `company_tasks_agent(agent_id,
  status)`, `runs_task(task_id)`, plus `company_tasks_source(company_id, source_key)` (unique, one task per external
  source) and `company_tasks_run(run_id)`.
- `runs.trigger` keeps its CHECK: a task run is stored as `'manual'` + `trigger_ext = 'task'` and reads back as
  `trigger: 'task'` with `taskId` / `agentId`.
- Autopilot and the in-flight cap live in the company row's JSON: `autopilot` (default false), `maxInFlight` (1-20,
  default 3).
- One-time backfill guarded by `meta.departments_migrated` (DEPARTMENTS.md §11): task mirrors from the JSON,
  `runs.task_id` from `company_tasks.run_id`, and a `blockReason` for blocked tasks. No departments or agents are
  created, and Autopilot is off everywhere.

### De.2 Shared types (add-only)
- `src/shared/company.ts`: `Department`, `DepartmentData`, `DepartmentSaveInput`, `DepartmentPresetKey`,
  `CompanyAgent`, `CompanyAgentData`, `CompanyAgentSaveInput`, `BoardSettings {companyId, autopilot, maxInFlight}`,
  `BoardTask` (= `CompanyTask` + `TaskBoardFields`: `departmentId`, `agentId`, `blockReason`, `ask`, `report`,
  `doneNote`, `routing`, `pendingWake`, `agentSessionId`, `autoWakes`, `handoffs`), `BLOCK_REASONS`,
  `TASK_ACTIVITY_KINDS` (every activity carries `by: 'human'|'agent'|'system'`), `TaskSource` + `agent`, `schedule`,
  and the one lane function `laneOf(task, openLiveAsk?, agentEligible?)` / `needsYouReason` (Inbox, Queued, Working,
  Needs you, Done) that the board, the sidebar, `CompanyOverview` and the rail badge all use.
- `src/shared/types.ts`: `ExperimentalFlags.departments`, `Workflow.departmentId`, `Schedule.departmentId`,
  `ScheduleTarget = RunTarget & {mode?: 'run'|'task'; agentId?}`.
- `src/shared/slack.ts`: `SlackTrigger.action?: 'run'|'task'` (absent = `run`) and `departmentId`.

### De.3 IPC (`src/shared/ipc.ts`, `handlers/company.ts`, `handlers/board.ts`)
Every channel below is zod-validated (`ipcSchemas.ts`, strict objects) and answers `forbidden` unless
`experimental.companies` and `experimental.departments` are on. Ids are checked against the task's (or row's) own
company, never a company the renderer names: a department or agent of another company is refused (`bad_request`
"… belongs to another company"), a department or agent never moves to another company, and a task's company never
changes.

| Channel | Request | Response | Notes |
|---|---|---|---|
| `departments:list` | `{companyId?, includeArchived?}` \| V | `Department[]` | absent = every company; sidebar order |
| `departments:save` | `DepartmentSaveInput` | `Department` | no id = create; key fixed at creation; `data` merges; a Slack channel routes to one department per company |
| `departments:archive` | `{id, archived?}` | `Department` | `conflict` while it has open tasks or its agents are in flight (the message names them) |
| `departments:reorder` | `{companyId, ids}` | `Department[]` | ids of another company: `not_found` |
| `departments:createPresets` | `{companyId, keys?}` | `Department[]` | the six §9 presets in one call, idempotent by key |
| `companyAgents:list` | `{companyId?, departmentId?, includeArchived?}` \| V | `CompanyAgent[]` | `departmentId: null` = company-level agents |
| `companyAgents:save` | `CompanyAgentSaveInput` | `CompanyAgent` | a profile agent's profile exists and is not shell; a workflow agent's workflow and the department are the agent's company's |
| `companyAgents:archive` | `{id, archived?}` | `CompanyAgent` | `conflict` while it has a task in flight |
| `companyAgents:pause` / `companyAgents:resume` | `{id}` | `CompanyAgent` | a paused agent takes no new task |
| `tasks:assign` | `{id, departmentId?, agentId?}` | `BoardTask` | absent = unchanged, null = clear; `routing.by: 'human'`; refused in flight |
| `tasks:acceptRoute` | `{id}` | `BoardTask` | applies the model's routing suggestion (never applied by itself) |
| `tasks:answer` | `{id, answer}` | `BoardTask` | `blocked(needs_input)` → `todo`; the same agent resumes with `Answer: …` |
| `tasks:approve` | `{id, doneNote}` | `BoardTask` | `in_review` → `done`, human only, note required; heals its dependents |
| `tasks:sendBack` | `{id, note}` | `BoardTask` | `in_review` → `todo`; the note is the next turn's wake |
| `tasks:unpark` | `{id}` | `BoardTask` | `blocked` (not `deps`) → `todo`; resets the wake counter |
| `tasks:openSession` | `{id, cols, rows}` | `{task, session}` | a PTY session (`sessions.task_id`) holds the lease |
| `tasks:takeover` | `{id, cols, rows}` | `{task, session}` | cancels the headless run, opens a session resuming `agentSessionId` |
| `tasks:stop` | `{id}` | `BoardTask` | cancels the run or ends the session; the task parks per §1.4 |
| `board:autopilot` | `{companyId, on, maxInFlight?}` | `BoardSettings` | the company's switch (default off); the rail's "Pause all agents" turns it off for every company |

- Existing `tasks:*` channels stay. `tasks:create` / `tasks:update` with departments on check the department and agent
  against the task's company, never create or patch a board task straight to `done`, and `tasks:update` cannot write
  the fields only main writes (`blockReason`, `ask`, `report`, `doneNote`, `routing`, `pendingWake`,
  `agentSessionId`, `autoWakes`, `handoffs`). With departments off they refuse a department or agent (`forbidden`).
- `schedules:create/update` accept `target.mode: 'task'` with `target.agentId` and `departmentId`;
  `slackTriggers:create/update` accept `action: 'task'` and `departmentId` (refused when the department is not the
  trigger's company's).
- Events: `data:changed {domain: 'departments'}` (departments and agents) and `{domain: 'tasks'}` (the board,
  including dispatcher and hivetask writes). No new event names.
- **Channel counts.** The departments feature adds 20 invoke channels (5 `departments:*`, 5 `companyAgents:*`, 9
  `tasks:*`, `board:autopilot`). No new send channels.

### De.4 Engine boundary (`src/shared/engine.ts`, add-only)
- `StartRunOptions.trigger: RunTrigger | 'task'`, `taskId`, `agentId` (persisted in `runs.task_id / agent_id`; the
  run's company is the task's), `resumeSessionId` (a resumed Claude task turn) and `runMinutes` (the seat's time cap;
  the agent is warned about 2 minutes before, `TASK_WRAP_UP_TEXT`, then the run is canceled and the task parks with
  `limit`).
- `RunTrigger` gains `'task'`, and `Run` gains optional `taskId` / `agentId` (read back from `runs.task_id / agent_id`).
  `tasks:start` goes through the dispatcher's `runNow`, so a board Run always records its task and seat.
- `CompanyBridge.tasks?: TaskRunBridge` (`companyOf`, `runMinutes`, `toolset`, `sessionCaptured`, `timeLimit`,
  `passportContext` with the department slot) and `CompanyBridge.boards?` (task-mode schedules and Slack triggers,
  `company/recurring.ts`). The engine never imports `src/main/company/**`.
- `EngineStore.insertRun(run, snapshot, task?: RunTaskLink)`.

### De.5 MCP: the `hivetask` toolset (`src/main/company/taskTools.ts`, `taskToolDefs.ts`)
Listed on the headless `hivemem` server of a Claude step of a task run (`HIVE_TASK_ID`, `HIVE_TASK_COMPANY_ID`) and
on the authoring `hive` server of a board session (`HIVE_TOOLSETS` includes `task`, `HIVE_COMPANY_ID`, plus
`HIVE_TASK_ID` when the session holds a task). Calls travel the live dir mailbox like the authoring tools: the broker
resolves the caller from the live dir's owner (never from the line), refuses a line whose `company_id` or `task_id` is
not the caller's, and lets a write through only while the caller's run or session still holds its task
(`in_progress` with its `runId`); `TaskTools` checks again. Reads are limited to the caller's company (another
company's task reads as "Task not found in this company", by id and by identifier). Output is redacted, capped at
8000 chars and marked as data, not instructions. Codex, Gemini and Cursor get no tools: the prompt carries the task
and they end with a fenced `principia-task-report` JSON block (malformed = no report).

| Tool | Caller | Effect |
|---|---|---|
| `task_get({id?})` | any | the current task, or a task of the same company (another agent's in-flight task shows who has it, nothing more) |
| `task_list({scope: 'mine'\|'department'\|'open', limit ≤ 50})` | any | the company board |
| `task_comment({text})` | the run or session holding the task | redacted; never wakes anyone |
| `task_report({outcome: 'review'\|'blocked', summary, evidence[]})` | holder | decides the run-end outcome (`in_review` or `blocked(agent)`) |
| `task_ask({kind: 'question'\|'confirm'\|'choice', prompt, options?})` | holder | `blocked(needs_input)` at run end; a choice needs 2-6 options |
| `task_create({title, description?, departmentKey?, blocksCurrent?})` | holder; a session holding no task files a top-level task | child of the current task, `source: 'agent'`, routed by §2; at most 4 per task, one level deep, 10 per company per hour; a replayed tool-use id returns the first task; `blocksCurrent` makes it a dependency (`blocked(deps)` at run end, then heals) |
| `task_handoff({departmentKey \| agentId, reason})` | holder | applied at run end: `todo` with the target (same company only), `handoff` activity; after 4 handoffs the task parks with `handoff_cap` |

Never exposed: setting `done`, another agent's in-flight task, department or agent config, cancelling runs.

### De.6 Tests
- `src/main/__tests__/departmentsIsolation.test.ts`: two companies over the real modules. Through both MCP servers
  (each driven through its real `callTool`, the LiveBridge mailbox and the broker) and through every
  `departments:*`, `companyAgents:*`, `tasks:*` and `board:autopilot` handler, company A can neither list, claim,
  comment on nor hand off to company B's tasks, and each refusal leaves B's board unchanged. With
  `experimental.departments` off, all 20 §10 channels answer `forbidden`, `tasks:create`/`tasks:update` refuse board
  fields, and every task tool on both servers is refused.
- `src/main/company/board.integration.test.ts`: the fake-adapter scenario (Slack message → task → Support →
  Autopilot run → `task_ask` → answer → resumed turn → review → approve with a note → the dependent Marketing task
  heals and runs), replayed twice with identical transcripts, and a seeded overnight soak over 5 companies (no task
  beyond its caps, nothing done without a human, no re-wake loop once the stimuli stop), plus a sixth company with
  Autopilot off whose auto seats receive the same wakes and never start.
- Per-package tests: `departments.test.ts`, `company.test.ts`, `taskState.test.ts`, `router.test.ts`,
  `dispatcher.test.ts`, `taskTools.test.ts`, `scope.departments.test.ts`, `db/__tests__/departmentsMigration.test.ts`,
  `engine/__tests__/recurringTasks.test.ts`, and the renderer's `lib/departments.test.ts` / `lib/board.test.ts`.

### De.7 Ownership
DEPARTMENTS.md §13 (D1-D11); file ownership is disjoint with COMPANY.md (C1-C7) and PASSPORT.md (P1-P8).

## Principia help (`principia_help`, 2026-10-27)

Agents know the founder's company, not Principia. Asked "how can I use Principia from my phone?", one answered that
it did not know and sent the founder to support, while Settings › App › Phone pairs a phone by QR code.

- **The knowledge base** is one curated module, `src/shared/help.ts` (`HELP_ENTRIES`): about 30 short entries, each a
  title, a few plain sentences on how to do it in the current build, the words people ask it with, and the principia://
  links that open the page. Written only from what the code and these docs say the build does; nothing planned.
- **The tool** `principia_help {question}` (read-only, `src/main/company/taskToolDefs.ts` `HELP_TOOL_DEF`) returns the
  best 1–3 entries (`searchHelp`: deterministic keyword, alias and phrase scoring with IDF), or every topic title when
  nothing matches so the agent can ask again. It is listed wherever `connections_list` is (the `hive` server of company
  sessions, plus every interactive session; a task run's hivemem server; the pre-allowed pane tools and the task
  toolset) and is answered by the server process itself from the bundled module, with no mailbox line. The broker
  answers a stray `principia_help` line with the same data.
- **The rule** (`principiaOps.ts`, listed when the tool is attached): questions about Principia itself go to
  principia_help and are answered with its link, never guessed and never sent to support.
- **Upkeep.** `src/shared/help.test.ts` parses every principia:// link in the module with `parseDeepLink`, so a link
  the parser no longer accepts fails the build. **A PR that changes a user-facing feature updates `src/shared/help.ts`**
  (§10). `principia://settings/phone` opens Settings › App › Phone (added to `SETTINGS_SECTIONS` for this).
