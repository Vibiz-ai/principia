/**
 * AgentTracker (LIVE.md §1, §3): one pure, deterministic reducer per root (session or step). It consumes parser
 * NormalizedEvents (headless streams) and HookEvents (hook lines, ask_user lines, PTY detections) and returns LiveOps.
 * The caller applies them (executor for steps, main's SessionLive for sessions): map keys to ids, redact, persist, emit.
 *
 * Identity (A6): a subagent's key is the FIRST id seen for it (headless: the spawning tool_use id; hooks: agent_id).
 * Every later id (task_id, agent_id, cursor subagent_id) is an alias of that key and never creates a second node.
 */
import type { AgentStatus, AskKind, AskOption, Attribution, ModelUsage, NeedsKind } from '../../../shared/live'
import type { AdapterId } from '../../../shared/types'
import type { NormalizedEvent } from '../parse'
import { GEMINI_AGENT_TOOL, GEMINI_BUILTIN_AGENTS } from '../parse'
import {
  ACTIVITY_MAX,
  SUMMARY_MAX,
  addFiles,
  clip,
  clipDetail,
  editedFiles,
  firstLine,
  isMemoryRead,
  summarizeTool
} from './summary'
import { ROOT_KEY, type AgentPatch, type AskOpen, type HookEvent, type LiveOp, type TrackedAsk } from './types'

/** Headless asks expire after 60 min (D8). */
export const ASK_TIMEOUT_MS = 60 * 60_000

const TERMINAL: ReadonlySet<AgentStatus> = new Set(['done', 'failed', 'canceled'])
export const isTerminal = (s: AgentStatus): boolean => TERMINAL.has(s)

interface Node extends AgentPatch {
  key: string
  /** Interactive root: session started, no prompt yet (status idle, not Needs you). */
  fresh: boolean
  /** Interactive root: a turn ended, waiting for the user (needs = idle). */
  idleWaiting: boolean
  /** Task text, for matching cursor subagentStop. */
  prompt: string | null
  /** gemini hook bracket bound (timing attribution). */
  bracketed: boolean
}

interface ToolRow {
  key: string
  name: string
  done: boolean
}

export interface TrackerOptions {
  provider: AdapterId
  root: { kind: 'session' | 'step'; title: string; cwd: string; model?: string | null }
  /** true for run steps (stream is the source of truth; hook tool lines outside subagents are dropped). */
  headless: boolean
  now?: () => Date
  askTimeoutMs?: number
  /** Extra gemini agent names (from .gemini/agents/*.md). */
  geminiAgents?: string[]
  /**
   * DEPARTMENTS.md §5: the board task of the run or session being tracked. Stamped on every opened ask so the store
   * writes asks.task_id (which otherwise falls back to the run's runs.task_id / the session's sessions.task_id).
   */
  taskId?: string | null
}

export interface AgentTracker {
  /** Ops creating the root row (status starting). Call once before feeding input. */
  begin(): LiveOp[]
  stream(e: NormalizedEvent): LiveOp[]
  hook(e: HookEvent): LiveOp[]
  /** Hive answered this ask (asks:answer). `summary` goes into the agent's timeline. */
  answered(gateId: string, summary: string): LiveOp[]
  /** The root's title changed (a chat titled by its first message). */
  retitle(title: string): LiveOp[]
  /** The ask's 60-min timer fired. */
  expire(gateId: string): LiveOp[]
  /** Close an ask without an answer (run canceled, gate withdrawn). */
  cancel(gateId: string): LiveOp[]
  /** The root reached a terminal status: cancels every open ask and ends open subagents (A4a). */
  end(status: 'done' | 'failed' | 'canceled', activity?: string | null): LiveOp[]
  openAsks(): TrackedAsk[]
  ask(gateId: string): TrackedAsk | null
  /** Resolves an external id (tool_use id, agent id, task id) to its key. */
  keyOf(id: string | null | undefined): string | null
  node(key: string): Readonly<AgentPatch> | null
  /** Keys in creation order (root first). */
  keys(): string[]
  ended(): boolean
}

const PERMISSION_HEADLESS: AskOption[] = [
  { id: 'allow', label: 'Allow once', kind: 'allow' },
  { id: 'allow_step', label: 'Allow for this step', kind: 'allow_step' },
  { id: 'deny', label: 'Deny', kind: 'deny' }
]
const PERMISSION_PTY: AskOption[] = [
  { id: 'allow', label: 'Allow once', kind: 'allow' },
  { id: 'deny', label: 'Deny', kind: 'deny' },
  { id: 'focus', label: 'Open terminal', kind: 'focus' }
]
const TRUST_PTY: AskOption[] = [{ id: 'focus', label: 'Open terminal', kind: 'focus' }]

