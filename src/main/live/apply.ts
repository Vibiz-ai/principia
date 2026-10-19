/**
 * Main-side applier for tracker ops on session-owned agent trees (docs/LIVE.md §3): maps tracker keys to `ag_` ids,
 * persists through LiveStore (which redacts + caps), and emits coalesced agent:updated (150 ms) / agent:events (100 ms)
 * plus immediate ask:updated. The engine has its own applier for run steps.
 */
import type { Id } from '../../shared/types'
import type { AgentEvent, AgentNode, Ask } from '../../shared/live'
import { newId } from '../../shared/ids'
import type { LiveStore } from '../db/liveStore'
import type { createAgentTracker } from '../engine'

/** Tracker op types, derived from the engine's exported tracker (CONTRACT §12.3 exports). */
export type AgentTracker = ReturnType<typeof createAgentTracker>
export type LiveOp = ReturnType<AgentTracker['hook']>[number]
export type HookEvent = Parameters<AgentTracker['hook']>[0]
/** Key of the root agent in tracker ops (engine live/types.ts ROOT_KEY). */
export const ROOT_KEY = 'root'

export const AGENT_COALESCE_MS = 150
export const EVENTS_COALESCE_MS = 100

export type LiveEmit =
  | { type: 'agent.updated'; agent: AgentNode }
  | { type: 'agent.events'; agentId: Id; events: AgentEvent[] }
  | { type: 'ask.updated'; ask: Ask }

export interface ApplierDeps {
  store: LiveStore
  /** The root row (already inserted). */
  root: AgentNode
  emit(e: LiveEmit): void
  now?: () => Date
  /** Hooks for the session wrapper (A3 seen-state, notifications). */
  beforeRootPatch?(patch: Partial<AgentNode>, cur: AgentNode): Partial<AgentNode>
  onAsk?(ask: Ask, change: 'opened' | 'resolved'): void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

/** Per-key coalescing emitter. */
export class Coalescer<T> {
  private pending = new Map<string, { value: T; timer: unknown }>()
  constructor(
    private ms: number,
    private flushOne: (key: string, value: T) => void,
    private merge: (a: T, b: T) => T = (_a, b) => b,
    private setTimer: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
    private clearTimer: (t: unknown) => void = (t) => clearTimeout(t as NodeJS.Timeout)
  ) {}
  push(key: string, value: T): void {
    const cur = this.pending.get(key)
    if (cur) {
      cur.value = this.merge(cur.value, value)
      return
    }
    const entry = { value, timer: null as unknown }
    entry.timer = this.setTimer(() => {
      this.pending.delete(key)
      try {
        this.flushOne(key, entry.value)
      } catch {
        /* store closed (quit) or row gone: nothing to emit */
      }
    }, this.ms)
    this.pending.set(key, entry)
  }
  flush(): void {
    for (const [k, e] of [...this.pending]) {
      this.clearTimer(e.timer)
      this.pending.delete(k)
      try {
        this.flushOne(k, e.value)
      } catch {
        /* ignore */
      }
    }
  }
}

export class LiveApplier {
  readonly keyToId = new Map<string, Id>()
  readonly gateToAsk = new Map<string, Id>()
  private agents: Coalescer<Id>
  private events: Coalescer<AgentEvent[]>

  constructor(private d: ApplierDeps) {
    this.keyToId.set(ROOT_KEY, d.root.id)
    this.agents = new Coalescer<Id>(
      AGENT_COALESCE_MS,
      (id) => {
        const a = this.d.store.getAgent(id)
        if (a) this.d.emit({ type: 'agent.updated', agent: a })
      },
      undefined,
      d.setTimer,
      d.clearTimer
    )
    this.events = new Coalescer<AgentEvent[]>(
      EVENTS_COALESCE_MS,
      (agentId, events) => this.d.emit({ type: 'agent.events', agentId, events: dedupeEvents(events) }),
      (a, b) => [...a, ...b],
      d.setTimer,
      d.clearTimer
    )
  }

  get rootId(): Id {
    return this.d.root.id
  }

  idOf(key: string): Id | null {
    return this.keyToId.get(key) ?? null
  }

  touched(id: Id): void {
    this.agents.push(id, id)
  }

  apply(ops: LiveOp[]): void {
    for (const op of ops) {
      try {
        this.applyOne(op)
      } catch {
        /* one bad op never breaks the stream */
      }
    }
  }

