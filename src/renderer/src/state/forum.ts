/**
 * Forum slice (FORUM.md §8, §9): per company, the state snapshot (members, channels with counts, presence), loaded
 * pages of channel messages and open threads. Snapshot via invoke, then live via `forum:event` (never polls). Kept
 * out of the global store, like the Slack slice, so the shell only re-renders for what it reads.
 */
import { useSyncExternalStore } from 'react'
import type { ForumEvent, ForumMessage, ForumPostRequest, ForumState } from '@shared/forum'
import { errorMessage, hive } from '../lib/hive'

export interface ChannelPage {
  list: ForumMessage[]
  hasMore: boolean
  loading: boolean
}
export interface CompanyForum {
  state: ForumState | null
  error: string | null
  pages: Record<string, ChannelPage>
  threads: Record<string, { root: ForumMessage; replies: ForumMessage[] }>
}
export interface ForumSlice {
  byCompany: Record<string, CompanyForum>
  /** the channel the user is looking at (marks incoming messages read) */
  viewing: { companyId: string; channelId: string } | null
}

let st: ForumSlice = { byCompany: {}, viewing: null }
const ls = new Set<() => void>()
export function getForum(): ForumSlice {
  return st
}
function set(p: Partial<ForumSlice> | ((s: ForumSlice) => Partial<ForumSlice>)): void {
  st = { ...st, ...(typeof p === 'function' ? p(st) : p) }
  for (const l of ls) l()
}
function patchCompany(companyId: string, fn: (c: CompanyForum) => Partial<CompanyForum>): void {
  set((s) => {
    const cur = s.byCompany[companyId] ?? { state: null, error: null, pages: {}, threads: {} }
    return { byCompany: { ...s.byCompany, [companyId]: { ...cur, ...fn(cur) } } }
  })
}
export function useForum<T>(sel: (s: ForumSlice) => T): T {
  return useSyncExternalStore(
    (l) => {
      ls.add(l)
      return () => ls.delete(l)
    },
    () => sel(st)
  )
}
/** Test hook: reset the slice. */
export function resetForum(next: Partial<ForumSlice> = {}): void {
  st = { byCompany: {}, viewing: null, ...next }
  for (const l of ls) l()
}

// ---------- loading ----------

const inflight = new Map<string, Promise<void>>()
export function loadForum(companyId: string): Promise<void> {
  const cur = inflight.get(companyId)
  if (cur) return cur
  const p = hive.forum
    .state({ companyId })
    .then((state) => patchCompany(companyId, () => ({ state, error: null })))
    .catch((e) => patchCompany(companyId, () => ({ error: errorMessage(e) })))
    .finally(() => inflight.delete(companyId))
  inflight.set(companyId, p)
  return p
}
const timers = new Map<string, ReturnType<typeof setTimeout>>()
function reloadSoon(companyId: string): void {
  clearTimeout(timers.get(companyId))
  timers.set(companyId, setTimeout(() => void loadForum(companyId), 120))
}

export async function loadChannel(companyId: string, channelId: string, older = false): Promise<void> {
  const page = st.byCompany[companyId]?.pages[channelId]
  if (page?.loading) return
  const beforeSeq = older && page?.list.length ? page.list[0].seq : undefined
  patchCompany(companyId, (c) => ({ pages: { ...c.pages, [channelId]: { list: page?.list ?? [], hasMore: page?.hasMore ?? false, loading: true } } }))
  try {
    const r = await hive.forum.messages({ companyId, channelId, ...(beforeSeq ? { beforeSeq } : {}), limit: 60 })
    patchCompany(companyId, (c) => ({ pages: { ...c.pages, [channelId]: { list: beforeSeq ? [...r.messages, ...(c.pages[channelId]?.list ?? [])] : r.messages, hasMore: r.hasMore, loading: false } } }))
  } catch (e) {
    patchCompany(companyId, (c) => ({ pages: { ...c.pages, [channelId]: { list: c.pages[channelId]?.list ?? [], hasMore: false, loading: false } }, error: errorMessage(e) }))
  }
}

