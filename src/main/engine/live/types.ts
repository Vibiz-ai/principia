/**
 * Engine-internal live types (LIVE.md §3): what the tracker consumes (HookEvent, alongside parse.ts NormalizedEvent)
 * and what it produces (LiveOp). Pure data, no I/O. Main imports these through src/main/engine/index.ts.
 */
import type { AgentEvent, AgentNode, AgentStatus, Ask, AskChannel, AskKind, AskOption, Attribution, NeedsKind } from '../../../shared/live'

/** Key of the root agent in tracker ops. Subagents are keyed by the first id seen for them (A6). */
export const ROOT_KEY = 'root'

export interface PtyPrompt {
  kind: 'permission' | 'trust'
  title: string
  toolHint?: string | null
}

/** Normalized hook / side-channel input (LIVE.md §3.2–3.4, §4.2, §3.8). Produced by normalizeHook() and by main. */
export type HookEvent =
  | { kind: 'session_start'; model: string | null; conv?: string | null }
  /** UserPromptSubmit / BeforeAgent / beforeSubmitPrompt. background = a subagent hand-back turn. */
  | { kind: 'prompt'; background: boolean }
  | { kind: 'tool_pre'; agent: string | null; toolUseId: string | null; name: string; input: unknown; conv?: string | null }
  | {
      kind: 'tool_post'
      agent: string | null
      toolUseId: string | null
      name: string
      input: unknown
      ok: boolean
      text?: string | null
      denied?: boolean
      conv?: string | null
    }
  /** A permission prompt visible in the TUI (claude PermissionRequest, gemini Notification ToolPermission). */
  | { kind: 'permission'; agent: string | null; name: string; input: unknown; title?: string | null; detail?: string | null }
  /** claude Notification{permission_prompt}: confirms Needs you. */
  | { kind: 'notify_permission'; message: string | null }
  /** claude Notification{idle_prompt}. */
  | { kind: 'notify_idle' }
  | { kind: 'notice'; text: string; agent?: string | null }
  | {
      kind: 'subagent_start'
      agentId: string
      type: string | null
      toolUseId?: string | null
      model?: string | null
      prompt?: string | null
      attribution: Attribution
    }
  | {
      kind: 'subagent_stop'
      agentId: string | null
      type: string | null
      prompt?: string | null
      status: 'done' | 'failed' | 'canceled'
      report: string | null
    }
  /** Turn ended (claude Stop, gemini AfterAgent, cursor stop). */
  | { kind: 'stop'; background: number; report?: string | null }
  | { kind: 'session_end' }
  /** A blocking hook gate (headless gemini/cursor, only when HOOKS_VERIFIED). */
  | { kind: 'gate'; gateId: string; agent: string | null; name: string; input: unknown }
  | { kind: 'gate_closed'; gateId: string }
  | { kind: 'ask_user'; gateId: string; question: string; options: string[]; allowText: boolean; toolUseHint: string | null }
  | { kind: 'ask_user_cancelled'; gateId: string }
  /** Main's quiet-tail PTY detector result (null = no prompt on screen now). */
  | { kind: 'pty_prompt'; prompt: PtyPrompt | null }
  /** The user typed into the PTY. */
  | { kind: 'user_input' }

/** Full tracker view of one agent, without Hive ids (the applier maps keys to `ag_` ids). */
export type AgentPatch = Omit<AgentNode, 'id' | 'parentId' | 'rootId' | 'sessionId' | 'runId' | 'stepId' | 'provider' | 'repoId' | 'cwd'> & {
  parentKey: string | null
}

export type AskOpen = Omit<Ask, 'id' | 'agentId' | 'rootId' | 'sessionId' | 'runId' | 'stepId' | 'status' | 'answer' | 'answeredVia' | 'answeredAt'>

export type LiveOp =
  | { op: 'agent.upsert'; key: string; patch: AgentPatch }
  | { op: 'event.append'; key: string; event: Omit<AgentEvent, 'seq' | 'agentId'> }
  /** Tool result for a running tool row. */
  | { op: 'event.update'; key: string; toolUseId: string; patch: Pick<AgentEvent, 'state' | 'detail'> }
  | { op: 'ask.open'; key: string; gateId: string; ask: AskOpen }
  | {
      op: 'ask.resolve'
      gateId: string
      key: string
      via: 'hive' | 'terminal' | 'timeout' | null
      status: 'answered' | 'expired' | 'canceled'
    }
  /** Headless claude: final result seen and no background tasks remain. */
  | { op: 'control.closeStdin' }

export interface TrackedAsk {
  gateId: string
  key: string
  channel: AskChannel
  kind: AskKind
  toolName: string | null
  toolInput: unknown
  title: string
  options: AskOption[]
  createdAt: string
  /** Opened by the PTY detector (vs a hook). */
  fromScreen: boolean
  /** The detector has seen this prompt on screen at least once. */
  seenOnScreen: boolean
}

export type { AgentStatus, NeedsKind }
