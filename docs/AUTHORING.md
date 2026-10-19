# Hive Authoring: Claude builds workflows inside Hive, plus stop-if, worktrees, wait, notify and Claude history

Design for A1–A3. This doc is binding for the three builders. CONTRACT.md "## 14. Authoring" is the interface summary.
If this doc and §14 disagree, §14 wins on shapes and this doc wins on behaviour.

**The user's requirement, verbatim intent:** "I don't want to click to create steps. I describe the workflow to Claude
inside Hive and Claude creates it for me, inside Hive." Everything below serves that loop:

```
user types in a Hive pane ──► Claude (spawned by Hive) ──► hive MCP tools ──► draft
     ▲                                                                         │
     │                                     Approval card (pane + Agents hub + notification)
     └──────── Claude reads the result ◄── Approve → saved to Workflows ◄──────┘
                                           Reject + note → back to Claude
```

Inputs: the current code (`src/main/memory/server/*`, `src/main/live/*`, `src/main/engine/*`, `src/shared/*`),
CONTRACT.md §11–§13, LIVE.md, MEMORY.md, and a read-only look at `~/.claude/projects/**` on this Mac (Claude Code
2.1.289 transcript format: `type` = `user|assistant|system|attachment|ai-title|custom-title|…`, per-session
`<sessionId>/subagents/agent-*.jsonl` + `.meta.json`).

Constraints that apply to everything below:
- **Strictly local.** No TCP listener, no HTTP, no WebSocket. The authoring server is one more stdio MCP child; it
  talks to Hive only through per-owner files under `<userData>/live/<ownerId>/` (the existing LiveBridge mailbox). The
  CONTRACT §9 `lsof` check stays empty.
- **No global CLI config edits.** Never write `~/.claude/settings.json`, `~/.gemini/**`, `~/.cursor/**`. Per-spawn
  `--mcp-config <file>` only. `~/.claude/projects/**` is **read-only** for Hive (A3).
- **Agents never change keys or settings.** The `hive` tool surface has no vault, settings, profile or repo-mutation
  tool, and main's author broker whitelists exactly the tools in §1. Anything that persists or executes needs a human
  click in Hive, except a run the user explicitly pre-allowed (§2.4).
- **Never touch the user's checkout.** Worktrees live under `<userData>/worktrees/`. Hive never runs `checkout`,
  `stash`, `reset`, `clean` or `pull` in a repo's own working tree (§5).
- **Development and QA never touch the installed app.** `/Applications/Hive.app`, its processes and
  `~/Library/Application Support/Hive` are off limits. Always `HIVE_USER_DATA=<throwaway dir>`. Smoke tests that read
  Claude history use `HIVE_CLAUDE_DIRS=<fixture dir>` (§7.1), never the real `~/.claude` in automated tests.
- **Redaction.** Every string Hive persists or emits from drafts, tool results, transcripts or notifications goes
  through `vault.redact` first.

Scope: A1 (authoring tools + approvals + provenance), A2 (stop-if, worktree per run, wait node, notify node, loop
authoring), A3 (Claude history). Nothing else.

### PO amendments (binding; they override any section below that disagrees)

The test is one loop: the user says one paragraph in a Hive claude pane, clicks **one** button, and has a saved,
scheduled (if asked), runnable workflow. Anything that does not serve that loop or close a hole is deleted.

- **PO1. Authoring is for interactive panes only.** The `hive` server is attached to interactive claude sessions
  Hive spawns, and to nothing else in v1. Headless workflow steps get **no** `hive` server. Deleted: step-owned drafts,
  `node:`/`run:` owner keys, the depth guard, the synthetic `author_wait`/`author_done` lines and their StepLive
  handling, step drafts in RunView. Why: a headless reviewer reading an outside contributor's PR diff must never be
  one prompt injection away from proposing or running workflows, and nobody asked for workflows that write workflows.
- **PO2. One card, one click.** `hive_workflow_create` / `hive_workflow_update` take optional `schedule` (the `when`
  object) and `run_now` (`{inputs}`). The card's primary button says what it does: **Approve**, **Approve & schedule**,
  **Approve & run now**, or **Approve, schedule & run now**, and one click does all of it. `hive_schedule_create` is
  **deleted**; scheduling an existing workflow = `hive_workflow_update` with `schedule` (same card, diff may be empty).
  When a notify node wants iMessage and no handle is set, the card shows the handle field inline (the user types it;
  the agent never can).
- **PO3. Standing run permission is pinned to what was approved.** The grant stores the approved workflow's
  `content_hash`. Any later change (agent update or human edit) voids it unless the user ticks the box again on that
  update card. A pre-allowed run may only pass inputs that are **not referenced in any command field** (shell, wait,
  command-check) or that equal their saved default; anything else gets a card. Otherwise an agent with a standing grant
  could run `{{inputs.test_command}}` = anything.
- **PO4. No agent output into a shell.** In an agent-authored draft, `{{node.output}}` / `{{node.transcript}}` inside a
  shell, wait or check `command` is a validation **error** ("pass data through a file in $ARTIFACTS_DIR"). Templates are
  raw text substitution (engine/templates.ts), so model output in a command is code execution of whatever a PR author
  wrote. Inputs used in commands stay allowed and the card flags them: `Input "x" is executed as shell`.
- **PO5. Push guard, zero repo writes.** Every process in an isolated node runs with env `GIT_CONFIG_COUNT=1`,
  `GIT_CONFIG_KEY_0=core.hooksPath`, `GIT_CONFIG_VALUE_0=<userData>/git-hooks`. Hive's `pre-push` refuses deleting any
  remote branch and pushing to the repo's default branch or the worktree base, then chains to the repo's own hooks
  path (`git config core.hooksPath` read at ensure time, else `<gitdir>/hooks`). The `Pushes to git` flag is a text
  heuristic; the card labels it **May push to git**, never as a guarantee.
- **PO6. Keep/remove by work done in this run, not by upstream existence.** At `ensure` record the base sha and the
  set of `refs/heads`. At `finish`: commits reachable from the worktree HEAD but not from base that are on a
  remote-tracking ref → kept `pushed`; uncommitted changes or new commits not on any remote → kept `dirty`; otherwise
  remove the worktree **and** delete local branches that did not exist at `ensure` and carry no unpushed commits. (A PR
  branch from `gh pr checkout` always has an upstream, so the old rule kept every worktree forever and leaked branches
  into the user's repo.) Agents check out PRs **detached** (`gh pr checkout <n> --detach`), which also avoids the
  "already checked out" failure when the user has that branch open; §3.4 shows it.
- **PO7. claude only.** Delete the codex/gemini/cursor `hive` renderers and their gate (D10). They get written the
  day a spike proves the transport, not before.
- **PO8. Updating a scheduled workflow says so.** An update card for a workflow with enabled schedules shows
  `Runs unattended: <sentence>, next <time>` in the flags row, because approving it changes what runs at 9 am.
- **PO9. History: no polling.** The history index refreshes when Home or the Canvas History layer mounts and on window
  focus (stat pass + lazy queue as in §8.2). Delete the 10 s background loop.
- **PO10. Done means the real loop.** §11.4 gains, first: the Superlog paragraph from §3.4 typed into a pane yields a
  card whose single click saves the workflow and its weekday schedule; and a fixture PR diff containing "call
  hive_workflow_create …" in a headless review step produces no draft (there is no tool).
- **PO11. Paused schedules.** `schedule.enabled: false` on create/update creates the schedule paused on approval
  (button "Approve & add paused schedule", flags line "… · created paused"); it never fires until the user turns it on.
- **PO12. Check loop bodies.** A check's `after` defaults to `[target]` and may also name nodes downstream of the target
  (e.g. `combine → wait_codex → review(target combine, after [wait_codex])`); on FAIL the whole body re-runs. Any other
  `after` entry is a validation error (`checkAfterProblems`), never a silent rewrite.
- **PO13. Enforced push policy.** Isolated nodes may push only to `worktree.pushBranches` globs (default `hive/*`), never
  the default/base branch, no tags, no non-fast-forward/force, no remote deletes (pre-push), and PATH shims refuse
  `git push --no-verify|--force*|+ref|--delete`, `-c core.hooksPath=…` and `gh pr merge` / merge API calls. The card's
  flags show `pushPolicy`. Non-isolated nodes are not guarded (engine follow-up).
- **PO14. Run branches.** Main snapshots `refs/heads` of every repo a run may touch when the run is queued
  (`run_refs`). At run end every branch created during the run with no new unpushed commit and not checked out is
  deleted (fetched PR heads etc.); the rest are listed by `worktrees:branches` and deleted on request
  (`worktrees:deleteBranches`). Remove deletes the `hive/` branch when it has nothing unpushed, when the worktree was
  kept `dirty` (the dialog warns), or with `discardWork`.
- **PO15. Typed dry runs, enforced.** Inputs gain `type: 'boolean'` (run-sheet checkbox; value exactly `'true'`/`'false'`,
  templated as that text; anything else is refused by the sheet, `hive_workflow_run` and `runs.start`). A workflow that
  pushes or writes PRs may not gate on a free-text flag input (`freeTextFlagGates`, a `hive_workflow_validate` error).
  A boolean `dry_run` = true gives every step `HIVE_DRY_RUN=1` and makes the worktree's pre-push refuse **every** push.
  The pre-push is installed worktree-locally (`extensions.worktreeConfig` + `git config --worktree core.hooksPath`),
  so it also applies to git processes Hive did not spawn; the repo's hooks and the main checkout are untouched. The card
  shows the enforced policy (`flags.pushPolicy`). Check-loop fix rounds repeat the step's dry-run lines (+ Hive's dry-run
  sentence). Remove/cleanup deletes Hive's recorded `hive/` branch only when it was created by the run and never pushed.

---

## 0. Decisions at a glance

