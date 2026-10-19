# Hive Live: subagents, Needs you, Agents hub, memory defaults, Home dashboard

Design for F1–F5. This is binding for the three builders. CONTRACT.md "## Live agents" (§12) is the interface summary.
If this doc and §12 disagree, §12 wins on shapes and this doc wins on behaviour.

Inputs: `docs/research/live-claude.md` (verified on Claude Code 2.1.301), `docs/research/live-gemini-cursor.md`
(from source and docs only; neither CLI is installed or logged in here), the fixtures in
`src/main/engine/__tests__/fixtures/`, and the current code.

Constraints that apply to everything below:
- **Strictly local.** No TCP listener, no HTTP, no WebSocket. All IPC between Hive and agent CLIs uses the child's stdio,
  per-spawn files under `<userData>/live/`, or the existing `hivemem` stdio MCP server. The §9 `lsof` check stays empty.
- **No global CLI config edits.** Never write `~/.claude/settings.json`, `~/.gemini/**` or `~/.cursor/**`. Use per-spawn flags
  and temp files only: claude `--settings <file>`, gemini `GEMINI_CLI_SYSTEM_SETTINGS_PATH=<file>`, cursor `--plugin-dir <dir>`.
  (The existing `claudeTrust.ts` behaviour is unchanged and out of scope.)
- **Redaction.** Everything persisted or emitted from streams, hooks or asks goes through `secrets.redact` first.
- **Real data only.** No estimated prices. If a CLI reports no cost, Hive shows tokens and leaves cost as `—`.
- **No new settings** (SPEC A11). This feature only changes a default (§7). (§16, a later pass, adds two:
  `autoRetryRateLimit` and `stallMinutes`.)

Scope boundary: F1–F5 only. The landscape work (paperclip, goodboy, usenaive) is a separate workflow. Codex keeps its
current behaviour and only gains root agent rows (§3.6), so it appears in the hub with no subagents and no Needs you.

---

## PO amendments (binding, override anything below that conflicts)

| # | Amendment |
|---|---|
| A1 | **No hook gate for interactive sessions.** Delete the claude interactive `PermissionRequest --gate`, the `mode` file and the focus-fallthrough policy. With a gate, the TUI goes blank while Hive waits, and a race between "focus pane → fallthrough" and "click Allow in hub" decides who wins. The interactive permission ask is always channel `pty`. The native dialog stays visible in the pane, and the hub's Allow/Deny write `ptyReplyKeys` (A9 guard). `allow_always` is dropped for interactive sessions. `hook_gate` stays only for headless gemini/cursor behind `HOOKS_VERIFIED`. |
| A2 | **`ask_user` is for headless steps only.** In an interactive session the agent already asks in the chat. An MCP tool that blocks would hide the question from the terminal, and the user can't answer it there. Interactive sessions attach hivemem only when memory is on, exactly as today. |
| A3 | **Idle counts as Needs you only while unseen.** A session whose turn ended (`Stop`) while its pane was not visible is `needs='idle'` and counts toward the badge, tray, dock and hub "Needs you". As soon as that pane is visible with the window focused (`ui:visibleOwner`), it becomes `seen`: it moves to "Open sessions" (dimmed) and stops counting, but stays `needs_you` for Reply. A turn that ends while the pane is already visible is never counted. Without this rule, five open sessions keep the badge lit all day. |
| A4 | **No stuck asks.** (a) When a root reaches a terminal status, every open ask in its tree becomes `canceled` (session PTY exit, step process exit), not only at boot. (b) `PreToolUse` never resolves asks, because async hooks arrive out of order and would close a fresh ask. A `pty` permission ask resolves `answered/terminal` on `PostToolUse`/`PostToolUseFailure` of the same agent and tool name, on `Stop`, on `UserPromptSubmit`, or on a real user keystroke into the PTY. Bytes xterm generates on its own never count: focus reports, replies to terminal queries (DA, cursor position, colors, XTVERSION) when a pane mounts, resizes or replays its scrollback, and empty bracketed-paste markers. The renderer flags `sessions:write` with `typed` (a key, paste or IME event in the pane just before), drops query replies produced by a scrollback replay, and main also ignores any chunk that is only terminal reports. (c) When the MCP server gets `notifications/cancelled` for a pending `ask_user`, it appends `{"hive":"ask_user_cancelled","gate_id"}`, and the ask becomes `canceled`. |
| A5 | **`ask_user` wait must survive the client's MCP timeout.** Headless claude spawns set env `MCP_TOOL_TIMEOUT=3700000` (per spawn, never global config). The fake-claude test asserts a 5-minute wait does not error. If a CLI still errors the call, A4(c) or process exit closes the ask, so Hive never shows a question nobody is waiting on. |
| A6 | **One subagent, one node.** The tracker key is the **first id seen** for a subagent: `toolUseId` in headless streams, `agent_id` in hooks. Later ids (`task_id`, `agent_id`) are stored as aliases that map to the same key and never create a second node. Tested by a fixture where `task_started` arrives after the `Agent` tool_use. |
| A7 | **Quiet notifications.** Notifications coalesce per root: at most one per root per 30 s, with body "n things need you" when several asks open in a burst (parallel subagents). No notification for asks resolved within 3 s (the user answered in the terminal). Expired and auto-denied asks are grouped into one notification per run. |
| A8 | **Delete scope creep.** Out of this pass: gemini `--session-id`/`canResume`, cursor `create-chat`/`--resume`/`canResume` (session resume is not F1–F5); the gemini synthetic `subagents (n)` group child (inner tools of overlapping subagents go to the root, labelled "activity matched by timing"); cursor inner-hook attribution by `conversation_id` (headless cursor subagent details arrive at completion; that is enough); §13 ACP is a note only, with no files, flags or fixtures created in this pass. |
| A9 | **PTY replies are guarded.** Before writing `ptyReplyKeys`, main re-runs `detectPtyPrompt` on the current quiet tail. If the matching prompt is gone or differs from the ask's title, it returns `conflict` ("The prompt changed; open the terminal") and resolves the ask `answered/terminal`. Hive never sends keys blind. |
| A10 | **Memory default really changes.** `sessionMemory` default becomes `'read-write'` in `DEFAULT_SETTINGS`. Settings writes stay patch-only (`updateSettings` stores only the keys the user changed), so users who never touched it get the new default. Frontend must not send the whole Settings object on save; a test asserts a fresh DB returns `'read-write'` and an explicit `'off'` survives. |

---

## 0. Summary of decisions

| # | Decision |
|---|---|
| D1 | A single **agent node tree** stored in `hive.db`. Root = a session or a run step; children = subagents (any depth); each node has a capped list of activity events (tool calls, text, asks). |
| D2 | The **engine owns the pure logic**: stream parsers, hook-payload normalizers, the `AgentTracker` reducer, PTY prompt patterns and reply keys, and the per-adapter config renderers. **Main owns I/O**: live dirs, file tailing, the hook script, PTY writes, persistence, notifications. Main imports the pure pieces from `src/main/engine/index.ts`. |
| D3 | **Headless claude** moves to `--input-format stream-json --permission-prompt-tool stdio`. Permission prompts arrive as `control_request can_use_tool` and are answered on stdin. Stdin stays open until the final `result` *and* no background tasks remain. |
| D4 | **Interactive claude** gets hooks through `claude --settings <liveDir>/claude-settings.json`. Every hook calls one Hive hook script that appends a JSON line to `<liveDir>/events.jsonl`. All hooks are observational (async). Permission replies go to the visible native dialog through guarded PTY keys (A1, A9). |
| D5 | **Gemini**: `-o stream-json` parser plus hooks in a merged system settings file. Subagent inner tools are attributed by timing. **Cursor**: own stream-json parser plus hooks in a temp `--plugin-dir`. Subagent internals arrive when it completes, plus hook lifecycle. Headless *gating* for both stays off behind `HOOKS_VERIFIED` until a real run passes `scripts/verify-live-hooks.cjs`. |
| D6 | **`ask_user`** is a new tool on the existing `hivemem` MCP server. It blocks on an answer file in the live dir. The server is attached to every **headless** claude step, even with memory off (then it lists only `ask_user`). Interactive sessions do not get it (A2). |
| D7 | An **Ask** is a persisted row (permission, question or trust) with a channel (`stdio`, `hook_gate`, `mcp`, `pty`). An idle "your turn" is *not* an Ask: it is `agent.needs = 'idle'` and is answered with `agents:reply`. |
| D8 | **Headless steps pause** while an Ask is open: the step's timeout clock stops and the step stays `running`. The agent node shows `needs_you`. Asks expire after 60 min (deny); cancelling the run cancels its asks. |
| D9 | **Memory defaults**: new sessions and new agent/room nodes default to `read-write` (check reviewers to `read`). Old nodes without `memory` stay `off`. The chip counts reads from agent activity and saves from the grant. |
| D10 | **Home** becomes the "since you were last here" dashboard, built from one new `app:dashboard` call. ACP transports (Gemini, Cursor) are **phase 2**: designed here (§13), not built in this pass. |

---

## 1. Unified agent-activity model

### 1.1 Agent node

```
session s_abc (root, kind=session)        step st_xyz (root, kind=step)
 ├─ subagent "Explore auth" (claude)       ├─ subagent "codebase_investigator" (gemini, timing)
 │   ├─ tool Read src/auth.ts  ok          │   └─ tool grep_search "token"  ok
 │   └─ tool Grep "jwt"        running     └─ tool run_shell_command "npm test"  needs_you
 └─ tool Edit src/login.ts     ok
```

- **Roots.** Exactly one root per interactive session (`kind: 'session'`) and one per run step (`kind: 'step'`, including
  shell steps and room turns). The root is created when the session or step is created and mirrors its lifecycle.
