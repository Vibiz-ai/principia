/**
 * Stream parsers: CLI stdout -> normalized events. Pure, line based, tolerant of non-JSON lines.
 * LIVE.md §3: events carry `agent` (the subagent they belong to; null/absent = the main agent) so the tracker can
 * build the agent tree, and `eventToChunk` keeps the step's live text to the main agent only.
 */
import type { Attribution } from '../../shared/live'
import { memoryToolLine } from './memory'

export interface ModelTokens {
  tokensIn: number
  tokensOut: number
  costUsd: number | null
}
export type ResultEvent = {
  kind: 'result'
  text: string | null
  isError: boolean
  subtype: string | null
  costUsd: number | null
  inputTokens: number | null
  outputTokens: number | null
  numTurns: number | null
  permissionDenials: string[]
}

export type NormalizedEvent =
  | { kind: 'session'; id: string }
  /** agent = parent_tool_use_id / subagent key; null or absent = main agent. */
  | { kind: 'text'; text: string; agent?: string | null }
  | { kind: 'tool_use'; name: string; input?: unknown; id?: string | null; agent?: string | null }
  | { kind: 'tool_result'; id: string; ok: boolean; text?: string | null; agent?: string | null; denied?: boolean }
  | ResultEvent
  | { kind: 'error'; message: string; agent?: string | null }
  | {
      kind: 'subagent_start'
      toolUseId: string | null
      agentId: string | null
      type: string | null
      description: string | null
      background: boolean
      depth: number | null
      /** The spawning agent's key (claude: the message's parent_tool_use_id). null = main agent; undefined = unknown. */
      parentAgent?: string | null
      attribution: Attribution
      model?: string | null
      /** The task text (cursor hooks match subagentStop by it). */
      prompt?: string | null
    }
  | {
      kind: 'subagent_progress'
      agentId: string
      activity: string | null
      lastTool: string | null
      tokens: number | null
      toolUses: number | null
      /** SubagentHandback: the final report, early. */
      report?: string | null
    }
  | {
      kind: 'subagent_end'
      agentId: string | null
      toolUseId: string | null
      status: 'done' | 'failed' | 'canceled'
      report: string | null
      tokensIn?: number | null
      tokensOut?: number | null
      model?: string | null
      transcript?: NormalizedEvent[]
    }
  | {
      kind: 'permission_request'
      requestId: string
      toolName: string
      input: unknown
      agentId: string | null
      toolUseId: string | null
      description: string | null
      suggestions: unknown[]
    }
  /** claude stdin control requests Hive does not handle: answered with an error. */
  | { kind: 'control_unknown'; requestId: string; subtype: string }
  | { kind: 'background'; running: number }
  | {
      kind: 'usage'
      model: string | null
      tokensIn: number | null
      tokensOut: number | null
      costUsd: number | null
      byModel?: Record<string, ModelTokens>
    }
  /** A status line for an agent's timeline (e.g. "Question skipped in headless mode"). */
  | { kind: 'notice'; text: string; agent?: string | null }
  /** A live activity hint (cursor todos). */
  | { kind: 'activity'; text: string; agent?: string | null }

export interface StreamParser {
  /** Feed one complete stdout line. */
  line(line: string): NormalizedEvent[]
  /** Final text output once the process exited. `rawStdout` = everything printed. */
  finalOutput(rawStdout: string): string
  /** The result event that decides the step (claude: the last non-empty one), if any. */
  result(): ResultEvent | null
  /** Set when the stream ended in a way that must fail the step even with exit 0 (gemini: EOF without result). */
  incomplete?(): string | null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
/** Numbers, or 64-bit ints serialized as decimal strings (cursor proto JSON). */
const num64 = (v: unknown): number | null => {
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v)
  return num(v)
}
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

function parseJson(line: string): Record<string, unknown> | null {
  const t = line.trim()
  if (!t.startsWith('{')) return null
  try {
    const v = JSON.parse(t)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])

function contentText(c: unknown): string | null {
  if (typeof c === 'string') return c
  const parts = arr(c)
    .map((x) => str(obj(x).text))
    .filter((x): x is string => !!x)
  return parts.length ? parts.join('\n') : null
}

