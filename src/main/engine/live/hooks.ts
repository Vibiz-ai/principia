/**
 * normalizeHook (LIVE.md §3.2–3.4, §4.2, §5): one line of `<liveDir>/events.jsonl` -> tracker HookEvents. Pure.
 *
 * Accepted line shapes:
 *  - the hook script's envelope `{"v":1,"provider","received_at","gate_id"?,"payload":{...}}`;
 *  - hivemem's `{"hive":"ask_user"|"ask_user_cancelled"|"gate_closed", ...}`;
 *  - a bare hook payload (fixtures, tests).
 */
import type { AdapterId } from '../../../shared/types'
import type { HookEvent } from './types'

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** Text of a hook tool_response (claude: object/string; gemini: {llmContent}; cursor: tool_output string). */
function responseText(v: unknown): string | null {
  if (typeof v === 'string') return v
  const o = obj(v)
  const llm = o.llmContent
  if (typeof llm === 'string') return llm
  if (Array.isArray(llm)) {
    const t = llm.map((x) => str(obj(x).text)).filter(Boolean)
    if (t.length) return t.join('\n')
  }
  for (const k of ['stdout', 'output', 'content', 'result', 'text', 'returnDisplay']) {
    const s = str(o[k])
    if (s) return s
  }
  try {
    const s = JSON.stringify(v)
    return s && s !== '{}' && s !== 'null' ? s : null
  } catch {
    return null
  }
}

export function normalizeHook(provider: AdapterId, line: unknown): HookEvent[] {
  const l = obj(line)
  // hivemem / hook-script side-channel lines
  const hive = str(l.hive)
  if (hive === 'ask_user') {
    const gateId = str(l.gate_id)
    const question = str(l.question)
    if (!gateId || !question) return []
    return [
      {
        kind: 'ask_user',
        gateId,
        question,
        options: arr(l.options).map((x) => (typeof x === 'string' ? x : String(x))).filter(Boolean),
        allowText: l.allow_text !== false,
        toolUseHint: str(l.agent_hint) ?? str(l.tool_use_id)
      }
    ]
  }
  if (hive === 'ask_user_cancelled') return str(l.gate_id) ? [{ kind: 'ask_user_cancelled', gateId: str(l.gate_id)! }] : []
  if (hive === 'gate_closed') return str(l.gate_id) ? [{ kind: 'gate_closed', gateId: str(l.gate_id)! }] : []
  if (hive) return []

  const enveloped = l.v === 1 && l.payload && typeof l.payload === 'object'
  const p = enveloped ? obj(l.payload) : l
  const gateId = enveloped ? str(l.gate_id) : null
  const prov = (enveloped ? (str(l.provider) as AdapterId | null) : null) ?? provider
  switch (prov) {
    case 'claude':
      return claudeHook(p)
    case 'gemini':
      return geminiHook(p, gateId)
    case 'cursor':
      return cursorHook(p, gateId)
    default:
      return []
  }
}

// ---------- claude (verified, fixtures claude-hooks-*.jsonl) ----------

function claudeHook(p: Record<string, unknown>): HookEvent[] {
  const ev = str(p.hook_event_name)
  const agent = str(p.agent_id)
  switch (ev) {
    case 'SessionStart':
      return [{ kind: 'session_start', model: str(p.model) }]
    case 'UserPromptSubmit':
      return [{ kind: 'prompt', background: /^\s*<agent-message from=/.test(str(p.prompt) ?? '') }]
    case 'PreToolUse':
      return [{ kind: 'tool_pre', agent, toolUseId: str(p.tool_use_id), name: str(p.tool_name) ?? 'tool', input: p.tool_input }]
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const failed = ev === 'PostToolUseFailure'
      return [
        {
          kind: 'tool_post',
          agent,
          toolUseId: str(p.tool_use_id),
          name: str(p.tool_name) ?? 'tool',
          input: p.tool_input,
          ok: !failed,
          text: failed ? str(p.error) ?? responseText(p.tool_response) : responseText(p.tool_response)
        }
      ]
    }
    case 'PermissionDenied':
      return [{ kind: 'tool_post', agent, toolUseId: str(p.tool_use_id), name: str(p.tool_name) ?? 'tool', input: p.tool_input, ok: false, denied: true }]
    case 'PermissionRequest':
      return [{ kind: 'permission', agent, name: str(p.tool_name) ?? 'tool', input: p.tool_input }]
    case 'Notification': {
      const t = str(p.notification_type)
      if (t === 'permission_prompt') return [{ kind: 'notify_permission', message: str(p.message) }]
      if (t === 'idle_prompt') return [{ kind: 'notify_idle' }]
      const m = str(p.message) ?? str(p.title)
      return m ? [{ kind: 'notice', text: m }] : []
    }
    case 'SubagentStart': {
      const id = str(p.agent_id)
      if (!id) return []
      return [{ kind: 'subagent_start', agentId: id, type: str(p.agent_type), attribution: 'exact' }]
    }
    case 'SubagentStop':
      return [
        {
          kind: 'subagent_stop',
          agentId: str(p.agent_id),
          type: str(p.agent_type),
          status: 'done',
          report: str(p.last_assistant_message)
        }
      ]
    case 'Stop':
      return [{ kind: 'stop', background: arr(p.background_tasks).length, report: str(p.last_assistant_message) }]
    case 'StopFailure':
      return [{ kind: 'notice', text: str(p.error) ?? 'The turn failed' }, { kind: 'stop', background: 0 }]
    case 'SessionEnd':
      return [{ kind: 'session_end' }]
    default:
      return []
  }
}

