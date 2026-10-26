# CHAT UI: Claude chats as a chat, not a terminal

Status: P1 built, plus the P2 toggle, slash and @ menus, images and meters (code in `src/main/chat/`, `src/shared/chat*.ts`, `src/shared/toolVerbs.ts`, `src/renderer/src/components/chat/`). Built differently from §3.1: the chat is the session's PtyLike (`ChatSession`), so `sessions.ts` and `engine/index.ts` need no chat branch; the hub picks chat or terminal inside `spawnPty`. Not built yet: the Principia-side decision log, Codex, the read-only terminal mirror. Author: Lea, designer-engineer. Branch `feat/chat-ui`, worktree `.claude/worktrees/chat-ui`.
Verified against claude 2.1.310 (subscription login, "Claude Max", `apiProvider: firstParty`, `ANTHROPIC_API_KEY` stripped) and codex-cli 0.163.0 on 2026-10-25.
Mock: `scratchpad/chatui/mock/index.html` (`#working`, `#needs`, `#composer`, `#terminal`, `#resumed`), shots in `scratchpad/chatui/mock/shots/*.png`.

The founder's ask: everything the CLI does, shown as a chat with the composer at the bottom. Tools, streaming and approvals should be clean enough for non-technical users, and the real terminal stays one click away.

---

## 1. How Principia runs Claude today

| Piece | Where | What it does |
|---|---|---|
| Interactive pane | `src/main/sessions.ts` `SessionManager.create` → `engine.providers.interactiveSpawn` (`engine/index.ts:411`) → `claudeAdapter.interactive` (`engine/adapters.ts`) | Spawns the claude TUI in a node-pty. Arg order: `hookArgs` (`--settings <liveDir>/claude-settings.json`), `mcpArgs` (one per-spawn `--mcp-config` holding hivemem, the `hive` authoring server and the MCP gateway), `--add-dir` (the company folders of a chat), `visualizeSkillArgs()`, `--session-id/--resume <uuid>`, optional positional first prompt, `--model`, `--permission-mode default` or `--dangerously-skip-permissions` (Settings `interactiveBypass`), and `--append-system-prompt` (artifacts hint + AUTHOR_HINT + memory brief + Passport + department/chat brief + chat-company hint + `principiaOps`, all redacted). The env comes from `buildChildEnv` (company keys, ARTIFACTS_DIR, HIVE_SESSION_ID, spawn tag, `MCP_TOOL_TIMEOUT`, push-guard shims through `worktreeGuard`). `trustFolder` pre-accepts the folder-trust dialog. |
| Headless steps (runs) | `claudeAdapter.headless` + executor | **Already speaks the protocol a chat needs**: `-p --input-format stream-json --output-format stream-json --verbose --permission-mode default --permission-prompt-tool stdio`. stdin = `initialize` control request, then a user message (`live/claudeControl.ts`). `control_request can_use_tool` becomes an Ask (`permission_request` in `engine/parse.ts`), and Hive answers with `control_response` (`allowDecision` / `denyDecision` / `askUserQuestionAllow`). |
| Parser | `engine/parse.ts` `createClaudeParser` | stream-json → `NormalizedEvent` (text, tool_use, tool_result, subagent_start/progress/end, permission_request, usage, result). It feeds the AgentTimeline and step logs. Text only, no partial deltas. |
| Live tree for panes | `engine/live/attach.ts` (claude hooks, observational, no gate, A1) → `<liveDir>/events.jsonl` → `live/tailer.ts` → `live/sessionLive.ts` (AgentTracker + LiveApplier) | Drives Live rows, Chats rows with the shimmer, Needs-you counts and notifications, the SessionStart rule re-injection (PROACTIVE §4) and the Stop nudge. Pane asks are answered by **guarded PTY keys** (`ptyReplyKeys`, A9), and a quiet-tail PTY detector catches trust and limit prompts. |
| Hive MCP tools | `author.server(...)` per session, written into the session's live dir | Authoring drafts (ApprovalCard in the pane), task tools, ask_user (headless only), chat-company. |
| Transcript | Claude's own `~/.claude/projects/<slug>/<uuid>.jsonl`; `history/transcript.ts` already reads it read-only with `summarizeTool` lines | Restart resumes `agentSessionId`. |
| Renderer | `views/SessionView.tsx` `SessionPane` | Header (company chip, cwd, provider, bypass note), TaskStrip, limit banner, ApprovalCard and AskCard "needs" slots, SessionDiagrams, **`pane__body` = TerminalPane**, footer (artifacts, keys, memory chips). `.working-edge` under the header while working. |