function claudeTaskStatus(s: string | null): 'done' | 'failed' | 'canceled' | null {
  if (!s) return null
  if (s === 'completed' || s === 'success') return 'done'
  if (s === 'failed' || s === 'error') return 'failed'
  if (s === 'killed' || s === 'stopped' || s === 'cancelled' || s === 'canceled' || s === 'aborted') return 'canceled'
  return null
}

/**
 * Claude Code `-p --output-format stream-json --verbose` (LIVE.md §3.1, verified on 2.1.301).
 * - anything with parent_tool_use_id != null belongs to that subagent and never counts toward the step's text;
 * - Agent|Task tool_use -> subagent_start; system/task_* -> lifecycle; SubagentHandback -> early report;
 * - the deciding result is the last one with non-empty text; cost = max total_cost_usd (cumulative);
 * - a repeated system/init is idempotent; stream_event deltas and system/hook_* lines are ignored.
 */
/** A claude task_* line whose task_type names something other than an agent (local_bash, …). Absent = agent (older CLIs). */
const isNonAgentTask = (o: Record<string, unknown>): boolean => {
  const t = typeof o.task_type === 'string' ? o.task_type : null
  return t != null && !t.includes('agent')
}

export function createClaudeParser(): StreamParser {
  let decided: ResultEvent | null = null
  let lastAny: ResultEvent | null = null
  let maxCost: number | null = null
  const sessions = new Set<string>()
  const texts: string[] = []
  const plain: string[] = []
  /** Agent tool_use ids seen, for the parent's tool_result carrying the subagent's usage. */
  const spawns = new Set<string>()
  /** Background non-agent tasks (task_type local_bash, …): their task_* lines are not subagents. */
  const nonAgentTasks = new Set<string>()
  return {
    line(line) {
      const o = parseJson(line)
      if (!o) {
        if (line.trim()) {
          plain.push(line)
          return [{ kind: 'text', text: line }]
        }
        return []
      }
      const out: NormalizedEvent[] = []
      const type = str(o.type)
      const parent = str(o.parent_tool_use_id)
      if (type === 'system') {
        const sub = str(o.subtype)
        if (sub === 'init') {
          const sid = str(o.session_id)
          if (sid && !sessions.has(sid)) {
            sessions.add(sid)
            out.push({ kind: 'session', id: sid })
            out.push({ kind: 'usage', model: str(o.model), tokensIn: null, tokensOut: null, costUsd: null })
          }
        } else if (sub === 'task_started' && isNonAgentTask(o)) {
          // a backgrounded Bash etc.: its tool_use already shows as a tool row; never a subagent node
          const tid = str(o.task_id)
          if (tid) nonAgentTasks.add(tid)
        } else if ((sub === 'task_progress' || sub === 'task_updated' || sub === 'task_notification') && (isNonAgentTask(o) || nonAgentTasks.has(str(o.task_id) ?? ''))) {
          // progress / end of a non-agent background task: ignored
        } else if (sub === 'task_started') {
          const tu = str(o.tool_use_id)
          if (tu) spawns.add(tu)
          out.push({
            kind: 'subagent_start',
            toolUseId: tu,
            agentId: str(o.task_id),
            type: str(o.subagent_type),
            description: str(o.description),
            background: o.is_backgrounded === true,
            depth: num(o.spawn_depth),
            attribution: 'exact'
          })
        } else if (sub === 'task_progress') {
          const id = str(o.task_id) ?? str(o.tool_use_id)
          const u = obj(o.usage)
          if (id)
            out.push({
              kind: 'subagent_progress',
              agentId: id,
              activity: str(o.description),
              lastTool: str(o.last_tool_name),
              tokens: num(u.total_tokens),
              toolUses: num(u.tool_uses)
            })
        } else if (sub === 'task_updated') {
          const st = claudeTaskStatus(str(obj(o.patch).status))
          if (st) out.push({ kind: 'subagent_end', agentId: str(o.task_id), toolUseId: null, status: st, report: null })
        } else if (sub === 'task_notification') {
          const st = claudeTaskStatus(str(o.status)) ?? 'done'
          out.push({
            kind: 'subagent_end',
            agentId: str(o.task_id),
            toolUseId: str(o.tool_use_id),
            status: st,
            // handback (SubagentHandback) when the subagent used it, else the plain final summary (2.1.301 does both)
            report: str(obj(o.handback_report).text) ?? (str(o.handback) === 'send' ? null : str(o.summary))
          })
        } else if (sub === 'background_tasks_changed') {
          out.push({ kind: 'background', running: arr(o.tasks).length })
        }
        // hook_started / hook_response / thinking_tokens / others: ignored
      } else if (type === 'assistant') {
        const content = arr(obj(o.message).content).map(obj)
        for (const c of content) {
          if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
            if (!parent) texts.push(c.text)
            out.push({ kind: 'text', text: c.text, agent: parent })
          } else if (c.type === 'tool_use') {
            const name = str(c.name) ?? 'tool'
            const id = str(c.id)
            const input = obj(c.input)
            if (SUBAGENT_TOOLS.has(name)) {
              if (id) spawns.add(id)
              out.push({
                kind: 'subagent_start',
                toolUseId: id,
                agentId: null,
                type: str(input.subagent_type),
                description: str(input.description),
                background: input.run_in_background === true,
                depth: null,
                parentAgent: parent,
                attribution: 'exact',
                prompt: str(input.prompt)
              })
            } else if (name === 'SubagentHandback' && parent) {
              out.push({
                kind: 'subagent_progress',
                agentId: parent,
                activity: null,
                lastTool: null,
                tokens: null,
                toolUses: null,
                report: str(input.message)
              })
            } else out.push({ kind: 'tool_use', name, input: c.input, id, agent: parent })
          }
        }
      } else if (type === 'user') {
        const msg = obj(o.message)
        const metas = arr(o.tool_result_meta).map(obj)
        for (const c of arr(msg.content).map(obj)) {
          if (c.type !== 'tool_result') continue
          const id = str(c.tool_use_id)
          if (!id) continue
          const tur = obj(o.tool_use_result)
          if (!parent && spawns.has(id)) {
            // the parent's tool_result for an Agent call: final usage of a foreground subagent (async = still running)
            if (str(tur.status) && str(tur.status) !== 'async_launched') {
              const u = obj(tur.usage)
              out.push({
                kind: 'subagent_end',
                agentId: str(tur.agentId),
                toolUseId: id,
                status: claudeTaskStatus(str(tur.status)) ?? (c.is_error === true ? 'failed' : 'done'),
                report: str(obj(tur.handbackReport).text) ?? contentText(tur.content),
                tokensIn: num(u.input_tokens),
                tokensOut: num(u.output_tokens),
                model: str(tur.resolvedModel)
              })
            }
            continue
          }
          const meta = metas.find((m) => str(m.id) === id) ?? metas[0]
          const decision = str(obj(obj(meta).permission_decision).decision)
          const denied = decision === 'reject' || decision === 'deny'
          out.push({ kind: 'tool_result', id, ok: c.is_error !== true, text: contentText(c.content), agent: parent, denied })
        }
      } else if (type === 'control_request') {
        const req = obj(o.request)
        const rid = str(o.request_id)
        if (rid && str(req.subtype) === 'can_use_tool') {
          out.push({
            kind: 'permission_request',
            requestId: rid,
            toolName: str(req.tool_name) ?? 'tool',
            input: req.input ?? {},
            agentId: str(req.agent_id),
            toolUseId: str(req.tool_use_id),
            description: str(req.description) ?? str(req.decision_reason),
            suggestions: arr(req.permission_suggestions)
          })
        } else if (rid) out.push({ kind: 'control_unknown', requestId: rid, subtype: str(req.subtype) ?? 'unknown' })
      } else if (type === 'result') {
        const usage = obj(o.usage)
        const denials = arr(o.permission_denials).map(obj)
        const cost = num(o.total_cost_usd) ?? num(o.cost_usd)
        if (cost != null) maxCost = maxCost == null ? cost : Math.max(maxCost, cost)
        const r: ResultEvent = {
          kind: 'result',
          text: str(o.result),
          isError: o.is_error === true || (str(o.subtype) ?? 'success').startsWith('error'),
          subtype: str(o.subtype),
          costUsd: maxCost,
          inputTokens: num(usage.input_tokens),
          outputTokens: num(usage.output_tokens),
          numTurns: num(o.num_turns),
          permissionDenials: denials.map((d) => str(d.tool_name) ?? 'tool')
        }
        lastAny = r
        if (r.text?.trim() || r.isError || !decided) decided = r
        else decided = { ...decided, costUsd: maxCost }
        out.push(r)
        const byModel: Record<string, ModelTokens> = {}
        for (const [m, v] of Object.entries(obj(o.modelUsage))) {
          const mu = obj(v)
          byModel[m] = {
            tokensIn: (num(mu.inputTokens) ?? 0) + (num(mu.cacheReadInputTokens) ?? 0) + (num(mu.cacheCreationInputTokens) ?? 0),
            tokensOut: num(mu.outputTokens) ?? 0,
            costUsd: num(mu.costUSD)
          }
        }
        const models = Object.values(byModel)
        out.push({
          kind: 'usage',
          model: null,
          tokensIn: models.length ? models.reduce((a, m) => a + m.tokensIn, 0) : num(usage.input_tokens),
          tokensOut: models.length ? models.reduce((a, m) => a + m.tokensOut, 0) : num(usage.output_tokens),
          costUsd: maxCost,
          ...(models.length ? { byModel } : {})
        })
      } else if (type === 'error') {
        const m = str(o.message) ?? str(obj(o.error).message) ?? 'error'
        out.push({ kind: 'error', message: m })
      }
      // stream_event (partial deltas), control_response, rate_limit_event: ignored
      return out
    },
    finalOutput(raw) {
      if (decided?.text != null && decided.text.trim()) return decided.text.trim()
      if (texts.length) return texts[texts.length - 1].trim()
      if (plain.length) return plain.join('\n').trim()
      return lastAny ? '' : raw.trim()
    },
    result: () => decided
  }
}