- **Subagents.** `kind: 'subagent'`, `parentId` = the spawning agent (root or another subagent), `depth` ≥ 1.
- **Events.** A tool call is not a node; it is an `AgentEvent` on the agent that made it. The UI shows events as the
  leaves of the tree.
- **Identity.** `externalId` is the CLI's id for the agent: claude `agent_id`/`task_id`, cursor `agentId`/`subagent_id`,
  gemini `tool_id` of the `invoke_agent` call. `toolUseId` is the id of the spawning tool call (claude `Agent`/`Task`
  `tool_use.id`, cursor Task `call_id`, gemini `tool_id`). The tracker keys subagents by `externalId` and falls back to
  `toolUseId`.

### 1.2 Status machine

`AgentStatus = 'starting' | 'working' | 'needs_you' | 'idle' | 'done' | 'failed' | 'canceled'`

| From → To | Trigger |
|---|---|
| `starting → working` | first stream event / hook (`SessionStart` for sessions goes to `idle`, see below) |
| `working → needs_you` | an Ask opens on this agent (`needs = permission \| question \| trust`); or, for interactive roots, a turn ends with no background tasks (`needs = 'idle'`) |
| `needs_you → working` | the Ask is answered or resolved; for idle, the user types into the PTY or `UserPromptSubmit` fires |
| `* → idle` | interactive root only: the session just started and has had no prompt yet. Not counted as Needs you. |
| `* → done \| failed \| canceled` | subagent: its completion event; step root: the step's final status (`passed` → done); session root: PTY exit (exit 0 or SIGHUP from Hive → done, else failed) |

- **Parent status.** A parent's `needs_you` is its own; a parent is *not* marked `needs_you` when a child is. The hub and
  the canvas roll up instead: `needsYouCount` = open asks on the root's tree.
- **Terminal statuses are final.** Late events (async hooks, the stray `SubagentStop`) never reopen a node.
- **Boot recovery.** Agents in `starting | working | needs_you | idle` become `failed` with activity "Hive quit". Open
  asks become `canceled`.
- **Root end.** When a root reaches `done | failed | canceled`, open asks in its tree become `canceled` at once (A4).

### 1.3 Activity line

`activity` is one short human line (≤ 120 chars), for example `Edit src/login.ts`, `Bash npm test`, `Reading note.txt`,
`Waiting for you: Bash curl …`, or `Your turn`. Sources by priority:
1. the open Ask's title;
2. claude `task_progress.description`;
3. the last tool call: name plus a summary of its main argument (`file_path`, `command`, `pattern`, `query`, `path`,
   `url`, or `agent_name`/`subagent_type`);
4. the last text, first line.

The engine builds it with `summarizeTool(provider, name, input)` from `live/summary.ts`. That also drives `lastTool`.
Memory tool calls reuse `memoryToolLine()`.

### 1.4 Counters

On each node:
- `toolCount`;
- `memReads`: calls to `memory_search` or `memory_get`, under any provider's naming;
- `filesTouched[]`: up to 50 paths relative to `cwd`, from edit-type tools only. The list is in §3.7.

Roots also aggregate the files touched by their descendants (union).

**Usage.** On roots: `tokensIn`, `tokensOut`, `costUsd`, `modelUsage {model: {tokensIn, tokensOut, costUsd|null}}`. On
subagents: tokens if reported. Cost is never summed root + children, because claude's `total_cost_usd` already includes
subagents.

### 1.5 Ask

`AskKind = 'permission' | 'question' | 'trust'`; `AskChannel = 'stdio' | 'hook_gate' | 'mcp' | 'pty' | 'acp'` (`acp` is phase 2).
`AskStatus = 'open' | 'answered' | 'expired' | 'canceled'`; `answeredVia = 'hive' | 'terminal' | 'timeout' | null`.

| Option kind | Meaning | Offered when |
|---|---|---|
| `allow` | allow once | permission |
| `allow_step` | allow this tool for the rest of this step (Hive remembers it; no file written) | headless permission (`stdio`, `hook_gate` on steps) |
| `deny` | deny, with an optional message to the agent | permission |
| `choice` | one option of a question (`label` = the text) | `ask_user` with options |
| `focus` | "Open terminal": no answer, just navigates | `pty` channel, `trust` |

(`allow_always` deleted by A1.)

Questions also accept free `text`. `toolInput` is redacted and truncated to 4 KB; `detail` is a ≤ 300-char summary.

---

## 2. Persistence (hive.db schema v2)

`SCHEMA_VERSION = 2`. `openDatabase` migrates v1 → v2 in one transaction (Backend). DDL lives in `src/main/db/schema.ts`
as `DDL_V2_MIGRATION`.

```sql
CREATE TABLE IF NOT EXISTS agents (             -- (E) steps/subagents of steps, (M) sessions/subagents of sessions
  id              TEXT PRIMARY KEY,             -- ag_xxxxxxxxxx
  kind            TEXT NOT NULL CHECK (kind IN ('session','step','subagent')),
  parent_id       TEXT REFERENCES agents(id) ON DELETE CASCADE,
  root_id         TEXT NOT NULL,                -- = id for roots
  session_id      TEXT, run_id TEXT, step_id TEXT,
  provider        TEXT NOT NULL,
  repo_id         TEXT, cwd TEXT NOT NULL,
  title           TEXT NOT NULL,
  agent_type      TEXT, external_id TEXT, tool_use_id TEXT, model TEXT,
  depth           INTEGER NOT NULL DEFAULT 0,
  background      INTEGER NOT NULL DEFAULT 0,
  attribution     TEXT NOT NULL DEFAULT 'exact' CHECK (attribution IN ('exact','timing','completion')),
  status          TEXT NOT NULL CHECK (status IN ('starting','working','needs_you','idle','done','failed','canceled')),
  needs           TEXT CHECK (needs IN ('permission','question','idle','trust')),
  activity        TEXT, last_tool TEXT,
  tool_count      INTEGER NOT NULL DEFAULT 0,
  mem_reads       INTEGER NOT NULL DEFAULT 0,
  files_json      TEXT NOT NULL DEFAULT '[]',
  tokens_in       INTEGER, tokens_out INTEGER, cost_usd REAL,
  model_usage_json TEXT,
  report          TEXT,                         -- subagent final report / step final text pointer (<= 8 KB)
  started_at      TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT
);
CREATE INDEX IF NOT EXISTS agents_root    ON agents(root_id);
CREATE INDEX IF NOT EXISTS agents_status  ON agents(status, updated_at);
CREATE INDEX IF NOT EXISTS agents_run     ON agents(run_id);
CREATE INDEX IF NOT EXISTS agents_session ON agents(session_id);
CREATE INDEX IF NOT EXISTS agents_step    ON agents(step_id);
CREATE INDEX IF NOT EXISTS agents_started ON agents(started_at);

CREATE TABLE IF NOT EXISTS agent_events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  ts          TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('tool','text','thinking','status','ask','answer','error')),
  tool_use_id TEXT,
  name        TEXT,
  summary     TEXT NOT NULL,                    -- <= 200 chars
  detail      TEXT,                             -- <= 4 KB, redacted
  state       TEXT CHECK (state IN ('running','ok','error','denied'))
);
CREATE INDEX IF NOT EXISTS agent_events_agent ON agent_events(agent_id, seq);
CREATE INDEX IF NOT EXISTS agent_events_tool  ON agent_events(agent_id, tool_use_id);

CREATE TABLE IF NOT EXISTS asks (
  id           TEXT PRIMARY KEY,                -- ask_xxxxxxxxxx
  agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  root_id      TEXT NOT NULL,
  session_id   TEXT, run_id TEXT, step_id TEXT,
  provider     TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('permission','question','trust')),
  channel      TEXT NOT NULL CHECK (channel IN ('stdio','hook_gate','mcp','pty','acp')),
  gate_id      TEXT,                            -- stdio request_id / hook gate id / mcp ask id
  title        TEXT NOT NULL, detail TEXT,
  tool_name    TEXT, tool_input_json TEXT, question TEXT,
  options_json TEXT NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL CHECK (status IN ('open','answered','expired','canceled')),
  answer_json  TEXT, answered_via TEXT CHECK (answered_via IN ('hive','terminal','timeout')),
  created_at   TEXT NOT NULL, answered_at TEXT, expires_at TEXT
);
CREATE INDEX IF NOT EXISTS asks_open ON asks(status, created_at);
CREATE INDEX IF NOT EXISTS asks_root ON asks(root_id);

-- schedules: engine-owned skip marker (F5 "Skip")
ALTER TABLE schedules ADD COLUMN skip_slot_at TEXT;
-- schedule_events: rebuild to add kind 'skipped' (create _new with the v1 columns + new CHECK, copy, drop, rename, re-index)
```

**Write ownership.**
- The engine writes agents, agent_events and asks for run steps through new `EngineStore` methods (§9.2).
- Main writes them for sessions directly.
- Both use the same repository module `src/main/db/liveStore.ts` (Backend).

**Caps and retention.**
- At most 500 events per agent. On insert past the cap, delete the oldest non-`ask`/`answer` rows of that agent.
- Assistant text deltas are never stored: one `text` event per whole assistant message, with `detail` ≤ 4 KB.
- Full transcripts stay in the step logs and session logs, as today.
- At boot: delete `agent_events` of agents that ended more than 30 days ago, and agents of sessions that `pruneOld`
  deletes. Agent rows are kept 90 days so the dashboard has history.

**ID prefixes** (`ID_PREFIX`, add-only): `agent: 'ag'`, `ask: 'ask'`.

---

## 3. How each adapter feeds the model

Everything goes through one pure reducer: `createAgentTracker({provider, root, now})` in `src/main/engine/live/tracker.ts`.
It consumes two kinds of input:
- `NormalizedEvent`s from the stream parsers (headless);
- `HookEvent`s from `normalizeHook(provider, payload)` in `live/hooks.ts` (hook lines from the events file, `ask_user` lines from hivemem, PTY prompt detections).