export function choiceOptions(labels: string[]): AskOption[] {
  return labels.slice(0, 6).map((l, i) => ({ id: `choice:${i}`, label: clip(l, 120), kind: 'choice' as const }))
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

export function createAgentTracker(o: TrackerOptions): AgentTracker {
  const now = (): string => (o.now ? o.now() : new Date()).toISOString()
  const askTimeout = o.askTimeoutMs ?? ASK_TIMEOUT_MS
  const provider = o.provider
  const interactive = !o.headless
  const geminiAgents = new Set<string>([...GEMINI_BUILTIN_AGENTS, ...(o.geminiAgents ?? [])])

  const nodes = new Map<string, Node>()
  const alias = new Map<string, string>()
  const tools = new Map<string, ToolRow>()
  const asks = new Map<string, TrackedAsk>()
  /** Hook tool rows without a tool_use_id, FIFO per tool name (gemini). */
  const pendingByName = new Map<string, string[]>()
  /** Open gemini invoke_agent brackets (keys). */
  const brackets: string[] = []
  let synth = 0
  let ptySeq = 0
  let bgRunning = 0
  let resultSeen = false
  let stdinClosed = false
  let hooksSeen = false
  let rootConv: string | null = null
  let rootEnded = false

  const t0 = now()
  const root: Node = {
    key: ROOT_KEY,
    parentKey: null,
    kind: o.root.kind,
    title: o.root.title,
    agentType: null,
    externalId: null,
    toolUseId: null,
    model: o.root.model ?? null,
    depth: 0,
    background: false,
    attribution: 'exact',
    status: 'starting',
    needs: null,
    activity: null,
    lastTool: null,
    toolCount: 0,
    memReads: 0,
    filesTouched: [],
    tokensIn: null,
    tokensOut: null,
    costUsd: null,
    modelUsage: null,
    report: null,
    startedAt: t0,
    updatedAt: t0,
    endedAt: null,
    fresh: false,
    idleWaiting: false,
    prompt: null,
    bracketed: false
  }
  nodes.set(ROOT_KEY, root)

  // ---------- helpers ----------

  const patchOf = (n: Node): AgentPatch => {
    const { key: _k, fresh: _f, idleWaiting: _i, prompt: _p, bracketed: _b, ...rest } = n
    return { ...rest, filesTouched: [...n.filesTouched], modelUsage: n.modelUsage ? { ...n.modelUsage } : null }
  }
  const upsert = (n: Node, ops: LiveOp[]): void => {
    n.updatedAt = now()
    // replace an earlier upsert of the same node in this batch: one row write per node per input
    const i = ops.findIndex((x) => x.op === 'agent.upsert' && x.key === n.key)
    const op: LiveOp = { op: 'agent.upsert', key: n.key, patch: patchOf(n) }
    if (i >= 0) ops.splice(i, 1)
    ops.push(op)
  }
  const keyOf = (id: string | null | undefined): string | null => {
    if (!id) return null
    if (nodes.has(id)) return id
    return alias.get(id) ?? null
  }
  const nodeFor = (agent: string | null | undefined): Node => {
    const k = keyOf(agent)
    return (k && nodes.get(k)) || root
  }
  const asksOn = (key: string): TrackedAsk[] => [...asks.values()].filter((a) => a.key === key)

  /** Status/needs/activity from the node's flags and its open asks. */
  const recompute = (n: Node): void => {
    if (isTerminal(n.status)) {
      n.needs = null
      return
    }
    const open = asksOn(n.key)
    if (open.length) {
      n.status = 'needs_you'
      n.needs = open[0].kind as NeedsKind
      n.activity = clip(`Waiting for you: ${open[0].title}`, ACTIVITY_MAX)
      return
    }
    if (n.idleWaiting) {
      n.status = 'needs_you'
      n.needs = 'idle'
      return
    }
    n.needs = null
    if (n.fresh) {
      n.status = 'idle'
      return
    }
    if (n.status === 'needs_you' || n.status === 'starting' || n.status === 'idle') n.status = 'working'
  }
  /** Activity arrived on this node: starting/idle -> working. */
  const touch = (n: Node): void => {
    if (isTerminal(n.status)) return
    // idle is cleared only by a prompt or user input: late async hook lines must not hide "Your turn"
    n.fresh = false
    if (n.status === 'starting' || n.status === 'idle') n.status = 'working'
    recompute(n)
  }
  const setActivity = (n: Node, line: string | null): void => {
    if (!line) return
    if (asksOn(n.key).length) return // the open ask's title wins (LIVE.md §1.3)
    n.activity = clip(line, ACTIVITY_MAX)
  }
  const appendEvent = (
    n: Node,
    ops: LiveOp[],
    e: { kind: 'tool' | 'text' | 'thinking' | 'status' | 'ask' | 'answer' | 'error'; summary: string; detail?: string | null; name?: string | null; toolUseId?: string | null; state?: 'running' | 'ok' | 'error' | 'denied' | null; description?: string | null }
  ): void => {
    ops.push({
      op: 'event.append',
      key: n.key,
      event: {
        ts: now(),
        kind: e.kind,
        toolUseId: e.toolUseId ?? null,
        name: e.name ?? null,
        summary: clip(e.summary, SUMMARY_MAX) || e.kind,
        detail: clipDetail(e.detail ?? null),
        state: e.state ?? null,
        ...(e.description ? { description: clip(e.description, SUMMARY_MAX) } : {})
      }
    })
  }

  const addFilesTo = (n: Node, paths: string[]): void => {
    if (!paths.length) return
    n.filesTouched = addFiles(n.filesTouched, paths)
    if (n !== root) root.filesTouched = addFiles(root.filesTouched, paths)
  }

  /** A tool call starts on node n (stream tool_use or hook Pre). */
  const toolStart = (n: Node, ops: LiveOp[], name: string, input: unknown, id: string, state: 'running' | 'ok' | 'error' | 'denied' = 'running', detail?: string | null): void => {
    tools.set(id, { key: n.key, name, done: state !== 'running' })
    const { line, lastTool } = summarizeTool(provider, name, input)
    touch(n)
    n.toolCount++
    n.lastTool = lastTool
    if (isMemoryRead(provider, name)) n.memReads++
    addFilesTo(n, editedFiles(provider, name, input, o.root.cwd))
    setActivity(n, line)
    appendEvent(n, ops, { kind: 'tool', summary: line, detail: detail ?? (input == null ? null : safeJson(input)), name, toolUseId: id, state, description: toolDescription(input) })
    if (n !== root && root.filesTouched.length) upsert(root, ops)
    upsert(n, ops)
  }
  const toolEnd = (id: string, ops: LiveOp[], state: 'ok' | 'error' | 'denied', text: string | null | undefined): Node | null => {
    const row = tools.get(id)
    if (!row) return null
    const n = nodes.get(row.key)
    if (!n || row.done) return n ?? null
    row.done = true
    ops.push({ op: 'event.update', key: row.key, toolUseId: id, patch: { state, detail: clipDetail(text ?? null) } })
    return n
  }

  // ---------- asks ----------

  const openAsk = (
    n: Node,
    ops: LiveOp[],
    a: {
      gateId: string
      kind: AskKind
      channel: TrackedAsk['channel']
      title: string
      detail?: string | null
      toolName?: string | null
      toolInput?: unknown
      question?: string | null
      options: AskOption[]
      fromScreen?: boolean
    }
  ): void => {
    if (asks.has(a.gateId) || rootEnded) return
    const createdAt = now()
    const headlessChannel = a.channel === 'stdio' || a.channel === 'hook_gate' || a.channel === 'mcp'
    const expiresAt = headlessChannel ? new Date(Date.parse(createdAt) + askTimeout).toISOString() : null
    const title = clip(a.title, SUMMARY_MAX) || 'Needs you'
    asks.set(a.gateId, {
      gateId: a.gateId,
      key: n.key,
      channel: a.channel,
      kind: a.kind,
      toolName: a.toolName ?? null,
      toolInput: a.toolInput ?? null,
      title,
      options: a.options,
      createdAt,
      fromScreen: a.fromScreen === true,
      seenOnScreen: a.fromScreen === true
    })
    // the agent row (needs_you) first: appliers emit it before the ask so the hub can place the ask
    if (n.status === 'starting' || n.status === 'idle') n.status = 'working'
    n.fresh = false
    recompute(n)
    upsert(n, ops)
    const ask: AskOpen & { taskId?: string } = {
      provider,
      kind: a.kind,
      channel: a.channel,
      title,
      detail: a.detail ? clip(a.detail, 300) : null,
      toolName: a.toolName ?? null,
      toolInput: a.toolInput ?? null,
      question: a.question ?? null,
      options: a.options,
      createdAt,
      expiresAt,
      ...(o.taskId ? { taskId: o.taskId } : {})
    }
    ops.push({ op: 'ask.open', key: n.key, gateId: a.gateId, ask })
    appendEvent(n, ops, { kind: 'ask', summary: `Waiting for you: ${title}`, detail: a.question ?? a.detail ?? null, name: a.toolName ?? null })
  }
  const resolveAsk = (
    gateId: string,
    ops: LiveOp[],
    via: 'hive' | 'terminal' | 'timeout' | null,
    status: 'answered' | 'expired' | 'canceled',
    summary?: string
  ): void => {
    const a = asks.get(gateId)
    if (!a) return
    asks.delete(gateId)
    ops.push({ op: 'ask.resolve', gateId, key: a.key, via, status })
    const n = nodes.get(a.key)
    if (!n) return
    if (summary) appendEvent(n, ops, { kind: 'answer', summary, name: a.toolName })
    n.activity = null
    recompute(n)
    upsert(n, ops)
  }
  const resolvePty = (ops: LiveOp[], pred: (a: TrackedAsk) => boolean): void => {
    for (const a of [...asks.values()]) if (a.channel === 'pty' && pred(a)) resolveAsk(a.gateId, ops, 'terminal', 'answered', 'Answered in the terminal')
  }

  const permissionTitle = (name: string, input: unknown): string => summarizeTool(provider, name, input).line

  // ---------- subagents ----------

  const newSubagent = (
    ops: LiveOp[],
    key: string,
    f: {
      parent: Node
      type: string | null
      description: string | null
      externalId: string | null
      toolUseId: string | null
      depth: number | null
      background: boolean
      attribution: Attribution
      model?: string | null
      prompt?: string | null
    }
  ): Node => {
    const t = now()
    const n: Node = {
      key,
      parentKey: f.parent.key,
      kind: 'subagent',
      title: clip(f.description || f.type || 'Subagent', SUMMARY_MAX),
      agentType: f.type,
      externalId: f.externalId,
      toolUseId: f.toolUseId,
      model: f.model ?? null,
      depth: f.depth ?? f.parent.depth + 1,
      background: f.background,
      attribution: f.attribution,
      status: 'working',
      needs: null,
      activity: f.description ? clip(f.description, ACTIVITY_MAX) : null,
      lastTool: null,
      toolCount: 0,
      memReads: 0,
      filesTouched: [],
      tokensIn: null,
      tokensOut: null,
      costUsd: null,
      modelUsage: null,
      report: null,
      startedAt: t,
      updatedAt: t,
      endedAt: null,
      fresh: false,
      idleWaiting: false,
      prompt: f.prompt ?? null,
      bracketed: false
    }
    nodes.set(key, n)
    if (f.externalId && f.externalId !== key) alias.set(f.externalId, key)
    if (f.toolUseId && f.toolUseId !== key) alias.set(f.toolUseId, key)
    upsert(n, ops)
    touch(f.parent)
    // the Agent/Task spawn is a tool call of the parent; streams turn it into this node instead of a tool row, so count
    // it here (hook paths that already saw the call as a tool row are not counted twice)
    if (f.toolUseId && !tools.has(f.toolUseId)) f.parent.toolCount++
    setActivity(f.parent, `Agent ${n.title}`)
    appendEvent(f.parent, ops, { kind: 'status', summary: `Started subagent ${n.agentType ? `${n.agentType}: ` : ''}${n.title}`, detail: f.prompt ?? null })
    upsert(f.parent, ops)
    return n
  }
  const endNode = (n: Node, ops: LiveOp[], status: 'done' | 'failed' | 'canceled', report: string | null, activity?: string | null): void => {
    if (isTerminal(n.status)) return
    for (const a of asksOn(n.key)) resolveAsk(a.gateId, ops, null, 'canceled')
    n.status = status
    n.needs = null
    n.idleWaiting = false
    n.fresh = false
    n.endedAt = now()
    if (report) n.report = clipDetail(report)
    n.activity = activity !== undefined ? activity : status === 'done' ? (n.report ? clip(firstLine(n.report), ACTIVITY_MAX) : 'Done') : status === 'failed' ? 'Failed' : 'Canceled'
    const b = brackets.indexOf(n.key)
    if (b >= 0) brackets.splice(b, 1)
    upsert(n, ops)
    if (n.parentKey) {
      const p = nodes.get(n.parentKey)
      if (p && !isTerminal(p.status)) {
        appendEvent(p, ops, { kind: 'status', summary: `Subagent ${n.title} ${status === 'done' ? 'finished' : status}`, detail: n.report })
      }
    }
  }

  // ---------- stream (headless) ----------

  const stream = (e: NormalizedEvent): LiveOp[] => {
    const ops: LiveOp[] = []
    if (rootEnded) return ops
    switch (e.kind) {
      case 'session':
        break
      case 'text': {
        const n = nodeFor(e.agent)
        if (!e.text.trim()) break
        touch(n)
        setActivity(n, firstLine(e.text))
        appendEvent(n, ops, { kind: 'text', summary: firstLine(e.text), detail: e.text })
        upsert(n, ops)
        break
      }
      case 'tool_use': {
        const n = nodeFor(e.agent)
        const id = e.id ?? `t${++synth}`
        if (tools.has(id)) break
        toolStart(n, ops, e.name, e.input, id)
        break
      }
      case 'tool_result': {
        const n = toolEnd(e.id, ops, e.denied ? 'denied' : e.ok ? 'ok' : 'error', e.text)
        if (n) {
          touch(n)
          upsert(n, ops)
        }
        break
      }
      case 'subagent_start': {
        const existing = keyOf(e.toolUseId) ?? keyOf(e.agentId) ?? (provider === 'gemini' ? bindGeminiHookNode(e.type) : null)
        if (existing) {
          const n = nodes.get(existing)!
          if (e.agentId && e.agentId !== existing) {
            alias.set(e.agentId, existing)
            n.externalId = e.agentId
          }
          if (e.toolUseId && e.toolUseId !== existing) {
            alias.set(e.toolUseId, existing)
            n.toolUseId ??= e.toolUseId
          }
          if (e.depth != null) n.depth = e.depth
          if (e.background) n.background = true
          if (e.type && !n.agentType) n.agentType = e.type
          if (e.model && !n.model) n.model = e.model
          upsert(n, ops)
          break
        }
        const key = e.toolUseId ?? e.agentId ?? `sa${++synth}`
        const parent = e.parentAgent ? nodeFor(e.parentAgent) : root
        newSubagent(ops, key, {
          parent,
          type: e.type,
          description: e.description,
          externalId: e.agentId,
          toolUseId: e.toolUseId,
          depth: e.depth,
          background: e.background,
          attribution: e.attribution,
          model: e.model ?? null,
          prompt: e.prompt ?? e.description
        })
        break
      }
      case 'subagent_progress': {
        const k = keyOf(e.agentId)
        const n = k ? nodes.get(k) : undefined
        if (!n) break
        if (e.report) n.report = clipDetail(e.report)
        if (isTerminal(n.status)) {
          upsert(n, ops)
          break
        }
        if (e.lastTool) n.lastTool = e.lastTool
        if (e.toolUses != null && e.toolUses > n.toolCount) n.toolCount = e.toolUses
        setActivity(n, e.activity)
        touch(n)
        upsert(n, ops)
        break
      }
      case 'subagent_end': {
        const k = keyOf(e.toolUseId) ?? keyOf(e.agentId)
        const n = k ? nodes.get(k) : undefined
        if (!n) break
        if (e.agentId && e.agentId !== n.key && !alias.has(e.agentId)) {
          alias.set(e.agentId, n.key)
          n.externalId ??= e.agentId
        }
        for (const t of e.transcript ?? []) ops.push(...stream(t))
        if (e.tokensIn != null) n.tokensIn = e.tokensIn
        if (e.tokensOut != null) n.tokensOut = e.tokensOut
        if (e.model && !n.model) n.model = e.model
        if (isTerminal(n.status)) {
          if (e.report && !n.report) n.report = clipDetail(e.report)
          upsert(n, ops)
          break
        }
        endNode(n, ops, e.status, e.report ?? n.report)
        break
      }
      case 'permission_request': {
        const byTool = e.toolUseId ? tools.get(e.toolUseId)?.key : null
        const n = (keyOf(e.agentId) && nodes.get(keyOf(e.agentId)!)) || (byTool && nodes.get(byTool)) || root
        if (e.toolName === 'AskUserQuestion') {
          const q = obj((Array.isArray(obj(e.input).questions) ? (obj(e.input).questions as unknown[]) : [])[0])
          const question = str(q.question) ?? 'The agent has a question'
          const labels = (Array.isArray(q.options) ? (q.options as unknown[]) : []).map((x) => str(obj(x).label) ?? str(x)).filter((x): x is string => !!x)
          openAsk(n, ops, { gateId: e.requestId, kind: 'question', channel: 'stdio', title: question, question, toolName: e.toolName, toolInput: e.input, options: choiceOptions(labels) })
          break
        }
        openAsk(n, ops, {
          gateId: e.requestId,
          kind: 'permission',
          channel: 'stdio',
          title: e.title ?? permissionTitle(e.toolName, e.input),
          detail: e.description,
          toolName: e.toolName,
          toolInput: e.input,
          options: e.options ?? PERMISSION_HEADLESS
        })
        break
      }
      case 'control_unknown':
        break
      case 'background':
        bgRunning = e.running
        if (resultSeen && bgRunning === 0) closeStdin(ops)
        else if (bgRunning > 0 && !isTerminal(root.status)) {
          setActivity(root, `Background: ${bgRunning} task${bgRunning === 1 ? '' : 's'}`)
          upsert(root, ops)
        }
        break
      case 'result':
        resultSeen = true
        if (bgRunning === 0) closeStdin(ops)
        break
      case 'usage': {
        if (e.model && !root.model) root.model = e.model
        if (e.tokensIn != null) root.tokensIn = e.tokensIn
        if (e.tokensOut != null) root.tokensOut = e.tokensOut
        if (e.costUsd != null) root.costUsd = e.costUsd
        if (e.byModel) {
          const mu: Record<string, ModelUsage> = {}
          for (const [m, v] of Object.entries(e.byModel)) mu[m] = { tokensIn: v.tokensIn, tokensOut: v.tokensOut, costUsd: v.costUsd }
          root.modelUsage = mu
        }
        upsert(root, ops)
        break
      }
      case 'error': {
        const n = nodeFor(e.agent)
        appendEvent(n, ops, { kind: 'error', summary: e.message, detail: e.message })
        upsert(n, ops)
        break
      }
      case 'notice': {
        const n = nodeFor(e.agent)
        appendEvent(n, ops, { kind: 'status', summary: e.text })
        upsert(n, ops)
        break
      }
      case 'activity': {
        const n = nodeFor(e.agent)
        touch(n)
        setActivity(n, e.text)
        upsert(n, ops)
        break
      }
    }
    return ops
  }

  const closeStdin = (ops: LiveOp[]): void => {
    if (stdinClosed) return
    stdinClosed = true
    ops.push({ op: 'control.closeStdin' })
  }

  /** gemini: a hook-created bracket node waiting for its stream subagent_start (hook line arrived first). */
  const bindGeminiHookNode = (type: string | null): string | null => {
    for (const n of nodes.values()) {
      if (n.kind === 'subagent' && n.key.startsWith('gh:') && !n.toolUseId && !isTerminal(n.status) && n.agentType === type) return n.key
    }
    return null
  }

  // ---------- hooks ----------

  const isGeminiAgentTool = (name: string): boolean => provider === 'gemini' && (name === GEMINI_AGENT_TOOL || geminiAgents.has(name))
  const geminiAgentName = (name: string, input: unknown): string | null =>
    name === GEMINI_AGENT_TOOL ? str(obj(input).agent_name) : name

  /** Which node a hook tool line belongs to, or null to drop it. */
  const hookToolNode = (agent: string | null, conv: string | null | undefined): Node | null => {
    if (provider === 'cursor') {
      if (conv && rootConv && conv !== rootConv) return null // A8: no attribution by conversation_id
      if (conv && !rootConv) rootConv = conv
    }
    const k = keyOf(agent)
    if (k) return nodes.get(k)!
    if (provider === 'gemini' && brackets.length) {
      if (brackets.length === 1) return nodes.get(brackets[0]) ?? root
      return root // overlapping subagents: "activity matched by timing" on the root (A8)
    }
    // headless: the stream already reports the main agent's tools
    return o.headless ? null : root
  }

  const hook = (e: HookEvent): LiveOp[] => {
    const ops: LiveOp[] = []
    if (rootEnded) return ops
    if (e.kind !== 'pty_prompt' && e.kind !== 'user_input') hooksSeen = true
    switch (e.kind) {
      case 'session_start':
        if (e.conv && !rootConv) rootConv = e.conv
        if (e.model && !root.model) root.model = e.model
        if (interactive) {
          root.fresh = true
          if (root.status === 'starting') root.status = 'idle'
          recompute(root)
        }
        upsert(root, ops)
        break
      case 'prompt':
        if (!interactive) break
        resolvePty(ops, (a) => a.kind === 'permission')
        root.fresh = false
        root.idleWaiting = false
        root.report = null // a new turn: the last turn's message no longer describes what the agent waits for
        if (!isTerminal(root.status)) {
          if (root.status === 'idle' || root.status === 'starting') root.status = 'working'
          setActivity(root, e.background ? 'Subagent handed back' : 'Thinking')
        }
        recompute(root)
        upsert(root, ops)
        break
      case 'tool_pre': {
        if (isGeminiAgentTool(e.name)) {
          geminiAgentPre(ops, geminiAgentName(e.name, e.input), str(obj(e.input).prompt))
          break
        }
        const n = hookToolNode(e.agent, e.conv)
        if (!n) break
        if (e.toolUseId && tools.has(e.toolUseId)) break // Post arrived first (async hooks): row already final
        const id = e.toolUseId ?? `h${++synth}`
        if (!e.toolUseId) pendingByName.set(e.name, [...(pendingByName.get(e.name) ?? []), id])
        toolStart(n, ops, e.name, e.input, id)
        break
      }
      case 'tool_post': {
        if (isGeminiAgentTool(e.name)) {
          geminiAgentPost(ops, geminiAgentName(e.name, e.input), e.ok, e.text ?? null)
          break
        }
        const state = e.denied ? 'denied' : e.ok ? 'ok' : 'error'
        let id = e.toolUseId
        if (!id) {
          const q = pendingByName.get(e.name)
          id = q?.shift() ?? null
        }
        let n: Node | null = null
        if (id && tools.has(id)) n = toolEnd(id, ops, state, e.text)
        else {
          n = hookToolNode(e.agent, e.conv)
          if (!n) break
          toolStart(n, ops, e.name, e.input, id ?? `h${++synth}`, state, e.text ?? null)
        }
        if (!n) break
        // A4b: a pty permission ask resolves when the same agent's same tool finished
        resolvePty(ops, (a) => a.kind === 'permission' && a.key === n!.key && (!a.toolName || a.toolName === e.name || provider !== 'claude'))
        touch(n)
        upsert(n, ops)
        break
      }
      case 'permission': {
        const n = nodeFor(e.agent)
        const dup = [...asks.values()].some((a) => a.channel === 'pty' && a.kind === 'permission' && a.key === n.key && (a.toolName === e.name || !a.toolName))
        if (dup) break
        openAsk(n, ops, {
          gateId: `pty${++ptySeq}`,
          kind: 'permission',
          channel: 'pty',
          title: e.title ?? permissionTitle(e.name, e.input),
          detail: e.detail ?? null,
          toolName: e.name,
          toolInput: e.input,
          options: PERMISSION_PTY
        })
        break
      }
      case 'notify_permission': {
        if ([...asks.values()].some((a) => a.kind === 'permission')) break
        openAsk(root, ops, {
          gateId: `pty${++ptySeq}`,
          kind: 'permission',
          channel: 'pty',
          title: e.message ?? 'Needs your permission',
          options: PERMISSION_PTY
        })
        break
      }
      case 'notify_idle':
        if (!interactive || isTerminal(root.status) || root.idleWaiting) break
        root.idleWaiting = true
        root.fresh = false
        recompute(root)
        upsert(root, ops)
        break
      case 'notice': {
        const n = nodeFor(e.agent)
        appendEvent(n, ops, { kind: 'status', summary: e.text })
        upsert(n, ops)
        break
      }
      case 'subagent_start': {
        if (!e.type) break // internal helper agents (empty agent_type) are ignored
        const existing = keyOf(e.agentId) ?? keyOf(e.toolUseId)
        if (existing) {
          const n = nodes.get(existing)!
          if (e.agentId !== existing) alias.set(e.agentId, existing)
          n.externalId ??= e.agentId
          if (provider === 'cursor') n.attribution = 'exact'
          if (e.model && !n.model) n.model = e.model
          upsert(n, ops)
          break
        }
        newSubagent(ops, e.agentId, {
          parent: root,
          type: e.type,
          description: null,
          externalId: e.agentId,
          toolUseId: e.toolUseId ?? null,
          depth: 1,
          background: false,
          attribution: e.attribution,
          model: e.model ?? null,
          prompt: e.prompt ?? null
        })
        break
      }
      case 'subagent_stop': {
        let n: Node | undefined
        if (e.agentId) {
          if (!e.type && provider === 'claude') break
          const k = keyOf(e.agentId)
          n = k ? nodes.get(k) : undefined
        } else {
          const open = [...nodes.values()].filter((x) => x.kind === 'subagent' && !isTerminal(x.status))
          n =
            open.find((x) => e.prompt && x.prompt === e.prompt) ??
            open.find((x) => e.type && x.agentType === e.type) ??
            (open.length === 1 ? open[0] : undefined)
        }
        if (!n || isTerminal(n.status)) break
        endNode(n, ops, e.status, e.report)
        break
      }
      case 'stop': {
        if (!interactive || isTerminal(root.status)) break
        resolvePty(ops, (a) => a.kind === 'permission')
        if (e.background > 0) {
          root.idleWaiting = false
          root.status = 'working'
          root.activity = `Background: ${e.background} task${e.background === 1 ? '' : 's'}`
        } else {
          root.idleWaiting = true
          root.fresh = false
          root.activity = 'Your turn'
        }
        root.report = e.report ? clipDetail(e.report) : null
        recompute(root)
        upsert(root, ops)
        break
      }
      case 'session_end':
        if (!interactive) break
        ops.push(...end('done'))
        break
      case 'gate': {
        const n = keyOf(e.agent) ? nodes.get(keyOf(e.agent)!)! : brackets.length === 1 ? nodes.get(brackets[0]) ?? root : root
        openAsk(n, ops, {
          gateId: e.gateId,
          kind: 'permission',
          channel: 'hook_gate',
          title: permissionTitle(e.name, e.input),
          toolName: e.name,
          toolInput: e.input,
          options: PERMISSION_HEADLESS
        })
        break
      }
      case 'gate_closed':
        resolveAsk(e.gateId, ops, 'terminal', 'answered')
        break
      case 'ask_user': {
        const byTool = e.toolUseHint ? tools.get(e.toolUseHint)?.key : null
        const n = (byTool && nodes.get(byTool)) || root
        openAsk(n, ops, {
          gateId: e.gateId,
          kind: 'question',
          channel: 'mcp',
          title: e.question,
          question: e.question,
          toolName: 'ask_user',
          options: choiceOptions(e.options)
        })
        break
      }
      case 'ask_user_cancelled':
        resolveAsk(e.gateId, ops, null, 'canceled')
        break
      case 'pty_prompt': {
        const p = e.prompt
        if (!p) {
          resolvePty(ops, (a) => a.fromScreen || a.seenOnScreen)
          break
        }
        const same = [...asks.values()].filter((a) => a.channel === 'pty' && a.kind === p.kind)
        if (same.length) {
          for (const a of same) a.seenOnScreen = true
          break
        }
        // claude permission dialogs come from hooks; the screen is a fallback only when hooks are broken. The folder
        // trust dialog only ever shows before SessionStart, so once any hook line arrived a trust match is model output.
        if ((p.kind === 'permission' || p.kind === 'trust') && provider === 'claude' && hooksSeen) break
        // gemini: Notification(ToolPermission) opens permission asks; once hooks work the screen is not consulted (a
        // stale or quoted dialog in the tail would otherwise reopen an answered ask). cursor has no permission hook.
        if (p.kind === 'permission' && provider === 'gemini' && hooksSeen) break
        openAsk(root, ops, {
          gateId: `pty${++ptySeq}`,
          kind: p.kind,
          channel: 'pty',
          title: p.title,
          toolName: p.toolHint ?? null,
          options: p.kind === 'trust' ? TRUST_PTY : PERMISSION_PTY,
          fromScreen: true
        })
        break
      }
      case 'user_input':
        resolvePty(ops, () => true)
        if (interactive && !isTerminal(root.status) && root.idleWaiting) {
          // typing is not submitting: the root rests in `idle` (not Needs you) until UserPromptSubmit
          root.idleWaiting = false
          root.fresh = true
          root.activity = null
          recompute(root)
          upsert(root, ops)
        }
        break
    }
    return ops
  }

  // gemini: invoke_agent hook brackets (timing attribution)
  const geminiAgentPre = (ops: LiveOp[], type: string | null, prompt: string | null): void => {
    // headless: the stream's tool_use created the node already (or will, then binds via bindGeminiHookNode)
    let n = [...nodes.values()].find((x) => x.kind === 'subagent' && x.attribution === 'timing' && !x.bracketed && !isTerminal(x.status) && x.agentType === type)
    if (!n) {
      n = newSubagent(ops, `gh:${++synth}`, {
        parent: root,
        type,
        description: prompt,
        externalId: null,
        toolUseId: null,
        depth: 1,
        background: false,
        attribution: 'timing',
        prompt
      })
    }
    n.bracketed = true
    brackets.push(n.key)
  }
  const geminiAgentPost = (ops: LiveOp[], type: string | null, ok: boolean, text: string | null): void => {
    const k = brackets.find((b) => nodes.get(b)?.agentType === type) ?? brackets[0]
    if (!k) return
    const n = nodes.get(k)!
    brackets.splice(brackets.indexOf(k), 1)
    const report = text ? text.replace(/^Subagent '[^']*' finished\.\s*(Termination Reason:[^\n]*\n)?(Result:\s*\n?)?/, '').trim() || text : null
    endNode(n, ops, ok ? 'done' : 'failed', report)
  }

  // ---------- public ----------

  const end = (status: 'done' | 'failed' | 'canceled', activity?: string | null): LiveOp[] => {
    const ops: LiveOp[] = []
    if (rootEnded) return ops
    for (const a of [...asks.values()]) resolveAsk(a.gateId, ops, null, 'canceled')
    for (const n of nodes.values()) {
      if (n === root || isTerminal(n.status)) continue
      endNode(n, ops, status === 'done' ? 'done' : 'canceled', null, status === 'done' ? undefined : 'Stopped with its parent')
    }
    endNode(root, ops, status, null, activity ?? (status === 'done' ? 'Done' : status === 'failed' ? 'Failed' : 'Canceled'))
    rootEnded = true
    return ops
  }

  return {
    begin() {
      const ops: LiveOp[] = []
      upsert(root, ops)
      return ops
    },
    stream,
    hook,
    answered(gateId, summary) {
      const ops: LiveOp[] = []
      resolveAsk(gateId, ops, 'hive', 'answered', summary)
      return ops
    },
    retitle(title) {
      const ops: LiveOp[] = []
      if (!title || root.title === title) return ops
      root.title = title
      upsert(root, ops)
      return ops
    },
    expire(gateId) {
      const ops: LiveOp[] = []
      resolveAsk(gateId, ops, 'timeout', 'expired', 'No answer within 60 min')
      return ops
    },
    cancel(gateId) {
      const ops: LiveOp[] = []
      resolveAsk(gateId, ops, null, 'canceled')
      return ops
    },
    end,
    openAsks: () => [...asks.values()],
    ask: (g) => asks.get(g) ?? null,
    keyOf,
    node: (k) => {
      const n = nodes.get(k)
      return n ? patchOf(n) : null
    },
    keys: () => [...nodes.keys()],
    ended: () => rootEnded
  }
}

function safeJson(v: unknown): string | null {
  try {
    const s = JSON.stringify(v)
    return s && s !== '{}' ? s : null
  } catch {
    return null
  }
}

/** CHAT-UI.md §8.4: the call's own one-line description (Claude's Bash `description`, "Run the unit tests"), if any. */
export function toolDescription(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const d = (input as Record<string, unknown>).description
  return typeof d === 'string' && d.trim() ? d.replace(/\s+/g, ' ').trim() : null
}
