/**
 * Applies tracker LiveOps (LIVE.md §3, §9.4): maps keys to `ag_` ids, redacts, persists through the optional
 * EngineStore live methods, and emits `agent.updated` (coalesced 150 ms per agent), `agent.events` (100 ms per
 * agent) and `ask.updated` (immediately). Works without the store methods (in-memory only) so the engine runs
 * against an older main. The executor uses one sink per step; main may use one per session.
 */
import type { EngineStore } from '../../../shared/engine'
import { newId } from '../../../shared/ids'
import type { AgentEvent, AgentNode, Ask, AskAnswer } from '../../../shared/live'
import type { AdapterId, EngineEvent, Id } from '../../../shared/types'
import { DETAIL_MAX } from './summary'
import { ROOT_KEY, type LiveOp } from './types'

export const AGENT_EMIT_MS = 150
export const EVENTS_EMIT_MS = 100

export interface LiveSinkOptions {
  store: Partial<EngineStore>
  emit(e: EngineEvent): void
  redact(s: string): string
  owner: { sessionId: Id | null; runId: Id | null; stepId: Id | null }
  provider: AdapterId
  cwd: string
  repoId: Id | null
  /** Id to use for the root (main may pre-create it). Default: a new `ag_` id. */
  rootId?: Id
  log?: { warn(msg: string, meta?: Record<string, unknown>): void }
  /** Coalescing off (tests): emit synchronously. */
  sync?: boolean
}

export interface LiveSink {
  apply(ops: LiveOp[]): void
  /** Ask row id for a tracker gate id. */
  askId(gateId: string): Id | null
  /** Gate id of an ask row. */
  gateOf(askId: Id): string | null
  ask(askId: Id): Ask | null
  /** Stores the user's answer; the next ask.resolve for that gate persists it. */
  setAnswer(gateId: string, a: AskAnswer): void
  agentId(key: string): Id | null
  agent(key: string): AgentNode | null
  rootId: Id
  /** Emit everything pending now (step end, tests). */
  flush(): void
  /** Callback for `control.closeStdin`. */
  onCloseStdin(cb: () => void): void
  /** Root-only fields Hive sets outside the tracker (CONTRACT §13: stopReason, resetAt, retryAt, stalledSince; wait activity). */
  patchRoot(patch: Pick<Partial<AgentNode>, 'stopReason' | 'resetAt' | 'retryAt' | 'stalledSince' | 'activity'>): void
}

const redactJson = (v: unknown, redact: (s: string) => string): unknown => {
  if (v == null) return null
  try {
    const s = redact(JSON.stringify(v))
    if (s.length > DETAIL_MAX) return `${s.slice(0, DETAIL_MAX - 1)}…`
    return JSON.parse(s)
  } catch {
    return null
  }
}