| # | Decision | Why |
|---|---|---|
| D1 | A **sibling stdio MCP server named `hive`** (`out/main/mcp-hive.js`), not more tools on `hivemem`. | hivemem's tool list depends on the memory grant and it opens `memory.db`; authoring must exist even with memory off, and must never open any DB. Separate server = separate allow-list, no grant coupling. |
| D2 | The `hive` server holds **no state and opens no database**. Every tool call is forwarded to main through the owner's live dir mailbox (`events.jsonl` line + `answers/<callId>.json`), exactly like `ask_user`. | One authority (main) validates, persists and attributes. The caller's identity comes from *which live dir* the line arrived in, never from the line's content, so a forged line can only create a draft that a human must approve. |
| D3 | Approvals are **Asks** of a new kind `approval`, channel `author`, plus an `author_drafts` row holding the payload. | Reuses Needs you counting, coalesced notifications (A7), tray, dock badge, hub list, pause-timeout-while-waiting. |
| D4 | Writes **block** (default 600 s, max 3300 s) until the user decides, then return the decision. A timeout returns `pending` + `draft_id`; `hive_draft_status` continues waiting. | In a pane the user is right there: Claude says "Approve it in Hive", the card is pinned above the terminal, and Claude continues the moment they click. |
| D5 | Authored JSON **is the existing `WorkflowDraft`** with two conveniences normalized by main before validation: `profileId` may be an adapter name (`"claude"`), and omitted fields get editor defaults. | One format. What Claude writes is what the editor shows and what export writes. |
| D6 | stop-if = an **output contract**: the step's last non-empty output line `HIVE_STOP: <reason>`. Run ends `passed` with `outcome: 'nothing_to_do'`, downstream nodes are skipped, no notification. | Works for agent, shell and wait nodes with zero new UI; trivially authorable by Claude. No separate gate node. |
| D7 | Worktree per run is a **workflow-level** `worktree` block + a **node-level** `isolate: 'worktree'` opt-in. Created lazily before the first isolated node; all isolated nodes share it. | One branch per run, nodes that only read (scan, notify) don't pay for it. |
| D8 | New node types **`wait`** and **`notify`**. Both run in the engine without an agent CLI. | Needed for "wait for Codex review comments" and "text me the roundup". |
| D9 | Claude history is an **index in hive.db** (`claude_history`, keyed by file path, invalidated by `(size, mtimeMs)`) built lazily and incrementally; transcripts are parsed on demand for preview. | Fast on hundreds of files; never writes to `~/.claude`. |
| D10 | `hive` is attached to **interactive claude panes only** (PO1, PO7). No renderers for other adapters and no headless attach in v1. | Never ship an attach path we have not seen work, nor a write surface nobody asked for. |

---

## 1. The `hive` MCP server and its tools

### 1.1 Process and attachment

- Fourth electron-vite main entry: `src/main/author/server/main.ts` → `out/main/mcp-hive.js`. Runs from `app.asar`
  like `mcp-memory.js` (zod resolves from asar; no native modules).
- Spawned by the agent CLI from a per-spawn MCP config: `command = process.execPath`, `args = [<main dir>/mcp-hive.js]`,
  `env = { ELECTRON_RUN_AS_NODE: '1', HIVE_LIVE_DIR: <owner live dir>, HIVE_SPAWN_ID, HIVE_USER_DATA }`.
  Nothing else: no DB path, no secrets, no grant id.
- stdio JSON-RPC, same `serveStdio` loop as hivemem (`src/main/memory/server/jsonrpc.ts`, reused, async `callTool`,
  `ping` answered while a call waits, `notifications/cancelled` aborts the waiting call).
- **Who gets it (PO1, PO7).** Interactive claude sessions spawned by Hive, nothing else. Sessions already open a
  LiveChannel (`sessions.ts`); the session passes `HIVE_LIVE_DIR` to the `hive` server only (hivemem keeps A2: no
  `ask_user` in panes). Headless steps and other adapters: no `hive` server.
- **claude argv.** One per-spawn config file `<spawnDir>/<spawnId>.mcp.json` holding every Hive server for that spawn
  (`hivemem` when granted, `hive` always). `--mcp-config <file> --allowedTools <list>`; the list adds
  `mcp__hive__<tool>` for every tool in §1.3 (writes are pre-allowed because Hive's own approval card is the gate;
  a second CLI permission prompt would be noise). Never `--strict-mcp-config`.
- **Timeout.** Spawns that attach `hive` set env `MCP_TOOL_TIMEOUT=3700000` (headless already does; sessions now too),
  per spawn only.
- **Server instructions** (MCP `initialize.instructions`, ≤ 1,500 chars):
  > Hive tools let you build and run Hive workflows for the user. Before writing a workflow, call
  > hive_workflow_schema once and hive_profiles_list / hive_repos_list for real ids. Validate with
  > hive_workflow_validate, then hive_workflow_create. The user approves in Hive; tell them a card is waiting. If they
  > reject, read the note, fix, and call hive_workflow_update or hive_workflow_create again. Never invent profile or
  > repo ids. You cannot change keys, settings or profiles.
- **Interactive system-prompt hint** (claude, appended to the existing `--append-system-prompt`, new conversations
  only): "You are running inside Hive. When the user asks for a workflow, automation, routine or schedule, build it with
  the mcp__hive__* tools instead of describing steps for them to click."

### 1.2 The mailbox (server ⇄ main)

Server, per call:
1. `callId = 'hac_' + 10 [0-9a-z]` (same generator as `newGateId`).
2. Append one line to `$HIVE_LIVE_DIR/events.jsonl`:
   `{"hive":"author_call","call_id":"hac_…","tool":"hive_workflow_create","args":{…},"agent_hint":"<claudecode/toolUseId>"}`
   Args > 256 KB → error result "Workflow too large" without writing.
3. Block on `$HIVE_LIVE_DIR/answers/<callId>.json` (reuse `waitForAnswer`, fs.watch + 250 ms poll), timeout =
   `(args.wait_s ?? default) + 30 s` for write tools, 30 s for reads.
4. The answer file is the full tool result: `{ok: true, result: {...}}` or `{ok: false, error: "..."}`. The server
   returns `result` as one JSON text item + `structuredContent` (≤ 24,000 chars for `hive_workflow_schema`, ≤ 12,000
   otherwise; main trims lists and sets `truncated: true`).
5. On `notifications/cancelled` or stdin EOF: append `{"hive":"author_cancelled","call_id"}` and stop waiting. Main
   cancels the call's pending wait (a draft stays pending; it is not withdrawn).

Main (`src/main/live/bridge.ts` routes, `src/main/author/broker.ts` handles):
- The bridge intercepts lines with `hive: 'author_call' | 'author_cancelled'` **before** delivering to channel
  callbacks, and calls `deps.onAuthorCall(owner, line, writeAnswer)`. `owner` is the channel's `LiveOwner`
  (`{sessionId}` or `{stepId, runId}`), which is the only identity the broker trusts.
- For calls that will wait on a human, the bridge also delivers synthetic lines to the channel callbacks:
  `{"hive":"author_wait","ask_id"}` when the approval Ask opens and `{"hive":"author_done","ask_id"}` when it resolves.
  The engine's StepLive treats them like an open/closed ask: root `needs_you`, step timeout paused (LIVE.md §4.4).
- Unknown tool → `{ok:false, error:"Unknown tool"}`. A tool not in the whitelist is never dispatched.
- Rate limits per owner: ≤ 60 calls/min, ≤ 5 pending drafts. Exceeding → error result, nothing persisted.

### 1.3 Tool list and exact input schemas

All tools return `{ ... }` objects as described. All string ids are Hive ids (`wf_…`, `repo_…`, `prof_…`, `r_…`,
`adr_…`). `annotations` are the MCP hints the server sends.

#### `hive_workflow_schema` (read)
Teaches the agent the workflow format (§3). Call once per conversation.
```json
{
  "type": "object",
  "properties": {
    "topic": { "type": "string", "enum": ["all", "nodes", "templating", "contracts", "examples"], "default": "all" }
  },
  "additionalProperties": false
}
```
Returns `{ version: 1, nodeTypes, workflowFields, templating, contracts, validationRules, tips, examples }` (§3.2).
`annotations: { readOnlyHint: true }`.

#### `hive_repos_list` (read)
```json
{ "type": "object", "properties": {}, "additionalProperties": false }
```
Returns `{ repos: [{ id, name, path, exists, isGit, defaultBranch }] }`. `defaultBranch` = `origin/HEAD` target, else
`main`/`master` if present, else `null` (computed lazily, cached 10 min). `readOnlyHint`.

#### `hive_profiles_list` (read)
```json
{ "type": "object", "properties": {}, "additionalProperties": false }
```
Returns `{ profiles: [{ id, name, adapter, model, permissionMode, available, isDefault, memory: "mcp"|"inject"|null, headlessAsks }], defaults: { claude: "prof_…"|null, codex: …, gemini: …, cursor: …, shell: … } }`.
`available` = the adapter's CLI is installed. No `secretNames`, no `extraArgs`. `readOnlyHint`.

#### `hive_workflow_list` (read)
```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string", "maxLength": 120, "description": "Substring of name or description." },
    "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 30 }
  },
  "additionalProperties": false
}
```
Returns `{ workflows: [{ id, name, description, nodeCount, nodeTypes, inputs: [{name,label,type}], updatedAt, origin, schedules: [{id, sentence, enabled}], lastRun: {id, status, outcome, endedAt} | null }] }`. `readOnlyHint`.

#### `hive_workflow_get` (read)
```json
{
  "type": "object",
  "properties": { "id": { "type": "string", "pattern": "^wf_[0-9a-z]{10}$" } },
  "required": ["id"],
  "additionalProperties": false
}
```
Returns `{ workflow: Workflow }` (full draft incl. nodes, `origin`). `readOnlyHint`.

#### `hive_workflow_validate` (read)
```json
{
  "type": "object",
  "properties": { "workflow": { "$comment": "WorkflowDraft, see 1.4", "type": "object" } },
  "required": ["workflow"],
  "additionalProperties": false
}
```
Returns `{ ok: boolean, errors: ValidationError[], warnings: string[], normalized: WorkflowDraft }`. `errors` come from
`engine.workflows.validate(normalized)` plus authoring checks (§3.3). `warnings`: unavailable adapters, shell nodes
present (the card will flag them), a `cwd` outside every repo, a check whose target is never re-run, notify with
iMessage but no handle configured. `readOnlyHint`.

