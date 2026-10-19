/** Pure tray model (SPEC A12) so title/menu logic is unit-testable without Electron. */
import type { Id, NextFire, StatusSnapshot } from '../shared/types'

export type TrayAction =
  | { kind: 'open' }
  | { kind: 'openSession'; id: Id }
  | { kind: 'openRun'; id: Id }
  | { kind: 'newSession'; repoId: Id | null }
  | { kind: 'togglePause' }
  | { kind: 'toggleSlackAutoPause' }
  | { kind: 'quit' }
  | { kind: 'focusAgent'; agentId: Id }

export interface TrayItem {
  label?: string
  type?: 'normal' | 'separator' | 'checkbox'
  enabled?: boolean
  checked?: boolean
  accelerator?: string
  action?: TrayAction
  submenu?: TrayItem[]
}

export interface TrayRunning {
  kind: 'session' | 'run'
  id: Id
  label: string
  startedAt: string | null
}

export interface TrayInput {
  status: StatusSnapshot
  running: TrayRunning[]
  lastFailure: { runId: Id; title: string; endedAt: string } | null
  recentRepos: { id: Id; name: string }[]
  now: Date
  /** LIVE.md §4.5: oldest first; the menu shows up to 5. */
  needsYou?: { agentId: Id; label: string }[]
  /** SLACK.md PO-S3e: shown only once Slack is connected. */
  slackAutoPaused?: boolean | null
}

export function trayTitle(s: StatusSnapshot): string {
  const parts: string[] = []
  const n = s.runningSessions + s.runningRuns
  if (n > 0) parts.push(`● ${n}`)
  if ((s.needsYou ?? 0) > 0) parts.push(`⚑ ${s.needsYou}`)
  if (s.unseenFailures > 0) parts.push('✕')
  if (s.schedulesPaused) parts.push('⏸')
  return parts.join(' ')
}

/** "14m", "2h 5m", "3d" */
export function shortDuration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function clock(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function nextFireLabel(next: NextFire | null, paused: boolean, now: Date): string {
  if (paused) return 'Schedules paused'
  if (!next) return 'Nothing scheduled'
  const ms = Date.parse(next.at) - now.getTime()
  return `Next: ${next.name} ${ms <= 60_000 ? 'now' : `in ${shortDuration(ms)}`}`
}

export function trayMenuModel(i: TrayInput): TrayItem[] {
  const items: TrayItem[] = [{ label: 'Open Hive', action: { kind: 'open' } }, { type: 'separator' }]
  const needs = i.needsYou ?? []
  if (needs.length) {
    items.push({ label: 'Needs you', enabled: false })
    for (const n of needs.slice(0, 5)) items.push({ label: `   ⚑ ${n.label}`, action: { kind: 'focusAgent', agentId: n.agentId } })
    if (needs.length > 5) items.push({ label: `   and ${needs.length - 5} more`, action: { kind: 'open' } })
    items.push({ type: 'separator' })
  }
  if (i.running.length) {
    items.push({ label: 'Running', enabled: false })
    for (const r of i.running.slice(0, 5)) {
      const dur = r.startedAt ? ` · ${shortDuration(i.now.getTime() - Date.parse(r.startedAt))}` : ''
      items.push({
        label: `   ● ${r.label}${dur}`,
        action: r.kind === 'session' ? { kind: 'openSession', id: r.id } : { kind: 'openRun', id: r.id }
      })
    }
    if (i.running.length > 5) items.push({ label: `   and ${i.running.length - 5} more`, action: { kind: 'open' } })
  } else {
    items.push({ label: 'Nothing running', enabled: false })
  }
  if (i.status.unseenFailures > 0 && i.lastFailure) {
    items.push({
      label: `Last: ✕ ${i.lastFailure.title} failed ${clock(i.lastFailure.endedAt)}`,
      action: { kind: 'openRun', id: i.lastFailure.runId }
    })
  }
  items.push({ label: nextFireLabel(i.status.nextFire, i.status.schedulesPaused, i.now), enabled: false })
  items.push({ type: 'separator' })
  items.push({
    label: 'New Session',
    submenu: [
      ...i.recentRepos.slice(0, 5).map((r) => ({ label: r.name, action: { kind: 'newSession', repoId: r.id } as TrayAction })),
      ...(i.recentRepos.length ? [{ type: 'separator' as const }] : []),
      { label: 'Chat', action: { kind: 'newSession', repoId: null } }
    ]
  })
  items.push({ type: 'separator' })
  items.push({
    label: 'Pause All Schedules',
    type: 'checkbox',
    checked: i.status.schedulesPaused,
    action: { kind: 'togglePause' }
  })
  if (i.slackAutoPaused !== undefined && i.slackAutoPaused !== null) {
    items.push({ label: 'Pause Slack Auto-Replies', type: 'checkbox', checked: i.slackAutoPaused, action: { kind: 'toggleSlackAutoPause' } })
  }
  items.push({ type: 'separator' })
  items.push({ label: 'Quit Hive', accelerator: 'Command+Q', action: { kind: 'quit' } })
  return items
}