  private applyOne(op: LiveOp): void {
    switch (op.op) {
      case 'agent.upsert':
        return this.upsert(op.key, op.patch as Partial<AgentNode> & { parentKey?: string | null })
      case 'event.append': {
        const id = this.ensure(op.key)
        const evs = this.d.store.appendAgentEvents(id, [op.event])
        if (evs.length) this.events.push(id, evs)
        return
      }
      case 'event.update': {
        const id = this.ensure(op.key)
        const ev = this.d.store.updateAgentEvent(id, op.toolUseId, op.patch)
        if (ev) this.events.push(id, [ev])
        return
      }
      case 'ask.open': {
        if (this.gateToAsk.has(op.gateId)) return
        const agentId = this.ensure(op.key)
        const root = this.d.root
        const ask: Ask & { gateId: string } = {
          ...op.ask,
          id: newId('ask'),
          agentId,
          rootId: root.id,
          sessionId: root.sessionId,
          runId: root.runId,
          stepId: root.stepId,
          status: 'open',
          answer: null,
          answeredVia: null,
          answeredAt: null,
          gateId: op.gateId
        }
        const saved = this.d.store.insertAsk(ask)
        this.gateToAsk.set(op.gateId, saved.id)
        this.d.emit({ type: 'ask.updated', ask: saved })
        this.d.onAsk?.(saved, 'opened')
        return
      }
      case 'ask.resolve': {
        const askId = this.gateToAsk.get(op.gateId)
        if (!askId) return
        this.resolveAsk(askId, op.status, op.via)
        return
      }
      case 'control.closeStdin':
        return
    }
  }

  /** Closes an open ask (no-op if it is already closed). Returns the updated ask or null. */
  resolveAsk(askId: Id, status: Ask['status'], via: Ask['answeredVia'], answer?: Ask['answer']): Ask | null {
    const cur = this.d.store.getAsk(askId)
    if (!cur || cur.status !== 'open') return null
    const a = this.d.store.updateAsk(askId, {
      status,
      answeredVia: via,
      answeredAt: (this.d.now?.() ?? new Date()).toISOString(),
      ...(answer ? { answer } : {})
    })
    this.d.emit({ type: 'ask.updated', ask: a })
    this.d.onAsk?.(a, 'resolved')
    return a
  }

  /** Gate id of an ask this applier opened. */
  gateOf(askId: Id): string | null {
    for (const [g, id] of this.gateToAsk) if (id === askId) return g
    return null
  }

  private ensure(key: string): Id {
    const id = this.keyToId.get(key)
    if (id) return id
    this.upsert(key, {})
    return this.keyToId.get(key)!
  }

  private upsert(key: string, patch: Partial<AgentNode> & { parentKey?: string | null }): void {
    const { parentKey, ...rest } = patch
    const strip = <T extends Partial<AgentNode>>(p: T): T => {
      const o: Partial<AgentNode> = { ...p }
      delete o.id
      delete o.rootId
      delete o.sessionId
      delete o.runId
      delete o.stepId
      delete o.provider
      delete o.repoId
      delete o.cwd
      delete o.parentId
      return o as T
    }
    const existing = this.keyToId.get(key)
    if (existing) {
      let p: Partial<AgentNode> = strip(rest)
      if (existing === this.d.root.id) {
        delete p.kind
        const cur = this.d.store.getAgent(existing)
        if (cur && this.d.beforeRootPatch) p = this.d.beforeRootPatch(p, cur)
      } else delete p.kind
      if (Object.keys(p).length) {
        this.d.store.updateAgent(existing, p)
        this.touched(existing)
      }
      return
    }
    const root = this.d.root
    const parentId = (parentKey && this.keyToId.get(parentKey)) || root.id
    const parent = parentId === root.id ? root : this.d.store.getAgent(parentId)
    const ts = (this.d.now?.() ?? new Date()).toISOString()
    const p = strip(rest)
    const node: AgentNode = {
      id: newId('agent'),
      kind: 'subagent',
      parentId,
      rootId: root.id,
      sessionId: root.sessionId,
      runId: root.runId,
      stepId: root.stepId,
      provider: root.provider,
      repoId: root.repoId,
      cwd: root.cwd,
      title: p.title || p.agentType || 'Subagent',
      agentType: p.agentType ?? null,
      externalId: p.externalId ?? null,
      toolUseId: p.toolUseId ?? null,
      model: p.model ?? null,
      depth: p.depth ?? (parent ? parent.depth + 1 : 1),
      background: p.background ?? false,
      attribution: p.attribution ?? 'exact',
      status: p.status ?? 'working',
      needs: p.needs ?? null,
      seen: false,
      activity: p.activity ?? null,
      lastTool: p.lastTool ?? null,
      toolCount: p.toolCount ?? 0,
      memReads: p.memReads ?? 0,
      filesTouched: p.filesTouched ?? [],
      tokensIn: p.tokensIn ?? null,
      tokensOut: p.tokensOut ?? null,
      costUsd: p.costUsd ?? null,
      modelUsage: p.modelUsage ?? null,
      report: p.report ?? null,
      startedAt: p.startedAt ?? ts,
      updatedAt: ts,
      endedAt: p.endedAt ?? null
    }
    this.d.store.insertAgent(node)
    this.keyToId.set(key, node.id)
    this.touched(node.id)
  }

  flush(): void {
    this.agents.flush()
    this.events.flush()
  }
}

/** Keeps the last version of each event seq (an update after an append in the same window). */
function dedupeEvents(events: AgentEvent[]): AgentEvent[] {
  const bySeq = new Map<number, AgentEvent>()
  for (const e of events) bySeq.set(e.seq, e)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}
