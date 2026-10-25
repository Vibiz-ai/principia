/**
 * DIAGRAMS.md §6: the little state diagrams need outside one block. The full window (one at a time), the Visualize
 * sheet, and the diagrams each chat drew this app session (a chat's last answer is replaced on the next turn, the
 * diagrams it held stay one click away). Module-level store, read with useSyncExternalStore.
 */
import { useSyncExternalStore } from 'react'
import type { Id } from '@shared/types'
import { splitDiagrams, parseDiagram, visualizePrompt } from '@shared/diagram'
import { hive } from '../lib/hive'
import { focusSession, getState, toast } from './store'

export interface SessionDiagram {
  raw: string
  title: string
  at: number
}
interface DiagramState {
  window: { raw: string } | null
  visualize: { sessionId: Id } | null
  bySession: Record<Id, SessionDiagram[]>
}

/**
 * The chat diagrams survive a renderer reload (sessionStorage, per window) but not a restart, matching "this app
 * session". Storage can be missing or full; then the strip just starts empty.
 */
const STORE_KEY = 'principia.sessionDiagrams.v1'
/** Most chats remembered, and the most characters stored in all (oldest chats drop first). */
const STORE_CHATS = 24
const STORE_CHARS = 1_500_000

export function loadSessionDiagrams(): Record<Id, SessionDiagram[]> {
  try {
    const raw = globalThis.sessionStorage?.getItem(STORE_KEY)
    const v = raw ? (JSON.parse(raw) as unknown) : null
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<Id, SessionDiagram[]> = {}
    for (const [k, list] of Object.entries(v as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue
      const ok = list.filter((d): d is SessionDiagram => !!d && typeof d.raw === 'string' && typeof d.title === 'string' && typeof d.at === 'number')
      if (ok.length) out[k] = ok
    }
    return out
  } catch {
    return {}
  }
}

/** Newest chats first until the caps are reached. */
export function trimSessionDiagrams(by: Record<Id, SessionDiagram[]>): Record<Id, SessionDiagram[]> {
  const newest = (l: SessionDiagram[]): number => l.reduce((m, d) => Math.max(m, d.at), 0)
  const order = Object.entries(by).sort((a, b) => newest(b[1]) - newest(a[1]))
  const out: Record<Id, SessionDiagram[]> = {}
  let chars = 0
  for (const [k, l] of order.slice(0, STORE_CHATS)) {
    const size = l.reduce((n, d) => n + d.raw.length + d.title.length + 40, 0)
    if (chars + size > STORE_CHARS) break
    chars += size
    out[k] = l
  }
  return out
}

function saveSessionDiagrams(by: Record<Id, SessionDiagram[]>): void {
  try {
    globalThis.sessionStorage?.setItem(STORE_KEY, JSON.stringify(trimSessionDiagrams(by)))
  } catch {
    /* storage off or full: the strip only lasts until the next reload */
  }
}

let state: DiagramState = { window: null, visualize: null, bySession: loadSessionDiagrams() }
const subs = new Set<() => void>()
const set = (patch: Partial<DiagramState>): void => {
  state = { ...state, ...patch }
  for (const s of subs) s()
}
const subscribe = (cb: () => void): (() => void) => {
  subs.add(cb)
  return () => subs.delete(cb)
}
export function useDiagramState<T>(pick: (s: DiagramState) => T): T {
  return useSyncExternalStore(subscribe, () => pick(state))
}

export const openDiagramWindow = (raw: string): void => set({ window: { raw } })
export const closeDiagramWindow = (): void => set({ window: null })

/** Most diagrams a chat keeps (oldest drop off). */
const KEEP = 8
const EMPTY: SessionDiagram[] = []
export const useSessionDiagrams = (sessionId: Id): SessionDiagram[] => useDiagramState((s) => s.bySession[sessionId] ?? EMPTY)

/** Records the diagrams in a chat's latest answer; returns how many were new. */
export function noteSessionAnswer(sessionId: Id, text: string | null | undefined): number {
  if (!text || !text.includes('principia-graph')) return 0
  const have = state.bySession[sessionId] ?? []
  const fresh: SessionDiagram[] = []
  for (const seg of splitDiagrams(text)) {
    if (seg.t !== 'diagram' || have.some((d) => d.raw === seg.raw) || fresh.some((d) => d.raw === seg.raw)) continue
    const p = parseDiagram(seg.raw)
    fresh.push({ raw: seg.raw, title: (p.ok && p.diagram.title) || 'Diagram', at: Date.now() })
  }
  if (!fresh.length) return 0
  set({ bySession: { ...state.bySession, [sessionId]: [...have, ...fresh].slice(-KEEP) } })
  saveSessionDiagrams(state.bySession)
  return fresh.length
}

/**
 * Only Claude chats can draw: they get the format note and /visualize, and their answers reach the strip through the
 * Stop hook. Codex, Gemini and Cursor chats would get the ask without the format, and nothing would show it.
 */
export const canVisualize = (s: { adapter: string; status: string } | undefined): boolean => !!s && s.status === 'running' && s.adapter === 'claude'

/** The chat Visualize writes into: the focused session, when it is a live Claude chat. */
export function visualizeTarget(): Id | null {
  const s = getState()
  const cur = s.sessions.find((x) => x.id === s.focusedSession)
  return cur && canVisualize(cur) ? cur.id : null
}

/** ⌘K "Visualize…" and the pane menu. */
export function openVisualize(sessionId: Id | null = visualizeTarget()): void {
  if (!sessionId) {
    const s = getState()
    const cur = s.sessions.find((x) => x.id === s.focusedSession)
    toast(
      cur && cur.status === 'running' && cur.adapter !== 'shell' && cur.adapter !== 'claude'
        ? 'Only Claude chats can draw diagrams for now. Focus a Claude chat, then Visualize.'
        : 'Open a Claude chat first, then Visualize asks its agent to draw.'
    )
    return
  }
  set({ visualize: { sessionId } })
}
export const closeVisualize = (): void => set({ visualize: null })

/** Types "Draw <what> as a principia-graph." into the chat and presses Return, as if the founder typed it. */
export function sendVisualize(sessionId: Id, what: string): void {
  const text = visualizePrompt(what)
  hive.send('sessions:write', { id: sessionId, data: text, typed: true })
  // a separate Return, so the TUI does not read it as part of a paste
  setTimeout(() => hive.send('sessions:write', { id: sessionId, data: '\r', typed: true }), 150)
  closeVisualize()
  focusSession(sessionId)
}