#### `hive_workflow_create` (write, approval)
```json
{
  "type": "object",
  "properties": {
    "workflow": { "$comment": "WorkflowDraft, see 1.4", "type": "object" },
    "summary": { "type": "string", "minLength": 10, "maxLength": 800, "description": "For the approval card: what it does, when, what it touches. Plain words." },
    "schedule": { "$comment": "optional; the `when` object: {kind:'cron', cron, tz?} | {kind:'at', at}, plus optional name and inputs (PO2)", "type": "object" },
    "run_now": { "$comment": "optional {inputs}; approving also starts one run (PO2)", "type": "object" },
    "wait_s": { "type": "integer", "minimum": 0, "maximum": 3300, "default": 600, "description": "How long to wait for the user's decision. 0 = return at once." }
  },
  "required": ["workflow", "summary"],
  "additionalProperties": false
}
```
Behaviour: normalize → validate. Invalid → `{ status: "invalid", errors, warnings }`, nothing persisted, no card.
Valid → insert `author_drafts` (`kind: 'create'`), open Ask, notify, wait. Identical pending draft (same owner, same
content hash) → reuses it. Returns one of:
- `{ status: "approved", draft_id, workflow_id, edited: boolean, run_allowed: boolean, note: string|null, schedule_id?: string, sentence?: string, run_id?: string }`
  (`schedule` is checked with `engine.scheduler.preview(when)` before the card opens; a preview error → `invalid`)
  (`edited` = the user changed it in the editor before approving; call `hive_workflow_get` to see the final version)
- `{ status: "rejected", draft_id, note: string|null }`
- `{ status: "pending", draft_id, note: "The user has not decided yet. Do not create a duplicate; call hive_draft_status." }`
- `{ status: "invalid", errors, warnings }`

