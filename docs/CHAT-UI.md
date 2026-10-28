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

---

## 7. Where you talk: New conversation, Recent, and who answers (2026-10-27)

The founder, on Home: "I should be able to just talk and automatically get in the chat the right agents. When I'm
here it's like I'm not sure where to go." The old Ask box sent to ONE agent picked by keywords (or silently the first
agent), opened that agent's page, and the conversation had no name or place of its own. Chats was a roster of agents.

### Decision: Claude-style (concept B), with the best of A and C

Three switchable prototypes were built (commit 9cb727b) and tested by three synthetic users (a non-technical solo
owner, a keyboard-first owner of three companies with eight agents each, a returning user). All three ranked B first
(8, 8, 8), A second (7, 6, 7) and C last (6, 6.5, 6). B was the only concept where every task went without a wrong
click: a labelled **New conversation** button, a **Recent** list visible from every page ("I can't lose a thread"),
and **To: › Talk to one person**. A's inline thread hid the composer when you came back to Home; C's composer had too
many controls ("To, team, routes, likely joining, new, continue… I just want to say write the newsletter") and its
dock left nothing to find a closed conversation by. Taken from A: the line under the composer that says, before you
send, who will answer; the composer in the first week too; drafts kept. Taken from C: the To: pill on every composer.

### What you see

- **Sidebar**: *New conversation ⌥⌘N* on top, then Search, the five doors, **RECENT** (the last five conversations,
  each with who is in it: "Marcus, Cato", "Private · Seneca", "Marcus answering…"), LIVE (an agent answering in a
  conversation reads "Marcus · Answering in “Launch plan”" and opens the conversation).