It returns `LiveOp[]`:

```ts
type LiveOp =
  | { op: 'agent.upsert'; key: string; patch: Partial<AgentNode> & { parentKey?: string | null } }   // key = externalId ?? toolUseId ?? 'root'
  | { op: 'event.append'; key: string; event: Omit<AgentEvent, 'seq' | 'agentId'> }
  | { op: 'event.update'; key: string; toolUseId: string; patch: Pick<AgentEvent, 'state' | 'detail'> } // tool result for a running tool
  | { op: 'ask.open'; key: string; ask: Omit<Ask, 'id' | 'agentId' | 'rootId' | 'sessionId' | 'runId' | 'stepId' | 'status' | 'answer' | 'answeredVia' | 'answeredAt'> }
  | { op: 'ask.resolve'; gateId: string | null; key: string; via: 'terminal' | 'timeout'; status: 'answered' | 'expired' | 'canceled' }
  | { op: 'control.closeStdin' }                                           // headless claude: final result and no background tasks
```

- The **caller applies the ops**: the executor for steps, `SessionLive` in main for sessions. Applying means: map the
  `key` to the `ag_` id (create the row on first upsert), redact, persist, then emit.
- The tracker is **pure and deterministic**. Tests feed fixture files line by line and snapshot the ops.

The **parsers** keep their current `StreamParser` interface and add events:

```ts
type NormalizedEvent = /* existing */
  | { kind: 'text'; text: string; agent?: string | null }                    // agent = parent_tool_use_id/agentId; null = main
  | { kind: 'tool_use'; name: string; input?: unknown; id?: string | null; agent?: string | null }
  | { kind: 'tool_result'; id: string; ok: boolean; text?: string | null; agent?: string | null; denied?: boolean }
  | { kind: 'subagent_start'; toolUseId: string; agentId: string | null; type: string | null; description: string | null; background: boolean; depth: number; parentAgent: string | null; attribution: Attribution }
  | { kind: 'subagent_progress'; agentId: string; activity: string | null; lastTool: string | null; tokens: number | null; toolUses: number | null }
  | { kind: 'subagent_end'; agentId: string | null; toolUseId: string | null; status: 'done' | 'failed' | 'canceled'; report: string | null; tokensIn?: number | null; tokensOut?: number | null; transcript?: NormalizedEvent[] }
  | { kind: 'permission_request'; requestId: string; toolName: string; input: unknown; agentId: string | null; description: string | null; suggestions: unknown[] }   // claude stdio
  | { kind: 'background'; running: number }                                    // claude background_tasks_changed
  | { kind: 'usage'; model: string | null; tokensIn: number | null; tokensOut: number | null; costUsd: number | null; byModel?: Record<string, { tokensIn: number; tokensOut: number; costUsd: number | null }> }
```

`eventToChunk` keeps producing `run:output` text **for the main agent only** (`agent == null`). Subagent text goes only to agent events.

### 3.1 Claude, headless (verified)

**argv.** Prompt goes on stdin, so there is no positional prompt:
```
claude -p --input-format stream-json --output-format stream-json --verbose
  [--mcp-config <f> --allowedTools mcp__hivemem__…,mcp__hivemem__ask_user]
  (--session-id U | --resume U) [--model M]
  (--dangerously-skip-permissions | --permission-mode default --permission-prompt-tool stdio)
  --append-system-prompt <ARTIFACTS hint + ask_user hint> [...extraArgs]
```

**Stdin protocol** (engine `live/claudeControl.ts`):
0. Spawn env adds `MCP_TOOL_TIMEOUT=3700000` (A5).
1. Write `{"type":"control_request","request_id":"init1","request":{"subtype":"initialize"}}`.
2. Write `{"type":"user","message":{"role":"user","content":<prompt>},"parent_tool_use_id":null,"session_id":""}`.
3. For each stdout `control_request` with `subtype:"can_use_tool"`:
   - the parser emits `permission_request`;
   - the tracker emits `ask.open` with channel `stdio` and `gateId = request_id`, on the agent `agent_id ?? root`;
   - the executor applies any `allow_step` memo first: if the tool name was allowed for this step, it answers right away without an Ask.
4. On answer, write `{"type":"control_response","response":{"subtype":"success","request_id":R,"response":<decision>}}` where:
   - allow: `{"behavior":"allow","updatedInput":<original input>}`
   - deny: `{"behavior":"deny","message":<user text or "Denied in Hive">}`
5. Other `control_request` subtypes are unknown: answer `{"subtype":"error","request_id":R,"error":"unsupported"}`, log once.
6. Close stdin (`control.closeStdin`) when a `result` has been seen **and** the running background-task count is 0 (from
   `system/background_tasks_changed`), or `background_tasks_changed{tasks:[]}` arrives after a result.

**Parser fixes** (`createClaudeParser`, fixtures `claude-subagent-{fg,bg,partial}.stream.jsonl`):
- Anything with `parent_tool_use_id != null` is attributed (`agent = parent_tool_use_id`) and never counts toward the step's text.
- `Agent` | `Task` tool_use becomes `subagent_start` (from the assistant message; `parentAgent` = that message's
  `parent_tool_use_id`).
- `system/task_started` binds `agentId = task_id` to `tool_use_id` and sets `depth = spawn_depth` and `background = is_backgrounded`.
- `task_progress` → `subagent_progress`. `task_updated.patch.status` and `task_notification` → `subagent_end`, with
  `report = handback_report.text` and usage.
- A `SubagentHandback` tool_use inside a subagent sets the report early. It is not shown as a tool row.
- `result`: keep the last result with non-empty `result` text as the final output. Cost = max `total_cost_usd` seen.
  Emit `usage` with `byModel` from `modelUsage[*].costUSD` and tokens. An empty trailing `result` never replaces the output.
- A repeated `system/init` is idempotent (same session id: no second `session` event).
- `stream_event` partial deltas are ignored for persistence. Live text keeps coming from whole assistant messages, as today.
- `system/hook_*` lines are ignored.
- **End of step = process exit**, never the first `result`.

**Step outcome.** Remove the "set bypass" error path (CONTRACT E5/A8). With `permissionMode: 'default'`, a denied tool
is just a denied tool. The step fails only on a non-zero exit or `is_error`.

### 3.2 Claude, interactive (verified)

`interactive()` adds `--settings <liveDir>/claude-settings.json` (rendered by `claudeHooksAttach`). These hooks merge
with the user's own, which is fine:

```json
{"hooks":{
  "SessionStart":[{"hooks":[H("SessionStart",async)]}],
  "UserPromptSubmit":[{"hooks":[H(async)]}],
  "PreToolUse":[{"matcher":"*","hooks":[H(async)]}],
  "PostToolUse":[{"matcher":"*","hooks":[H(async)]}],
  "PostToolUseFailure":[{"matcher":"*","hooks":[H(async)]}],
  "PermissionRequest":[{"matcher":"*","hooks":[H(async)]}],
  "Notification":[{"matcher":"*","hooks":[H(async)]}],
  "SubagentStart":[{"hooks":[H(async)]}], "SubagentStop":[{"hooks":[H(async)]}],
  "Stop":[{"hooks":[H(async)]}], "SessionEnd":[{"hooks":[H(async)]}]}}
```

- `H(...)` = `{"type":"command","command":"<hook command> --provider claude","async":true}` for observational events.
- No hook is blocking (A1).
- Async hooks can arrive out of order. The tracker orders tool rows by `tool_use_id`: a Post before its Pre creates the
  row as `ok`, and the later Pre is ignored.

**Hook normalization** (`normalizeHook('claude', p)` → tracker), from fixtures `claude-hooks-*.jsonl`:

| Hook | Effect |
|---|---|
| `SessionStart` | root `idle` (no Needs you), model |
| `UserPromptSubmit` | root `working`, clears `needs='idle'`. A prompt starting with `<agent-message from=` is a background handback: still working. |
| `PreToolUse` | tool event `running` on `agent_id ?? root`. Never resolves asks (A4). |
| `PostToolUse` / `PostToolUseFailure` | tool event `ok` / `error`. Counters, files, memReads. Resolves an open `pty` permission ask of the same agent and tool name as `answered/terminal`. |
| `PermissionRequest` | `ask.open` on the agent `agent_id ?? root`, kind `permission`, channel `pty`. Options: allow, deny, focus. |
| `Notification{permission_prompt}` | ensure an open permission ask exists (the `pty` channel if none). Confirms the Needs you state. |
| `Notification{idle_prompt}` | root `needs_you/idle`, if not already set |
| `Notification{other}` | `status` event only |
| `SubagentStart` | child node (`externalId = agent_id`, title = `agent_type`). **Ignored when `agent_type` is empty.** |
| `SubagentStop` | ends a known `agent_id` (`report = last_assistant_message`). Unknown or empty-type stops are ignored. |
| `Stop` | if `background_tasks` is non-empty: root stays `working` with activity "Background: n tasks". Else root `needs_you/idle` **immediately** (do not wait for `idle_prompt`), counted only while unseen (A3). Resolves open `pty` permission asks as `answered/terminal`. |
| `SessionEnd` | root `done` (the PTY exit also does this) |

**Interactive permission reply** (A1, A9). No gate. The native TUI dialog stays visible. Hub/banner Allow = `"1"`,
Deny = `"\x1b"` (from `ptyReplyKeys('claude','permission',decision)`), written only after the A9 guard re-detects the
prompt on the current quiet tail. Hive never sends "always" through the PTY. (The gate fixture
`claude-hooks-pty-permreq-allow.jsonl` stays as a hook-shape fixture for headless gemini/cursor gating later.)

**Trust prompt.** No hooks fire before trust is granted. The PTY detector matches
`/Is this a project you created or one you trust|Quick safety check/` and opens a `trust` ask on the `pty` channel with
only `focus`. Hive never auto-answers it.

### 3.3 Gemini, headless (from source; parser runs on fixtures)