/**
 * Codex `exec --json`: JSONL events. Supports both the current shape
 * ({type:"item.completed", item:{type:"agent_message", text}}) and the older one
 * ({msg:{type:"agent_message", message}}). Unknown lines are ignored; final output falls back to raw stdout.
 */
export function createCodexParser(): StreamParser {
  const messages: string[] = []
  let errored: string | null = null
  let sawJson = false
  let last: ResultEvent | null = null
  return {
    line(line) {
      const o = parseJson(line)
      if (!o) return line.trim() && !sawJson ? [{ kind: 'text', text: line }] : []
      sawJson = true
      const out: NormalizedEvent[] = []
      const type = str(o.type)
      const item = o.item as Record<string, unknown> | undefined
      const msg = o.msg as Record<string, unknown> | undefined
      if (type === 'thread.started' && str(o.thread_id)) out.push({ kind: 'session', id: str(o.thread_id)! })
      if (item && (type === 'item.completed' || type === 'item.started')) {
        const it = str(item.type)
        if (type === 'item.completed' && (it === 'agent_message' || it === 'assistant_message') && str(item.text)) {
          messages.push(str(item.text)!)
          out.push({ kind: 'text', text: str(item.text)! })
        } else if (type === 'item.started' && (it === 'command_execution' || it === 'mcp_tool_call' || it === 'file_change')) {
          const tool = str(item.tool)
          const name = it === 'mcp_tool_call' && tool && str(item.server) === 'hivemem' ? `hivemem.${tool}` : null
          out.push({
            kind: 'tool_use',
            name: name ?? (it === 'file_change' ? 'file_change' : null) ?? str(item.command) ?? tool ?? it!,
            input: name ? item.arguments ?? item : item,
            id: str(item.id)
          })
        } else if (type === 'item.completed' && (it === 'command_execution' || it === 'mcp_tool_call' || it === 'file_change') && str(item.id)) {
          const st = str(item.status)
          out.push({ kind: 'tool_result', id: str(item.id)!, ok: st !== 'failed' && st !== 'declined' })
        }
      } else if (msg) {
        const mt = str(msg.type)
        if (mt === 'agent_message' && str(msg.message)) {
          messages.push(str(msg.message)!)
          out.push({ kind: 'text', text: str(msg.message)! })
        } else if (mt === 'exec_command_begin') {
          const cmd = Array.isArray(msg.command) ? (msg.command as string[]).join(' ') : 'exec'
          out.push({ kind: 'tool_use', name: cmd })
        } else if (mt === 'error' && str(msg.message)) {
          errored = str(msg.message)
          out.push({ kind: 'error', message: errored! })
        }
      }
      if (type === 'turn.completed') {
        const usage = (o.usage ?? {}) as Record<string, unknown>
        last = {
          kind: 'result',
          text: messages[messages.length - 1] ?? null,
          isError: false,
          subtype: 'success',
          costUsd: null,
          inputTokens: num(usage.input_tokens),
          outputTokens: num(usage.output_tokens),
          numTurns: null,
          permissionDenials: []
        }
        out.push(last)
        out.push({ kind: 'usage', model: null, tokensIn: last.inputTokens, tokensOut: last.outputTokens, costUsd: null })
      } else if (type === 'turn.failed' || type === 'error') {
        const m = str((o.error as Record<string, unknown> | undefined)?.message) ?? str(o.message) ?? 'codex error'
        errored = m
        out.push({ kind: 'error', message: m })
      }
      return out
    },
    finalOutput(raw) {
      if (messages.length) return messages[messages.length - 1].trim()
      if (errored) return errored
      return raw.trim()
    },
    result: () => last
  }
}