#### `hive_workflow_update` (write, approval)
```json
{
  "type": "object",
  "properties": {
    "id": { "type": "string", "pattern": "^wf_[0-9a-z]{10}$" },
    "workflow": { "$comment": "full WorkflowDraft (not a patch)", "type": "object" },
    "summary": { "type": "string", "minLength": 10, "maxLength": 800, "description": "What changed and why." },
    "wait_s": { "type": "integer", "minimum": 0, "maximum": 3300, "default": 600 }
  },
  "required": ["id", "workflow", "summary"],
  "additionalProperties": false
}
```
Any workflow may be targeted (not only the agent's own); the card shows a diff (§2.2). Same results as create.
`conflict` result if the workflow changed after the agent last read it is **not** enforced (the card's diff is against
the current saved version, so the user sees exactly what would change).

#### `hive_draft_status` (read, may wait)
```json
{
  "type": "object",
  "properties": {
    "draft_id": { "type": "string", "pattern": "^adr_[0-9a-z]{10}$" },
    "wait_s": { "type": "integer", "minimum": 0, "maximum": 3300, "default": 0 }
  },
  "required": ["draft_id"],
  "additionalProperties": false
}
```
Only drafts of the calling owner. Returns the same result shapes as the tool that created the draft (create, update,
run, schedule). `readOnlyHint`.

#### `hive_workflow_run` (write, approval unless pre-allowed)
```json
{
  "type": "object",
  "properties": {
    "workflow_id": { "type": "string", "pattern": "^wf_[0-9a-z]{10}$" },
    "inputs": { "type": "object", "additionalProperties": { "type": "string", "maxLength": 20000 }, "description": "Input name -> value. repo inputs take a repo id." },
    "reason": { "type": "string", "maxLength": 400, "description": "Shown on the approval card." },
    "wait_s": { "type": "integer", "minimum": 0, "maximum": 3300, "default": 600, "description": "Wait for approval (not for the run to finish; use hive_run_get)." }
  },
  "required": ["workflow_id"],
  "additionalProperties": false
}
```
Unknown input names → `invalid`. Missing inputs take their defaults. Returns `{ status: "started", run_id, approved_by: "user"|"standing_permission" }`, `rejected`, `pending` or `invalid`. Rules in §2.4.

#### `hive_run_get` (read, may wait)
```json
{
  "type": "object",
  "properties": {
    "run_id": { "type": "string", "pattern": "^r_[0-9a-z]{10}$" },
    "wait_s": { "type": "integer", "minimum": 0, "maximum": 3300, "default": 0, "description": "Wait until the run ends or this many seconds pass." },
    "output_chars": { "type": "integer", "minimum": 0, "maximum": 4000, "default": 1500 }
  },
  "required": ["run_id"],
  "additionalProperties": false
}
```
Any run the user can see. Returns `{ run: { id, title, status, outcome, reason, startedAt, endedAt, worktree }, steps: [{ nodeId, nodeType, attempt, status, verdict, halt, error, output (tail, output_chars) }] }`. `readOnlyHint`.

#### ~~`hive_schedule_create`~~ (DELETED by PO2: use `schedule` on create/update. Kept below only as the `when` reference.)
```json
{
  "type": "object",
  "properties": {
    "workflow_id": { "type": "string", "pattern": "^wf_[0-9a-z]{10}$" },
    "name": { "type": "string", "minLength": 1, "maxLength": 120 },
    "inputs": { "type": "object", "additionalProperties": { "type": "string", "maxLength": 20000 } },
    "when": {
      "type": "object",
      "description": "Either {kind:'cron', cron:'0 9 * * 1-5', tz:'Europe/Madrid'} or {kind:'at', at:'<ISO>'}. tz defaults to the Mac's zone.",
      "properties": {
        "kind": { "type": "string", "enum": ["cron", "at"] },
        "cron": { "type": "string", "maxLength": 120 },
        "tz": { "type": "string", "maxLength": 64 },
        "at": { "type": "string", "format": "date-time" }
      },
      "required": ["kind"],
      "additionalProperties": false
    },
    "summary": { "type": "string", "minLength": 10, "maxLength": 800 },
    "wait_s": { "type": "integer", "minimum": 0, "maximum": 3300, "default": 600 }
  },
  "required": ["workflow_id", "name", "when", "summary"],
  "additionalProperties": false
}
```
Validated with `engine.scheduler.preview(when)` first (`invalid` with the preview error, e.g. "Minimum interval is 5
minutes"). Approve → `schedules:create` path (`enabled: true`, `preset` derived when the cron matches a UI preset).
Returns `{ status: "approved", draft_id, schedule_id, sentence }` | `rejected` | `pending` | `invalid`.

Not provided (by design): delete workflow, delete/edit schedule, anything under `secrets:*`, `settings:*`,
`profiles:*`, `repos:*` mutations, `memory:*` (agents use hivemem), `processes:*`.

### 1.4 The `workflow` argument

`workflow` is a `WorkflowDraft` (`src/shared/types.ts`) with the §4 additions. The server's input schema keeps
`workflow` as an open `object` (one node `items` schema with all union fields, `required: ["id","type"]`), because CLI
schema support for `oneOf` varies; **main** validates strictly with zod (`src/main/author/draftSchema.ts`) and returns
precise `ValidationError`s. Normalization (`normalizeAuthoredDraft`, pure, `src/shared/authoring.ts`, also used by the
renderer preview):

| Field | If omitted / shorthand | Becomes |
|---|---|---|
| `description` | — | `''` |
| `inputs` | — | `[]`; each input `label` defaults to `name`, `type` to `'text'` |
| node `label` | — | the node id |
| node `after` | — | `[]` (template refs and check targets are dependencies anyway, CONTRACT E2) |
| node `cwd` | — | `null` |
| node `timeoutMin` | — | 30 (agent, room, shell, check), 60 (wait), 1 (notify) |
| node `memory` | — | `'read'` for agent/room/agent-check, `'off'` for shell/wait/notify/command-check |
| `profileId` / `participants[].profileId` | adapter name `"claude"`, `"codex"`, `"gemini"`, `"cursor"` | that adapter's default profile id; unknown/unavailable → validation error naming `hive_profiles_list` |
| `cwd` | absolute path equal to a repo's path | that `repo_…` id |
| check `after` | anything | `[target]` (B9) |
| check `maxRetries` | — | 2 |
| check `profileId`/`command` | both absent | validation error |
| room `rounds` / `final` | — | 2 / `'summary'` |
| wait `intervalSec` / `until` / `onTimeout` | — | 60 / `'exit0'` / `'fail'` |
| notify `imessage` | — | `false` |

Unknown fields → validation error (strict), so typos never silently disappear.

---

## 2. Approval flow, permissions, provenance

### 2.1 Draft lifecycle

```
            create/update/run/schedule call
                       │ valid
                       ▼
   pending ──Approve──► approved (workflow saved / run started / schedule created)
      │   ──Reject────► rejected (note returned to the agent)
      │   ──Edit in editor → Save──► approved (edited: true)
      └── owner ends (session exit / step end) → still pending, card stays; agent no longer waiting
          after 7 days pending → expired (card removed)
```

`author_drafts` row (hive.db, created with `CREATE TABLE IF NOT EXISTS`, no version bump, like CONTRACT §13.5):

| Column | Meaning |
|---|---|
| `id` | `adr_…` |
| `kind` | `create` \| `update` \| `run` \| `schedule` |
| `status` | `pending` \| `approved` \| `rejected` \| `expired` |
| `owner_kind`, `session_id`, `run_id`, `step_id`, `agent_id` | who asked (from the live dir) |
| `owner_key` | identity for run permissions (§2.4) |
| `owner_label` | "example-project · Claude" or "Morning brief › summarize" (redacted) |
| `adapter` | caller's adapter |
| `summary` | agent's summary (redacted, ≤ 800) |
| `workflow_id` | update/run/schedule target; create: set on approve |
| `payload_json` | normalized `WorkflowDraft` (create/update), `{inputs, reason}` (run), `ScheduleInput` (schedule) |
| `base_json` | update: the saved workflow at draft time (for the diff) |
| `content_hash` | sha256 of payload (dedupe) |
| `ask_id` | the Ask |
| `decision_note`, `decided_at`, `edited`, `run_allowed`, `result_json` | outcome |
| `created_at` | |

### 2.2 The approval card

One component, `ApprovalCard` (renderer), shown in three places:
1. **Session pane**: pinned directly above the terminal of the session that asked (SessionView), so the user never
   leaves the conversation. This is why a blocking tool is acceptable in a pane (LIVE.md A2's concern was a question
   hidden from the terminal; here the card is in the pane and Claude's own TUI shows the tool call running).
2. **Agents hub** › Needs you (like every Ask), and RunView for step-owned drafts.
3. **Native notification** (A7 coalescing, suppressed when the owner is the visible owner): title "Claude wants to
   create a workflow", body = workflow name. Click → `ui:command {kind:'openApproval', draftId}`.

Card content (from `author:get`, `AuthorDraftDetail`):
- Header: kind verb ("Create workflow" / "Update workflow" / "Run workflow" / "Schedule workflow"), name, owner label,
  adapter icon, time.
- Agent's **summary** (plain text).
- **Mini graph**: read-only `GraphView` of the draft (same dagre layout as the editor, node chips colored by type, check
  loop-back arrow, isolated nodes with a branch glyph). Update: added nodes green, removed red (ghost), changed amber.
- **Readable node list**: per node `type · label · agent (profile name) · folder`, prompt/topic/criteria collapsed to
  2 lines with "more". **Shell, wait and command-check commands are always shown in full, monospace**, never collapsed.
- **Flags** row (computed by main, `AuthorFlags`): `Runs shell commands (n)`, `Uses a git worktree of <repo>`,
  `Pushes to git` (a command or prompt mentions `git push`/`gh pr create`), `Sends iMessage to <handle>`,
  `Agents with bypass permissions (n)`, `Uses memory read-write`, `Schedule: <sentence>` (when `schedule` is set),
  `Inputs: name=value` (run kind / `run_now`), `Input "x" is executed as shell` (PO4), `Runs unattended: <sentence>,
  next <time>` (update of a scheduled workflow, PO8). `Pushes to git` is displayed as **May push to git** (PO5).
- Primary button label per PO2 (Approve / Approve & schedule / Approve & run now / Approve, schedule & run now).
- Validation warnings (from §1.3 validate).
- Actions: **Approve** (⌘↩), **Reject** (⌘⌫; optional note field, ≤ 2,000 chars), **Edit in editor** (create/update:
  opens WorkflowEditor on the draft, unsaved; its Save button reads "Approve & save" and calls `author:decide` with the
  edited draft), and for create/update a checkbox **"Allow this agent to run workflows it created"** (default off).

### 2.3 Deciding (`author:decide`)

- Approve create → `workflows:create` path (engine validate again; a failure keeps the draft pending and shows the
  errors on the card) with `origin` set (§2.5). Approve update → `workflows:update` path, `origin.updatedBy` appended.
- Approve run → `engine.runs.start({kind:'workflow', workflowId, inputs}, {trigger:'agent', startedBy})`.
- Approve schedule → `schedules:create` path.
- Reject → `status='rejected'`, note stored. Approval Ask → `answered` (`answeredVia: 'hive'`), then the answer file for
  the waiting call is written with the result. If no call is waiting (timed out or owner ended), the result is kept for
  `hive_draft_status`.
- `asks:answer` on an approval Ask maps `optionId 'approve'|'reject'` + `message` to `author:decide` (tray and hub
  keyboard paths keep working).
- `data:changed {domain:'workflows'}` / `'schedules'` after approval; `author:updated` always.

### 2.4 Running workflows (permissions)

- `hive_workflow_run` needs an approval card **unless** a standing permission exists for `(workflow_id, owner_key)`.
- A standing permission is created only by the checkbox on a create/update card, only for that workflow, and only when
  the workflow's `origin.ownerKey` equals the caller's `owner_key` ("workflows it created").
- `owner_key`: interactive claude session → `claude:<agentSessionId>` (survives Restart, which resumes the same
  conversation). No other owner kinds exist (PO1).
- Table `author_run_grants (workflow_id, owner_key, owner_label, content_hash, created_at)`. A grant applies only while
  the saved workflow's hash equals `content_hash`; any change voids it (PO3). Settings › Agents lists them with
  Revoke (`author:revokeRun`). Deleting the workflow deletes its grants.
- Pre-allowed runs: every input referenced in a shell/wait/check `command` must be absent or equal its default, else a
  card (PO3).
- Runs started by an agent: `trigger: 'agent'`, `startedBy: { draftId|null, ownerLabel, ownerKey }`. Max 3
  agent-started runs active per owner (`conflict` result).
- Schedules always need a card (they ride on the create/update card, PO2).

### 2.5 Provenance

`Workflow.origin` (new, optional, persisted in `workflows.origin_json`):
```ts
interface WorkflowOrigin {
  kind: 'agent'
  adapter: AdapterId               // 'claude'
  ownerLabel: string               // "example-project · Claude"
  ownerKey: string
  sessionId: Id | null
  runId: Id | null
  stepId: Id | null
  draftId: Id
  approvedAt: ISODate
  edited: boolean                  // the user changed it before approving
  updatedBy?: { draftId: Id; ownerLabel: string; at: ISODate }[]   // later agent updates (≤ 20 kept)
}
```
Renderer: WorkflowsView row and WorkflowEditor header show **"Created by Claude in example-project · Claude"** (adapter label
+ owner label), with a link that opens the session (or run). Human edits after approval do not clear `origin`; the
editor shows "edited since". Export (`WorkflowFile`) omits `origin`.

---

## 3. How `hive_workflow_schema` teaches the agent

### 3.1 Source of truth

`src/shared/authoring.ts` (pure, no Node/DOM) exports `AUTHORING_SCHEMA` (the object returned by the tool),
`normalizeAuthoredDraft`, `authorFlags`, and `EXAMPLES`. A test (`src/main/author/__tests__/schema.test.ts`) runs every
example through `normalizeAuthoredDraft` + the engine's `validateWorkflow` with fake profiles/repos and fails if any is
invalid, so the teaching material can never drift from the engine. The AI builder updates `nodeTypes` text whenever a
node type changes.

### 3.2 What it returns (`topic: 'all'`)

```jsonc
{
  "version": 1,
  "workflowFields": {
    "name": "string, required",
    "description": "string",
    "inputs": "[{name:/[a-zA-Z_][a-zA-Z0-9_]*/, label, default?, type?: 'text'|'multiline'|'repo'}] -> {{inputs.name}}; repo inputs take a repo id and render as its absolute path",
    "nodes": "array, >= 1",
    "worktree": "optional {repo: repo id | '{{inputs.X}}', base?: branch (default: repo default branch)} - see isolate"
  },
  "nodeTypes": {
    "common": "id: lowercase slug unique; label; after: [ids]; cwd: repo id | absolute path | '{{inputs.repo}}' | null (scratch); timeoutMin 1-1440; memory: off|read|read-write; isolate?: 'worktree' (runs in the run's git worktree; needs workflow.worktree)",
    "agent":  "profileId (id or 'claude'|'codex'|'gemini'|'cursor'), prompt. Output = the agent's final message.",
    "room":   "participants [{profileId, label}] >= 2, topic, rounds 1-10, final 'last'|'summary'. Agents debate in turns.",
    "check":  "target: an agent node id; reviewer = profileId (agent reviewer, criteria required, must end with 'VERDICT: PASS' or 'VERDICT: FAIL') OR command (exit 0 = PASS). On FAIL the target (and nodes between target and check) re-run with the feedback, up to maxRetries 0-5. This is how you build loops.",
    "shell":  "command run with $SHELL -lc in cwd. Output = trimmed stdout. Non-zero exit fails the run.",
    "wait":   "command re-run every intervalSec (5-3600) until it exits 0 (until 'exit0') or its stdout matches pattern (until 'match', JS regex) within timeoutMin; onTimeout 'fail'|'continue'. Output = last attempt's stdout.",
    "notify": "title, message (templated), imessage true|false. Posts a macOS notification; with imessage also texts the user's handle from Settings. Output = the message sent."
  },
  "templating": {
    "syntax": "{{inputs.NAME}}, {{NODE.output}}, {{NODE.transcript}} (rooms), {{ARTIFACTS_DIR}}, {{WORKTREE_DIR}}, {{WORKTREE_BRANCH}}. Nothing else; no filters, no expressions.",
    "dependencies": "Referencing {{x.output}} makes the node run after x automatically.",
    "env": "Steps also get $ARTIFACTS_DIR, $HIVE_RUN_ID, $HIVE_REPOS, and in isolated nodes $HIVE_WORKTREE, $HIVE_WORKTREE_BRANCH."
  },
  "contracts": {
    "stop": "Any agent, shell or wait node may end the whole run early as 'nothing to do' by making the LAST non-empty line of its output exactly: HIVE_STOP: <short reason>. The run ends passed, later nodes are skipped, the user is not notified. Use it right after a scan step.",
    "verdict": "Agent reviewers (check) must end with VERDICT: PASS or VERDICT: FAIL; the text above it is the feedback.",
    "artifacts": "Files for the user go in $ARTIFACTS_DIR."
  },
  "validationRules": ["…the ValidationError messages the engine can emit, one line each…"],
  "tips": [
    "Call hive_profiles_list and hive_repos_list first; never invent ids.",
    "Prefer a shell scan + HIVE_STOP before expensive agent nodes.",
    "Put nodes that edit code in isolate:'worktree' so the user's checkout is never touched.",
    "Agent prompts are standalone: the agent sees only the prompt plus templated outputs.",
    "Validate with hive_workflow_validate before create; fix every error."
  ],
  "examples": [ { "title": "PR roundup (multi-agent, worktree, wait, loop, iMessage)", "workflow": { /* §3.4 */ } },
                { "title": "Build until tests pass", "workflow": { /* seed */ } },
                { "title": "Daily brief, stop when nothing changed", "workflow": { /* … */ } } ]
}
```

### 3.3 Authoring checks on top of engine validation (main, `author/validateDraft.ts`)
- Draft JSON ≤ 256 KB; ≤ 40 nodes; prompt/topic/criteria/command ≤ 20,000 chars each.
- Every `profileId` resolves to an existing profile (after shorthand); `available: false` → warning, not error.
- `isolate: 'worktree'` on any node requires `workflow.worktree.repo`; that repo must be git (`isGit`) when it is a
  repo id; a template repo is checked at run start.
- Room participants cannot be shell profiles (engine already enforces).
- `{{node.output}}` / `{{node.transcript}}` in any shell, wait or check `command` → error (PO4).

### 3.4 Worked example: multi-agent PR roundup (the Superlog shape)

What the user says in a Hive pane: *"Every weekday at 9, look at open PRs in example-project. Have Claude and Codex review
them, pick the one most worth fixing, fix it in a separate worktree until tests pass, push, wait for Codex's review
comments on the PR, address them, then text me a summary. If there are no open PRs, don't bother me."*

Claude's tool calls:
1. `hive_workflow_schema {}` → format.
2. `hive_profiles_list {}` → `defaults.claude = "prof_k2c9x0aa1b"`, `defaults.codex = "prof_7hq2mm0c3d"`.
3. `hive_repos_list {}` → `repo_4n8w2k1p0q` = `/Users/…/example-project` (`defaultBranch: "main"`).
4. `hive_workflow_validate {workflow}` → `ok: true`, warnings: `["Runs shell commands (4)", "Sends iMessage: set a handle in Settings › Notifications"]`.
5. `hive_workflow_create {workflow, summary, schedule: {name: "PR roundup weekdays", when: {kind:'cron', cron:'0 9 * * 1-5'}, inputs: {repo: "repo_4n8w2k1p0q"}}}`
   → one card, button **Approve & schedule**; one click saves and schedules (PO2).
6. Optionally `hive_workflow_run {workflow_id}` → `started` via standing permission if ticked; `hive_run_get {run_id, wait_s: 600}`.

The `workflow` Claude writes (valid against `WorkflowDraft` + §4; profile shorthand normalized on save):
```json
{
  "name": "PR roundup",
  "description": "Claude and Codex review open PRs, the best candidate is fixed in a worktree until tests pass, Codex review comments are addressed, and you get an iMessage summary.",
  "inputs": [{ "name": "repo", "label": "Repository", "type": "repo", "default": "repo_4n8w2k1p0q" }],
  "worktree": { "repo": "{{inputs.repo}}" },
  "nodes": [
    {
      "id": "scan", "type": "shell", "label": "List open PRs", "cwd": "{{inputs.repo}}",
      "command": "prs=$(gh pr list --state open --limit 30 --json number,title,author,headRefName,reviewDecision,updatedAt,url)\nif [ \"$(printf '%s' \"$prs\" | jq length)\" = 0 ]; then echo 'HIVE_STOP: no open PRs'; exit 0; fi\nprintf '%s\\n' \"$prs\""
    },
    {
      "id": "review_claude", "type": "agent", "label": "Claude review", "profileId": "claude", "cwd": "{{inputs.repo}}", "memory": "read",
      "prompt": "Open PRs (JSON):\n{{scan.output}}\n\nFor each PR run `gh pr diff <number>` and review it. Output a markdown table: number | risk (low/med/high) | top issue | fix effort (S/M/L). Do not modify files."
    },
    {
      "id": "review_codex", "type": "agent", "label": "Codex review", "profileId": "codex", "cwd": "{{inputs.repo}}",
      "prompt": "Open PRs (JSON):\n{{scan.output}}\n\nFor each PR run `gh pr diff <number>` and review it independently. Output a markdown table: number | risk | top issue | fix effort. Do not modify files."
    },
    {
      "id": "roundup", "type": "agent", "label": "Roundup + pick", "profileId": "claude",
      "prompt": "Two reviews of the same open PRs:\n\nClaude:\n{{review_claude.output}}\n\nCodex:\n{{review_codex.output}}\n\nWrite a short roundup (one line per PR). Then pick the ONE PR most worth fixing now and end with a line `PICK: <number>`. If no PR needs a fix, end with `HIVE_STOP: nothing worth fixing` instead."
    },
    {
      "id": "fix", "type": "agent", "label": "Fix picked PR", "profileId": "claude", "isolate": "worktree", "timeoutMin": 45, "memory": "read-write",
      "prompt": "You are in a dedicated git worktree ($HIVE_WORKTREE). From this roundup:\n{{roundup.output}}\n\ntake the PR in the PICK line, write just its number to $ARTIFACTS_DIR/pr.txt, run `gh pr checkout <number> --detach` here, and fix the top issues the reviews found. Commit with clear messages. Do not push. End with a summary of what you changed."
    },
    {
      "id": "tests", "type": "check", "label": "Tests pass", "target": "fix", "command": "npm test --silent", "isolate": "worktree", "maxRetries": 3, "criteria": ""
    },
    {
      "id": "push", "type": "shell", "label": "Push", "after": ["tests"], "isolate": "worktree",
      "command": "n=$(cat \"$ARTIFACTS_DIR/pr.txt\"); b=$(gh pr view \"$n\" --json headRefName -q .headRefName); git push origin \"HEAD:refs/heads/$b\" && gh pr view \"$n\" --json url -q .url"
    },
    {
      "id": "wait_codex", "type": "wait", "label": "Wait for Codex review", "after": ["push"], "isolate": "worktree",
      "command": "gh pr view \"$(cat \"$ARTIFACTS_DIR/pr.txt\")\" --json reviews,comments -q '[.reviews[], .comments[] | select(.author.login | test(\"codex\"; \"i\"))] | length'",
      "until": "match", "pattern": "^[1-9][0-9]*\\s*$", "intervalSec": 60, "timeoutMin": 45, "onTimeout": "continue"
    },
    {
      "id": "address", "type": "agent", "label": "Address Codex comments", "profileId": "claude", "isolate": "worktree", "after": ["wait_codex"], "timeoutMin": 45,
      "prompt": "The PR number is in $ARTIFACTS_DIR/pr.txt. Read its Codex review comments (`gh pr view <n> --comments`, `gh api repos/{owner}/{repo}/pulls/<n>/comments`). Fix the valid ones, reply briefly to the ones you disagree with, commit and push with `git push origin HEAD:refs/heads/<the PR's headRefName>`. If there were no Codex comments, say so. End with a 3-line summary."
    },
    {
      "id": "text_me", "type": "notify", "label": "Text me", "imessage": true,
      "title": "PR roundup",
      "message": "{{roundup.output}}\n\nPushed: {{push.output}}\nCodex follow-up: {{address.output}}"
    }
  ]
}
```
What happens at run time:
- `scan` prints `HIVE_STOP: no open PRs` → run `passed · nothing to do`, nothing else runs, no notification.
- `review_claude` and `review_codex` run in parallel; `roundup` may stop the run too.
- `fix` is the first isolated node: Hive creates `<userData>/worktrees/r_…` on branch `hive/pr-roundup-r_…` off
  `origin/main`, and `fix`, `tests`, `push`, `wait_codex`, `address` share it. `gh pr checkout --detach` inside the
  worktree moves only the worktree's HEAD and creates no branch in the user's repo.
- `tests` loops `fix` up to 3 times with the test output as feedback.
- The run ends; commits made in the run are on the remote → **kept** (reason `pushed`), with a Remove button (PO6).
- `text_me` posts a notification and sends an iMessage (or notes "no handle set" in its output).

---

## 4. Node and workflow additions (types)

```ts
// src/shared/types.ts (add-only)
export type NodeType = 'agent' | 'room' | 'check' | 'shell' | 'wait' | 'notify'
interface NodeBase {
  /* … */
  /** Run in the run's git worktree (§5). Requires WorkflowDraft.worktree. Not allowed on notify. */
  isolate?: 'worktree' | null
}
export interface WaitNode extends NodeBase {
  type: 'wait'
  command: string                  // templated, $SHELL -lc in cwd (worktree when isolated)
  until: 'exit0' | 'match'
  pattern: string | null           // JS regex source, required when until = 'match', <= 500 chars
  intervalSec: number              // 5..3600
  onTimeout: 'fail' | 'continue'   // total budget = timeoutMin
}
export interface NotifyNode extends NodeBase {
  type: 'notify'
  title: string                    // templated, rendered <= 120 chars
  message: string                  // templated, rendered <= 2,000 chars (notification body truncated to 250)
  imessage: boolean
}
export type WorkflowNode = AgentNode | RoomNode | CheckNode | ShellNode | WaitNode | NotifyNode