export function createLiveSink(o: LiveSinkOptions): LiveSink {
  const ids = new Map<string, Id>()
  const agents = new Map<Id, AgentNode>()
  const asksByGate = new Map<string, Id>()
  const gateByAsk = new Map<Id, string>()
  const asks = new Map<Id, Ask>()
  const answers = new Map<string, AskAnswer>()
  const localEvents = new Map<Id, AgentEvent[]>()
  let localSeq = 0
  let closeStdin: (() => void) | null = null
  const rootId = o.rootId ?? newId('agent')
  ids.set(ROOT_KEY, rootId)

  const pendingAgents = new Set<Id>()
  const pendingEvents = new Map<Id, Map<number, AgentEvent>>()
  let agentTimer: NodeJS.Timeout | null = null
  let eventTimer: NodeJS.Timeout | null = null

  const r = (s: string | null | undefined): string | null => (s == null ? null : o.redact(s))
  const safe = <T>(what: string, f: () => T): T | undefined => {
    try {
      return f()
    } catch (e) {
      o.log?.warn(`live: ${what} failed`, { error: String(e) })
      return undefined
    }
  }

  const flushAgents = (): void => {
    if (agentTimer) clearTimeout(agentTimer)
    agentTimer = null
    for (const id of pendingAgents) {
      const a = agents.get(id)
      if (a) o.emit({ type: 'agent.updated', agent: { ...a, filesTouched: [...a.filesTouched] } })
    }
    pendingAgents.clear()
  }
  const flushEvents = (): void => {
    if (eventTimer) clearTimeout(eventTimer)
    eventTimer = null
    for (const [agentId, evs] of pendingEvents) {
      if (evs.size) o.emit({ type: 'agent.events', agentId, events: [...evs.values()].sort((a, b) => a.seq - b.seq) })
    }
    pendingEvents.clear()
  }
  const queueAgent = (id: Id): void => {
    pendingAgents.add(id)
    if (o.sync) return flushAgents()
    agentTimer ??= setTimeout(flushAgents, AGENT_EMIT_MS)
  }
  const queueEvent = (ev: AgentEvent): void => {
    const m = pendingEvents.get(ev.agentId) ?? new Map<number, AgentEvent>()
    m.set(ev.seq, ev)
    pendingEvents.set(ev.agentId, m)
    if (o.sync) return flushEvents()
    eventTimer ??= setTimeout(flushEvents, EVENTS_EMIT_MS)
  }

  const apply = (ops: LiveOp[]): void => {
    for (const op of ops) {
      switch (op.op) {
        case 'agent.upsert': {
          const p = op.patch
          let id = ids.get(op.key)
          const parentId = p.parentKey ? ids.get(p.parentKey) ?? rootId : null
          const fields = {
            kind: p.kind,
            title: r(p.title) ?? '',
            agentType: r(p.agentType),
            externalId: p.externalId,
            toolUseId: p.toolUseId,
            model: p.model,
            depth: p.depth,
            background: p.background,
            attribution: p.attribution,
            status: p.status,
            needs: p.needs,
            activity: r(p.activity),
            lastTool: p.lastTool,
            toolCount: p.toolCount,
            memReads: p.memReads,
            filesTouched: p.filesTouched.map((f) => o.redact(f)),
            tokensIn: p.tokensIn,
            tokensOut: p.tokensOut,
            costUsd: p.costUsd,
            modelUsage: p.modelUsage,
            report: r(p.report),
            startedAt: p.startedAt,
            updatedAt: p.updatedAt,
            endedAt: p.endedAt
          }
          if (!id || !agents.has(id)) {
            id ??= newId('agent')
            ids.set(op.key, id)
            const node: AgentNode = {
              id,
              parentId: op.key === ROOT_KEY ? null : parentId,
              rootId,
              sessionId: o.owner.sessionId,
              runId: o.owner.runId,
              stepId: o.owner.stepId,
              provider: o.provider,
              repoId: o.repoId,
              cwd: o.cwd,
              ...fields
            }
            agents.set(id, node)
            safe('insertAgent', () => o.store.insertAgent?.(node))
          } else {
            const prev = agents.get(id)!
            const node: AgentNode = { ...prev, ...fields }
            agents.set(id, node)
            safe('updateAgent', () => o.store.updateAgent?.(id!, fields))
          }
          queueAgent(id)
          break
        }
        case 'event.append': {
          const id = ids.get(op.key) ?? rootId
          const e = op.event
          const ev = { ...e, summary: o.redact(e.summary), detail: r(e.detail) }
          const stored = safe('appendAgentEvents', () => o.store.appendAgentEvents?.(id, [ev]))
          const full: AgentEvent = stored?.[0] ?? { ...ev, seq: ++localSeq, agentId: id }
          if (!stored) {
            const list = localEvents.get(id) ?? []
            list.push(full)
            if (list.length > 500) list.splice(0, list.length - 500)
            localEvents.set(id, list)
          }
          queueEvent(full)
          break
        }
        case 'event.update': {
          const id = ids.get(op.key) ?? rootId
          const patch = { state: op.patch.state, detail: r(op.patch.detail) }
          let updated = safe('updateAgentEvent', () => o.store.updateAgentEvent?.(id, op.toolUseId, patch)) ?? null
          if (!updated) {
            const list = localEvents.get(id) ?? []
            const ev = [...list].reverse().find((x) => x.toolUseId === op.toolUseId && x.kind === 'tool')
            if (ev) {
              Object.assign(ev, patch)
              updated = ev
            }
          }
          if (updated) queueEvent(updated)
          break
        }
        case 'ask.open': {
          const agentId = ids.get(op.key) ?? rootId
          const a = op.ask
          const ask: Ask = {
            id: newId('ask'),
            agentId,
            rootId,
            sessionId: o.owner.sessionId,
            runId: o.owner.runId,
            stepId: o.owner.stepId,
            provider: a.provider,
            kind: a.kind,
            channel: a.channel,
            title: o.redact(a.title),
            detail: r(a.detail),
            toolName: a.toolName,
            toolInput: redactJson(a.toolInput, o.redact),
            question: r(a.question),
            options: a.options.map((x) => ({ ...x, label: o.redact(x.label) })),
            status: 'open',
            answer: null,
            answeredVia: null,
            createdAt: a.createdAt,
            answeredAt: null,
            expiresAt: a.expiresAt
          }
          asksByGate.set(op.gateId, ask.id)
          gateByAsk.set(ask.id, op.gateId)
          asks.set(ask.id, ask)
          safe('insertAsk', () => o.store.insertAsk?.({ ...ask, gateId: op.gateId }))
          // the agent row (needs_you) goes out first so the hub can place the ask
          flushAgents()
          o.emit({ type: 'ask.updated', ask })
          break
        }
        case 'ask.resolve': {
          const askId = asksByGate.get(op.gateId)
          const prev = askId ? asks.get(askId) : undefined
          if (!askId || !prev || prev.status !== 'open') break
          const answer = answers.get(op.gateId) ?? null
          answers.delete(op.gateId)
          const patch: Partial<Ask> = {
            status: op.status,
            answeredVia: op.via,
            answeredAt: new Date().toISOString(),
            ...(answer ? { answer: { ...answer, text: answer.text != null ? o.redact(answer.text) : undefined, message: answer.message != null ? o.redact(answer.message) : undefined } } : {})
          }
          const next: Ask = { ...prev, ...patch }
          asks.set(askId, next)
          safe('updateAsk', () => o.store.updateAsk?.(askId, patch))
          o.emit({ type: 'ask.updated', ask: next })
          break
        }
        case 'control.closeStdin':
          closeStdin?.()
          break
      }
    }
  }

  return {
    apply,
    askId: (g) => asksByGate.get(g) ?? null,
    gateOf: (a) => gateByAsk.get(a) ?? null,
    ask: (a) => asks.get(a) ?? null,
    setAnswer: (g, a) => void answers.set(g, a),
    agentId: (k) => ids.get(k) ?? null,
    agent: (k) => {
      const id = ids.get(k)
      return id ? agents.get(id) ?? null : null
    },
    rootId,
    flush() {
      flushAgents()
      flushEvents()
    },
    onCloseStdin(cb) {
      closeStdin = cb
    },
    patchRoot(patch) {
      const prev = agents.get(rootId)
      if (!prev) return
      const changed = (Object.keys(patch) as (keyof typeof patch)[]).some((k) => (prev[k] ?? null) !== (patch[k] ?? null))
      if (!changed) return
      // updatedAt stays: the renderer drops older updates, and the tracker's next upsert must still win
      agents.set(rootId, { ...prev, ...patch })
      safe('updateAgent', () => o.store.updateAgent?.(rootId, patch))
      queueAgent(rootId)
    }
  }
}