/** Gemini built-in subagents (LIVE.md §3.3). Older CLIs expose each agent as a tool of the same name. */
export const GEMINI_BUILTIN_AGENTS = ['codebase_investigator', 'cli_help', 'generalist', 'browser_agent'] as const
export const GEMINI_AGENT_TOOL = 'invoke_agent'

/**
 * Gemini CLI `-o stream-json` (LIVE.md §3.3, from source; fixtures gemini-stream-*.jsonl).
 * Assistant text arrives as delta chunks: concatenated and emitted as one `text` at each tool_use and at result.
 * `invoke_agent` (or a known agent name) is a subagent attributed by timing; EOF without `result` fails the step.
 */
export function createGeminiParser(opts: { agentNames?: string[] } = {}): StreamParser {
  const agents = new Set<string>([...GEMINI_BUILTIN_AGENTS, ...(opts.agentNames ?? [])])
  const subagentIds = new Set<string>()
  let buf = ''
  const blocks: string[] = []
  let last: ResultEvent | null = null
  let sawJson = false
  let deniedNoticed = false
  const plain: string[] = []
  const flush = (out: NormalizedEvent[]): void => {
    const t = buf.trim()
    buf = ''
    if (!t) return
    blocks.push(t)
    out.push({ kind: 'text', text: t })
  }
  return {
    line(line) {
      const o = parseJson(line)
      if (!o) {
        if (line.trim() && !sawJson) plain.push(line)
        return []
      }
      sawJson = true
      const out: NormalizedEvent[] = []
      const type = str(o.type)
      if (type === 'init') {
        const sid = str(o.session_id)
        if (sid) out.push({ kind: 'session', id: sid })
        out.push({ kind: 'usage', model: str(o.model), tokensIn: null, tokensOut: null, costUsd: null })
      } else if (type === 'message') {
        if (str(o.role) === 'assistant') {
          const c = str(o.content) ?? ''
          if (o.delta === true) buf += c
          else {
            buf += c
            flush(out)
          }
        }
      } else if (type === 'tool_use') {
        flush(out)
        const name = str(o.tool_name) ?? 'tool'
        const id = str(o.tool_id)
        const params = obj(o.parameters)
        if (name === GEMINI_AGENT_TOOL || agents.has(name)) {
          if (id) subagentIds.add(id)
          out.push({
            kind: 'subagent_start',
            toolUseId: id,
            agentId: null,
            type: name === GEMINI_AGENT_TOOL ? str(params.agent_name) : name,
            description: str(params.prompt),
            background: false,
            depth: 1,
            parentAgent: null,
            attribution: 'timing',
            prompt: str(params.prompt)
          })
        } else out.push({ kind: 'tool_use', name, input: o.parameters, id })
      } else if (type === 'tool_result') {
        const id = str(o.tool_id)
        if (!id) return out
        const ok = str(o.status) === 'success'
        const err = obj(o.error)
        if (subagentIds.has(id)) {
          out.push({ kind: 'subagent_end', agentId: null, toolUseId: id, status: ok ? 'done' : 'failed', report: str(o.output) })
        } else {
          const denied = !ok && str(err.type) === 'policy_violation'
          out.push({ kind: 'tool_result', id, ok, text: str(o.output) ?? str(err.message), denied })
          if (denied && !deniedNoticed && /denied by policy/i.test(str(err.message) ?? str(o.output) ?? '')) {
            deniedNoticed = true
            out.push({ kind: 'notice', text: "Gemini can't ask in headless mode yet; denied" })
          }
        }
      } else if (type === 'error') {
        out.push({ kind: 'error', message: str(o.message) ?? 'gemini error' })
      } else if (type === 'result') {
        flush(out)
        const st = obj(o.stats)
        const byModel: Record<string, ModelTokens> = {}
        for (const [m, v] of Object.entries(obj(st.models))) {
          const mv = obj(v)
          byModel[m] = { tokensIn: num(mv.input_tokens) ?? 0, tokensOut: num(mv.output_tokens) ?? 0, costUsd: null }
        }
        const isError = str(o.status) === 'error'
        last = {
          kind: 'result',
          text: blocks[blocks.length - 1] ?? null,
          isError,
          subtype: str(o.status),
          costUsd: null,
          inputTokens: num(st.input_tokens),
          outputTokens: num(st.output_tokens),
          numTurns: null,
          permissionDenials: []
        }
        if (isError) last.text = str(obj(o.error).message) ?? last.text
        out.push(last)
        out.push({
          kind: 'usage',
          model: null,
          tokensIn: num(st.input_tokens),
          tokensOut: num(st.output_tokens),
          costUsd: null,
          ...(Object.keys(byModel).length ? { byModel } : {})
        })
      }
      return out
    },
    finalOutput(raw) {
      if (last?.text?.trim()) return last.text.trim()
      const t = [...blocks, buf.trim()].filter(Boolean)
      if (t.length) return t[t.length - 1]
      if (plain.length) return plain.join('\n').trim()
      return sawJson ? '' : raw.trim()
    },
    result: () => last,
    incomplete: () => (sawJson && !last ? 'Gemini ended without a result' : null)
  }
}

