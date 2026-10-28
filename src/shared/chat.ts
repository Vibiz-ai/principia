/**
 * CHAT-UI.md §3.2: Claude chats shown as a chat. Main runs `claude -p` in stream-json mode, folds every line into
 * ChatItems with one pure reducer (shared/chatReduce.ts) and sends small ChatOps to the renderer. TYPE-ONLY except
 * small `as const` lists. No Node or DOM imports.
 */
import type { Id, Session } from './types'

/** Which pane owns the conversation right now. */
export type ChatMode = 'chat' | 'terminal'
/** Settings › Agents "Open chats as". auto = Chat for chats, Terminal for repo and worktree sessions. */
export type OpenChatsAs = 'auto' | 'chat' | 'terminal'
/** starting: the process is coming up; sleeping: no process (idle 10 min, or not resumed yet); ended: session exited. */
export type ChatTurn = 'starting' | 'idle' | 'working' | 'needs' | 'sleeping' | 'terminal' | 'ended' | 'error'

export type ToolStatus = 'pending' | 'running' | 'ok' | 'error' | 'denied' | 'interrupted'

export interface ChatSuggestion {
  /** Button text: "Always allow `git push` here", "Allow this folder for this chat" */
  label: string
  /** the CLI's permission_suggestion, sent back verbatim as updatedPermissions */
  raw: unknown
}

export interface ChatQuestionSpec {
  question: string
  header: string | null
  multiSelect: boolean
  options: { label: string; description: string | null }[]
}

interface Base {
  id: string
  /** Task/Agent tool_use id this item ran under (a subagent's work); null = the main conversation. */
  parent: string | null
}
export interface ChatUserItem extends Base {
  kind: 'user'
  text: string
  images: number
  /** small JPEG data URLs of the sent images (the bubble shows them; replayed history has none) */
  thumbs?: string[]
  state: 'queued' | 'sent'
  /** ms epoch it was sent (replayed history: the transcript's own time); the chat's group timestamps read it */
  at?: number
}
export interface ChatTextItem extends Base {
  kind: 'text'
  md: string
  streaming: boolean
}
export interface ChatThinkingItem extends Base {
  kind: 'thinking'
  text: string
  streaming: boolean
  startedAt: number | null
  ms: number | null
}
export interface ChatToolItem extends Base {
  kind: 'tool'
  toolUseId: string
  name: string
  input: Record<string, unknown>
  /** the tool's input while it streams in (partial JSON) */
  inputPartial: string
  status: ToolStatus
  resultText: string
  resultTruncated: boolean
  startedAt: number | null
  ms: number | null
}
export interface ChatPermissionItem extends Base {
  kind: 'permission'
  requestId: string
  toolUseId: string | null
  tool: string
  input: Record<string, unknown>
  description: string | null
  suggestions: ChatSuggestion[]
  blockedPath: string | null
  state: 'open' | 'allowed' | 'denied' | 'expired'
  /** "Allowed in Principia", "Denied: use the staging branch", "Answered in Needs you" */
  outcome: string | null
}
export interface ChatQuestionItem extends Base {
  kind: 'question'
  requestId: string
  /** the AskUserQuestion tool_use this card answers (its tool card is hidden) */
  toolUseId: string | null
  questions: ChatQuestionSpec[]
  input: Record<string, unknown>
  state: 'open' | 'answered' | 'skipped' | 'expired'
  answers: Record<string, string> | null
}
export interface ChatPlanItem extends Base {
  kind: 'plan'
  requestId: string
  toolUseId: string | null
  plan: string
  input: Record<string, unknown>
  state: 'open' | 'approved' | 'rejected' | 'expired'
}
export interface ChatNoticeItem extends Base {
  kind: 'notice'
  tone: 'info' | 'warn' | 'error'
  text: string
  action: 'retry' | 'openTerminal' | null
}
export interface ChatTurnEndItem extends Base {
  kind: 'turnEnd'
  ms: number | null
  files: { path: string; add: number; del: number }[]
  costUsd: number | null
  error: string | null
}
export type ChatItem =
  | ChatUserItem
  | ChatTextItem
  | ChatThinkingItem
  | ChatToolItem
  | ChatPermissionItem
  | ChatQuestionItem
  | ChatPlanItem
  | ChatNoticeItem
  | ChatTurnEndItem