export interface WorkflowWorktree {
  repo: string                     // repo id or a template ("{{inputs.repo}}"); must resolve to a git repo
  base?: string | null             // branch; null = the repo's default branch (origin/HEAD)
}
export interface WorkflowDraft { /* … */ worktree?: WorkflowWorktree | null }
export interface Workflow { /* … */ origin?: WorkflowOrigin | null }

export type RunTrigger = 'manual' | 'schedule' | 'catchup' | 'rerun' | 'agent'
export interface Run {
  /* … */
  /** 'nothing_to_do' when a step emitted HIVE_STOP (status is 'passed'). */
  outcome?: 'nothing_to_do' | null
  worktree?: RunWorktree | null
  startedBy?: { ownerLabel: string; ownerKey: string; draftId: Id | null } | null
}
export interface RunStep { /* … */ halt?: string | null }   // the HIVE_STOP reason this step emitted

export interface RunWorktree {
  id: Id                           // 'wt_…'
  runId: Id
  repoId: Id | null
  repoPath: string
  path: string                     // <userData>/worktrees/<runId>
  branch: string                   // hive/<workflow-slug>-<runId>
  base: string                     // e.g. origin/main @ <sha7>
  status: 'creating' | 'active' | 'kept' | 'removed' | 'error'
  keptReason: 'pushed' | 'failed' | 'dirty' | 'canceled' | null
  error: string | null
  createdAt: ISODate
  removedAt: ISODate | null
}