const CURSOR_FAILURES = new Set(['failure', 'rejected', 'permissionDenied', 'error', 'timeout', 'spawnError', 'fileNotFound', 'readPermissionDenied', 'writePermissionDenied', 'toolNotFound', 'serverNotFound'])
const CURSOR_DENIED = new Set(['rejected', 'permissionDenied'])

/** The ToolCall oneof: `{shellToolCall:{args,result}}` -> ['shell', {args,result}]. */
function cursorOneof(tc: Record<string, unknown>): [string, Record<string, unknown>] | null {
  for (const [k, v] of Object.entries(tc)) {
    if (k.endsWith('ToolCall') && v && typeof v === 'object') return [k.slice(0, -'ToolCall'.length), v as Record<string, unknown>]
  }
  return null
}
function cursorToolName(kind: string, body: Record<string, unknown>): string {
  if (kind === 'mcp') {
    const a = obj(body.args)
    const server = str(a.serverIdentifier) ?? str(a.providerIdentifier) ?? 'mcp'
    const tool = str(a.toolName) ?? str(a.name) ?? 'tool'
    return `mcp:${server}.${tool}`
  }
  return kind
}
function cursorSubagentType(v: unknown): string | null {
  if (typeof v === 'string') return v
  const o = obj(v)
  const k = Object.keys(o)[0]
  if (!k) return null
  if (k === 'custom') return str(obj(o.custom).name) ?? 'custom'
  return k
}
function cursorResult(body: Record<string, unknown>): { key: string | null; value: Record<string, unknown> } {
  const r = obj(body.result)
  const key = Object.keys(r)[0] ?? null
  return { key, value: key ? obj(r[key]) : {} }
}
function cursorResultText(kind: string, key: string | null, v: Record<string, unknown>): string | null {
  if (!key) return null
  if (kind === 'shell') return str(v.interleavedOutput) ?? str(v.stdout) ?? str(v.reason) ?? null
  if (kind === 'mcp') {
    const t = arr(v.content)
      .map((c) => str(obj(obj(c).text).text))
      .filter(Boolean)
    return t.length ? t.join('\n') : str(v.error) ?? null
  }
  return str(v.message) ?? str(v.error) ?? str(v.reason) ?? null
}