export type ChatItemKind = ChatItem['kind']

export interface ChatCommand {
  name: string
  description: string
  argumentHint: string | null
}
export interface ChatModel {
  value: string
  label: string
  description: string | null
}
export interface ChatMeta {
  model: string | null
  /** default | acceptEdits | plan | auto | bypassPermissions */
  permissionMode: string | null
  /** --dangerously-skip-permissions: the mode chip reads "Runs without asking" */
  bypass: boolean
  commands: ChatCommand[]
  models: ChatModel[]
  agents: string[]
  /** 0..100 of the context window, from get_context_usage */
  contextPct: number | null
  /** 0..100 of the 5-hour subscription window (rate_limit_event) */
  planPct: number | null
  planResetsAt: number | null
  cliVersion: string | null
  /** the subscription in use ("Claude Max"); never the email */
  plan: string | null
  /** AGENT CHAT: which CLI runs this chat (Codex has its own approval modes and no terminal view yet). Absent = claude. */
  harness?: 'claude' | 'codex'
  /** the approval modes this harness offers (absent: Claude's four) */
  modes?: ChatModeOption[] | null
}
export interface ChatModeOption {
  value: string
  label: string
  hint: string
}

export interface ChatQueued {
  id: string
  text: string
  images: number
}

export interface ChatSnapshot {
  sessionId: Id
  mode: ChatMode
  /** false: this session has no chat (other CLIs, or a Claude version that is not verified yet) */
  available: boolean
  turn: ChatTurn
  activity: string | null
  /** ms epoch the running turn started (elapsed timer) */
  turnStartedAt: number | null
  items: ChatItem[]
  queue: ChatQueued[]
  meta: ChatMeta
  seq: number
  /** why the toggle is unavailable ("Claude is working in the terminal…") */
  note: string | null
  /** how the session opened (a session that began as a terminal has no "back" to the chat) */
  startedAs?: ChatMode
}

export type ChatOp =
  | { op: 'add'; item: ChatItem }
  | { op: 'patch'; id: string; set: Partial<ChatItem> }
  | { op: 'append'; id: string; field: 'md' | 'text' | 'inputPartial' | 'resultText'; text: string }
  | { op: 'remove'; id: string }
  | { op: 'reset'; items: ChatItem[] }
  | { op: 'state'; turn: ChatTurn; activity?: string | null; turnStartedAt?: number | null; note?: string | null }
  | { op: 'mode'; mode: ChatMode }
  | { op: 'queue'; queue: ChatQueued[] }
  | { op: 'meta'; meta: Partial<ChatMeta> }

export const EMPTY_CHAT_META: ChatMeta = {
  model: null,
  permissionMode: null,
  bypass: false,
  commands: [],
  models: [],
  agents: [],
  contextPct: null,
  planPct: null,
  planResetsAt: null,
  cliVersion: null,
  plan: null
}

/** AGENT CHAT: Codex's approval modes, mapped onto the chat's mode values (codex app-server approval policies). */
export const CODEX_MODES: ChatModeOption[] = [
  { value: 'default', label: 'Ask before commands', hint: 'Codex asks before it runs any command that is not a plain look-up' },
  { value: 'acceptEdits', label: 'Ask when needed', hint: 'Codex works inside this folder and asks before anything outside it' }
]

/** A message's images: at most CHAT_IMAGE_MAX, each at most CHAT_IMAGE_BYTES (Claude's own cap), in these types. */
export const CHAT_IMAGE_MAX = 6
export const CHAT_IMAGE_BYTES = 5 * 1024 * 1024
export const CHAT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