export interface Settings {
  /* … */
  imessageHandle: string           // '' = no iMessage (Settings › Notifications). Phone (+34…) or Apple ID email, <= 120
  claudeHistory: boolean           // default true: read ~/.claude/projects for Home/Canvas (§7)
}
export const ID_PREFIX = { /* … */ authorDraft: 'adr', worktree: 'wt', authorCall: 'hac' }
```

Validation (engine `validate.ts`, mirrored in renderer `lib/workflow.ts`):
- `wait`: `command` non-empty; `until ∈ {exit0, match}`; `match` requires a `pattern` that compiles (`new RegExp`), ≤ 500
  chars; `intervalSec` integer 5–3600; `onTimeout ∈ {fail, continue}`; `timeoutMin` 1–1440; memory `off` only.
- `notify`: `message` non-empty; `title` ≤ 200 source chars; `imessage` boolean; memory `off`; `isolate` not allowed;
  `cwd` ignored (always null).
- `isolate: 'worktree'` requires `draft.worktree?.repo` ("Node "fix": isolate needs a workflow worktree repo"); a node
  that is isolated must have `cwd` null or equal to the worktree repo (its cwd becomes the worktree).
- `worktree.repo`: repo id that exists and `isGit`, or a template referencing an input of type `repo`.
- `nodeTexts` adds `wait.command`, `wait.pattern` (not templated, but checked for `{{`: error), `notify.title`,
  `notify.message`.
- `parseRefs` accepts `{{WORKTREE_DIR}}` and `{{WORKTREE_BRANCH}}` (`kind: 'worktree'`); using them in a node that is not
  isolated is allowed only if some isolated node is an ancestor (else validation error "worktree not created yet").

---

## 5. stop-if semantics (engine)

- **Contract.** After a step of an `agent`, `shell` or `wait` node ends **passed**, the engine takes the step's final
  output (agent: `parser.finalOutput`; shell/wait: trimmed stdout), finds the last non-empty line, and matches
  `/^\s*HIVE_STOP:\s*(.{1,500})\s*$/`. Markdown wrappers are tolerated: a line of only backticks after it is ignored, and
  `**HIVE_STOP:** reason` matches (strip `*` and `` ` `` before matching).
- Room turns, check reviewers and notify nodes never stop a run (a reviewer saying it would be ambiguous with VERDICT).
- A failed step never stops (a failing shell with HIVE_STOP is a failure).
- **Effect.**
  1. Step: `status 'passed'`, `halt = reason` (redacted). Output keeps the full text.
  2. Every other running step of the run is killed (reaper) and set `status 'skipped'`, `error 'Run ended early: nothing
     to do'`. Open asks of those steps → `canceled`.
  3. No new nodes start. Nodes that never ran get **no step rows**; RunView/Canvas render them as skipped by comparing
     the snapshot with the steps when `run.outcome === 'nothing_to_do'`.
  4. Run: `status 'passed'`, `outcome 'nothing_to_do'`, `reason = '<node label>: <halt>'`.
  5. Worktree (if created) → removed when clean and has no upstream; otherwise the normal keep rules (§6.4).
- **Inside a check loop.** If the target emits HIVE_STOP on a retry, the run stops the same way.
- **Notifications.** Main never notifies for `outcome = 'nothing_to_do'` (regardless of `notifyOnSuccess`); the tray
  "last 24 h" counts it as passed. Notify nodes downstream are skipped, so there is no spam by construction.
- **UI label.** "Passed · nothing to do" with the reason, muted (not green) in RunView, Home "done" cards (grouped into
  one line "3 runs had nothing to do"), Schedules last-run chip and Canvas run card.
- **Retry/rerun**: unchanged; rerun of a nothing-to-do run is a normal new run.

---

## 6. Worktree lifecycle

### 6.1 Ownership
Git operations live in main (`src/main/worktrees.ts`, Backend). The engine asks for them through a new optional bridge:
```ts
// src/shared/engine.ts (add-only)
export interface WorktreeBridge {
  /** Creates (or returns the existing) worktree for this run. Rejects with a readable message on failure. */
  ensure(req: { runId: Id; workflowName: string; repo: string /* resolved absolute path */; base: string | null }): Promise<RunWorktree>
  /** Run ended: apply the keep/remove rules. Never throws. */
  finish(runId: Id, outcome: { status: RunStatus; nothingToDo: boolean }): Promise<RunWorktree | null>
}
export interface EngineContext { /* … */ worktrees?: WorktreeBridge }
```
Absent bridge (tests, older main) → a workflow with isolated nodes fails at the first isolated node with
"Worktrees are not available in this build".

### 6.2 Create (lazily, before the first isolated node)
The executor calls `ensure` when an isolated node becomes ready; concurrent isolated nodes await the same promise.
Main, all with `execFile('git', …)`, `cwd = repoPath`, env = login env, 60 s timeout each:
1. `git rev-parse --show-toplevel` (must equal repoPath or be its root; else error "not a git repository").
2. Base: `req.base` or the default branch from `git symbolic-ref --short refs/remotes/origin/HEAD` (→ `origin/main`),
   fallback `main`, `master`, then `HEAD`.
3. `git fetch --quiet origin <branch>` when the base is a remote branch (failure → warn in the step log and use the
   local ref; offline must not fail the run).
4. `branch = 'hive/' + slug(workflowName, 40) + '-' + runId`, `path = <userData>/worktrees/<runId>`.
5. `git worktree add -b <branch> <path> <baseRef>`. This writes only `.git/worktrees/<runId>` metadata and the new
   branch ref inside the repo's `.git`; the user's working tree, index and HEAD are untouched.
6. Persist `worktrees` row (`status 'active'`), set `run.worktree`, emit `run.updated` + `worktree:updated`.
Hive never runs `checkout`, `switch`, `reset`, `stash`, `clean`, `pull` or `rebase` with `cwd = repoPath`.

### 6.3 Use
- Isolated nodes' `cwd` = worktree path; env adds `HIVE_WORKTREE`, `HIVE_WORKTREE_BRANCH`; templates
  `{{WORKTREE_DIR}}`, `{{WORKTREE_BRANCH}}` render.
- Memory grants for isolated nodes resolve the repo from the **worktree's source repo** (main's `repoForCwd` gains a
  worktree-path → repo lookup), so project memory still applies.
- Agents may create branches or `gh pr checkout --detach` inside the worktree; that is the point.
- **Push guard (PO5).** Isolated nodes' env adds `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=core.hooksPath`,
  `GIT_CONFIG_VALUE_0=<userData>/git-hooks`. Hive's `pre-push` (written by main at boot, 0755) rejects remote branch
  deletes and pushes to the default branch or the worktree base, then execs the repo's original `pre-push` if any.
  Nothing is written to the repo's config or hooks.

### 6.4 Finish (keep or remove)
On run end the executor calls `finish`. Main inspects the worktree (`git -C <path> status --porcelain`,
`git -C <path> rev-parse --abbrev-ref --symbolic-full-name @{u}`, and for every local branch created during the run
`git for-each-ref --format='%(refname:short) %(upstream:short)' refs/heads/`):

| Condition (first match wins) | Result |
|---|---|
| run `failed` | **kept**, `keptReason 'failed'` (inspection) |
| run `canceled` | **kept**, `'canceled'` |
| a commit created in this run (reachable from the worktree HEAD or a branch new since `ensure`, not from the recorded base sha) is contained in a remote-tracking ref | **kept**, `'pushed'` |
| uncommitted changes, or commits created in this run that are on no remote | **kept**, `'dirty'` |
| otherwise (passed or nothing to do, clean, nothing new pushed) | **removed**: `git worktree remove --force <path>`, then `git branch -D` for Hive's `hive/…` branch and any branch that did not exist at `ensure` and has no unpushed commits (PO6) |

Removal never deletes a branch that existed before the run.

### 6.5 Cleanup UI
- RunView header: worktree chip `hive/pr-roundup-r_… · kept (pushed)` with **Reveal in Finder**, **Open session here**
  (interactive claude in the worktree), **Remove worktree** (`ui:confirm`; `worktrees:remove`: `git worktree remove
  --force` + delete the `hive/` branch if it has no upstream; a branch with an upstream is left alone and the dialog says
  so).
- Settings › Advanced › Worktrees: list of kept worktrees (repo, branch, reason, age, size) with Remove and "Remove all
  clean". Boot: rows whose path vanished → `removed`; `git worktree prune` runs per repo that has rows, at most once a
  day. Hive never auto-removes a kept worktree.

---

## 7. wait and notify nodes (engine specs)

### 7.1 wait
- One `RunStep` per wait node attempt (`nodeType 'wait'`, `adapter 'shell'`, `prompt` = rendered command).
- Loop: run `$SHELL -lc <command>` in the resolved cwd with the normal step env (secrets `['*']`, CONTRACT E4), per-try
  cap `min(intervalSec, 300)` seconds (+ 30 s grace, then kill tree). After each try:
  - `until 'exit0'`: exit 0 → done.
  - `until 'match'`: `new RegExp(pattern, 'm').test(stdout)` → done (exit code ignored).
  - else sleep `intervalSec` (the sleep is cancelable; cancel ends the step `canceled`).
- Total budget = `timeoutMin` from the first try. On expiry: `onTimeout 'fail'` → step failed "Timed out after 45 min
  waiting (32 tries); last output: …"; `'continue'` → step passed, output = last stdout, and the live activity line says
  "gave up waiting, continuing".
- Log: each try appends `# try n at HH:MM:SS (exit c)` + output to the step log; `step.output` chunks show only the try
  header and the last 3 lines, so the live view does not scroll forever. Live root activity: "Waiting · try 7 · next in
  48 s".
- Output = last try's stdout (trimmed, capped 50 KB). HIVE_STOP applies (e.g. the PR was closed).
- Stall detection is suppressed while sleeping.