**Main finding:** the protocol needed for a chat is already in the codebase and tested for headless runs (`claudeControl.ts`, `can_use_tool` asks). A chat session is that headless protocol, kept alive across turns, spawned with the *interactive* pane's context (hooks, MCP, brief, add-dirs, env, guard) instead of a run's.

## 2. Mechanism: the claude CLI in stream-json mode (not the Agent SDK)

### Chosen
One long-lived process per open chat:

```
claude -p --input-format stream-json --output-format stream-json --verbose
       --include-partial-messages --replay-user-messages
       <hookArgs> <mcpArgs> <--add-dir …> <visualizeSkillArgs>
       (--session-id|--resume) <uuid> [--model m] [--effort e]
       (--permission-mode <mode> --permission-prompt-tool stdio | --dangerously-skip-permissions)
       --append-system-prompt <same text as the pane> <profile extraArgs>
```
stdin stays open. Each user turn is one `{"type":"user",…}` line. Control requests and responses travel on the same pipes.

### Verified locally (probe: `scratchpad/chatui/probe/probe*.cjs`, haiku, about $0.01)
- **Subscription login works.** `initialize` returns `account.subscriptionType: "Claude Max"` with no API key. The CLI is the same binary and the same login as the terminal.
- `initialize` response carries `commands` (slash commands plus skills), `agents`, `models` (with `supportedEffortLevels`), `available_output_styles`, `current_permission_mode` and `account`. That is everything the composer needs.
- Partial streaming: `stream_event` with `content_block_start` (text, tool_use, thinking), `text_delta`, `input_json_delta` (a tool's input streams in, so "Editing PricingPage.tsx" can show before the tool runs), `thinking_delta`, plus `system:thinking_tokens` estimates and `message_delta` usage.
- Permissions: `control_request {subtype:"can_use_tool", tool_name, display_name, input, description, permission_suggestions[{type:addRules|addDirectories, rules, behavior, destination: localSettings|session}], blocked_path, tool_use_id}`. The answer goes back as a `control_response`. `tool_result_meta.permission_decision` echoes the decision.
- `interrupt` → `{still_queued: []}`, then a user `[Request interrupted by user]` line and `result:error_during_execution`. The process **stays alive** for the next turn.
- **Follow-ups during a turn:** a user line written while the model is working is queued by the CLI and runs as the next turn. With `--replay-user-messages`, each one is echoed with a `uuid` when it is taken, so Principia knows when "queued" becomes "sent".
- `set_permission_mode` (emits `system:status {permissionMode}`), `set_model`, `get_context_usage` (categories plus tokens, which feed the context meter), `mcp_status` and `get_settings` all succeed mid-session.
- `--resume <uuid>` in `-p` mode continues a conversation and keeps its history ("what file did you write earlier?" was answered correctly).
- `rate_limit_event` carries `unifiedWindows.five_hour/seven_day.utilization`. That is the right usage number for subscription users ($ cost is meaningless for them).
- ⚠ `mcp_status` returns MCP configs **with their auth headers** (a bearer token showed in the probe). It must never be forwarded to the renderer or written to disk. Only names and statuses go out.

### Rejected: `@anthropic-ai/claude-agent-sdk`
- It is not in `node_modules`. It would bundle a **second copy** of Claude Code at its own version, next to the one the user installed and Principia version-gates (`HOOKS_VERIFIED`, provider detection). The terminal toggle resumes the same `uuid` in the user's CLI, so both sides must be the same binary and the same session store.
- The SDK spawns the CLI with exactly this protocol (`canUseTool` is `can_use_tool`, and streaming input is stream-json stdin). We already have the protocol code and its tests, so the SDK would add a dependency and buy nothing.
- Subscription auth works either way, because both rely on the CLI's stored login. With the CLI, nothing changes for the user.
- We may copy its TypeScript message types as a dev reference (not a dependency).

### Permission routing: stdio, not an MCP prompt tool or hooks
`--permission-prompt-tool stdio` puts the decision on our own pipe, synchronously. Our hive MCP server would add a hop and a timeout, and hook gates are for CLIs without a host protocol. **Hooks stay attached unchanged** (same `--settings`): they keep the live tree, Live and Chats shimmer, the SessionStart rules on resume or compaction, and the Stop nudge working. The hook script's `PermissionRequest` events are ignored as asks for chat sessions (the stream owns asks), so nothing is counted twice.

Answers:

| UI | control_response.response |
|---|---|
| Allow | `{behavior:"allow", updatedInput: input}` |
| Always allow … | `{behavior:"allow", updatedInput: input, updatedPermissions: [chosen permission_suggestion]}`, labelled from the suggestion: "Always allow `git push` in this folder" (addRules/localSettings) or "Allow this folder for this chat" (addDirectories/session) |
| Deny | `{behavior:"deny", message:"Denied in Principia"}` |
| Tell Claude what to do instead… | `{behavior:"deny", message:<typed text>}` (the model reads it) |
| AskUserQuestion option(s) | `allow` with `updatedInput.answers{[question]: label}`. This extends `askUserQuestionAllow` to several questions and multiSelect. |
| ExitPlanMode "Approve plan" / "Keep planning" | `allow` / `deny` with feedback. Approving can also `set_permission_mode` to `acceptEdits` ("Approve and let Claude edit"). |

Bypass (`interactiveBypass`) keeps `--dangerously-skip-permissions`. The mode chip then reads "Runs without asking", the same honesty as today's pane header.

### Codex
`codex app-server` exists in 0.163.0 (JSON-RPC over stdio: threads, turns, streamed items, approval requests, `generate-ts` for typed bindings). It maps onto the same ChatItem model below, but it is unverified. **Phase 3, after a spike.** Until then Codex (and Gemini, Cursor, shell) open as terminals and the toggle is hidden. The ChatItem model is provider-neutral so a Codex driver can be added later.

## 3. Runtime design

### 3.1 Process and module layout (all new files unless noted)
```
src/shared/chat.ts            ChatItem / ChatOp / ChatMeta types, IPC channel map (spread into ipc.ts)
src/shared/chatReduce.ts      PURE reducer: (state, stream line | transcript record) -> ChatOp[]; tool verbs; diff
src/shared/toolVerbs.ts       friendly verb lines (§4.3), shares mainArg logic with summary.ts
src/main/chat/streamProc.ts   one claude -p process: spawn, line splitter, control-request ids, write queue, exit
src/main/chat/chatManager.ts  registry by sessionId: start/resume, send/queue, interrupt, answer, set mode/model,
                              idle sleep, terminal hand-off, persistence, ops batching (16 ms) to the renderer
src/main/chat/replay.ts       Claude transcript jsonl -> ChatItem[] through the same reducer (resume, hand-back)
src/main/engine/chatArgs.ts   claudeChatArgs(interactiveInvocation, opts): derives the chat argv from
                              claudeAdapter.interactive(...) (drops the positional prompt and the interactive mode
                              flags, adds -p stream flags); no edit to adapters.ts
src/main/handlers/chat.ts     ipc handlers
src/renderer/src/components/chat/*   ChatPane and children (§4.2)
src/renderer/src/state/chat.ts       per-session item store (applies ChatOps), composer drafts, queue
src/renderer/src/styles/chat.css
```
Small, separated hunks in shared files (to keep the merge with the steps 3-5 team easy):
- `shared/types.ts`: `Session.mode?: 'chat' | 'terminal'` and `Settings.openChatsAs?: 'auto' | 'chat' | 'terminal'`.
- `shared/ipc.ts` and `main/ipcSchemas.ts`: `...CHAT_CHANNELS` and the zod schemas imported from `shared/chat.ts`.
- `main/sessions.ts` `create()`: one branch. After the spec, env, guard and reaper are built exactly as today, `mode === 'chat'` hands `{file, args, env, cwd}` to `chatManager.start()` instead of `spawnPty`. The Session row, title, company, department, memory grant, live channel and reaper registration are unchanged, so every existing consumer (Live, Chats list, canvas, tray, counts) sees an ordinary running session. `kill/restart/remove/handoff` delegate to the chat manager when `mode === 'chat'`.
- `engine/index.ts` `interactiveSpawn`: an `opts.chat` flag that returns `claudeChatArgs(inv)`. Everything else (MCP, hooks, brief, ops) is shared code, so chat and terminal panes cannot drift apart.
- `live/sessionLive.ts`: chat sessions skip the PTY quiet-tail detector and PTY replies. `answer()` for channel `'chat'` calls `chatManager.answer`.
- `views/SessionView.tsx`: the `pane__body` hunk becomes `s.mode === 'chat' ? <ChatPane …/> : <TerminalPane …/>`, plus the Chat | Terminal segmented control in `pane__header`.
- `state/store.ts`: `startSession` passes `mode` (resolved by `openChatsAs`).
- `views/SettingsView.tsx`: one row.

### 3.2 Event model (main → renderer)
Main owns the truth. It runs the reducer, so a remount, a second window or a hand-back never re-parses in the renderer.
```ts
type ChatItem =
  | { id; kind:'user'; text; images?: ImageRef[]; state:'queued'|'sent'; uuid? }
  | { id; kind:'text'; md; streaming: boolean; agent: string|null }
  | { id; kind:'thinking'; ms; tokens; text?: string /* only if the CLI streams it */ }
  | { id; kind:'tool'; toolUseId; name; verb; target; input; status:'pending'|'running'|'ok'|'error'|'denied'|'interrupted';
      result?: { text; truncated; image? }; diff?: DiffHunk[]; agent: string|null; children?: string[] /* Task/Agent */ }
  | { id; kind:'toolGroup'; items: string[]; summary }        // consecutive read-only tools
  | { id; kind:'todo'; todos: {content, status, activeForm}[] } // latest TodoWrite (one live card per turn)
  | { id; kind:'permission'; requestId; toolUseId; tool; input; description; suggestions; blockedPath; state:'open'|'allowed'|'denied'|'expired' }
  | { id; kind:'question'; requestId; questions; state; answers? }
  | { id; kind:'plan'; requestId; plan; state }
  | { id; kind:'notice'; tone:'info'|'warn'|'error'; text; action?: 'retry'|'openTerminal'|'login' } // interrupted, compacted, limit, crash
  | { id; kind:'turnEnd'; ms; files: {path, add, del}[]; costUsd?: number }
type ChatOp = { op:'add', item } | { op:'patch', id, set?: Partial<ChatItem>, append?: { field:'md'|'resultText', text } }
            | { op:'state', turn:'idle'|'working'|'needs'|'sleeping'|'terminal'|'starting'|'error', activity?: string }
            | { op:'meta', meta: ChatMeta }   // commands, agents, models, mode, model, effort, context %, plan usage %
```
IPC:
- invoke: `chat:snapshot {id} → {items, meta, seq}`, `chat:send {id, text, images?, files?}`, `chat:queueEdit {id, itemId, text|null}`, `chat:interrupt {id, sendNext?: boolean}`, `chat:answer {id, requestId, decision}`, `chat:setMode {id, mode}`, `chat:setModel {id, model, effort?}`, `chat:files {id, query} → paths` (for @), `chat:toTerminal {id, force?}`, `chat:toChat {id}`.
- event: `chat:ops {sessionId, seq, ops[]}`, batched every 16 ms like `pty:data` and redacted with `secrets.redact` before it leaves main. The renderer drops ops with `seq <= snapshot.seq` and resnapshots on a gap.

Asks stay first-class: an open `permission` / `question` / `plan` item also opens an **Ask row** (new `AskChannel 'chat'`) through the LiveApplier. Home's Needs-you list, notifications, the tray and the dock badge keep working, and answering from the inbox routes to `chatManager.answer`. When the item resolves, the Ask resolves (`answered`, `hive`).

### 3.3 Persistence and resume
- **Canonical store = Claude's own transcript** (`~/.claude/projects/<slug>/<uuid>.jsonl`). Its records have the same `assistant`/`user` message shapes as stream-json, so `replay.ts` folds them with the **same reducer**. Turns typed in the terminal therefore show up in the chat after a hand-back with no extra work. Opened read-only, as `history/transcript.ts` already does.
- **Principia's own log** `<userData>/logs/chats/<sessionId>.jsonl` (0600, 5 MB ring like session logs, redacted) stores only what Claude does not: permission decisions and who made them, Principia notices, queued-message edits, image refs (the files themselves go to the session artifacts dir via the existing `sessions:saveImage`), and turn timings. Replay merges it by `tool_use_id` and `uuid`.
- **Resume a past conversation** (from Chats, from "outside Claude sessions" history, or Restart): `chat:snapshot` replays the transcript (earlier turns collapsed under "23 earlier messages", see the `#resumed` mock) and the next send spawns `--resume <uuid>`. Sending is the only thing that starts a process.
- **Sleeping:** an idle chat process (no open ask, no queue) exits after 10 minutes. The row reads "idle"; the session stays `running` from the user's point of view (meta `turn:'sleeping'`). The next send respawns with `--resume`. This bounds memory to about one node process per *active* chat and makes app restarts seamless (all chats come back asleep).
- The append-system-prompt follows today's `paneAppend` rule: it is passed on every spawn, and the CLI's system-prompt snapshot makes it free on resume.

### 3.4 Interrupt and queue
- **Stop** button, or **Esc** when the pane is focused and no menu is open → `control_request interrupt`. The running tool card becomes `interrupted`, open permission items become `expired` (and are answered `deny`), and a notice reads "Stopped. Claude kept everything up to here."
- **Queued follow-ups** are held **by Principia**, not written to stdin right away, so they stay editable and cancellable (the `#working` mock): "Queued: … · Edit · Send now · ×". On `result`, the next queued message is written. "Send now" = interrupt, then write. Several queued messages are joined into one turn ("2 messages") so Claude reads them together, which is what the CLI does in the TUI.
- Double Esc on an empty composer (the TUI's "edit previous message") is out of scope for v1.

### 3.5 The Terminal toggle (honest hand-off)
One conversation id has **one owner process at a time**. Two claude processes writing the same transcript would fork it.
- **Chat → Terminal:** if a turn is running, the toggle asks "Claude is working. Stop it and open the terminal?" (or waits for the end of the turn, with that as a second button). Then the chat manager closes stdin, waits up to 2 s for exit, and SessionManager spawns the **PTY in the same Session row** with the same spawn spec and `--resume <uuid>`, `mode:'terminal'`. The pane swaps ChatPane for TerminalPane and shows the hand bar from the `#terminal` mock. The TUI renders the conversation's history itself.
- **Terminal → Chat:** allowed when the live tracker says the root is idle (turn ended). Otherwise the toggle is disabled with the tooltip "Claude is working in the terminal. Switch when it's done", plus an "Interrupt and switch" option. The PTY is then ended (SIGHUP to the group, the same path as Restart), the chat replays the transcript (everything done in the terminal appears as cards), and the next send resumes in stream mode.
- The Session row keeps its id, task lease, company, department, memory grant and artifacts dir across switches, so the TaskStrip, memory chips, drafts and Live rows do not flicker. `agentSessionId` never changes.
- Some commands only exist in the terminal (`/config`, `/login`, `/doctor`, …, everything not in `initialize.commands`). They show greyed in the slash menu under "Only in the terminal", and picking one performs the hand-off.
- Not built (yet): a live **read-only mirror** of the terminal in chat (tailing the transcript while the TUI owns it). It's cheap with `replay.ts` and is a good phase-3 polish.

### 3.6 Principia features in chat mode

| Feature | How it keeps working |
|---|---|
| Company, department, chat brief, Passport, memory brief, `principiaOps`, artifacts hint, AUTHOR_HINT | Same `interactiveSpawn` builder; `--append-system-prompt` text is identical |
| hivemem, `hive` authoring tools, MCP gateway | Same per-spawn `--mcp-config`, `MCP_TOOL_TIMEOUT`. Tool cards get Principia verbs (§4.3). Authoring drafts still open ApprovalCard in the pane's needs slot |
| Hooks: live tree, Live and Chats shimmer, Needs-you, SessionStart rules, Stop nudge, StopFailure / limits | Same `--settings` hook file (hooks run in `-p`). The stream also gives `rate_limit_event` and `result` for an in-chat limit notice with LimitActions |
| Task strip, task leases, `tasks:openSession` | Unchanged (Session row). "Open as session" uses `openChatsAs` |
| Drafts and asks | Chat asks are Ask rows (channel `chat`). Drafts unchanged |
| Diagrams (principia-graph) | Rendered inline in the message via `TextWithDiagrams`. SessionDiagrams still gets `root.report` |
| Memory chips, keys footer, artifacts link | `pane__footer` unchanged |
| Push guard, worktrees | Same env (`worktreeGuard` shims, hooksPath) |
| Reaper and spawn tag | `reaper.register(id, child.pid)`; `HIVE_SPAWN_ID` in env; kill = group kill |
| Secrets | Every op and every log line goes through `secrets.redact`; `mcp_status` configs never leave main |
| Folder trust | `-p` skips the trust dialog; `trustFolder` is still called so a later terminal hand-off does not open on "Quick safety check" |
| Slack "Ask an agent about this thread" (`initialPromptFor`) | Becomes the first user message (written after `initialize`) |
| Restart, handoff to Codex | Restart = resume. Codex handoff reads the replayed transcript as text |

### 3.7 Failure modes
- The `initialize` handshake fails, or the CLI version is unverified (`CHAT_VERIFIED` table like `HOOKS_VERIFIED`, starting with 2.1.310): open the terminal instead, with the notice "This Claude version opens in the terminal for now."
- The process crashes mid-turn: a notice "Claude stopped unexpectedly · Retry" (retry = resume and resend the last user turn if no assistant output followed it).
- Not logged in (`result` auth error or an `account` missing from `initialize`): a notice with "Open terminal to log in" (the hand-off runs `/login`).
- Context full: an auto-compact notice comes from the stream (`compact_boundary`), shown as a "Conversation compacted" divider.

## 4. UX

### 4.1 Research (Mobbin, web)
- **Replit Agent** ([screen](https://mobbin.com/screens/20a3ac62-d3ef-4bd1-9feb-235af79faa5c)): narrative sentences, each followed by a compact row of tool glyphs ("4 actions"). Takeaway: prose leads and tools are secondary and collapsible.
- **Snowflake CoCo** ([screen](https://mobbin.com/screens/6fb83e2e-eb44-4e76-a1f9-bf9dd1774af6)): "Thinking complete" and "Read 1 file and edited 1 file ⌄" as single summarising lines. Takeaway: group the read-only work into one sentence.
- **v0** ([screen](https://mobbin.com/screens/f31134fa-e453-4706-9216-b76fba411924)): "Thought for 3s" collapsed, a ✅ step list, "Worked for 12s" footer. Takeaway: duration labels instead of spinners after the fact.
- **Cursor agents** ([screen](https://mobbin.com/screens/fa7df34d-7288-4c26-a0e9-95a84921e34e)): end-of-turn "3 Files Changed" card with +/− per file. Takeaway: a turnEnd summary card.
- **Gumloop** ([screen](https://mobbin.com/screens/a0c0e7b0-88bb-4a89-904a-d88ee892a8dd)): inline "Asking for your input" card with radio options, Reject / Submit. Takeaway: the question card in the transcript, not a modal.
- **Claude.ai and Cursor composer** ([Claude](https://mobbin.com/screens/d72b17b4-df91-4813-8e5d-a04d20041570), [Cursor](https://mobbin.com/screens/f09b6493-8a77-46e4-b3a8-f16fc804cc90)): one rounded box, "+" on the left, model chip, send on the right; Cursor adds an "MCPs" chip. Takeaway: our model and permission-mode chips.
- **Replit permission prompt** ([screen](https://mobbin.com/screens/5f594ed4-4151-4082-81d4-5683479ffa1a)): two buttons, primary on the right in blue. We put the primary first, because the keyboard default is Enter.

All of these are light or warm. We keep Principia's dark surface, white line icons and the cool accent only.

### 4.2 Components (renderer, `components/chat/`)

| Component | Purpose | States |
|---|---|---|
| `ChatPane` | Replaces `pane__body` for chat sessions; owns scroll and keyboard | starting, idle, working, needs, sleeping, error, terminal-owned |
| `ChatTranscript` | Virtualised-lite list (`content-visibility:auto`; "Show earlier" past 400 items); stick-to-bottom unless the user scrolled up ("↓ New activity" pill) | — |
| `UserMessage` | Right bubble with image thumbs and @file chips | queued (dashed, with Edit, Send now, ×), sent |
| `AssistantText` | Markdown via MarkdownLite + TextWithDiagrams; streaming caret; partial trailing code fence rendered as a pending code block; throttled (`useThrottled` 50 ms) | streaming, final |
| `ThinkingRow` | "Thinking…" (shimmer) → "Thought for 6s"; expands to text when the CLI provides it | live, done |
| `ToolGroupRow` | Consecutive read-only tools → "Read 3 files, searched 1 pattern · pricing.tsx, plans.ts…"; expands into ToolCards | live (shimmer), done |
| `ToolCard` | Verb line + target + meta + status glyph; expand = input (pretty), output (tail 40 lines, "Show all"), diff, or image | pending (input streaming), running (spinner + shimmer verb), ok ✓, error ✕ (red output auto-expanded), denied, interrupted |
| `DiffView` | Edit/MultiEdit from old_string/new_string (or `tool_use_result.structuredPatch` when present); Write → "New file · 42 lines" preview | collapsed by default except the latest edit |
| `SubagentCard` | Task/Agent: "Explore agent · checked where prices are used · 6 steps · 14s"; children nested with a white guide line; reuses AgentGlyph | running, done, failed |
| `TodoCard` | Latest TodoWrite as a checklist; the current item shows a spinner and shimmer; one per turn, updated in place | — |
| `PermissionCard` | "Claude wants to run a command / edit a file / use Slack"; description; exact command or path; Allow (↵), Always allow (from suggestions), Deny (esc), "Tell Claude what to do instead…" | open (accent ring), allowed, denied, expired |
| `QuestionCard` | AskUserQuestion; radio or checkbox per question; "Something else…" free text; Answer / Skip | open, answered |
| `PlanCard` | ExitPlanMode markdown plan; Approve / Approve and let Claude edit / Keep planning | — |
| `NoticeRow` | Divider style: resumed, compacted, stopped, limit (with LimitActions), crashed (Retry) | — |
| `TurnEnd` | "Worked for 1m 12s · 3 files changed" plus a file list with +/− (click opens the file or diff) | — |
| `WorkingLine` | Bottom of the live turn: spinner + `.shimmer-text` activity ("Editing PricingPage.tsx…") + elapsed + "esc to stop" | — |
| `Composer` | Auto-growing textarea; Enter send, Shift+Enter newline, Esc stop; paste or drop images; `/` menu; `@` menu; chips; context and plan meter; Send or Stop | idle, working (placeholder "Add to the queue…"), needs ("Answer above, or tell Claude something else…"), disabled (terminal-owned) |
| `SlashMenu` | From `initialize.commands` (skills tagged "skill", project commands tagged "project"); TUI-only commands greyed under "Only in the terminal" | — |
| `MentionMenu` | `chat:files` fuzzy over `git ls-files` (or an fs walk, capped at 5k) of cwd + add-dirs; inserts `@path` | — |
| `ModelChip`, `ModeChip` | From `initialize.models` (with effort submenu where `supportsEffort`) / `set_permission_mode`: "Ask before edits" (default), "Accept edits", "Plan first", "Auto", "Runs without asking" (only when Settings allow bypass) | — |
| `ContextMeter` | Ring + "38% context · 19% of plan" from `get_context_usage` after each turn and `rate_limit_event`. Hover lists categories and the reset time. $ only in the TurnEnd hover, and only for API-key profiles | — |
| `ModeToggle` (header) | Chat / Terminal segmented control | enabled, busy-disabled with tooltip |

Working state uses the existing classes only: `.working-edge` under the pane header, `.shimmer-text` on the live verb, the todo item and the WorkingLine, and `.is-shimmering` on the Chats row (already driven by the live tracker). Reduced motion follows tokens.css.

Accessibility: the final assistant text of a turn is announced via `aria-live="polite"` (never per token). Cards are buttons with `aria-expanded`. Permission and question cards trap ↵ / esc only while focused or while they are the newest open ask in the focused pane (same `hotkeys` rule as AskCard).

### 4.3 Friendly verbs (`toolVerbs.ts`)

| Tool | Running | Done |
|---|---|---|
| Read | Reading `plans.ts` | Read `plans.ts` (grouped: "Read 3 files") |
| Grep / Glob / LS | Searching for "price" / Finding files | Searched 1 pattern / Found 12 files |
| Edit, MultiEdit | Editing `plans.ts` | Edited `plans.ts` +12 −3 |
| Write | Creating `Toggle.tsx` | Created `Toggle.tsx` (42 lines) |
| Bash | its `description` if present ("List directory contents"), else "Running a command"; known patterns: "Running the tests" (npm/pnpm/yarn test, pytest, vitest), "Installing packages", "Committing", "Pushing" | same in past tense + exit summary ("48 passed", "exit 1") |
| WebSearch / WebFetch | Searching the web for "…" / Reading example.com | Searched the web / Read example.com |
| Task / Agent | Asked the Explore agent to … | (SubagentCard) |
| Skill | Using the visualize skill | Used … |
| TodoWrite | (TodoCard, no tool card) | |
| AskUserQuestion / ExitPlanMode | (QuestionCard / PlanCard) | |
| mcp__hivemem__* | memory line from `memoryToolLine` ("Checked memory for 'pricing'") | |
| mcp__hive__* (Principia) | "Filing a task", "Drafting a Slack reply", "Updating the company page" | |
| other MCP | `displayToolName` → "Using linear.create_issue" | |

Read-only tools group together. Mutating tools always get their own card. Errors are never hidden inside a group.

### 4.4 Defaults and setting
- Settings › Agents: **"Open chats as: Auto / Chat / Terminal"** (`openChatsAs`, default `auto`).
- Auto = **Chat** for a new chat in a company with no code repos, for department chats in such companies, and for every "New Chat" where the user didn't pick a folder. **Terminal** for sessions opened on a repo or worktree (code work), and for non-Claude providers until they have a chat driver.
- The pane toggle changes only that session (stored in `Session.mode`). Restart keeps the mode.

## 5. Plan
1. **P1, core (Claude):** `chatArgs`, `streamProc`, reducer and replay with fixture tests (recorded probe lines, redacted), chatManager (send, queue, interrupt, answer, sleep), Ask channel `chat`, ChatPane with text, tools, groups, diff, subagents, todo, permission, question, plan, notices, turnEnd, composer (text only, mode and model chips), resume, the `openChatsAs` setting. Proof run: a separate instance (`HIVE_USER_DATA` = scratch copy, `HIVE_NO_SCHEDULER=1`, `--outDir` scratch) driven over CDP with "list the files here and write hello.txt".
2. **P2, toggle and composer extras:** Terminal hand-off both ways, slash menu, @ mentions, image paste (`{type:'image', source:{type:'base64',…}}` content blocks; verify `@path` expansion in `-p`, else attach the file as a text block), context and plan meter, effort.
3. **P3:** read-only terminal mirror in chat, Codex via `codex app-server`, PlanCard polish, export.

Tests: reducer fixtures (partial deltas, a tool with a streamed input, can_use_tool, interrupt, a queued replay, a subagent with parent_tool_use_id, compact boundary); streamProc with a fake child (handshake, control id matching, exit mid-turn); chatManager (queue ordering, sleep and wake, hand-off ownership: never two processes for one uuid); SessionView render test that chat sessions mount ChatPane. Everything runs in `npx vitest run`, with no real claude needed (the probe fixtures are checked in).

## 6. Risks
- The stream-json control protocol is the SDK's wire format, stable in practice but not a public CLI contract. Mitigations: the `CHAT_VERIFIED` version gate, falling back to the terminal, and fixture tests to re-record on each CLI bump.
- Slash commands in `-p` are the subset `initialize` lists. We show the rest honestly as terminal-only.
- Memory: about one node process per active chat. Sleeping after 10 minutes bounds it.
- Hook `PermissionRequest` in `-p`: must not create a second ask. The chat channel owns it (covered by a test).
- `mcp_status` and `get_settings` responses hold secrets. Main must never forward them (covered by a test).

---

## QA round 1 fixes (2026-10-25)

Verified live on a separate instance (CDP 9491) against claude 2.1.310.

- **Stuck "Working…"**: a replayed user line (set_model's `<local-command-stdout>`) no longer starts a turn. An interrupt the CLI acknowledges with no `result` ends the turn after 2.5 s (`STOP_SETTLE_MS`).
- **Dropped settle ops**: `ChatReducer.user()` settled items on `[Request interrupted…` but dropped those ops, so main had the tool interrupted and the approval expired while the renderer kept a spinning card and a live Allow button. Root cause of "dead approval card after Esc" and "Creating… after Stopped".
- **Terminal → Chat on an unstarted conversation**: the hand-back checks the transcript and uses `--session-id` when the TUI never wrote it. "No conversation found" / "already in use" retries once with the other flag.
- **Choices carry over**: the picked model and permission mode (including "Allow all edits for this chat") go into the terminal argv and the next chat process (`withChoices`).
- **Crashes**: any exit that is not Kill or quit (kill -9 included) is a "stopped unexpectedly" notice with Retry. The session goes on.
- **Typing under an open card answers it**: it denies with a note, answers a question, or keeps planning.
- **Findable chats**: the first message titles the session row and the live root (`shared/chatTitle.ts`, `tracker.retitle`). `sessionTitle`, the view title and the pane header show it, and ⌘K finds it.
- **Needs you reads like the card**: the ask titles itself like the chat card ("Claude wants to create bye.txt") with the chat's own buttons. Its open button reads "Open chat".
- **Words**: denied or stopped tools say "Didn't edit" / "Stopped before creating". Look-ups never say "thing". Always-allow labels never cut mid-quote. Outcomes drop backticks, and paths are relative to the chat's folder.
- **Streaming writes**: a streaming Write shows the file text (`partialField`), not JSON.
- **Layout and keys**: narrow panes use container queries, so Send and Stop stay visible in a split of two at 1100 px. ⌃\` and ⌘K "Show this chat as Terminal / Chat" switch the view.
- **Smaller fixes**: `/model` opens the picker. Sent images show thumbnails, and ordered lists keep their numbers. Chat mode no longer draws the diagram strip.

Deferred: chats come back asleep after an app restart, which needs SessionManager to revive chat rows at boot (today an exited chat reads "Resting" and the next message resumes it). Also deferred: "Your turn" counting as Needs you (an app-wide rule shared with terminal sessions), the raw-markdown preview on Home's idle row and the "Kill" wording (both in views being rebuilt on another branch). The status bar's "Idle" and the 10–20 s stale Needs-you card did not reproduce with a visible window. The renderer merges live updates on requestAnimationFrame, which a hidden window throttles.