export async function loadThread(companyId: string, rootId: string): Promise<void> {
  try {
    const t = await hive.forum.thread({ messageId: rootId })
    patchCompany(companyId, (c) => ({ threads: { ...c.threads, [t.root.id]: t } }))
  } catch (e) {
    patchCompany(companyId, () => ({ error: errorMessage(e) }))
  }
}

export function setViewing(v: ForumSlice['viewing']): void {
  if (st.viewing?.channelId === v?.channelId && st.viewing?.companyId === v?.companyId) return
  set({ viewing: v })
}

export async function markRead(companyId: string, channelId: string, seq?: number): Promise<void> {
  const ch = st.byCompany[companyId]?.state?.channels.find((c) => c.id === channelId)
  if (ch && !ch.unread && !ch.mentions && (seq === undefined || seq <= ch.lastReadSeq)) return
  // optimistic: the badge clears now, the event confirms
  patchCompany(companyId, (c) => (c.state ? { state: { ...c.state, channels: c.state.channels.map((x) => (x.id === channelId ? { ...x, unread: 0, mentions: 0, unreadTasks: [], lastReadSeq: Math.max(x.lastReadSeq, seq ?? x.lastSeq) } : x)) } } : {}))
  try {
    await hive.forum.markRead({ channelId, ...(seq !== undefined ? { seq } : {}) })
  } catch {
    reloadSoon(companyId)
  }
}

export async function post(req: ForumPostRequest): Promise<ForumMessage> {
  const m = await hive.forum.post(req)
  upsertMessage(req.companyId, m)
  return m
}

function upsert(list: ForumMessage[], m: ForumMessage): ForumMessage[] {
  const i = list.findIndex((x) => x.id === m.id)
  if (i >= 0) return list.map((x, j) => (j === i ? m : x))
  // keep seq order (events can arrive out of order with invoke answers)
  const out = [...list, m]
  out.sort((a, b) => a.seq - b.seq)
  return out
}
function upsertMessage(companyId: string, m: ForumMessage): void {
  patchCompany(companyId, (c) => {
    const next: Partial<CompanyForum> = {}
    if (!m.threadId) {
      const page = c.pages[m.channelId]
      if (page) next.pages = { ...c.pages, [m.channelId]: { ...page, list: upsert(page.list, m) } }
      const t = c.threads[m.id]
      if (t) next.threads = { ...c.threads, [m.id]: { ...t, root: m } }
    } else {
      const t = c.threads[m.threadId]
      if (t) next.threads = { ...(next.threads ?? c.threads), [m.threadId]: { ...t, replies: upsert(t.replies, m) } }
    }
    return next
  })
}

/** Applies one main event. Exported for tests. */
export function applyForumEvent(e: ForumEvent): void {
  const c = st.byCompany[e.companyId]
  if (!c) return
  switch (e.kind) {
    case 'message': {
      upsertMessage(e.companyId, e.message)
      const v = st.viewing
      if (v && v.companyId === e.companyId && v.channelId === e.message.channelId && !e.message.threadId && typeof document !== 'undefined' && document.hasFocus()) {
        void markRead(e.companyId, e.message.channelId, e.message.seq)
      }
      reloadSoon(e.companyId)
      return
    }
    case 'presence':
      patchCompany(e.companyId, (cur) =>
        cur.state ? { state: { ...cur.state, presence: [...cur.state.presence.filter((p) => p.memberId !== e.presence.memberId), ...(e.presence.state === 'idle' ? [] : [e.presence])] } } : {}
      )
      return
    case 'read':
      return
    default:
      reloadSoon(e.companyId)
  }
}

let subscribed = false
/** Subscribes to `forum:event` once (idempotent; called by the Forum view and the sidebar section). */
export function initForumEvents(): void {
  if (subscribed || typeof window === 'undefined' || !window.hive?.on) return
  subscribed = true
  window.hive.on('forum:event', applyForumEvent)
  window.hive.on('data:changed', ({ domain }) => {
    // a department or seat change changes channels and members
    if (domain !== 'departments') return
    for (const id of Object.keys(st.byCompany)) reloadSoon(id)
  })
}
