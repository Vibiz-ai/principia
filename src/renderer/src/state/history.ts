/**
 * Claude history (AUTHORING.md §8, PO9): read-only list of the user's Claude Code sessions. Fetched when Home or the
 * Canvas History layer mounts and when the window regains focus; history:changed refreshes it after main's lazy
 * index drains. No polling.
 */
import { useEffect, useRef, useState } from 'react'
import type { ClaudeHistorySession, HistoryListQuery } from '@shared/authoring'
import type { Session } from '@shared/types'
import { errorCode, errorMessage, hive, useHiveEvent } from '../lib/hive'
import { focusSession, getState, refreshSessions, toast, toastError, useStore } from './store'

export interface HistoryState {
  items: ClaudeHistorySession[]
  total: number
  indexing: boolean
  /** null = loading; false = main doesn't serve history:* yet, or the user turned it off. */
  available: boolean | null
  error: string | null
}

export function useClaudeHistory(query: HistoryListQuery, enabled = true): HistoryState & { reload: () => void } {
  const on = useStore((s) => s.settings?.claudeHistory !== false)
  const winFocused = useStore((s) => s.window.focused)
  const [st, setSt] = useState<HistoryState>({ items: [], total: 0, indexing: false, available: null, error: null })
  const key = JSON.stringify(query)
  const seq = useRef(0)
  const load = (): void => {
    if (!enabled || !on) return
    const my = ++seq.current
    hive.history.list(query).then(
      (r) => my === seq.current && setSt({ items: r.items, total: r.total, indexing: r.indexing, available: true, error: null }),
      (e) => {
        if (my !== seq.current) return
        // an unimplemented channel answers 'internal' "not implemented yet": hide the section instead of erroring
        const missing = errorCode(e) === 'internal' && /not implemented/i.test(errorMessage(e))
        setSt((s) => ({ ...s, available: missing ? false : s.available, error: missing ? null : errorMessage(e) }))
      }
    )
  }
  // mount + query change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [key, enabled, on])
  // window focus regained (PO9)
  const wasFocused = useRef(winFocused)
  useEffect(() => {
    if (winFocused && !wasFocused.current) load()
    wasFocused.current = winFocused
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [winFocused])
  useHiveEvent('history:changed', () => load())
  return { ...st, available: on ? st.available : false, reload: load }
}

/** "Resume in Principia": a normal Principia pane running `claude --resume <id>` in the transcript's folder. */
export async function resumeHistory(id: string): Promise<Session | undefined> {
  const { cols, rows } = getState().lastTermSize
  try {
    const sess = await hive.history.resume({ id, cols, rows })
    await refreshSessions().catch(() => undefined)
    focusSession(sess.id)
    toast('Resumed in Principia')
    return sess
  } catch (e) {
    toastError(e, 'Resume')
    return undefined
  }
}