**argv**:
```
gemini -o stream-json [--yolo | --approval-mode default] [-m M] [...extra] -p <hint + prompt>
```
`canResume` unchanged (A8). The engine also sets env `GEMINI_CLI_SYSTEM_SETTINGS_PATH=<liveDir>/gemini-system.json` (see 3.5) for hooks.

**`createGeminiParser`** (fixtures `gemini-stream-subagent.jsonl`, `gemini-stream-denied.jsonl`):

| Stream event | Output |
|---|---|
| `init` | `session` + `usage.model` |
| `message` assistant `delta:true` | concatenated into the current text block. Emitted as `text` at each `tool_use`, and at `result`. |
| `tool_use` with `invoke_agent`, or a known agent name (`codebase_investigator`, `cli_help`, `generalist`, `browser_agent`, plus `.gemini/agents/*.md` names the engine lists from cwd and `~` read-only) | `subagent_start{toolUseId: tool_id, type: agent_name, attribution:'timing'}` |
| any other `tool_use` | `tool_use` |
| `tool_result` for a subagent `tool_id` | `subagent_end` (`status` from success/error; no report, since `output` is absent) |
| other `tool_result` | `tool_result` (`denied` when `error.type === 'policy_violation'`) |
| `error` | `error` |
| `result` | `result` with tokens from `stats` and `usage.byModel` from `stats.models` (`costUsd: null`) |

- EOF without a `result` = failure.
- MCP tool names `mcp_hivemem_*` count as memory tools.

**Hooks while headless** (observational only until `HOOKS_VERIFIED.gemini`):
- `BeforeTool`/`AfterTool` lines arriving between the `BeforeTool(invoke_agent)` and the `AfterTool(invoke_agent)` of the
  same `session_id` are attributed to that subagent. Its node gets `attribution: 'timing'`.
- With two or more concurrently open `invoke_agent`s, inner tools go to the root (A8).
- `AfterTool(invoke_agent).tool_response.llmContent` gives the subagent's report.

**Gating** (only when `HOOKS_VERIFIED.gemini && profile.permissionMode === 'default'`):
- Run with `--approval-mode yolo`. `BeforeTool` gets `--gate` for `run_shell_command`, `write_file`, `replace` and
  `mcp_*` except `mcp_hivemem_*`.
- Answers: allow → `{}`; deny → `{"decision":"deny","reason":<msg>}`.
- Hook `timeout` 3_600_000 ms.
- Until the flag flips, `default` profiles keep today's behaviour (Gemini auto-denies headlessly). Hive shows those
  denials as `denied` tool rows plus a `status` event: "Gemini can't ask in headless mode yet".

### 3.4 Cursor, headless (from bundled code; parser runs on fixtures)

**argv**:
```
cursor-agent -p --output-format stream-json [--force] [--model M] --plugin-dir <liveDir>/cursor-plugin [--approve-mcps] [...extra] <hint + prompt>
```
- `canResume` unchanged; no `create-chat` (A8).
- `--approve-mcps` is passed only when the plugin's `mcp.json` is non-empty.

**`createCursorParser`** (fixture `cursor-stream-subagent.jsonl`):

| Stream event | Output |
|---|---|
| `system/init` | `session`, `usage.model` (display name) |
| `assistant` (flush mode) | `text`. In partial mode (only with `--stream-partial-output`, which Hive does not pass), the docs' skip rule applies. |
| `thinking/*` | ignored for output. A `thinking` event (summary only) at `thinking/completed`. |
| `tool_call/started` with `taskToolCall` | `subagent_start{toolUseId: call_id, description, type: subagentType (string or {x:{}} → "x"), attribution:'completion'}` |
| `tool_call/completed` with `taskToolCall` | `subagent_end{status, report: last assistantMessage text, transcript: conversationSteps mapped to text/tool_use/tool_result with agent = call_id}`. The tracker appends that transcript to the child in one batch. |
| other `tool_call/*` | `tool_use` / `tool_result`. Name = oneof key without `ToolCall` (`shell`, `read`, `edit`, `mcp:<server>.<tool>`). The result is `ok` unless its oneof is `failure|rejected|permissionDenied|error|…`. 64-bit strings are converted to numbers. |
| `updateTodosToolCall` | also sets the root `activity` to the in-progress todo |
| `interaction_query/*` | a `status` event ("Question skipped in headless mode") |
| `system/task_notification` | ends a background subagent by `task_id` if known |
| `result/success` | `result` plus `usage` from `usage` (`costUsd: null`) |

**Hooks** (via `--plugin-dir`, observational):
- `subagentStart` creates or binds the child (`tool_call_id` = the Task `call_id`) and sets `attribution: 'exact'` for live lifecycle.
- `subagentStop` ends it, with `summary`.
- Inner `preToolUse`/`postToolUse` are dropped for headless subagents; the transcript arrives at completion (A8).

**Gating** (only when `HOOKS_VERIFIED.cursor && permissionMode === 'default'`):
- `--force` plus blocking `beforeShellExecution`/`beforeMCPExecution` with `failClosed: true` and `timeout: 3600` (seconds).
- Answers: `{"permission":"allow"}` / `{"permission":"deny","agent_message":<msg>}`.
- Until verified: no `--force` for `default` profiles (proposals only, as today). **Never** `--force` with unverified gating.

### 3.5 Per-spawn injection (engine renders, main writes)

New adapter member, parallel to `mcpAttach`:

```ts
hooksAttach?(live: LiveSpawn, opts: { headless: boolean; gate: boolean; memory: McpAttachment | null }): McpAttachment
// LiveSpawn = { dir: string; hookCommand: string }   (hookCommand is a ready-to-use shell command, quoted)
```

| Adapter | Renders |
|---|---|
| claude | `<dir>/claude-settings.json` + args `['--settings', file]`. Interactive always. Headless: none, since the stream carries everything. |
| gemini | **one** system settings file `<dir>/gemini-system.json` holding `hooksConfig.enabled`, `hooks.*`, **and** `mcpServers.hivemem` when memory is attached. This **supersedes** `geminiMcpAttach`'s separate file. Before writing, merge the existing `/Library/Application Support/GeminiCli/settings.json` if present: Hive keys are added; on conflict, the admin file wins, except `hooks`, which are concatenated. Env `GEMINI_CLI_SYSTEM_SETTINGS_PATH`. |
| cursor | dir `<dir>/cursor-plugin/` with `.cursor-plugin/plugin.json {"name":"hive"}`, `hooks/hooks.json` (version 1: `sessionStart, subagentStart, subagentStop, preToolUse, postToolUse, postToolUseFailure, beforeShellExecution, beforeMCPExecution, stop, sessionEnd`) and `mcp.json` (hivemem, only if memory or `ask_user` is attached and MCP is verified). Args `['--plugin-dir', dir]`. |

- Files are written 0600 in dirs 0700, through the existing `writeMcpFiles`.
- `HOOKS_VERIFIED: Record<AdapterId, boolean> = {claude: true, gemini: false, cursor: false, codex: false, shell: false}`
  gates **only blocking gates**. Observational hooks are injected for claude, gemini and cursor on every spawn.
- `LIVE_HOOKS` (same shape, all three true) is the kill switch for injection itself.

### 3.6 Codex and shell

- **Codex**: a root node per session and step. Activity from the existing parser; tokens from `turn.completed`.
  No subagents, no asks.
- **Shell**: a root node for the step, activity = the command, finished with the step.

### 3.7 File-touch and memory-read extraction (`live/summary.ts`)

| Provider | Edit tools → path field | Memory reads |
|---|---|---|
| claude | `Edit`, `MultiEdit`, `Write`, `NotebookEdit` → `file_path` / `notebook_path` | `mcp__hivemem__memory_search`, `mcp__hivemem__memory_get` |
| gemini | `write_file`, `replace` → `file_path` | `mcp_hivemem_memory_search`, `mcp_hivemem_memory_get` |
| cursor | `edit` (and legacy `write`) → `args.path` | `mcp:hivemem.memory_search`, `mcp:hivemem.memory_get` |
| codex | `file_change` → `changes[].path` | `hivemem.memory_search`, `hivemem.memory_get` |

Paths are stored relative to the root's `cwd` when inside it, else absolute. Each node keeps at most 50.

### 3.8 PTY heuristics (fallback, `live/pty.ts`)

`detectPtyPrompt(provider, screenTail): {kind:'permission'|'trust', title, toolHint?} | null` runs on the ANSI-stripped
last 4 KB of output after 300 ms with no new output (main, `SessionLive`).

| Provider | Patterns |
|---|---|
| claude | trust: `Quick safety check\|Is this a project you created or one you trust`. Permission fallback, used only when no hook line has arrived in this session (hooks broken): `Do you want to (proceed\|make this edit)\?` plus `❯\s*1\. Yes` |
| gemini | `Allow execution of\|Apply this change\?\|Do you want to proceed\?` together with `Allow once` |
| cursor | `Run this command\?\|Run this MCP tool\?\|Run this command outside the sandbox\?\|Waiting for approval\.\.\.` |

- A match opens one `pty` ask, deduplicated by title until it clears.
- It clears (`answered/terminal`) when the pattern is absent from the next quiet tail, or when the user writes to the PTY.

`ptyReplyKeys(provider, kind, decision)`:
- claude allow `"1"`, deny `"\x1b"`;
- gemini allow `"\r"`, deny `"\x1b"`;
- cursor allow `"y"`, deny `"n"`;
- trust: none (focus only).

Cursor mode-switch prompts auto-reject after 15 s, so a cursor `pty` ask notifies at once, even with the window focused,
unless that pane is visible.

---

## 4. Needs you and reply

### 4.1 Detection summary