- **Home**: the composer first: *To: Principia picks ▾*, "New conversation… say what you need", and the route line
  ("→ Principia brings in Marcus"). Send opens the conversation in Chats (one destination, never the agent's page).
  Needs you shows its top three and "+ N more".
- **To ▾** (↑ ↓, type to filter, ↵): Principia picks · Everyone on the team · *Talk to one person* (each agent and
  role) · *Outside the team*: Claude directly ("Plain Claude, not one of your agents"), Claude in <repository>.
- **@ picker**: typing @ in any composer or reply lists @all and the team with roles (↑ ↓, ↵ or Tab).
- **Chats**: opens on New conversation until you pick one. The list keeps "‹ Menu" plus Home, Team and Board one
  click away, then New conversation, search (title, who is in it, why), Everything / Live only, and groups: *With the
  team*, *One-on-one*, *Agent sessions* (an agent's own work session from its page), *Claude*, *Working*.
- **A conversation**: title (click to rename), "Private" when it is you and one agent, who is in it, Principia's
  handoff line ("Principia brought in Marcus (Content Writer): the request mentions “newsletter”."), the messages,
  "Marcus is working…", a reply box where @name or @all adds people.
- **⌘K** finds conversations by title, person or topic, and its footer row is "New conversation: …" (routed the same).

### Who answers (lib/conversations.ts routeTeam; Principia owns it, never a CLI harness)

1. To: Everyone, or @all / @team / @everyone: the whole active team (at most eight, the responder's conversation cap).
2. @names (or To: a person): exactly them. One person is a **private conversation**; picking them again (or Team ›
   Message) continues it, so there is one thread per person ("New topic" starts another).
3. Else the words, scored against each seat's role, department and **what it does** (its capabilities and its
   department's charter, the words the Team page shows): the best match plus anyone close, at most three.
   "Customers" alone no longer means support; pricing, margins and staffing go to operations.
4. Else "No clear fit · Principia reads it and picks, or suggests a new specialist · @someone to choose".

Everyday verbs in a seat's description ("Checks the repo…") no longer score: "check whats the status of the posts"
went to the Repo auditor. Rules 3 and 4 are only the preview and the fallback: with "Principia picks", main reads the
request on Send (§7.2).

### 7.1 Titles (2026-10-28)

The founder: the list read "Bro now lets also …", "Check hola@exam…", "Check whats the …". Each conversation now gets
a short title (3-6 words: "Unscheduled posts on Acme workspace", "Onboarding flow fixes").

- Until Principia names it, the title is the first message's own words (`conversationTitle`), so nothing is ever
  blank. Right after Send, one call on the cheap tier names it; after the first agent answer, one more call refines it
  with the answer in view. A failed call, a timeout, no Claude CLI or a nonsense answer (`cleanTitle`) keeps what is
  there. Calls run one at a time.
- Rename: click the title in the conversation, or right-click a row in Chats › Rename… (F2). A person's rename sets
  `titleBy: 'you'` in the channel's data, and ForumStore.autoTitle checks it inside its own write, so a rename made
  while the model was thinking still wins and the generator never touches it again.
- The title shows in the Chats list, Recent conversations and the conversation header (channel topic). Older
  conversations (no `titleBy`) are named once per app run when their company's conversations load (at most twelve,
  newest first); one with a second "set the topic" line was renamed by hand and keeps its title.
- Tasks filed from a conversation keep their own titles. The phone lists sessions and agents, not team
  conversations, so it has nothing to rename yet.

### 7.2 Principia picks, and new specialists on demand (2026-10-28)

The founder: "almost everything lands on Julia (Repo auditor), even marketing, social and support questions".

- **Send** (To: Principia picks, by words or no fit) calls `forum:startConversation`: main creates the conversation
  with only you in it, posts your message, shows "Principia is reading your request to bring in the right people…",
  and asks the cheap tier to pick (`conversationPilot.ts`: the team as s1, s2… with role, department and charter,
  capabilities and instructions; pick by meaning, never by one shared word). The pick joins quietly, the handoff line
  says who and why ("Principia brought in Marcus (Content writer): they run the posts."), and they answer. To: a
  person, @names and Everyone skip the model and answer at once.
- **Nobody fits** (`fit: "none"`): no one is brought in. Principia posts a hire card in the conversation: "No one on
  the team handles social media scheduling yet. Create “Social scheduler” in Marketing?" with the role, department,
  AI tool (the default profile of Settings' default provider) and short instructions. **Create & bring in** hires it
  through the Forum proposal path (ForumService.decide → `departmentActions.saveAgent`, the same validation as Team ›
  Add agent), adds it to the conversation and wakes it on your message; **Edit…** opens the hire sheet first; **Use
  Marcus instead** brings in the closest existing agent. A role someone already has is brought in instead of proposed.
- **Mid-conversation**: an agent whose reply needs a specialist answers with `forum_reply` + `proposal`
  (`{"kind":"agent","role",…}`, also as a fenced `reply` op); it renders the same card, in the thread, and the hire
  answers the person's message. The conversation reply prompt says when and how.
- **Never on its own**: there is no setting for autonomous hiring; every hire is the founder's click (owner or admin,
  checked in decide).
- **No model** (no Claude CLI, failure, timeout, an answer naming nobody real): the deterministic route the composer
  showed, with its handoff line; nobody fits → the first active agent, as before.

Both calls use the app's one cheap tier for small text jobs, `company/routeCall.ts` `routeModelCall`: one headless
Claude turn on `--model haiku`, no tools, no MCP, an empty cwd, the founder's own login, the text redacted and framed
as data. One model; a failure never swaps in another model.

### How it works

A conversation is a private Forum channel named `chat-…` (shared/forum.ts `isConversationChannel`): topic = title,
purpose = handoff line. The responder (main/forum/responder.ts) treats it like a group DM: every agent in it answers
each message, an @name wakes only them. Reply runs are titled "Marcus replying in “Launch plan”", and the run's Forum
presence carries the conversation's channel, so "answering…" shows on that conversation only, never on every
conversation the same agent is in. The Forum view and its unread badge leave conversations out.

**REPOSITORIES**: with a team, the sidebar section folds into conversations: "Claude in <repository>" is a To:
destination, its sessions are rows under Chats › Claude, and ⌘O still adds a repository. It was a second, unlabelled
"new chat" button with different rules (terminal, no agents). Without a team (Personal, a pure code workspace) it
stays, because there it is the only way in. The keyboard-first developer persona did not miss it.

### Follow-ups

- iPhone / web phone app: the same To: (Principia picks / a person), New conversation and Recent (ChatsView.swift,
  remote/views.ts `phoneChats`), and a route over the conversation's channel.
- The phone app's conversations (when it lists them, the same title and hire card).
- A conversation that turns into work already becomes a Board task when the agent files it; show that link in the thread. Done in §8: the live task card.
- The agent page's composer is the agent's work session (model, permissions); it is listed as Agent sessions.

### Running it on demo data

```sh
HIVE_USER_DATA=<fresh dir> node scripts/seed-demo.mjs <fresh dir>
HIVE_USER_DATA=<dir> HIVE_NO_SCHEDULER=1 HIVE_CLAUDE_BIN=$PWD/scripts/fake-claude.cjs npx electron-vite dev --outDir <out>
```

`HIVE_CLAUDE_BIN` (dev only, `electron-vite dev`) points agent turns at a stand-in that answers in role after 2.5 s
("Demo reply: no model ran."); routing, reply runs, presence and posts are real. CDP selectors: `data-chatux` =
`new-conversation`, `composer-input`, `composer-send`, `route-line`, `to-pill`, `to-option[data-value=team|everyone|
agent:<Name>|claude|repo:<name>]`, `mention-option`, `new-topic`, `thread`, `handoff`, `thread-msg`,
`thread-pending`, `thread-input`, `private`, `recent-row`, `chat-row`, `new-pane`, `needs-more`, `thread-picking`,
`hire-card` (`hire-create`, `hire-edit`, `hire-instead`, `hire-dismiss`, `hire-outcome`), `chat-row-rename`.

## 8. Work started from a conversation: the live task card (2026-10-27)

The founder wrote in a team conversation "we need to get more conversion in vibiz ugc… check posthog". Julia and
Junia each answered "It's on the Board" and each filed a task (VO-8, VO-9); the only trace in the conversation was a
grey system line, "Julia made VO-9 from this message.", and the work then ran somewhere else. His words: "it did a
task to do the work and i didnt understand, it should be clear that its making a task… i was waiting there was nothing
to wait… it should show the task within the thing while its doing it so i can see that its doing the task".

### What you see

- **The task card** replaces the grey line, wherever a task is filed from a message: Chats conversations and Forum
  channels share it (`components/conversations/TaskCard.tsx`, used by `ConversationKit.MessageBubble` and
  `forum/Message.MessageRow`). It reads:
  - the identifier and title, and who is on it (agent face and name);
  - its state, one of six (`shared/taskCard.ts taskCardState`): **Queued** (todo, backlog, triage, or blocked on
    other tasks), **Working** (in progress; the label and the activity line shimmer), **Needs you** (an unanswered
    board ask, an open live ask on its run, or a block that waits on a person), **In review**, **Done**, **Failed**
    (canceled, or blocked because the run failed, was interrupted, gave no report or hit a limit);
  - the latest activity line of its run (the run's root agent, `plainActivity`, so a company without code reads
    "Working on it", not "Bash"), live; elapsed time since it started, frozen when it came back;
  - actions: **Watch** (the run's live view), **Open task** (the Board drawer), and when it needs you **Answer** (the
    question is the agent's own message in the conversation, answered from the composer: see "When the task needs
    you" below; there is no answer box in the card), **Answer it** for a live permission ask (opens the run),
    **Approve** when it is in review;
  - once it came back: **Done** (or In review / Failed) with the one-line result and the **Pull request** when the task
    has one.
- **The card is one message**, updated in place: a `system` Forum message with a `task` payload
  (`ForumMessage.task: ForumTaskCard`). Main follows open cards and patches the payload (state, run, result, PR,
  finish time); the desktop recomputes the state live from `state.tasks`, `state.agents` and `state.asks` between
  patches, so the card moves the moment the task does. Its text ("Julia started VO-9: Lift UGC conversion") is what
  search, notifications and older clients show.
- **"Working on it"**: one line under the conversation's header while a task started from it is open
  (`WorkingStrip`, `shared/taskCard.ts workingStrip`): "Julia is working on VO-9 · 2m · Watch", "VO-9 needs you ·
  Julia is waiting · 4m", "VO-9 is queued for Julia · 1m". With more, "2 tasks running · 1 needs you"; a click lists
  them, each with Watch. In review, done and failed tasks leave the strip (the card says it).
- **The composer** says where answers and results go: "→ Junia and Julia answer here · work they start reports back
  here".

### Seeing it work: the live tail, the log in place, Run now (2026-10-28)

The founder: "within the chat I should see it working … show the task it's doing, like all the logs, within the chat,
or at least saying working, and if I click it I could see the actual logs". The card said "Julia · Waiting for its
turn · 3m" and nothing else. Now (`components/conversations/TaskCard.tsx`, `lib/taskCardView.ts`, `shared/taskCard.ts`):

- **Working**: the line reads "Julia · Working · 1m 12s"; the clock ticks every second (`clockLabel`, its own
  `WorkClock` component so only the clock re-renders) and counts from the run's root agent `startedAt`, not from when
  the task was filed. Under it, the **live tail**: the last 4 things the agent did (`tailLines`): tool calls in words
  ("Reading taskCard.ts", "Running npm test" in a company with code, "Working on it" without), the first line of its
  latest message, errors and asks. Data: `useAgentEvents(root.id)`, the same `agent:events` stream and cache the run
  view's Activity timeline reads, subscribed per card, so a new event re-renders that card only, never the chat.
- **Show logs** (or a click on the card's head) opens the run's whole log in place, 320 px, scrollable, following the
  tail unless you scrolled up: the run view's own components, `AgentTimeline` (Activity, default) and `StepLog`
  (Output: `runs:stepLog` + live `run:output`), behind a small Activity / Output switch. Mounted only while open; the
  tail hides while it is open. Done, in review, failed and needs-you cards keep Show logs. The run's root loads on
  demand (`agents:list {runId, rootsOnly}`) when the store has none, e.g. a chat reopened after a restart.
  **Watch** / **See the run** and **Open task** are secondary links.
- **Queued says why** (`queuedReason`, the dispatcher's gates in order): nobody assigned / waiting to be routed, the
  company or seat paused, dependencies not done ("Waiting for VO-3 to finish"), an open question, backlog / triage,
  a session seat, Autopilot off ("Autopilot is off in Vibiz: it waits for you to press Run now"), a manual seat, the
  company at maxInFlight, the agent already running AGENT_MAX_PARALLEL tasks ("Julia is running 3 tasks; VO-15 starts when one finishes"), else "Starting in a moment". When it can start, **Run now**
  (Start without code) sits on the card and calls `tasks:start`, the Board drawer's Run now; a refusal is shown inline
  on the card (`task-run-error`), not as a toast.
- **Needs you** after a run stopped (blocked, needs input) shows the report it stopped with as an outcome line.
- **The strip** uses the same run clock ("Julia is working on VO-15 · 1m"), and with several tasks it no longer calls
  queued ones running: "2 tasks · 1 working · 1 queued" ("2 tasks running" only when none waits).
- **The phone** (`PhoneTaskCard.activity`): a working card carries its run's current activity line, read when the room
  loads (`PhoneApi.cardActivity`, plain words, redacted), shown under "Working · 3m" (`tcard__a`). No full log there.

### The result comes back to the conversation

Before this, a task run's update went to the agent's department channel (`postAsAgent`'s default), never to the
conversation the founder was waiting in. Now:

1. Principia's run-report post (`orchestrator/apply.ts`, step 1) goes to the task's conversation when it has a card
   (`ForumService.conversationOfTask`), and the Forum's automatic post of a task step's answer (`autoPost`) does too.
2. `ForumService.reconcileTaskCards(companyId, { post: true })` runs a moment after every board write and run end
   (`forum/wire.ts`, 2.5–4 s, so Principia's richer post lands first). For a task that came back (in review, done,
   failed) it posts the result once per run, as the agent on it, via Principia ("VO-9 is ready for your review:
   <summary>", plus the pull request), unless the agent or Principia already posted in that conversation for this run
   (`resultPosted`). The opKey `card:<task>:<run>:result` keeps it idempotent across restarts.
3. A card whose task is done or canceled, with its result back, is `final`: main stops following it.
   `ForumService.state()` also reconciles (without posting), so the phone reads a current state.

### What agents say, and one task per request

- `company/principiaOps.ts` `TASK_STARTED_RULE`, in the chat rule for filing work: say "I started VO-9: <title>. I'll
  post the result here.", never "It's on the Board"; `task_list {scope:"open"}` first and never file a duplicate, even
  one a teammate just filed. The Forum reply rules (`forum/responder.ts`) say the same; `forum_reply` text may carry
  `{task}`, which becomes the identifier it just filed, so the reply can name it.
- Server side, one task per person's message whoever files it (`ForumService.cardFor`, by the card's `messageId`, and
  the per-message map): a second agent's `forum_reply` task gets "already filed as VO-9 by Julia: not filed again. Say
  who is on it", and nothing is filed.
- The task is filed before the reply is posted (so `{task}` resolves), and its card goes under the reply.

### Tasks a chat session files (company_file_task, task_create)

A chat session (an agent's own chat, a company or department chat) files work with the board tools, not with
`forum_reply`. Those tools are chat tools only: headless reply runs in a conversation do not get them. Their tasks
follow the same rules:

- **The card is the tool call.** A successful `company_file_task` or `task_create` call in the chat draws as the live
  task card instead of a tool row (`shared/taskCard.ts chatTaskCard` reads the task from the tool's JSON result;
  `ChatCards.block` renders `TaskCardView`). It moves with the task like a conversation's card. The transcript keeps the
  call, so the card comes back when the chat is reopened.
- **The strip** sits above the chat (`ChatPane`, `WorkingStrip cards={chatTaskCards(items)}`).
- **The result comes back** as a notice in that chat (`main/chat/taskNotes.ts ChatTaskNotes`, on every board write).
  The task's `externalId` names the session that filed it (`<session>:<call>`, or `track:<session>:<call>` for the
  chat's own work). The notice is posted once per task and run, while the chat is open, through
  `ChatHub.note → principiaNote`, and it is never sent to the model.
- **One task per request** (`TaskTools.alreadyFiled`): a chat filing what is already open from the last hour gets the
  first task back, marked `already`, with "Already filed as PC-9 (Copywriter is on it): not filed again". This covers
  the same chat's second call for the same message, another chat, and an agent in a conversation; matches use
  `sameRequest` (equal titles, or a long title inside the other). The repeat is not drawn as a second card.

### When the task needs you: the agent asks in the conversation (2026-10-28)

The founder asked Julia to check something; she filed VO-15, which stopped with "Needs access: Can't read production
rows (social_post, vagent_autopilot_proposals) to co…". All the conversation showed was that truncated line in the card
and a tiny "Your answer… [Send]" box inside it. His words: "it should give it to the agent, not that shit within the
task. It should come back and reply to the parent so the parent tells what it needs". Now:

- **The parent asks.** When a task filed from a conversation waits for the founder's answer (`waitsForAnswer`: an
  unanswered board ask, set by `task_ask`, `forum_ask` on the task, or Principia from the run report's founder
  questions and blockers, `orchestrator/apply.ts beforeSync`), the agent who filed it posts one message in the
  conversation (`ForumService.followAsk`, inside `reconcileTaskCards {post:true}`, a moment after the board write): the
  whole question in the first person, what the run found so far and where to answer (`shared/taskCard.ts taskAskSay`):

  > VO-15 is stuck and needs you.
  > So far: The posts were made by the autopilot, but I could not see which workspace member turned it on
  > I need access: Can't read production rows (social_post, vagent_autopilot_proposals) to see who created those posts
  > Reply here and I'll pass it on to VO-15.

  It is an `ask` message (`ask.taskId`, to the owner) posted for the agent with origin `principia:ask:<run>` (never
  `principia:<run>`, which means "the result came back"), opKey `card:<task>:ask:<taskAskKey>`: **one message per ask**
  (task, run and prompt), across restarts. An agent's own `forum_ask` for the task in the same conversation is used
  instead of a second one. The card records it (`ForumTaskCard.askKey`, `askMessageId`). Principia's run-report update
  is not posted on top of it (`apply.ts` step 1 skips a blocked task whose question goes to its conversation), and the
  Forum's ask badge does not count it (the task is in Needs you already).
- **Connect in place.** A blocker that needs a connection carries `principia://connect/<tool>`; the conversation draws
  each one under the question as the shared `ConnectionSlot` row (CONNECTIONS.md §4.1, "Connect once, everywhere"), and
  the ask's options as quick answers. **Reply** under the question, or **Answer** on the card, puts the composer in
  reply mode: "Replying to VO-15's question" (× or Esc clears it); the reply goes in the question's thread.
- **The answer goes back through the conversation** (`handlers/forum.ts forum:post`, the desktop composer and the
  phone's room post alike):
  1. a reply in the question's thread answers it (the existing ask path, `ForumService.answer`);
  2. else `ForumService.routeTaskReply`: exactly one task question open in the conversation, this is the founder's
     first message since it was asked, no @mention, and it does not start something new (`looksLikeAnswer`: "also…",
     "btw", "another thing", "new task"… do not count; an option said back always does). Then it answers the task
     straight away and no reply run starts;
  3. otherwise the agents get the message as usual, and the reply run's rules list the open questions
     (`responder.ts taskAskRule`): if the message answers one, `forum_reply {…, "answer_task": {"task": "VO-15",
     "answer"?: "…"}}` passes it on; if it is about something else they answer it and leave the question open.
  The answer reaches the task through the same path as the drawer (`tasks:answer`: back to To do, the same agent
  resumes with "Answer: …"; while its run still runs, it is held and applied when it parks). The parent then says
  "Got it, back on VO-15." (or, for `answer_task`, its own reply is the confirmation). Answered elsewhere (the drawer,
  the phone's Needs you), the question closes and the parent says "Got your answer. Back on VO-15." once.
- **The result** comes back as before (Principia's update from the run report, else the card's result line), posted as
  the agent: in a conversation a task in review reads "VO-15 is ready for your review. <summary>" with "What I checked:
  …" instead of "Evidence: …".
- **The card** stays a compact status card: NEEDS YOU · the reason on one line · Show logs · Answer · Open task.
- **Its options are buttons.** The question's options (`ForumAsk.options`) are quick answers under the message; the
  bubble drops the "Options: A, B or C." line of the stored text while the buttons say it (`taskCardView.ts
  questionText`; the line stays for search, notifications and older clients). Once answered, the options stay as quiet
  chips with the one picked marked. A question always opens its own message group (name and time over it,
  `ConversationKit.startsGroup`), so after "Got it, back on VO-15." from the same agent it does not read as part of the
  confirmation; consecutive messages from one person keep a small gap between them.
- **The strip** "VO-15 needs you · Julia is waiting" is a link to Julia's question (it scrolls there and marks it);
  with several tasks, each needs-you row has "See the question".
- **The phone** gets the question as an ordinary room message, and a reply from the phone's room box goes through the
  same `forum:post` routing.
- **A chat session** (company_file_task, task_create): the question is said in that chat as a notice, once per ask
  (`ChatTaskNotes`); Answer on its card opens the task's drawer, since a chat's reply goes to its model, not the board.

### The phone

`PhoneRoomMessage.task` (`shared/remote.ts PhoneTaskCard`: identifier, title, state, label, result, PR, times) is
mapped by `remote/api.ts roomMessage` from main's stored payload. The web phone app (`cloud/phone/render.ts
roomTaskCard`) and the iPhone (`ios/Principia/UI/RoomView.swift TaskCardRow`) draw it as a compact card with its state
tile, the elapsed time, the result and the PR link; a patched card replaces itself in place (`AppModel.place`, the web
app's `room` message). A working card shows its run's activity line (read when the room loads); Watch, answers and the log stay on the Mac.

### Tests

`shared/taskCard.test.ts` (state mapping, result, clock, strip), `renderer/src/lib/taskCardView.test.ts` (live view,
activity, needs, done), `orchestrator/taskCard.test.ts` (one card and one task with two agents, the result back in the
conversation and not the department, the card patched in place, the fallback without a run report),
`forum/forum.test.ts` (Make task card, the result posted once as the agent with the PR), `chat/chatTasks.test.ts` (company_file_task and task_create from a chat: card, strip, one task per request, the result back in that chat), `principiaOps.test.ts` (the
wording rule in the chat rules and the reply prompt), `cloud/phone/phone.test.ts` and `ChatReplicaTests.swift` (the
phone card). CDP selectors: `data-chatux` = `task-card` (with `data-state`, `data-task`), `task-state`,
`task-activity`, `task-needs`, `task-result`, `task-watch`, `task-open`, `task-approve`, `task-option`, `task-answer`,
`task-pr`, `working-strip`, `working-strip-line`, `working-strip-watch`, `task-clock`, `task-tail`, `task-logs`,
`task-log`, `task-why`, `task-run`, `task-run-error`; the question (§ When the task needs you): `thread-msg` with
`data-question` (open, answered, closed) and `data-msg-id`, `task-question`, `task-question-option`,
`task-question-reply`, `thread-replyto`, `working-strip-question`. Tests: `orchestrator/taskAsk.test.ts` (one question
as the filer with what it found, no update on top, never twice; the next message routed to the task with one
confirmation and the result back as the agent; a thread reply; something else through the agent's answer_task; two
open questions never guessed; answered on the board), `shared/taskCard.test.ts` (`taskAskSay`, `taskAskKey`,
`looksLikeAnswer`), `taskCardView.test.ts` (`connectToolsIn`), `conversations/taskCard.render.test.ts` (no answer box,
Answer, the strip's link), `chat/chatTasks.test.ts` (a chat's question notice once per ask). Live tail, log, Run now and the queued reasons:
`conversations/taskCard.render.test.ts`, `taskCardView.test.ts` (tail, run clock), `shared/taskCard.test.ts`
(`clockLabel`, `queuedReason`, strip), `remote/remote.test.ts` (the phone's working line).


### 8.4 Live opens the work itself (2026-10-28), and the task is a chat

"If it says live and I click it, I should see it working within the chat, not on the right." Then, trying it: a wall
of "Running a command" rows and raw `ToolSearch select:mcp__hivemem__task_get,…` lines. "Why don't we just see a chat,
so I can add or comment more stuff if I want?"

- **The task chat** (Chats, `task:<id>`, `components/chats/TaskLiveView.tsx`, thread built by `lib/taskThread.ts`):
  - header: who and what ("Julia · VO-15 Check why…", the title alone in a company with no code), the state with
    "Working · 4m 12s" ticking from the run's start, **From: <conversation>** back to the conversation that filed it,
    Pause, Open task;
  - body, a conversation thread in time order: the task's brief as the first message ("The task"), the agent's text
    and thoughts as bubbles (the conversation's `Bubble`, so it reads like the team chat; thoughts dimmed), the task's
    activity (your notes and answers on the right; the agent's comments, reports and questions), quiet lines for
    started / paused / stopped, and **tool calls folded** between the bubbles: one line per run of calls, "Ran 6
    commands · read 3 files · checked memory" (`toolsLabel`; one call reads as itself). A click opens each call in
    words ("Run the unit tests", "Reading taskCard.ts", "Loading tools"), its duration and state; a click on a call
    shows the raw call and its output. An open permission ask shows as its AskCard; an open board question as the
    agent's question bubble with its options as quick answers; a task that came back ends with its outcome line;
    while it works, the activity in words under the last message. **Full log** opens the run's TaskLog (Activity /
    Output) in place;
  - composer: "Add a note for Julia…". Send posts a task comment (`tasks:comment`, by you): it is in the thread at once
    (optimistic, replaced by the stored row) and reaches the agent through the task's wake, the same inbox a
    teammate's question uses (`orchestrator/mailbox.ts` → `pendingWake`): coalesced while the run works, so the agent
    picks it up as soon as the running turn ends; a task not running gets it as its next turn's wake. With an open
    question, Send answers it (`tasks:answer`). The line under the box says which (`noteHint`).
- **Words, never raw calls**: a Bash call uses its own `description` ("Run the unit tests"; stored with the event,
  `agent_events.description`, from the call's input in `engine/live/tracker.ts`); `ToolSearch` reads "Loading tools";
  Principia's task tools on the memory server read as what they do (`mcp__hivemem__task_get` "Reading the task",
  `task_comment` "Commenting on the task", `task_report` "Reporting back"…; `lib/plainActivity.ts`). Connector calls
  stay words ("Running a SQL query in PostHog").
- **Who opens it**: Watch on a task card and in the dock, the right panel's working box, Home's Open, a task row in
  Chats (§8.6), LIVE rows of tasks with no conversation, the status bar when its one working item is such a task.
  LIVE rows of tasks filed from a conversation open the conversation instead (§8.6).
- **The resting chat is not live**: an agent's own chat shows live only while it answers there; its row keeps its own
  last message (never "Working on 2 tasks…") and the "Julia is working on 2 tasks now · Watch …" banner is gone: the
  eye goes to the conversation that filed the work.

### 8.5 Working tasks stay at the bottom: the dock (2026-10-28)

The founder: the task card sits where it was first posted; as the chat goes on (Julia's question, his answer, "Got it,
back on VO-15") the live card scrolls away to the top and the work is "hidden". Now, in a team conversation:

- **The dock** (`TaskCard.tsx TaskDock`), right above the composer, outside the message list: the compact live card
  (`TaskCardView dock`) of every task filed from this conversation that is **queued, working or needs you**
  (`taskCardView.ts dockedTasks`, from the strip's live states, oldest first so the newest sits next to the reply box).
  One head line: face, identifier, title, who, the state and its clock ("WORKING · 1m 12s"); under it the 2 latest
  activity lines (the live tail), or why it waits, or what it needs; then Run now / Answer, Show logs, Watch, Open task.
  **Show logs** opens the run's log above the card (the dock grows upward), 240 px capped at 35vh, scrollable. More than
  three: the newest three and "+N more" (`dockRows`, `DOCK_VISIBLE`), which expands them all. The dock is capped at 55vh
  and scrolls.
- **It never covers messages**: the list is a flex sibling above it, so it shrinks as the dock grows. The list follows
  new messages while you are at its end, also when the dock grows or shrinks (a `ResizeObserver` on the list).
- **The history keeps a reference**: while its task is docked, the original card is one line, "VO-15 · working · see
  below" (`TaskCardRef`, `dockRefLine`; a click marks the docked card). When the task comes back (in review, done,
  failed) it leaves the dock with a short fade, the reference turns back into the full outcome card, and the result
  message comes into the stream as before.
- **The header strip** stays; with one task its line marks the docked card (`jumpToDockedTask`) instead of being inert,
  except needs you, which still goes to the question. With several, each identifier in the list marks its docked card.
  A chat session's strip (ChatPane) has no dock and is unchanged.
- **The phone** (`cloud/phone/render.ts roomDocked`, `roomTaskRef`): the room's queued, working and needs-you cards
  are pinned (sticky) above the reply box, the newest three and "+N more"; the stream shows "VO-15 · working · see
  below" in their place. The iPhone app (`RoomView.swift`) is not changed yet.
- CDP selectors: `task-dock`, `task-dock-card` (with `data-dock-task`), `task-dock-more`, `task-card-ref`,
  `working-strip-dock`, `task-question-option-done`.
- Tests: `taskCardView.test.ts` (dock membership by status, order, "+N more", the reference line, `questionText`),
  `conversations/taskCard.render.test.ts` (the dock's cards, the compact working and needs-you cards, the history's
  reference and the full card once done, the options as buttons without the "Options:" line, `startsGroup`, the strip's
  link to the dock), `cloud/phone/phone.test.ts` (pinned cards, references, "+N more").

### 8.6 Tasks are the conversation's subagents (2026-10-28)

"At the end these tasks are like subagents, and I was working within the other chat. That chat should show as live, or
with X tasks being done, so I can focus my eyes there." `lib/convWork.ts`:

- **Which conversation**: main's Forum state carries `taskChannels` (task id → the channel of its newest card,
  `ForumStore.taskChannels`); `workOf` sorts a conversation's tasks into working, needs you, queued.
- **The row says it**: in the sidebar's RECENT, Chats › With the team / One-on-one and New conversation's Recent
  conversations, a conversation with work shows the live shimmer and "Julia · 2 tasks working" or "1 needs you"
  (`workLine`), with the needs dot; such rows sort first (`workRank`, `byWork`: needs you, working or answering,
  unread news, the rest).
- **LIVE lists conversations**: the one live source's working items are grouped (`groupLive`): every task filed from a
  conversation, and an agent answering in one, joins that conversation's row ("Launch plan" over "Julia · 2 tasks
  working · Running the tests"), which opens the conversation (its working tasks are docked, §8.5). Tasks with no
  conversation (autopilot, Board › Run now, routines), your own chats and workflow steps stay rows of their own; such
  a task opens its task chat. Chats › Live only counts the same: conversations with work, live sessions, task rows.
- **Task rows** (Chats › Tasks): a task with no conversation while it works, needs you, or came back unread; it opens
  the task chat. Its sessions ("Open as session", a restart of one) are not listed again under Claude.
- **Unread results**: when a task finishes (in review, done, failed) or stops for you, its result or question is posted
  in the parent conversation (§8). The Forum's own read state (`last_read_seq`, persisted) already counts it unread;
  each channel now also names the tasks behind its unread messages (`ForumChannel.unreadTasks`, from the message's ask,
  its `card:<taskId>:…` key or the run it came from), so the row reads "VO-16 finished · unread" ("2 results to read"
  for more) with a dot and the bright title until the conversation is opened. Opening it marks it read (`forum:markRead`)
  and the view opens on the first new message under a "New" line. A task with no conversation is unread from its last
  change until its chat is opened (`state.taskSeen`, kept in local storage; only results after the first launch with
  this, and from the last week, light up).
- **Status bar**: "2 working" opens the conversation when every working item belongs to one, the task chat when it is
  one task with no conversation, else Chats › Live only (`workingTarget`).
- **One row per chat with Claude**: Restart, Hand off and Open as session make a new session row that continues the same
  agent conversation, and the old exited one stayed, so "VO-15 · Check why…" was listed twice under Claude.
  `lib/sessionRows.ts dedupeSessions` keeps one per board task (sessions now carry `taskId`), else per agent-side
  conversation id, the running one or else the newest.
- CDP selectors: `task-chat`, `task-chat-brief`, `task-chat-msg` (`data-by`), `task-chat-tools` (`data-count`),
  `task-chat-tools-label`, `task-chat-step`, `task-chat-composer`, `task-chat-input`, `task-chat-hint`,
  `task-chat-send`, `task-chat-from`, `task-chat-fulllog`, `task-row`, `thread-new`; rows carry `data-work`.
- Tests: `lib/convWork.test.ts` (work by conversation, lines, ranks, LIVE grouping, orphan tasks, the status bar's
  target, orphan unread), `lib/taskThread.test.ts` (thread order, folding, labels, Bash descriptions, ToolSearch,
  the note hint), `lib/sessionRows.test.ts`, `lib/plainActivity.test.ts`, `components/chats/taskLive.render.test.ts`
  (the task chat, its composer and its comment delivery), `components/chats/chats.render.test.ts` (rows),
  `main/forum` (`unreadTasks`, `taskChannels`), `main/engine/live` (the stored description).
