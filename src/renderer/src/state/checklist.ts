/**
 * AUTOPILOT.md §2: the setup checklist's per-viewer prefs (collapsed, dismissed) in localStorage, with a tiny
 * subscription so the palette's "Show Setup Checklist" brings a dismissed card back on a Home that is already open.
 */
import { useSyncExternalStore } from 'react'
import type { Id } from '@shared/types'
import { CHECKLIST_KEY, parseChecklistPrefs, type ChecklistPref, type ChecklistPrefs } from '../lib/checklist'
import { loadJson, navigate, saveJson } from './store'

const prefListeners = new Set<() => void>()
let prefCache: { raw: string; prefs: ChecklistPrefs } | null = null
function getPrefs(): ChecklistPrefs {
  const raw = JSON.stringify(loadJson<unknown>(CHECKLIST_KEY, null))
  if (!prefCache || prefCache.raw !== raw) prefCache = { raw, prefs: parseChecklistPrefs(JSON.parse(raw)) }
  return prefCache.prefs
}
export function setChecklistPref(companyId: Id, patch: Partial<ChecklistPref> | null): void {
  const all = { ...getPrefs() }
  const next: ChecklistPref = patch === null ? {} : { ...(all[companyId] ?? {}), ...patch }
  for (const k of Object.keys(next) as (keyof ChecklistPref)[]) if (next[k] === undefined) delete next[k]
  if (Object.keys(next).length) all[companyId] = next
  else delete all[companyId]
  saveJson(CHECKLIST_KEY, all)
  prefCache = null
  for (const l of prefListeners) l()
}
export function useChecklistPref(companyId: Id): ChecklistPref {
  const prefs = useSyncExternalStore(
    (cb) => {
      prefListeners.add(cb)
      return () => void prefListeners.delete(cb)
    },
    getPrefs,
    getPrefs
  )
  return prefs[companyId] ?? {}
}
/** "Show Setup Checklist" (palette): brings a dismissed card back, expanded, and goes Home. */
export function showChecklist(companyId: Id): void {
  setChecklistPref(companyId, { dismissedAt: undefined, collapsed: false })
  void navigate({ name: 'home' })
}