| Situation | Signal | Ask channel / needs |
|---|---|---|
| claude headless permission | `control_request can_use_tool` | `stdio` |
| claude interactive permission | `PermissionRequest` hook (+ `Notification`) | `pty` |
| claude interactive idle | `Stop` with no background tasks | `needs='idle'` (counted while unseen, A3) |
| headless claude step `ask_user` | hivemem tool call | `mcp` |
| gemini interactive permission | `Notification{ToolPermission}` hook, PTY pattern | `pty` |
| gemini interactive idle | `AfterAgent` hook | `needs='idle'` |
| gemini headless permission | gated `BeforeTool` (when verified) | `hook_gate` |
| cursor interactive permission | PTY pattern | `pty` |
| cursor interactive idle | `stop` hook | `needs='idle'` |
| cursor headless permission | gated `beforeShellExecution`/`beforeMCPExecution` (when verified) | `hook_gate` |
| claude folder trust | PTY pattern | `trust` / `pty` (focus only) |

### 4.2 `ask_user` on hivemem (Backend, `src/main/memory/server/tools.ts`)

- **Tool.** `ask_user {question: string (1..2000), options?: string[] (≤ 6, each ≤ 120), allow_text?: boolean = true}`.
  - Description: "Ask the human user a question and wait for the answer. Use when you need a decision or information only the user has. The step pauses until they answer."
  - Annotations: `readOnlyHint: true`. Listed when `HIVE_LIVE_DIR` is set in the server env.
- **Flow.**
  1. The server creates `gate_id = ask_…`.
  2. It appends `{"hive":"ask_user","gate_id","question","options","agent_hint":<_meta claudecode/toolUseId>}` to
     `$HIVE_LIVE_DIR/events.jsonl`.
  3. It waits for `answers/<gate_id>.json`, up to 3600 s.
  4. It returns `{"answer": <text|option label>}`, or `{"answer": null, "note": "The user did not answer; continue with your best judgement."}` on timeout or cancel.
- **Async server.** `McpHandlers.callTool` may return a Promise, and `handleMessage` becomes async. Responses can be out
  of order, which JSON-RPC allows. The server must keep answering `ping` while an ask waits.
- **`server/discover` probe.** Answer it with `{}` (verified to work with claude 2.1.301). Unknown methods keep answering `-32601`.
- **Attachment.** The engine attaches hivemem to every **headless claude** step, whether or not memory is on. Interactive
  sessions: unchanged (memory only, A2).
  - With memory off: `HIVE_MEM_GRANT` is empty and only `ask_user` is listed.
  - The server must not open `memory.db` until a memory tool is called.
  - `--allowedTools` always includes `mcp__hivemem__ask_user`.
  - The claude system-prompt hint appends: "If you need a decision from the user, call the `ask_user` tool (mcp__hivemem__ask_user); do not guess."
  - gemini and cursor get it only when their MCP attach is verified (`MCP_VERIFIED`).
- **Attribution.** For claude, `_meta["claudecode/toolUseId"]` matches the preceding `tool_use` id in the stream or hook.
  The tracker puts the ask on the agent that made that tool call, else on the root.

### 4.3 Reply flows

```
Renderer ──asks:answer{askId, optionId|text, message?}──▶ main
  ask.runId  ─▶ engine.asks.answer(id, a)
                  ├ stdio     → control_response on the step's stdin
                  ├ hook_gate → LiveChannel.writeAnswer(gateId, decision)   (main's fs helper via ctx.live)
                  └ mcp       → LiveChannel.writeAnswer(gateId, {answer})
  ask.sessionId ─▶ SessionLive.answer(id, a)
                  └ pty       → guard (A9), then sessions.write(id, ptyReplyKeys(...))
  → ask row answered/hive, agent event 'answer', agent back to working, emit ask:updated + agent:updated
Renderer ──agents:reply{agentId, text}──▶ main: live session root with needs='idle' → pty.write(text + '\r'); clears idle
```

- `writeAnswer` writes `answers/<gateId>.json.tmp`, then renames it into place (atomic).
- Answering a non-open ask → `conflict` ("Already answered in the terminal").
- `focus` options are handled by the renderer (navigate) and never call `asks:answer`.
- **Any user keystroke** into a session (`sessions:write`) clears `needs='idle'` and resolves that session's `pty` asks
  as `answered/terminal`.

### 4.4 Headless pause, resume and timeouts (AI, executor)

- **Pause.** When an ask opens on a step, the executor calls `handle.pauseTimeout()`.
  - `process.ts` gains a pausable timeout: the remaining ms are kept.
  - The step stays `running` (no new `StepStatus`). The root agent goes `needs_you`. The run stays `running`.
- **Resume.** When the last open ask of the step closes, `resumeTimeout()`.
- **Expiry.** `ASK_TIMEOUT_MS = 60 min` (engine constant). On expiry:
  - stdio: answer deny with "No answer from the user within 60 min";
  - hook_gate: deny;
  - mcp: the server times out on its own at 3600 s; the engine marks the ask `expired`.
  - The ask becomes `expired/timeout`, and main sends a notification "Hive denied … after 60 min".
- **Cancel.** `runs.cancel` first cancels the run's open asks (`canceled`): stdio deny, gate files
  `{"behavior":"deny","message":"Run canceled"}`. Then it kills the process tree as today.
- **Concurrency.** A paused step keeps its semaphore slot. That is the honest cost of waiting; the hub shows it.
- **allow_step.** The memo is per step: `Set<toolName>` for claude stdio. For hook gates it is keyed by the gemini/cursor
  tool name. Not persisted.
- **Room turns and checks** behave the same, since they are steps.

### 4.5 Notifications, badge, tray (Backend)

- `StatusSnapshot.needsYou` = open asks + live session roots with `needs='idle'` that are still unseen (A3).
- The tray title shows `● n  ⚑ k` when k > 0. The tray menu gets a "Needs you" section (up to 5 rows; click → `focusAgent`).
- The dock badge is `app.dock.setBadge(k ? String(k) : '')`.
- **Native notifications.**
  - Every new **permission, question or trust** ask notifies (title `"<root title> needs you"`, body `ask.title`) unless
    the window is focused **and** the owning session pane or run view is visible. The renderer reports the visible
    owner via `ui:visibleOwner` (§12).
  - **Idle** notifies only when the window is unfocused and the session's turn lasted ≥ 20 s, at most once per session
    per 60 s.
  - All notifications follow A7 (per-root coalescing, 3 s grace).
  - Sound follows `notificationSound`.
  - Click → `ui:command {kind:'focusAgent', agentId}`.
- Expired and auto-denied asks notify once.

---

## 5. Live dirs and the hook script (Backend)

```
<userData>/live/<ownerId>/          ownerId = s_… (session) or st_… (step); 0700; removed on exit; swept at boot
  events.jsonl                      appended by the hook script and by hivemem ask_user; tailed by main
  answers/<gateId>.json             written by main (tmp + rename); deleted by the waiter after reading
  claude-settings.json | gemini-system.json | cursor-plugin/   rendered by the engine
```

**Hook script.** `src/main/live/hookMain.ts` is a third electron-vite main entry, built to `out/main/hive-hook.js` and
run from asar like `mcp-memory.js`. It has no dependencies.
- **Command string.** `ELECTRON_RUN_AS_NODE=1 '<process.execPath>' '<…/hive-hook.js>' --events '<dir>/events.jsonl' --dir '<dir>'`,
  with each path single-quoted and escaped (userData contains a space). The adapter adds `--provider <id>` and `--gate`.
- **What it does.**
  1. Read stdin (cap 1 MB) and parse it.
  2. Truncate `tool_response`, `tool_input`, `last_assistant_message` and `prompt` string fields to 2 KB each.
  3. Wrap as `{"v":1,"provider","received_at","gate_id"?,"payload"}`.
  4. Write it with **one** `fs.appendFileSync` call.
  5. With `--gate` (headless gemini/cursor steps only, when verified): wait for `answers/<gate_id>.json` (fs.watch + 250 ms poll, ≤ 3600 s), print the adapter's decision JSON, then append `{"hive":"gate_closed","gate_id"}`.
- It must print only JSON or nothing on stdout, exit 0 on any internal error, and never block longer than the gate wait.
- **Budget.** p50 under 150 ms per invocation. Measure it in `scripts/verify-live-hooks.cjs`. Claude observational hooks
  are `async`, so their latency stays off the critical path.

**Tailer** (`src/main/live/tailer.ts`):
- `fs.watch` on the file, plus a 500 ms poll fallback.
- It reads from the saved byte offset and splits on `\n`, keeping a partial last line until the next read.
- Blank lines are skipped. Non-JSON lines are logged once and dropped.

**LiveBridge** (`EngineContext.live?`, implemented in `src/main/live/bridge.ts`):

```ts
interface LiveBridge {
  open(owner: { stepId: Id; runId: Id } | { sessionId: Id }): LiveChannel
}
interface LiveChannel {
  dir: string                 // created 0700
  hookCommand: string         // quoted base command (adapter appends --provider/--gate)
  mcpEnv: Record<string, string> // { HIVE_LIVE_DIR: dir } for the hivemem server env
  onLine(cb: (line: unknown) => void): void   // parsed JSONL from events.jsonl
  writeAnswer(gateId: string, payload: unknown): void
  close(): void               // stop tailing, delete dir
}
```

---

## 6. Agents hub (F3)

**Navigation.**
- View `agents`. It is the **first** sidebar row, above Home, with a count badge (amber when k > 0) and a live dot when
  anything is working.
- App menu: View > Agents `⇧⌘A`; Go > Next Needs You `⌘J`. `⌘J` focuses the oldest open ask anywhere (`UiCommand nextNeedsYou`).
- The command palette lists every live agent ("Go to …") and every open ask ("Answer …").

**Data.**
- On mount: `agents:list {status: live statuses ∪ ended in last 24 h, rootsOnly: false, limit: 300}` + `asks:list {status:'open'}`.
- Then apply `agent:updated`, `agent:events` and `ask:updated` events. No polling.