export interface ChatImage {
  mediaType: (typeof CHAT_IMAGE_TYPES)[number]
  /** base64, no data: prefix */
  data: string
  /** a small JPEG data URL for the sent bubble (the renderer makes it) */
  thumb?: string
}

/** How the user answered a permission, question or plan card. */
export type ChatDecision =
  | { kind: 'allow' }
  | { kind: 'allowAlways'; suggestion: number }
  | { kind: 'deny'; message?: string }
  | { kind: 'answer'; answers: Record<string, string> }
  | { kind: 'skip' }
  | { kind: 'approvePlan'; acceptEdits?: boolean }
  | { kind: 'rejectPlan'; message?: string }

type V = void
export interface ChatInvokeMap {
  'chat:snapshot': [{ id: Id }, ChatSnapshot]
  'chat:send': [{ id: Id; text: string; images?: ChatImage[] }, V]
  /** text null removes the queued message */
  'chat:queueEdit': [{ id: Id; queueId: string; text: string | null }, V]
  /** sendNow: interrupt, then send the queue at once */
  'chat:interrupt': [{ id: Id; sendNow?: boolean }, V]
  'chat:answer': [{ id: Id; requestId: string; decision: ChatDecision }, V]
  'chat:setPermissionMode': [{ id: Id; mode: string }, V]
  'chat:setModel': [{ id: Id; model: string }, V]
  /** @ mentions: files under the chat's folders matching the query */
  'chat:files': [{ id: Id; query: string }, string[]]
  /** force: stop a working turn first */
  'chat:toTerminal': [{ id: Id; force?: boolean }, V]
  'chat:toChat': [{ id: Id; force?: boolean }, V]
  /**
   * AGENT CHAT: the standing chat of a company agent, running (started, or resumed with its conversation, when it was
   * not). The renderer shows it with the same ChatPane as any chat.
   */
  'chat:openAgent': [{ agentId: Id }, Session]
  /** AGENT CHAT: a message straight into an agent's chat (Home's Ask box, ⌘K, New chat). Returns the session. */
  'chat:sendAgent': [{ agentId: Id; text: string; images?: ChatImage[] }, Session]
}
export const CHAT_CHANNELS = [
  'chat:snapshot', 'chat:send', 'chat:queueEdit', 'chat:interrupt', 'chat:answer', 'chat:setPermissionMode', 'chat:setModel',
  'chat:files', 'chat:toTerminal', 'chat:toChat', 'chat:openAgent', 'chat:sendAgent'
] as const satisfies readonly (keyof ChatInvokeMap)[]

export interface ChatEventMap {
  /** batched ~16 ms, redacted; the renderer resnapshots on a seq gap */
  'chat:ops': { sessionId: Id; seq: number; ops: ChatOp[] }
}
export const CHAT_EVENTS = ['chat:ops'] as const satisfies readonly (keyof ChatEventMap)[]

/** Commands that exist only in the interactive TUI: picking one hands the chat to the terminal. */
export const TERMINAL_ONLY_COMMANDS: { name: string; description: string }[] = [
  { name: 'config', description: 'Open the settings panel' },
  { name: 'login', description: 'Sign in to your Anthropic account' },
  { name: 'logout', description: 'Sign out' },
  { name: 'doctor', description: 'Check the Claude Code install' },
  { name: 'permissions', description: 'Manage allow and deny rules' },
  { name: 'resume', description: 'Pick another conversation' },
  { name: 'status', description: 'Version, model, account' },
  { name: 'theme', description: 'Change the terminal theme' },
  { name: 'vim', description: 'Vim editing mode' },
  { name: 'hooks', description: 'Manage hooks' },
  { name: 'memory', description: 'Edit CLAUDE.md memory files' },
  { name: 'add-dir', description: 'Add a working folder' },
  { name: 'export', description: 'Export the conversation' },
  { name: 'ide', description: 'Connect an IDE' }
]
