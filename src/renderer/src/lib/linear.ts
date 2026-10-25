/** LINEAR.md §6: the renderer's view of a company's Linear sync (the key never reaches here). */
import { useEffect, useRef, useState } from 'react'
import type { LinearStatusView } from '@shared/linear'
import { hive, useHiveEvent } from './hive'

/** One company's sync status, refetched when tasks or keys change. null while loading or without a company. */
export function useLinear(companyId: string | null | undefined): { status: LinearStatusView | null; reload: () => void } {
  const [status, setStatus] = useState<LinearStatusView | null>(null)
  const n = useRef(0)
  const load = (): void => {
    if (!companyId) { setStatus(null); return }
    const k = ++n.current
    void hive.linear.status({ companyId }).then((s) => { if (n.current === k) setStatus(s) }, () => { if (n.current === k) setStatus(null) })
  }
  useEffect(load, [companyId])
  useHiveEvent('data:changed', ({ domain }) => { if (domain === 'tasks' || domain === 'secrets' || domain === 'company') load() })
  return { status, reload: load }
}

/** "Synced 12 s ago", "Synced 3 min ago", "Not synced yet". */
export function syncedAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'Not synced yet'
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return `Synced ${s} s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `Synced ${m} min ago`
  const h = Math.round(m / 60)
  return h < 24 ? `Synced ${h} h ago` : `Synced ${Math.round(h / 24)} d ago`
}

/** The one-line state of a connection, as the Board menu and Company Settings show it. */
export function linearLine(s: LinearStatusView | null, now = Date.now()): string {
  if (!s || !s.connected) return 'Linear: Not connected'
  if (s.state === 'auth') return 'Linear: Key turned down · Autosync is off'
  if (s.syncing) return `Linear: Syncing with ${s.team?.key ?? 'the team'}…`
  if (s.state === 'network') return `Linear: Offline · ${syncedAgo(s.lastSyncedAt, now)}`
  if (s.state === 'error') return `Linear: Sync problem · ${syncedAgo(s.lastSyncedAt, now)}`
  return `Linear: ${syncedAgo(s.lastSyncedAt, now)}${s.autosync ? '' : ' · Autosync off'}`
}

/** In progress (or in review) in Linear with no run here: someone there is on it, no agent of ours. */
export function startedInLinear(task: { status: string; runId?: string | null }, link: { status?: string } | null | undefined): boolean {
  return !!link && task.status === 'in_progress' && !task.runId
}
/** "in progress in Linear", or "in review in Linear" while the issue sits in a review state there. */
export function linearWorkLabel(link: { status?: string } | null | undefined): string {
  return link?.status === 'in_review' ? 'in review in Linear' : 'in progress in Linear'
}
/** The team the connect sheet starts on: the connected one, else the first that no other company syncs with. */
export function defaultTeam(teams: { id: string; syncedWith?: string[] }[], current: string | null | undefined): string {
  if (current && teams.some((t) => t.id === current)) return current
  return (teams.find((t) => !t.syncedWith?.length) ?? teams[0])?.id ?? ''
}

/** Labels typed as "bug, Launch,  bug" → ['bug', 'Launch'] (first spelling kept, matched in any case). */
export function parseLabels(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(',')) {
    const l = raw.trim().slice(0, 80)
    if (!l || seen.has(l.toLowerCase())) continue
    seen.add(l.toLowerCase())
    out.push(l)
  }
  return out.slice(0, 50)
}