**Layout.** Three groups. Repo filter chips sit at the top ("All repos" default).

| Group | Content | Sort |
|---|---|---|
| **Needs you** | roots whose tree has an open ask, or unseen `needs='idle'` (A3) | ask age, oldest first. Permission and question before idle. |
| **Working** | roots `starting \| working` (plus `idle` and seen-idle live sessions, dimmed under "Open sessions", each with a Reply box) | `updatedAt` desc |
| **Done recently** | roots ended within 24 h, at most 30 | `endedAt` desc |

**Row** (root):
- status glyph (amber pulsing for needs_you), provider icon, title (session title, or `<run title> › <node>`), repo name;
- activity line (one line, ellipsized), elapsed (live tick), cost if known else tokens, subagent count chip `2 subagents`;
- the memory chip (§7);
- a disclosure arrow expands children (subagents, recursively) with their own status, activity and elapsed.

**Ask card** (inline under the row in Needs you):
- title, detail (the tool input summary in mono; "Show full input" opens a popover with the redacted JSON);
- buttons from `options`. Defaults: `⌘↩` = allow, `⌘⌫` = deny. A free-text field for questions or a deny message.
- `pty`-channel cards also show "Open terminal".
- Idle rows show a one-line **Reply** box (↩ sends via `agents:reply`) and "Open terminal".
  Above the box, what the agent last said: the root's `report`, set on each turn end from the hook's last assistant
  text (claude `Stop.last_assistant_message`, gemini `AfterAgent.prompt_response`), else the ANSI-stripped PTY tail
  without TUI chrome. A new prompt clears it.
- The "↩ You allowed it" answered trace replaces the activity line only once nothing is pending for that root (no
  open ask in its tree, root not `needs_you`); a row that waits always shows what it waits for.

**Click on a row.**
- Session root → `openSession` (focuses the pane).
- Step root or subagent → `openRun {runId, stepId}`, with the run view expanding the agent.
- Subagent of a session → `openSession`, with the session's subagent strip scrolled to it.

---

## 7. Memory defaults and the chip (F4)

**Defaults (add-only semantics).**
- `Settings.sessionMemory` default `'off'` → **`'read-write'`** (store defaults). Users who saved `'off'` explicitly keep it.
- Workflow editor: new `agent` and `room` nodes get `memory: 'read-write'`; new agent-reviewer `check` nodes get
  `memory: 'read'`; shell and command checks get none.
- The Home/quick prompt run composer sends `memory: 'read-write'`.
- The engine still treats **absent = off**, so existing workflows behave exactly as before.
- "Within the repo" is already enforced by `MemoryService.grant`: no repo means read-only on global, and agents never
  write global (PO2).
- gemini, cursor and codex stay on the `inject` transport (brief only, read) until their MCP attach is verified. The chip says "brief".

**Chip data** ("3 read · 1 saved").
- **Saved** = `MemoryGrantInfo.wrote.facts + wrote.relations` (existing).
- **Read** = sum of `agents.mem_reads` over the step's or session's root and its descendants (new). Counting tool calls
  in hive.db keeps PO4 intact: reads never write `memory.db`.
- `memory:grants` adds `reads: number` to each `MemoryGrantInfo`. Main joins on `step_id` / `session_id`.
- Brief-only grants show `brief` instead of the read count.

**Placement.**
- Run view step rows (existing `StepMemoryMark`), session header, Agents hub rows, canvas node footers.
- Click → `navigate({name:'memory', runId})` for steps, or `{name:'memory', sessionId}` for sessions.
- `MemoryScopeFilter` gains `sessionId?: Id`: facts whose grant has that `session_id` (Backend, memory store).

---

## 8. Home dashboard, "since you were last here" (F5)

**Last seen.**
- `app:dashboard {since?}` uses `since = arg ?? meta.home_last_seen_at ?? now-24h`, clamped to at least now-7d.
- The renderer calls `app:markSeen` when it leaves Home, or when the window blurs after Home was visible for ≥ 5 s.
- The header reads "Since 9:14 yesterday" with a menu: Last visit / 24 h / 7 days.

**Sections, in order, each hidden when empty** (except Live now, which shows "Nothing running").

| Section | Query (main, `src/main/live/dashboard.ts`) |
|---|---|
| **Needs you** | open asks + idle live session roots. Same cards as the hub (shared components). |
| **What got done** | `runs` ended ≥ since (≤ 20, newest first). Per run: status, duration, `costUsd = Σ root agents.cost_usd` (null if all null), `tokens = Σ tokens`, `filesChanged = |∪ root files_json|` (+ first 5 names), up to 4 artifacts (`artifacts` by run_id, images first), and for failures the first failed step `{stepId, nodeId, error first line}` with a **Retry** button (`runs:rerun`). |
| **What agents learned** | `MemoryService.factsSince(since, 10)`: `mem_fact` with `actor='agent'`, status `active\|pending`, created ≥ since, joined with entity name, repo name, grant run_id/run_title. Click → Memory page on that entity. |
| **Activity** (14 days) | per local day from `runs` (created_at, localtime): runs, passed, failed. From root `agents`: tokens and cost by `model_usage_json` keys (fallback to `model` column, then provider). Success rate = passed / (passed + failed) over the window. Three small inline-SVG charts: runs/day (stacked passed/failed bars), tokens/day by model (stacked bars, ≤ 5 models + "other"), spend/day (bars; only days with reported cost; a footnote "Gemini and Cursor don't report cost" when such tokens exist). |
| **Live now** | live roots and their subagents (same row component, compact) |
| **Coming up** | `scheduler.nextRuns(5)` + schedule names and sentences. **Run now** (`schedules:runNow`), **Skip** (`schedules:skipNext`). |
| **Morning brief** (pinned card) | newest artifact with name matching `/^morning-brief.*\.md$/i` (any run). Shows title, age and the first 600 chars via `artifacts:peek`; click → Quick Look. Hidden if none. |

`schedules:skipNext {id}` (engine `scheduler.skipNext(id)`):
- Sets `skip_slot_at = current nextFireAt` and recomputes `nextFireAt` to the next slot after it.
- Logs a `schedule_events` row of kind `skipped` ("Skipped by you"), emits `schedule.updated`.
- If the next fire is already at or after that slot, it does nothing.
- A skipped slot is never fired by the tick or by catch-up.

---

## 9. Engine boundary changes (`src/shared/engine.ts`, add-only)

### 9.1 EngineContext
```ts
interface EngineContext { /* … */ live?: LiveBridge }
interface InteractiveSpawnOptions { /* … */ live?: { dir: string; hookCommand: string; mcpEnv: Record<string,string> } | null }
interface MemoryGrant { /* unchanged */ }
interface McpServerSpec { /* env may also carry HIVE_LIVE_DIR */ }
```
`MemoryBridge` gains `askOnlyServer(): McpServerSpec`, the hivemem spec with an empty grant, used when memory is off.

### 9.2 EngineStore (implemented by main in `engineStore.ts` on top of `liveStore.ts`)
```ts
insertAgent(a: AgentNode): void
updateAgent(id: Id, patch: Partial<Omit<AgentNode,'id'>>): AgentNode
appendAgentEvents(agentId: Id, events: Omit<AgentEvent,'seq'|'agentId'>[]): AgentEvent[]
updateAgentEvent(agentId: Id, toolUseId: string, patch: Pick<AgentEvent,'state'|'detail'>): AgentEvent | null
insertAsk(a: Ask): void
updateAsk(id: Id, patch: Partial<Omit<Ask,'id'>>): Ask
listOpenAsks(q: { runId?: Id; stepId?: Id }): Ask[]
setScheduleFireState(id, { …, skipSlotAt?: ISODate | null })   // extended
```

### 9.3 Engine
```ts
interface Engine {
  /* … */
  asks: { answer(id: Id, a: AskAnswer): Ask }           // run-owned asks only; conflict if not open
  scheduler: { /* … */ skipNext(id: Id): Schedule }
}
```
`src/main/engine/index.ts` also exports these pure helpers for main:
`createAgentTracker`, `normalizeHook`, `detectPtyPrompt`, `ptyReplyKeys`, `summarizeTool`, `HOOKS_VERIFIED`, `LIVE_HOOKS`.

### 9.4 EngineEvent (add-only)
```ts
| { type: 'agent.updated'; agent: AgentNode }
| { type: 'agent.events'; agentId: Id; events: AgentEvent[] }
| { type: 'ask.updated'; ask: Ask }
```
- The engine **coalesces** `agent.updated` per agent at 150 ms and `agent.events` per agent at 100 ms.
- It emits after persisting. Main forwards them to the renderer as `agent:updated`, `agent:events`, `ask:updated`, and
  updates status, tray and notifications.

---

## 10. IPC additions

Exact shapes are in CONTRACT §12. Summary:

| Kind | Name | Shape |
|---|---|---|
| invoke | `agents:list` | `AgentListQuery → AgentNode[]` |
| invoke | `agents:get` | `{id, eventsLimit?} → AgentDetail` |
| invoke | `agents:events` | `{agentId, beforeSeq?, limit?} → AgentEvent[]` |
| invoke | `agents:reply` | `{agentId, text} → V` (live session root with `needs='idle'`; else `conflict`) |
| invoke | `asks:list` | `{status?: 'open' \| 'all', runId?, sessionId?, limit?} → Ask[]` |
| invoke | `asks:answer` | `AskAnswer → Ask` |
| invoke | `app:dashboard` | `{since?} → DashboardData` |
| invoke | `app:markSeen` | `V → V` |
| invoke | `schedules:skipNext` | `{id} → Schedule` |
| send | `ui:visibleOwner` | `{sessionId?: Id \| null; runId?: Id \| null}` (drives notification suppression and A3 "seen") |
| event | `agent:updated` | `AgentNode` |
| event | `agent:events` | `{agentId, events: AgentEvent[]}` |
| event | `ask:updated` | `Ask` |