/** Maps one cursor ToolCall (stream or conversationSteps) to tool_use + tool_result events. */
function cursorToolEvents(tc: Record<string, unknown>, id: string, agent: string | null, completed: boolean): NormalizedEvent[] {
  const one = cursorOneof(tc)
  if (!one) return []
  const [kind, body] = one
  const name = cursorToolName(kind, body)
  const out: NormalizedEvent[] = [{ kind: 'tool_use', name, input: body.args, id, agent }]
  if (completed) {
    const { key, value } = cursorResult(body)
    out.push({
      kind: 'tool_result',
      id,
      ok: !!key && !CURSOR_FAILURES.has(key) && !(kind === 'mcp' && value.isError === true),
      text: cursorResultText(kind, key, value),
      agent,
      denied: !!key && CURSOR_DENIED.has(key)
    })
  }
  return out
}

/**
 * cursor-agent `-p --output-format stream-json` (LIVE.md §3.4; fixture cursor-stream-subagent.jsonl).
 * Without --stream-partial-output every `assistant` line is a whole flush. Task tool calls are subagents whose
 * transcript (conversationSteps) arrives at completion.
 */
export function createCursorParser(): StreamParser {
  const texts: string[] = []
  const started = new Set<string>()
  const tasks = new Set<string>()
  let last: ResultEvent | null = null
  let sawJson = false
  const plain: string[] = []
  return {
    line(line) {
      const o = parseJson(line)
      if (!o) {
        if (line.trim() && !sawJson) plain.push(line)
        return []
      }
      sawJson = true
      const out: NormalizedEvent[] = []
      const type = str(o.type)
      const sub = str(o.subtype)
      if (type === 'system' && sub === 'init') {
        const sid = str(o.session_id)
        if (sid) out.push({ kind: 'session', id: sid })
        out.push({ kind: 'usage', model: str(o.model), tokensIn: null, tokensOut: null, costUsd: null })
      } else if (type === 'assistant') {
        const t = contentText(obj(o.message).content)
        if (t?.trim()) {
          texts.push(t)
          out.push({ kind: 'text', text: t })
        }
      } else if (type === 'tool_call') {
        const id = str(o.call_id) ?? str(obj(o.tool_call).toolCallId)
        const tc = obj(o.tool_call)
        const one = cursorOneof(tc)
        if (!id || !one) return out
        const [kind, body] = one
        const args = obj(body.args)
        if (kind === 'task') {
          if (sub === 'started' && !tasks.has(id)) {
            tasks.add(id)
            out.push({
              kind: 'subagent_start',
              toolUseId: id,
              agentId: str(args.agentId),
              type: cursorSubagentType(args.subagentType),
              description: str(args.description),
              background: false,
              depth: 1,
              parentAgent: null,
              attribution: 'completion',
              model: str(args.model),
              prompt: str(args.prompt)
            })
          } else if (sub === 'completed') {
            const { key, value } = cursorResult(body)
            const steps = arr(value.conversationSteps).map(obj)
            const transcript: NormalizedEvent[] = []
            let report: string | null = null
            let n = 0
            for (const s of steps) {
              if (s.assistantMessage) {
                const t = str(obj(s.assistantMessage).text)
                if (t) {
                  report = t
                  transcript.push({ kind: 'text', text: t, agent: id })
                }
              } else if (s.toolCall) {
                const inner = obj(s.toolCall)
                const iid = str(inner.toolCallId) ?? `${id}:${n++}`
                transcript.push(...cursorToolEvents(inner, iid, id, true))
              }
            }
            out.push({
              kind: 'subagent_end',
              agentId: str(value.agentId),
              toolUseId: id,
              status: key === 'success' ? 'done' : 'failed',
              report: report ?? str(obj(value.error).error) ?? str(value.error),
              transcript
            })
          }
          return out
        }
        if (kind === 'updateTodos') {
          const todos = arr(args.todos).map(obj)
          const cur = todos.find((t) => /in.?progress/i.test(str(t.status) ?? ''))
          if (cur && str(cur.content)) out.push({ kind: 'activity', text: str(cur.content)! })
        }
        if (sub === 'started') {
          started.add(id)
          out.push(...cursorToolEvents(tc, id, null, false))
        } else if (sub === 'completed') {
          const evs = cursorToolEvents(tc, id, null, true)
          out.push(...(started.has(id) ? evs.filter((e) => e.kind === 'tool_result') : evs))
        }
      } else if (type === 'interaction_query' && sub === 'request') {
        const qt = str(o.query_type) ?? ''
        if (/askQuestion/i.test(qt)) out.push({ kind: 'notice', text: 'Question skipped in headless mode' })
      } else if (type === 'system' && sub === 'task_notification') {
        const st = claudeTaskStatus(str(o.status)) ?? 'done'
        out.push({ kind: 'subagent_end', agentId: str(o.task_id), toolUseId: str(o.task_id), status: st, report: str(o.detail) })
      } else if (type === 'result') {
        const u = obj(o.usage)
        const isError = o.is_error === true || (sub ?? 'success') !== 'success'
        last = {
          kind: 'result',
          text: str(o.result),
          isError,
          subtype: sub,
          costUsd: null,
          inputTokens: num64(u.inputTokens),
          outputTokens: num64(u.outputTokens),
          numTurns: null,
          permissionDenials: []
        }
        out.push(last)
        out.push({ kind: 'usage', model: null, tokensIn: last.inputTokens, tokensOut: last.outputTokens, costUsd: null })
      }
      return out
    },
    finalOutput(raw) {
      if (texts.length) return texts[texts.length - 1].trim()
      if (last?.text?.trim()) return last.text.trim()
      if (plain.length) return plain.join('\n').trim()
      return sawJson ? '' : raw.trim()
    },
    result: () => last
  }
}