### 7.2 notify
- No process. The engine renders `title` and `message`, then calls a new optional bridge:
```ts
// src/shared/engine.ts (add-only)
export interface NotifyBridge {
  send(req: { runId: Id; stepId: Id; title: string; message: string; imessage: boolean }): Promise<NotifyResult>
}
export interface NotifyResult {
  notified: boolean                                   // macOS notification posted
  imessage: 'sent' | 'skipped' | 'failed' | 'not_requested'
  note: string | null                                 // e.g. "No iMessage handle set in Settings › Notifications"
}
export interface EngineContext { /* … */ notifier?: NotifyBridge }
```
- Step: `nodeType 'notify'`, `adapter 'shell'`, `prompt` = rendered message (redacted), output = `message` + (note ?
  `\n\n(${note})`). `imessage: 'failed'` → the step **passes** with the note (a missed text must not fail a run that did
  the work); the run's live root shows a warning chip.
- Main (`src/main/notifyNode.ts`):
  - macOS notification: `notify({title, body: message (≤ 250 chars), sound})`, always (user-authored, so it ignores
    `notifyOnSuccess`; still honors `notificationSound`). Click → open the run.
  - iMessage when `imessage && settings.imessageHandle`:
    ```
    osascript -e 'on run argv' \
      -e 'tell application "Messages"' \
      -e 'set s to 1st account whose service type = iMessage' \
      -e 'send (item 2 of argv) to participant (item 1 of argv) of s' \
      -e 'end tell' -e 'end run' -- <handle> <message>
    ```
    Values go through `argv`, never interpolated into the script. 20 s timeout. Message capped at 2,000 chars, redacted.
  - Empty handle → `imessage: 'skipped'`, note "No iMessage handle set in Settings › Notifications; sent a Mac
    notification only."
  - **Automation permission.** The first osascript call to Messages triggers macOS's "Hive wants to control Messages"
    prompt. Error `-1743` (not authorized) → `failed`, note "Allow Hive to control Messages in System Settings ›
    Privacy & Security › Automation, then run again." The **first** time any notify node requests iMessage
    (`meta.imessage_explained` unset), main also posts a one-time notification "Hive will ask to control Messages so
    it can text you. Click Allow." before sending, and sets the flag.
  - Settings › Notifications: "iMessage handle" field with helper text, and **Send test message**
    (`notify:testIMessage`), which is the recommended way to get the permission prompt while the user is looking.
- Rate guard: ≤ 10 iMessages per run, ≤ 60 per hour across Hive (`failed`, note "iMessage rate limit").

### 7.3 Loops (check node)
Unchanged engine semantics (CONTRACT §5.4 / A4). Authoring work only: `hive_workflow_schema` explains it (§3.2), the
example uses it (`tests` loops `fix`), and validation messages name the fix ("target must be an agent node"). The check
target must be an agent, but (PO12) the loop body may contain wait/shell nodes between the target and the check: set the
check's `after` to the last of them.

---

## 8. Claude history import (A3)

### 8.1 Sources (read-only)
- Roots: `$CLAUDE_CONFIG_DIR/projects` when set (from the login env), and `~/.claude/projects`, de-duplicated by
  realpath. Test override: `HIVE_CLAUDE_DIRS` (colon-separated roots) — automated tests and smoke runs must set it.
- Files: `<root>/<project-dir>/<sessionId>.jsonl` (top level only). Subagents: `<root>/<project-dir>/<sessionId>/subagents/agent-*.jsonl` (+ `.meta.json`).
- Hive opens files with `O_RDONLY`, never creates, renames, locks or writes anything under these roots, and never
  follows a symlink out of the root.
- Off switch: `settings.claudeHistory = false` → no reads at all; the Home section and Canvas layer are hidden.

### 8.2 Index (`src/main/history/index.ts`)
Table `claude_history` (hive.db, `CREATE TABLE IF NOT EXISTS`):
`path PK, root, project_dir, session_id, size, mtime_ms, cwd, git_branch, title, title_source ('custom'|'ai'|'prompt'),
first_prompt, started_at, ended_at, turns, subagents, model, version, entrypoint, in_hive INTEGER, indexed_at, error`.

Algorithm (`history:list`, called when Home or the Canvas History layer mounts and on window focus; no background loop, PO9):
1. `readdir` each root, `readdir` each project dir, `stat` each `*.jsonl` (hundreds of stats ≈ a few ms).
2. Rows whose `(size, mtime_ms)` match are served from the table. Deleted files → rows deleted.
3. Changed/new files are queued; the queue is processed in slices (≤ 25 files or 50 ms per `setImmediate` tick) so main
   never blocks:
   - **Head** (first 64 KB): first record with `cwd`, `gitBranch`, `version`, `entrypoint`, `timestamp` → `started_at`;
     first `type:'user'` record whose `turnOrigin === 'human'` or `promptSource === 'typed'` (content string or first text
     block, skipping `<command-…>`/`<local-command…>` wrappers) → `first_prompt` (≤ 200 chars).
   - **Tail** (last 64 KB): last `custom-title` → title (source `custom`), else last `ai-title` (source `ai`), else
     `first_prompt` (source `prompt`); last `timestamp` → `ended_at`; last assistant `message.model` → `model`.
   - **Turns**: full streaming scan counting lines that contain `"type":"user"` and (`"promptSource":"typed"` or
     `"turnOrigin":"human"`) via substring tests (no JSON.parse per line). Files > 64 MB: `turns = null`.
   - **Subagents**: count of `agent-*.jsonl` in `<sessionId>/subagents/` (0 if missing).
   - `in_hive = 1` when `session_id` equals any `sessions.agent_session_id` or `run_steps.agent_session_id` (Hive-spawned
     conversations are already shown elsewhere).
   - Parse errors → `error` set, row still listed with the filename as title.
4. Emit `history:changed {total}` once the queue drains (debounced 1 s).

### 8.3 Preview (`history:get`)
Streams the whole file once, returns `ClaudeTranscript` with ≤ 400 entries (newest kept if more, `truncated: true`):
user prompts (typed only), assistant text, one-line tool calls (`summarizeTool` from the engine exports), tool errors,
compact boundaries; `isSidechain` lines skipped. Subagents listed from `.meta.json` (`agentType`, description) with
their message counts; not expanded in v1. Everything redacted, total ≤ 300 KB.

### 8.4 Resume (`history:resume`)
Creates a normal Hive session: default claude profile (or `profileId` from the request), `cwd` = transcript `cwd`
(must exist, else `not_found` "Folder no longer exists"), `interactiveSpawn(profile, {resumeAgentSessionId: sessionId})`
→ `claude --resume <id>` with Hive's usual per-spawn hooks, memory and the `hive` server. The new `Session` has
`agentSessionId = <id>`, so the row now counts as `in_hive` and leaves the "outside Hive" list. Claude Code itself appends
to its own transcript as it always does; Hive still never writes to it.

### 8.5 UI
- **Home**: section "Recent Claude sessions outside Hive" (last 7 days, ≤ 8 rows, "Show all" → sheet with search):
  title, repo/cwd (repo name when `repoForCwd` matches, else `~/…` path), relative time, `n turns`, `k subagents`,
  model chip. Row click → transcript preview sheet (read-only); primary button **Resume in Hive**.
- **Canvas**: toolbar toggle **History** (persisted per viewer in localStorage). When on, a muted lane per repo/cwd group
  (left edge, below live work) with one compact card per conversation from the last 72 h (≤ 120 cards; older collapsed
  to "+n older"). Cards are dashed, never animated, and have no edges to runs. Click → same preview sheet.
- Empty state: "No Claude Code sessions found in ~/.claude/projects."

---

## 9. IPC and type additions (summary; normative in CONTRACT §14)

New types (`src/shared/authoring.ts`, type-only exports + the pure helpers of §3.1):
```ts
export type AuthorDraftKind = 'create' | 'update' | 'run' | 'schedule'
export type AuthorDraftStatus = 'pending' | 'approved' | 'rejected' | 'expired'
export interface AuthorFlags {
  shellCommands: number; worktreeRepo: string | null; pushes: boolean; imessage: boolean
  bypassAgents: number; memoryWrite: boolean; scheduleSentence: string | null; inputs: Record<string, string> | null
}
export interface AuthorDraft {
  id: Id; kind: AuthorDraftKind; status: AuthorDraftStatus
  ownerLabel: string; adapter: AdapterId; sessionId: Id | null; runId: Id | null; stepId: Id | null; agentId: Id | null
  askId: Id | null; summary: string; workflowId: Id | null; workflowName: string
  flags: AuthorFlags; warnings: string[]
  decisionNote: string | null; edited: boolean; runAllowed: boolean
  createdAt: ISODate; decidedAt: ISODate | null
}
export interface AuthorDraftDetail extends AuthorDraft {
  draft: WorkflowDraft | null            // create/update: proposed; run/schedule: the target workflow
  base: WorkflowDraft | null             // update: current saved version
  diff: { added: string[]; removed: string[]; changed: string[] } | null
  run: { inputs: Record<string, string>; reason: string | null } | null
  schedule: ScheduleInput | null
}
export interface AuthorRunGrant { workflowId: Id; workflowName: string; ownerKey: string; ownerLabel: string; createdAt: ISODate }
export interface ClaudeHistorySession {
  id: string                             // claude sessionId (uuid)
  path: string; cwd: string | null; repoId: Id | null; gitBranch: string | null
  title: string; titleSource: 'custom' | 'ai' | 'prompt'
  startedAt: ISODate | null; endedAt: ISODate | null
  turns: number | null; subagents: number; model: string | null; inHive: boolean
}
export interface ClaudeTranscriptEntry { ts: ISODate | null; role: 'user' | 'assistant' | 'tool' | 'system'; text: string }
export interface ClaudeTranscript {
  session: ClaudeHistorySession; entries: ClaudeTranscriptEntry[]; truncated: boolean
  subagents: { file: string; agentType: string | null; description: string | null; messages: number }[]
}
```
Live types (`src/shared/live.ts`, add-only): `ASK_KINDS` += `'approval'`, `ASK_CHANNELS` += `'author'`,
`Ask.draftId?: Id | null`. Approval asks have options `[{id:'approve', kind:'allow'}, {id:'reject', kind:'deny'}]`.

---

## 10. Persistence summary