**Changed shapes (add-only).**
- `StatusSnapshot.needsYou: number`.
- `CanvasSnapshot.agents?: AgentNode[]`: live roots and their descendants, plus the roots of included runs and sessions
  with their subagents (≤ 400).
- `MemoryGrantInfo.reads?: number`.
- `MemoryScopeFilter.sessionId?: Id`.
- `Schedule.skipSlotAt?: ISODate | null`.
- `ScheduleEventKind` adds `'skipped'`.
- `View` adds `'agents'`.
- `UiCommand` adds `{kind:'focusAgent'; agentId}` and `{kind:'nextNeedsYou'}`.
- `ID_PREFIX` adds `agent`, `ask`.

---

## 11. UX notes

- **Color.** Add a token `--status-needs: #f5a524` / `--status-needs-soft` (amber) to `docs/tokens.css` and the renderer
  tokens. Needs you is amber everywhere: glyph, sidebar badge, canvas ring, tray ⚑. Failed stays red.
- **Canvas.**
  - Subagents render as **child pills** stacked under their parent node: 28 px rows inside the node card's footer,
    up to 4 visible plus `+n more`. Each has a status dot, label and live activity.
  - Hovering a pill shows the last 3 events. Clicking selects the agent in the drawer, where `StepDrawer` gains an agent tree.
  - A node with an open ask in its tree gets an amber pulsing ring and an `⚑` badge. Clicking the badge opens the inline ask card in the drawer.
  - Layout stays dagre on nodes only, since pills are inside nodes. No edge explosion.
- **Run view.**
  - Left step list: each step row gets a disclosure when it has subagents. The tree is step → subagent (→ nested).
  - Right pane: the selected agent's event timeline. Tool rows show name + summary + state + duration and expand to
    detail. Text rows show the first 3 lines and expand.
  - The live tail auto-scrolls unless the user scrolled up.
  - An open ask pins an amber card at the top of the right pane.
- **Session view.**
  - A header strip shows the root's activity line and a subagent strip (chips, click → popover with the event list).
  - When `needs_you`: an amber banner above the terminal with the ask card (or an idle Reply box). `Esc` focuses the terminal.
- **Honest degradation labels** (small tertiary text on the subagent pill or tree header):
  - gemini subagents: "activity matched by timing";
  - cursor headless subagents: "details arrive when it finishes";
  - "partial text only for subagents" is not shown (noise);
  - gemini/cursor headless steps with `default` permissions: "can't ask in headless mode yet; denied" on denied tool rows.
- **No polling.** Snapshot + events everywhere. Elapsed time uses the existing `useTick`.
- **Keyboard.** `⌘J` next needs-you, `⇧⌘A` Agents. On an ask card: `⌘↩` allow, `⌘⌫` deny.
- **Copy.** Buttons say exactly what happens:
  - "Allow once";
  - "Allow for this step";
  - "Deny".

---

## 12. File ownership (3 parallel builders)

**Order.** Backend lands the contract commit first (`contract: live`): `src/shared/live.ts`, the add-only edits to
`types.ts`, `ipc.ts` and `engine.ts`, and the schema v2 DDL. Then all three proceed in parallel against fakes. After
that, `src/shared/*` is co-owned and announced.

| Area | Owner | Files |
|---|---|---|
| Contract types | **Backend** (first) | `src/shared/live.ts` (new: AgentNode, AgentEvent, Ask, AskAnswer, AskOption, AgentListQuery, AgentDetail, DashboardData, RunCard, LearnedFact, ActivityDay, ComingUp, enums), add-only edits in `src/shared/types.ts`, `ipc.ts`, `engine.ts`, `memory.ts`, `docs/CONTRACT.md` §12 |
| DB + persistence | **Backend** | `src/main/db/schema.ts` (v2), `db/index.ts` (migration v1→v2, boot recovery for agents/asks, retention), `db/liveStore.ts` (new), `db/engineStore.ts` (new methods), `db/mappers.ts`, `db/store.ts` (settings default `sessionMemory:'read-write'`, `home_last_seen_at`, schedules `skip_slot_at` mapping) |
| Hook script + live I/O | **Backend** | `src/main/live/hookMain.ts` (3rd electron-vite entry → `out/main/hive-hook.js`), `live/bridge.ts` (LiveBridge, dirs, answers), `live/tailer.ts`, `live/sessionLive.ts` (per-session tracker wiring, PTY quiet-tail detector, guarded PTY reply (A9), idle clearing and A3 seen-state, cancel asks on exit (A4)), `live/asks.ts` (ask broker: notify with A7 coalescing, badge, tray), `live/dashboard.ts`, `electron.vite.config.ts`, `scripts/verify-live-hooks.cjs` (per adapter: spawn with hooks, assert events arrive, measure hook latency, print whether `HOOKS_VERIFIED` may flip) |
| MCP | **Backend** | `src/main/memory/server/tools.ts` (`ask_user`), `jsonrpc.ts` (async `callTool`, `server/discover`), `server/main.ts` (lazy DB open, `HIVE_LIVE_DIR`), `memory/service.ts` (`askOnlyServer`, `factsSince`, `reads` in grants, `sessionId` filter), `memory/store.ts` |
| Main wiring | **Backend** | `sessions.ts` (open LiveChannel, pass `live` to `interactiveSpawn`, write() clears idle, close on exit), `hive.ts` (forward agent/ask events, `needsYou` in status, badge), `trayModel.ts`/`tray.ts`, `notify.ts`, `menu.ts` (⇧⌘A, ⌘J), `handlers/agents.ts` + `handlers/asks.ts` (new), `handlers/app.ts` (`app:dashboard`, `app:markSeen`, canvas `agents`), `handlers/schedules.ts` (`skipNext`), `handlers/memory.ts`, `ipcSchemas.ts`, `src/preload/**` (channel lists only), `index.ts` (LiveBridge into EngineContext, boot sweep of `live/`) |
| Parsers + tracker | **AI** | `src/main/engine/parse.ts` (claude fixes, `createGeminiParser`, `createCursorParser`, new NormalizedEvents, `eventToChunk` main-agent only), `engine/live/tracker.ts`, `live/hooks.ts` (normalizeHook claude/gemini/cursor + `ask_user` lines), `live/summary.ts`, `live/pty.ts`, `live/claudeControl.ts` |
| Adapters | **AI** | `engine/adapters.ts` (claude stream-json input + `--permission-prompt-tool stdio`; gemini `-o stream-json`; cursor parser, `--plugin-dir`; `hooksAttach` renderers; `HOOKS_VERIFIED`/`LIVE_HOOKS`; ask_user hint), `engine/memory.ts` (gemini settings merge with hooks; attach hivemem to headless claude steps with `askOnlyServer` when memory is off; `mcp__hivemem__ask_user` in allowedTools; `MCP_TOOL_TIMEOUT` env (A5)) |
| Executor | **AI** | `engine/process.ts` (stdin pipe + `write`/`end`, pausable timeout), `engine/executor.ts` (root agent per step, tracker → store/emit with coalescing, LiveChannel per step, asks: stdio/gate/mcp, allow_step memo, pause/resume, `ASK_TIMEOUT_MS`, cancel → cancel asks, process exit → cancel open asks (A4), close-stdin rule), `engine/index.ts` (`asks.answer`, exports), `engine/scheduler.ts` (`skipNext`, skip slot honored by tick and catch-up) |
| Engine tests | **AI** | `engine/__tests__/live-*.test.ts` against every fixture: claude fg/bg/partial streams, sdk can_use_tool (root + subagent), hooks pty permission/idle/permreq-allow/headless-bg; gemini stream subagent/denied + hooks timing attribution; cursor stream subagent (transcript at completion) + hooks. The cursor/gemini ACP fixtures are reserved for phase 2. |
| Agents hub | **Frontend** | `views/AgentsView.tsx` (new), `components/agents/AgentRow.tsx`, `AgentTree.tsx`, `AgentTimeline.tsx`, `AskCard.tsx`, `ReplyBox.tsx`, `NeedsBadge.tsx`; `state/store.ts` (agents + asks slice fed by events, `focusAgent`, `nextNeedsYou`), `shell/Sidebar.tsx` (top row + badge), `shell/CommandPalette.tsx`, `App.tsx` (route, ⌘J, ⇧⌘A, `ui:visibleOwner` send) |
| Run / Canvas / Session | **Frontend** | `views/RunView.tsx` (step → subagent tree, timeline, pinned ask), `views/CanvasView.tsx` + `lib/graph.ts` (child pills, amber ring, drawer agent tree), `views/SessionView.tsx` (activity strip, subagent chips, Needs you banner) |
| Memory UI | **Frontend** | `components/memory/MemoryChips.tsx` ("n read · m saved", brief, click → filtered Memory page incl. `sessionId`), `views/MemoryView.tsx` (session filter), `views/WorkflowEditor.tsx` + `lib/workflow.ts` (new-node defaults), `views/SettingsView.tsx` (shows the new default) |
| Home | **Frontend** | `views/HomeView.tsx` (dashboard sections), `components/home/*` (RunCard, LearnedList, ActivityCharts with inline SVG, ComingUp, MorningBrief), `docs/tokens.css` + renderer tokens (`--status-needs`) |

**Rules.**
- Nobody edits another owner's files. Shared-file edits are add-only and announced.
- The engine never imports `electron` or main code. Main imports only `src/main/engine/index.ts`.

**Fakes for parallel work.**
- Frontend uses `window.hive` with the new channels answering "not implemented" until Backend lands. It must degrade to
  empty lists and the old Home.
- Backend tests `sessionLive` with recorded hook fixtures through the engine's exported `normalizeHook` and tracker.
- AI tests the executor with a fake `LiveBridge` (in-memory lines + `writeAnswer` spy) and a fake claude that replays
  `claude-sdk-can-use-tool.stream.jsonl` and reads stdin.

