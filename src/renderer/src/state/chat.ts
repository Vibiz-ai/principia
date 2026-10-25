/**
 * CHAT-UI.md §3.2: the renderer side of a chat. Main owns the truth; this module keeps one replica per open session
 * (snapshot + numbered ops, resnapshot on a gap) and hands it to components with useSyncExternalStore.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { Id, Session } from '@shared/types'
import type { ChatMode, ChatOp, ChatSnapshot } from '@shared/chat'
import { EMPTY_CHAT_META } from '@shared/chat'
import { ChatModel } from '@shared/chatReduce'
import { hive } from '../lib/hive'

export interface ChatView extends Omit<ChatSnapshot, 'items'> {
  items: ChatSnapshot['items']
  loaded: boolean
}

interface Entry {
  model: ChatModel
  view: ChatView
  /** ops that arrived while the snapshot was loading */
  early: { seq: number; ops: ChatOp[] }[]
  loading: boolean
  subs: number
}

const entries = new Map<Id, Entry>()
const listeners = new Map<Id, Set<() => void>>()
let wired = false

const blank = (sessionId: Id): ChatView => ({
  sessionId,
  mode: 'terminal',
  available: false,
  turn: 'starting',
  activity: null,
  turnStartedAt: null,
  items: [],
  queue: [],
  meta: { ...EMPTY_CHAT_META },
  seq: 0,
  note: null,
  loaded: false
})

function notify(id: Id): void {
  for (const l of listeners.get(id) ?? []) l()
}

function entry(id: Id): Entry {
  let e = entries.get(id)
  if (!e) {
    e = { model: new ChatModel(), view: blank(id), early: [], loading: false, subs: 0 }
    entries.set(id, e)
  }
  return e
}

/** Applies ops to the replica; returns the next view (new object, so React re-renders). */
function applyOps(e: Entry, seq: number, ops: ChatOp[]): void {
  let v = { ...e.view, seq }
  for (const op of ops) {
    switch (op.op) {
      case 'state':
        v = { ...v, turn: op.turn, ...(op.activity !== undefined ? { activity: op.activity } : {}), ...(op.turnStartedAt !== undefined ? { turnStartedAt: op.turnStartedAt } : {}), ...(op.note !== undefined ? { note: op.note } : {}) }
        break
      case 'mode':
        v = { ...v, mode: op.mode, available: true }
        break
      case 'queue':
        v = { ...v, queue: op.queue }
        break
      case 'meta':
        v = { ...v, meta: { ...v.meta, ...op.meta } }
        break
      default:
        e.model.apply(op)
    }
  }
  e.view = { ...v, items: e.model.items.slice() }
}

async function load(id: Id): Promise<void> {
  const e = entry(id)
  if (e.loading) return
  e.loading = true
  try {
    const snap = await hive.chat.snapshot({ id })
    e.model.apply({ op: 'reset', items: snap.items })
    e.view = { ...snap, items: e.model.items, loaded: true }
    const early = e.early.filter((x) => x.seq > snap.seq).sort((a, b) => a.seq - b.seq)
    e.early = []
    for (const x of early) applyOps(e, x.seq, x.ops)
  } catch {
    e.view = { ...e.view, loaded: true }
  } finally {
    e.loading = false
    notify(id)
  }
}

function wire(): void {
  if (wired) return
  wired = true
  hive.on('chat:ops', ({ sessionId, seq, ops }) => {
    const e = entries.get(sessionId)
    if (!e) return
    if (e.loading || !e.view.loaded) {
      e.early.push({ seq, ops })
      return
    }
    if (seq <= e.view.seq) return
    if (seq !== e.view.seq + 1) {
      // a gap (missed batch): main is the truth, take a fresh snapshot
      void load(sessionId)
      return
    }
    applyOps(e, seq, ops)
    notify(sessionId)
  })
}

/** The chat replica of a session (snapshot on first use, live ops after). */
export function useChat(sessionId: Id): ChatView {
  wire()
  const e = entry(sessionId)
  useEffect(() => {
    e.subs++
    if (!e.view.loaded && !e.loading) void load(sessionId)
    return () => {
      e.subs--
    }
  }, [sessionId, e])
  return useSyncExternalStore(
    (cb) => {
      let set = listeners.get(sessionId)
      if (!set) listeners.set(sessionId, (set = new Set()))
      set.add(cb)
      return () => set!.delete(cb)
    },
    () => entries.get(sessionId)?.view ?? e.view
  )
}

/** The replica as it is now, outside React (⌘K's "Show as terminal / chat"). */
export function peekChat(sessionId: Id): ChatView | null {
  return entries.get(sessionId)?.view ?? null
}

/** Re-read a session's chat (after a restart, a hand-off failure). */
export function reloadChat(sessionId: Id): void {
  void load(sessionId)
}

/** Which pane a session shows: chat for Claude chats, terminal otherwise. null while it is being looked up. */
export function useChatMode(s: Pick<Session, 'id' | 'adapter'>): ChatMode | null {
  const v = useChat(s.id)
  if (s.adapter !== 'claude') return 'terminal'
  if (!v.loaded) return null
  return v.mode
}