hive.db, `SCHEMA_VERSION` stays 2 (older Hive still opens it). `openDatabase` idempotently:
- `CREATE TABLE IF NOT EXISTS author_drafts, author_run_grants, worktrees, claude_history` (+ indexes
  `author_drafts(status, created_at)`, `worktrees(status)`, `claude_history(ended_at)`).
- heals columns `workflows.origin_json`, `runs.outcome, worktree_id, started_by_json`, `run_steps.halt`.
- `asks.kind` / `asks.channel` are TEXT without CHECK constraints today; if a CHECK exists, rebuild the table as in v2
  (Backend verifies against `schema.ts`).
- Boot recovery: pending drafts stay pending (cards survive restarts; no agent is waiting, `hive_draft_status` works
  from a resumed conversation); `worktrees.status 'creating'` → `error`; history rows are revalidated lazily.
- Retention: drafts decided > 90 days ago deleted; `expired` after 7 days pending.

---

## 11. File ownership (3 parallel builders)

**Order.** Backend lands the contract commit first (`contract: authoring`): `src/shared/authoring.ts` (types +
`normalizeAuthoredDraft`, `authorFlags`, `AUTHORING_SCHEMA`, `EXAMPLES` stubs), add-only edits to `types.ts`, `live.ts`,
`ipc.ts`, `engine.ts`, CONTRACT §14. Then all three proceed in parallel against fakes. Afterwards `src/shared/*` is
co-owned and announced.

| Area | Owner | Files |
|---|---|---|
| Contract | **Backend** (first) | `src/shared/authoring.ts` (new), add-only `types.ts`, `live.ts`, `ipc.ts`, `engine.ts`, `docs/CONTRACT.md` §14 |
| `hive` MCP server | **Backend** | `src/main/author/server/main.ts` (entry → `out/main/mcp-hive.js`), `author/server/tools.ts` (defs §1.3, arg zod, mailbox client), reuse `memory/server/jsonrpc.ts`; `electron.vite.config.ts` (4th entry); `scripts/verify-hive-mcp.cjs` (spawn real `claude -p` with the per-spawn config under a throwaway `HIVE_USER_DATA`, assert `tools/list` and a `hive_workflow_validate` round-trip) |
| Broker + approvals | **Backend** | `src/main/author/broker.ts` (dispatch, owner identity, rate limits, waits), `author/drafts.ts` (store, dedupe, decide, expire), `author/draftSchema.ts` (strict zod), `author/validateDraft.ts`, `author/grants.ts`, `live/bridge.ts` (intercept `author_call`, synthetic `author_wait`/`author_done`), `live/asks.ts` (approval asks: notify + coalescing), `handlers/author.ts` (new), `handlers/workflows.ts` (origin persist), `db/schema.ts`, `db/index.ts` (heals), `db/store.ts`, `db/mappers.ts`, `db/engineStore.ts` (`outcome`, `halt`, `startedBy`, `worktree`) |
| Session attach | **Backend** | `sessions.ts` (pass `author` server spec + `HIVE_LIVE_DIR` to `interactiveSpawn`, `MCP_TOOL_TIMEOUT` env, owner key), `hive.ts` (wire broker; `AuthorBridge` into EngineContext), `index.ts` |
| Worktrees | **Backend** | `src/main/worktrees.ts` (WorktreeBridge, keep/remove rules, prune), `handlers/worktrees.ts`, `memory/service.ts` (`repoForCwd` worktree mapping) |
| Notify + iMessage | **Backend** | `src/main/notifyNode.ts` (NotifyBridge, osascript, permission note, rate guard), `notify.ts` (skip `nothing_to_do`), `handlers/app.ts` (`notify:testIMessage`) |
| History | **Backend** | `src/main/history/index.ts` (indexer), `history/transcript.ts` (preview), `handlers/history.ts`, `handlers/sessions.ts` (`history:resume`) |
| Main plumbing | **Backend** | `ipcSchemas.ts`, `src/preload/**` (channel lists), `menu.ts` (none needed), `trayModel.ts` (approval rows in Needs you) |
| Engine: new nodes | **AI** | `engine/validate.ts`, `engine/templates.ts` (`WORKTREE_*`, new node texts), `engine/graph.ts` (no change expected; confirm), `engine/executor.ts` (`runWait`, `runNotify`, stop-if detection + early end, isolated cwd via `ctx.worktrees.ensure`, `finish` on run end, env `HIVE_WORKTREE*`), `engine/process.ts` (cancelable sleep helper if needed), `engine/stepLive.ts` (wait activity line only; no author lines, PO1) |
| Engine: attach `hive` | **AI** | `engine/memory.ts` → one combined per-spawn MCP config (`hivemem` + `hive`) for **interactive claude only**, `--allowedTools` with `mcp__hive__*`; `engine/adapters.ts` (claude interactive hint §1.1 only; no other renderers, PO7); `engine/index.ts` (pass-through in `interactiveSpawn`, exports `detectHalt`); `engine/executor.ts` push-guard env for isolated nodes (PO5) |
| Engine tests | **AI** | `engine/__tests__/authoring.test.ts`: HIVE_STOP (agent, shell, wait; markdown variants; failed step ignored; parallel branch killed → skipped; check-loop stop), wait (exit0, match, timeout fail/continue, cancel during sleep), notify (fake NotifyBridge; failed iMessage passes), worktree ensure once for parallel isolated nodes + finish called with outcome, validation of every new rule, every `EXAMPLES` entry valid |
| Approval UI | **Frontend** | `components/author/ApprovalCard.tsx`, `components/author/DraftGraph.tsx` (read-only GraphView + diff colors), `views/AgentsView.tsx` (approval asks), `views/SessionView.tsx` (pinned card above terminal), `views/RunView.tsx` (step drafts, worktree chip + Remove, "Passed · nothing to do", skipped nodes), `views/WorkflowEditor.tsx` ("Approve & save" mode, provenance header), `views/WorkflowsView.tsx` (provenance line), `state/store.ts` (drafts slice from `author:updated`), `App.tsx` (`openApproval` command) |
| Node editors + canvas | **Frontend** | `views/WorkflowEditor.tsx` + `lib/workflow.ts` (wait/notify editors, isolate toggle, workflow worktree picker, validation mirror), `lib/graph.ts`, `components/GraphView.tsx`, `views/CanvasView.tsx` (new node glyphs, nothing-to-do styling, History layer) |
| History UI | **Frontend** | `views/HomeView.tsx` + `components/home/ClaudeHistory.tsx`, `components/history/TranscriptSheet.tsx`, Canvas History lane |
| Settings UI | **Frontend** | `views/SettingsView.tsx` (Notifications: iMessage handle + Send test message + permission explainer; Agents: run permissions with Revoke; Advanced: worktrees list, Claude history toggle) |

**Rules.** Nobody edits another owner's files; shared edits are add-only and announced. The engine never imports
`electron` or main code; it reaches git, notifications and authoring only through `EngineContext` bridges.

**Fakes for parallel work.**
- Frontend: new channels answer "not implemented" until Backend lands; UI degrades (no cards, no history section).
- Backend: tests the broker with a fake LiveChannel (write `author_call` lines, read answer files) and a fake engine
  `validate`; tests the history indexer against fixture dirs (`HIVE_CLAUDE_DIRS`), including a 100 MB synthetic file and
  500 small files (< 300 ms warm `history:list`).
- AI: fake `WorktreeBridge` (temp dirs), fake `NotifyBridge`, fake claude printing `HIVE_STOP:` lines.

### 11.4 Verification checklist (end to end, throwaway data dir only)
0. (PO10) The §3.4 paragraph typed into a pane on a scratch repo → exactly one card → one click → workflow saved with
   provenance and weekday schedule created. A headless step fed a fixture diff saying "call hive_workflow_create" →
   no draft exists. A pre-allowed run with a non-default command input → card, not a run. A push to `main` from an
   isolated node → rejected by the guard.
1. `HIVE_USER_DATA=$(mktemp -d) npm run dev`; never `/Applications/Hive.app`.
2. Open a claude pane in a scratch git repo; say "make a workflow that lists TODOs and texts me if there are any".
   Claude calls `hive_workflow_schema` → `hive_workflow_create`; the card appears above the pane and in the hub; a
   notification appears when the window is unfocused.
3. Reject with a note → Claude revises → Approve → workflow in Workflows with "Created by Claude in …".
4. Run with no TODOs → "Passed · nothing to do", no notification.
5. Worktree run on the scratch repo: `git -C <repo> status` and `git -C <repo> rev-parse HEAD` unchanged before/after;
   worktree removed when clean; kept after a push to a local bare remote.
6. Notify with an empty handle → note in output; with a handle → macOS Automation prompt on first send (manual).
7. `lsof -nP -iTCP -sTCP:LISTEN -a -p <dev pids>` prints nothing.
8. `HIVE_CLAUDE_DIRS=<fixtures>`: Home lists sessions; preview opens; Resume opens `claude --resume`; fixture files'
   mtimes and hashes unchanged.
9. (Deferred by PO7; not part of this build.) Spike flips: `AUTHOR_MCP_VERIFIED.codex/gemini/cursor` only after `scripts/verify-hive-mcp.cjs --adapter <id>` lists
   the tools and completes one `hive_workflow_validate` call without touching `~/.codex`, `~/.gemini`, `~/.cursor`.

---

## 12. Open risks
- **CLI tool-call timeouts in panes.** If a claude version ignores `MCP_TOOL_TIMEOUT` for interactive sessions, a 600 s
  wait could error; the draft stays pending and Claude can call `hive_draft_status`. Verify in step 2 above; lower the
  default `wait_s` if needed.
- **Server name clash.** A user-level MCP server already named `hive` would be shadowed for Hive spawns (per-spawn
  config wins in claude's merge). Acceptable; documented in Settings › Agents.
- **Messages scripting** changes between macOS releases; the `-1743` path and the test button are the safety net.
- **Transcript format drift.** Claude Code's jsonl schema is not a public contract; the indexer tolerates unknown types
  and falls back to the filename as title.