/** Plain text CLIs (shell): every line is text; output = stdout. */
export function createTextParser(): StreamParser {
  return {
    line: (line) => (line.length ? [{ kind: 'text', text: line }] : []),
    finalOutput: (raw) => raw.trim(),
    result: () => null
  }
}

/** Last `VERDICT: PASS|FAIL` in a reviewer reply; missing = FAIL (SPEC 7.3). */
export function parseVerdict(text: string): 'PASS' | 'FAIL' {
  const all = [...text.matchAll(/VERDICT:\s*\**\s*(PASS|FAIL)/gi)]
  if (!all.length) return 'FAIL'
  return all[all.length - 1][1].toUpperCase() as 'PASS' | 'FAIL'
}

/**
 * Human-readable live line for a normalized event (step.output chunks are text, not JSON).
 * Main agent only: subagent text and tools go to agent events (LIVE.md §3).
 */
export function eventToChunk(e: NormalizedEvent): string | null {
  switch (e.kind) {
    case 'text':
      if (e.agent) return null
      return e.text.endsWith('\n') ? e.text : `${e.text}\n`
    case 'tool_use': {
      if (e.agent) return null
      const mem = memoryToolLine(e.name, e.input)
      return mem ? `${mem}\n` : `→ ${e.name}\n`
    }
    case 'subagent_start':
      // only the spawning tool call (not the later lifecycle event for the same subagent)
      if (e.agentId != null || e.parentAgent) return null
      return `→ subagent${e.type ? ` ${e.type}` : ''}${e.description ? `: ${e.description}` : ''}\n`
    case 'error':
      if (e.agent) return null
      return `✕ ${e.message}\n`
    case 'result': {
      const bits: string[] = []
      if (e.numTurns != null) bits.push(`${e.numTurns} turn${e.numTurns === 1 ? '' : 's'}`)
      if (e.costUsd != null) bits.push(`$${e.costUsd.toFixed(4)}`)
      if (e.inputTokens != null || e.outputTokens != null)
        bits.push(`${e.inputTokens ?? 0} in / ${e.outputTokens ?? 0} out tokens`)
      return bits.length ? `— ${e.isError ? 'error' : 'done'} · ${bits.join(' · ')}\n` : null
    }
    default:
      return null
  }
}