---

## 13. Phase 2 (designed, not built in this pass): ACP transport for Gemini and Cursor

- **Transport.** JSON-RPC 2.0 over the child's stdio (`gemini --acp`, `cursor-agent acp`). No TCP.
- **Client.** An engine `live/acpClient.ts`:
  - `initialize` (cursor with `clientCapabilities.subagents = {}`), `session/new {cwd, mcpServers:[hivemem]}`, `session/prompt`;
  - maps `session/update` to tracker inputs, and cursor `subagent_spawned`/child-session updates/`subagent_state_update`
    to exact subagent nodes (`attribution:'exact'`);
  - maps `session/request_permission` to an ask on channel `acp`, answered with the matching option id
    (gemini `proceed_once|proceed_always|cancel`; cursor `allow-once|allow-always|reject-once`);
  - maps `cursor/ask_question` to a question ask.
- **Gate.** Version probe plus an `ACP_VERIFIED` flag per adapter. Fixtures: `gemini-acp-permission.jsonl`,
  `cursor-acp-subagents.jsonl` (strip `dir`).
- **Outcome.** Headless Gemini and Cursor steps get real pausing approvals and, for Cursor, a live subagent tree,
  without relying on unverified hook loading.

## 14. First real run checklist (gemini, cursor)

Run `node scripts/verify-live-hooks.cjs --adapter gemini|cursor --bin <path>` on a machine where the CLI is logged in. It reports:
1. the stream parses with no unknown event types (they are logged);
2. hook lines arrive in `events.jsonl` for SessionStart/BeforeTool/AfterTool (gemini) and for sessionStart/preToolUse/subagentStart (cursor), in `-p` mode;
3. a gated tool blocks, and an answer file allows or denies it;
4. hook p50 latency;
5. whether cursor inner `conversation_id` equals `subagent_id`.

If 2 and 3 pass, flip `HOOKS_VERIFIED[adapter]` (AI) and record the CLI version next to the flag. Until then, Hive
injects observational hooks only, and `default`-permission headless steps behave as today.

## 15. Open risks

- Claude `async` hooks and ordering: handled by `tool_use_id` (§3.2). Nested subagents (depth ≥ 2) were not captured.
  The tracker supports them through `parentAgent`, but this is untested on real output.
- Whether the built-in `AskUserQuestion` goes through `can_use_tool` is unverified. If a `can_use_tool` arrives with
  `tool_name: "AskUserQuestion"`, the tracker opens a **question** ask from `input.questions[0]` and answers allow with
  `updatedInput` carrying the answer. Treat this as best effort, behind a test once a fixture exists.
- `--settings` hooks run alongside the user's own hooks, so slow user hooks add latency Hive cannot remove.
- The gemini system-settings merge depends on the admin file's shape. If it does not parse, Hive skips gemini hook injection for that spawn and logs a warning; the step still runs.
- Interactive PTY replies depend on claude's dialog layout (`1. Yes` first). A9 guards against stale prompts; if the layout changes, the reply returns `conflict` and the user answers in the pane.

## 16. Usage limits, Stalled?, spawn tagging + reaper (Elon's cut #4, #5)

Interface: CONTRACT §13. This section is the behaviour. It does not change F1–F5. Scope cut kept: no cost ledgers, no
`/usage` side-spawns, no limit chips.

### 16.1 Rate limit stop reason + Retry at reset

**Classification** (pure, engine `live/limits.ts`, fixtures in `engine/__tests__/fixtures/limits/`). Only the CLIs' own
wording counts, never an agent's prose about rate limiting:

| Source | Signal | Reset |
|---|---|---|
| claude headless | `rate_limit_event` with `rate_limit_info.status: "rejected"`; assistant message with `error: "rate_limit"`; `result` errors with limit text | `resetsAt` (epoch s), else the text |
| claude interactive | `StopFailure` hook (`error: "rate_limit"`, `last_assistant_message`; added to the observational hook list) and the PTY banner | text |
| claude text | "You've hit your session/weekly/… limit · resets 3pm (Europe/Madrid)", "5-hour limit reached ∙ resets 3pm", "Claude usage limit reached. Your limit will reset at 3pm (…)", "Claude AI usage limit reached\|<epoch>", "API Error: 429 … rate_limit_error" | parsed |
| codex | `error` / `turn.failed` "You've hit your usage limit … try again at 3:05 PM / in 2 days 3 hours 5 minutes", "last status: 429" | parsed |
| gemini | `error` / `result.error` "You have exhausted your capacity/daily quota … Your quota will reset after 2h32m15s", "Usage limit reached for …", "Quota exceeded for quota metric", RESOURCE_EXHAUSTED | parsed |
| cursor | "You've hit your usage limit … Try again at …" (stdout/stderr) | parsed |

- Reset parsing understands clock times (next occurrence; named IANA zone, else local), dates ("Oct 20, 9am"), weekdays,
  ISO stamps ("2026-08-08 00:00 UTC"), relative waits ("in 2 h 5 m", "after 2h32m15s") and the old epoch suffix. Unknown =
  `resetAt: null`. The first precise reset wins (claude's `rate_limit_event` before its minute-rounded banner).
- **Headless steps** (not shell steps): every stdout line and stderr line is classified; the step is `rate_limited`
  only if it *failed* (a CLI that falls back to overage and finishes is fine). The step root agent gets
  `stopReason/resetAt`; the run gets them in the same write as `status: failed` (latest reset among limited steps).
- **Sessions**: the `StopFailure` hook, or the strict banner shapes in the last 12 lines of the quiet PTY tail while the
  root is *not* working (a limit ends the turn; a banner seen mid-turn is old scrollback being redrawn). The episode
  ends when the user types, a new turn starts (`UserPromptSubmit`), or the pane exits; a redraw of the cleared banner
  never re-flags it.

**Retry at reset.** "Retry at reset" = `resetAt + 1 min` (unknown reset: in 1 h).
- Runs: `runs:retryAt` sets `run.retryAt`; the scheduler's 15 s tick (and launch/wake catch-up) reruns it once
  (`trigger: 'rerun'`, `parentRunId`, same `scheduleId`) and records `retryRunId`. Pause stops it like any schedule; a
  retry found more than 12 h late is dropped. "Retry now" = `runs:rerun`.
- **Scheduled runs** (`trigger` `schedule` | `catchup`) that hit the limit get exactly one automatic retry at the reset
  when `Settings.autoRetryRateLimit` (default on). The retry is a `rerun`, so it never retries again.
- Sessions: `sessions:retry` types `continue` + Return into the pane now, or at the reset (a main-process timer; the
  root shows `retryAt`), only if the session is still live and still limited.
- UI: run banner, step chip ("usage limit"), hub row, Home result card and session banner show "Hit usage limit ·
  resets 15:00" with **Retry at reset** (or "Retry in 1 h"), **Retry now**, and "Retry scheduled 15:01" + Cancel.
  Step roots mirror `run.retryAt` until it fires.
- One notification per rate-limited run (replaces its failure notification) and one per session episode.

### 16.2 Stalled?

- A **working** step root or session root with no output (stdout/stderr, PTY bytes) and no hook / events.jsonl line for
  `Settings.stallMinutes` (default 10, 1..240) gets `stalledSince` = when the silence began. One engine-wide monitor for
  steps, one in main for sessions; both sweep every 15 s and read the threshold live.
- Not flagged: steps with an open ask (needs you), session roots that are idle / needs you / starting (waiting for the
  user, or no hooks to tell). Cleared at once by any activity, by an ask opening, or when the owner ends.
- Badge: amber "Stalled?" on the hub row, Home (Needs you / Live now rows), the Canvas card, the sidebar session row and
  the Agents nav row ("Stalled? n" when nothing needs you), the run's step row and the session header. One notification
  per stall. **Never auto-killed.**

### 16.3 Spawn tagging + reaper

- Tag: `HIVE_SPAWN_ID=<st_… | s_…>` + `HIVE_USER_DATA` on every step spawn, PTY session and hivemem MCP child; each
  step / session leads its own process group.
- **When an owner ends** (step exit, cancel, timeout; session exit or kill) its tree is killed: SIGTERM, SIGKILL after
  1.5 s. The tree = the owner's process group + descendants by parent pid (collected *before* the leader is killed, since
  children are re-parented to launchd after) + every process whose `ps -E` env carries the owner's tag and this userData
  (dev servers that `setsid`/detached away) and their groups + descendants a 20 s sampler saw while the owner ran (for
  escapees whose env macOS hides: platform binaries such as `/bin/sleep`). Hive, its ancestors and its own group are
  never touched; neither is another Hive's (different userData) tree.
- A step whose leader exited while an escaped child still holds its stdout/stderr no longer hangs: after 1.5 s its tree
  is reaped, the pipes close and the step ends.
- **Quit**: after sessions and runs stop, every tagged process of this userData is SIGKILLed (also on the guarded
  `app.exit` / signal paths).
- **Launch**: tagged processes of this userData whose owner is not live (an earlier Hive run that died hard) are listed,
  never killed: Home "Needs you" › Leftover processes and Settings › Data › Leftover processes (command, cwd via `lsof`,
  age; Stop / Stop all with a confirm). Stop re-verifies each pid before killing its tree.

### 16.4 Verification

`engine/__tests__/limits.test.ts` (classifier fixtures), `stall.test.ts` (fake clock), `reaper.test.ts` (ps fixture,
fake process table, real fake processes), `limits-exec.test.ts` (executor: stop reason, auto retry fired once by the
scheduler, Stalled? on steps, tree reaped on cancel and on a natural end), `main/__tests__/sessionLimits.test.ts`,
`limitsDb.test.ts`, `sessions.test.ts` (tagging + reap order). The Playwright smoke runs the real app with a throwaway
`HIVE_USER_DATA`, a fake `claude` and a fake login shell.