// ---------- gemini (from source, fixture gemini-hooks-events.jsonl) ----------

function geminiHook(p: Record<string, unknown>, gateId: string | null): HookEvent[] {
  const ev = str(p.hook_event_name)
  switch (ev) {
    case 'SessionStart':
      return [{ kind: 'session_start', model: str(p.model) }]
    case 'BeforeAgent':
      return [{ kind: 'prompt', background: false }]
    case 'BeforeTool': {
      const name = str(p.tool_name) ?? 'tool'
      if (gateId) return [{ kind: 'gate', gateId, agent: null, name, input: p.tool_input }]
      return [{ kind: 'tool_pre', agent: null, toolUseId: null, name, input: p.tool_input }]
    }
    case 'AfterTool': {
      const resp = obj(p.tool_response)
      const err = resp.error
      const text = responseText(p.tool_response)
      return [
        {
          kind: 'tool_post',
          agent: null,
          toolUseId: null,
          name: str(p.tool_name) ?? 'tool',
          input: p.tool_input,
          ok: !err,
          text,
          denied: !!err && /blocked|denied/i.test(typeof err === 'string' ? err : JSON.stringify(err))
        }
      ]
    }
    case 'Notification': {
      if (str(p.notification_type) === 'ToolPermission') {
        const d = obj(p.details)
        const title = str(d.title)
        const what = str(d.command) ?? str(d.filePath) ?? str(d.fileName) ?? str(d.toolName)
        return [
          {
            kind: 'permission',
            agent: null,
            name: title ?? 'tool',
            input: d,
            title: what ? `${title ?? 'Tool'} ${what}` : str(p.message),
            detail: str(p.message)
          }
        ]
      }
      const m = str(p.message)
      return m ? [{ kind: 'notice', text: m }] : []
    }
    case 'AfterAgent':
      // prompt_response = the agent's final text for the turn (shown above the hub's Reply box)
      return [{ kind: 'stop', background: 0, report: str(p.prompt_response) }]
    case 'SessionEnd':
      return [{ kind: 'session_end' }]
    default:
      return []
  }
}

// ---------- cursor (from docs, fixture cursor-hooks-events.jsonl) ----------

function cursorHook(p: Record<string, unknown>, gateId: string | null): HookEvent[] {
  const ev = str(p.hook_event_name)
  const conv = str(p.conversation_id)
  switch (ev) {
    case 'sessionStart':
      return [{ kind: 'session_start', model: str(p.model), conv }]
    case 'beforeSubmitPrompt':
      return [{ kind: 'prompt', background: false }]
    case 'preToolUse':
      return [{ kind: 'tool_pre', agent: null, toolUseId: str(p.tool_use_id), name: str(p.tool_name) ?? 'tool', input: p.tool_input, conv }]
    case 'postToolUse':
    case 'postToolUseFailure': {
      const failed = ev === 'postToolUseFailure'
      return [
        {
          kind: 'tool_post',
          agent: null,
          toolUseId: str(p.tool_use_id),
          name: str(p.tool_name) ?? 'tool',
          input: p.tool_input,
          ok: !failed,
          text: failed ? str(p.error_message) : responseText(p.tool_output),
          denied: failed && /permission|denied|rejected/i.test(str(p.failure_type) ?? ''),
          conv
        }
      ]
    }
    case 'beforeShellExecution':
    case 'beforeMCPExecution': {
      if (!gateId) return []
      const name = ev === 'beforeShellExecution' ? 'shell' : `mcp:${str(p.mcp_server_name) ?? 'mcp'}.${str(p.tool_name) ?? 'tool'}`
      const input = ev === 'beforeShellExecution' ? { command: str(p.command) } : p.tool_input
      return [{ kind: 'gate', gateId, agent: null, name, input }]
    }
    case 'subagentStart': {
      const id = str(p.subagent_id)
      if (!id) return []
      return [
        {
          kind: 'subagent_start',
          agentId: id,
          type: str(p.subagent_type),
          toolUseId: str(p.tool_call_id),
          model: str(p.subagent_model),
          prompt: str(p.task),
          attribution: 'exact'
        }
      ]
    }
    case 'subagentStop': {
      const st = str(p.status)
      return [
        {
          kind: 'subagent_stop',
          agentId: str(p.subagent_id),
          type: str(p.subagent_type),
          prompt: str(p.task),
          status: st === 'error' ? 'failed' : st === 'aborted' ? 'canceled' : 'done',
          report: str(p.summary)
        }
      ]
    }
    case 'stop':
      return [{ kind: 'stop', background: 0 }]
    case 'sessionEnd':
      return [{ kind: 'session_end' }]
    default:
      return []
  }
}
