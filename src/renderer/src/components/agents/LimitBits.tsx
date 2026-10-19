/**
 * Usage limits, "Stalled?" and leftover processes (LANDSCAPE "Elon's cut" #4, #5): the amber Stalled? badge, the
 * "Hit usage limit · resets 15:00" line with Retry at reset / Retry now / Cancel, and the leftover-process list used
 * on Home and in Settings. Hive never stops a stalled agent or a leftover process on its own.
 */
import { useEffect, useState } from 'react'
import type { AgentNode } from '@shared/live'
import type { Id, LeftoverProcess, Run } from '@shared/types'
import { confirmNative, errorCode, errorMessage, hive, useHiveEvent } from '../../lib/hive'
import { isStalled, limitLine, retryAtResetLabel, retryLabel, stalledMinutes } from '../../lib/live'
import { span } from '../../lib/time'
import { attempt, navigate, toast, useStore } from '../../state/store'
import { Button, EmptyState, useTick } from '../ui'

/** Amber "Stalled?" badge for a live root with no output for Settings.stallMinutes. Hidden otherwise. */
export function StalledBadge({ agent }: { agent: Pick<AgentNode, 'status' | 'stalledSince'> | null | undefined }): React.JSX.Element | null {
  const mins = useStore((s) => s.settings?.stallMinutes ?? 10)
  useTick(60_000)
  if (!agent || !isStalled(agent)) return null
  const n = stalledMinutes(agent, mins)
  return (
    <span className="stalled-badge" title={`No output for ${n} min. Hive never stops it on its own.`}>
      Stalled?
    </span>
  )
}

/** What a limit row retries: a run (rerun via the scheduler) or a live session (types "continue" into the pane). */
export type LimitTarget =
  | { kind: 'run'; runId: Id; resetAt: string | null | undefined; retryAt: string | null | undefined }
  | { kind: 'session'; sessionId: Id; resetAt: string | null | undefined; retryAt: string | null | undefined }

export async function retryAtReset(t: LimitTarget): Promise<void> {
  if (t.kind === 'run') {
    const r = await attempt(() => hive.runs.retryAt({ id: t.runId, when: 'reset' }), 'Retry at reset')
    if (r) toast(r.retryAt ? retryLabel(r.retryAt) : 'Retry scheduled')
  } else {
    const ok = await attempt(() => hive.sessions.retry({ id: t.sessionId, when: 'reset' }).then(() => true), 'Retry at reset')
    if (ok) toast(t.resetAt ? 'Hive will type “continue” at the reset' : 'Hive will type “continue” in 1 h')
  }
}
export async function retryNow(t: LimitTarget, open = false): Promise<void> {
  if (t.kind === 'run') {
    const r = await attempt(() => hive.runs.rerun({ id: t.runId }), 'Retry now')
    if (!r) return
    toast('Retrying now')
    if (open) void navigate({ name: 'run', runId: r.id })
  } else {
    const ok = await attempt(() => hive.sessions.retry({ id: t.sessionId, when: 'now' }).then(() => true), 'Retry now')
    if (ok) toast('Sent “continue”')
  }
}
export async function cancelRetry(t: LimitTarget): Promise<void> {
  const ok = await attempt(
    () => (t.kind === 'run' ? hive.runs.retryAt({ id: t.runId, when: 'cancel' }).then(() => true) : hive.sessions.retry({ id: t.sessionId, when: 'cancel' }).then(() => true)),
    'Cancel retry'
  )
  if (ok) toast('Retry canceled')
}

/** "Hit usage limit · resets 15:00" plus Retry at reset / Retry now, or "Retry scheduled 15:01" + Cancel. */
export function LimitActions({ target, compact = false, open = false, showLine = true }: { target: LimitTarget; compact?: boolean; open?: boolean; showLine?: boolean }): React.JSX.Element {
  useTick(60_000)
  const stop = (e: React.SyntheticEvent): void => e.stopPropagation()
  return (
    <div className={`limit-actions ${compact ? 'limit-actions--compact' : ''}`} onClick={stop} onKeyDown={stop}>
      {showLine && <span className="limit-line">{limitLine({ resetAt: target.resetAt ?? null })}</span>}
      {target.retryAt ? (
        <>
          <span className="limit-scheduled">{retryLabel(target.retryAt)}</span>
          <Button size="sm" variant="ghost" onClick={() => void cancelRetry(target)}>
            Cancel
          </Button>
        </>
      ) : (
        <Button size="sm" onClick={() => void retryAtReset(target)} title={target.kind === 'run' ? 'Re-run it once when the limit resets' : 'Type “continue” into the pane when the limit resets'}>
          {retryAtResetLabel(target.resetAt)}
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => void retryNow(target, open)}>
        Retry now
      </Button>
    </div>
  )
}

export function runLimitTarget(r: Pick<Run, 'id' | 'resetAt' | 'retryAt'>): LimitTarget {
  return { kind: 'run', runId: r.id, resetAt: r.resetAt ?? null, retryAt: r.retryAt ?? null }
}
/** Limit target for a hub root: step roots retry their run, session roots resume the pane. */
export function agentLimitTarget(a: AgentNode): LimitTarget | null {
  if (a.sessionId) return { kind: 'session', sessionId: a.sessionId, resetAt: a.resetAt ?? null, retryAt: a.retryAt ?? null }
  if (a.runId) return { kind: 'run', runId: a.runId, resetAt: a.resetAt ?? null, retryAt: a.retryAt ?? null }
  return null
}

// ---------- leftover processes ----------
/** Leftover processes (tagged, owner gone): loaded once, then live via processes:changed. null = unsupported. */
export function useLeftovers(): { items: LeftoverProcess[] | null; reload: () => void } {
  const [items, setItems] = useState<LeftoverProcess[] | null>(null)
  const load = (): void => {
    hive.processes.leftovers().then(setItems, (e) => {
      if (errorCode(e) !== 'internal' && !/not implemented/i.test(errorMessage(e))) console.warn('[leftovers]', errorMessage(e))
      setItems(null)
    })
  }
  useEffect(load, [])
  useHiveEvent('processes:changed', (l) => setItems(l))
  return { items, reload: load }
}

export async function stopLeftovers(pids: number[], all: boolean): Promise<void> {
  if (!pids.length) return
  if (all) {
    const ok = await confirmNative({
      message: `Stop ${pids.length} leftover process${pids.length === 1 ? '' : 'es'}?`,
      detail: 'They were started by agents in an earlier Hive run. Their whole process trees are stopped.',
      confirmLabel: 'Stop all',
      destructive: true
    }).catch(() => false)
    if (!ok) return
  }
  const r = await attempt(() => hive.processes.stop({ pids }), 'Stop')
  if (r) toast(r.stopped ? `Stopped ${r.stopped} process${r.stopped === 1 ? '' : 'es'}` : 'Already gone')
}

/** The list (Home "Needs you", Settings). Each row: command, cwd, age, Stop. */
export function LeftoverList({ items, onChanged, empty = null }: { items: LeftoverProcess[]; onChanged?: () => void; empty?: React.ReactNode }): React.JSX.Element | null {
  useTick(60_000)
  if (!items.length) return empty ? <>{empty}</> : null
  const stop = async (pids: number[], all: boolean): Promise<void> => {
    await stopLeftovers(pids, all)
    onChanged?.()
  }
  return (
    <div className="leftovers">
      <div className="leftovers__head">
        <span className="text-secondary">
          {items.length} process{items.length === 1 ? '' : 'es'} left running by agents from an earlier Hive run. Hive won’t stop them on its own.
        </span>
        <Button size="sm" variant="destructive" onClick={() => void stop(items.map((p) => p.pid), true)}>
          Stop all
        </Button>
      </div>
      <div className="group-list">
        {items.map((p) => (
          <div key={p.pid} className="leftover-row list-row">
            <span className="leftover-row__cmd mono" title={`${p.command}\npid ${p.pid} · ${p.spawnId}`}>
              {p.command}
            </span>
            <span className="leftover-row__cwd text-tertiary" title={p.cwd ?? 'Folder unknown'}>
              {p.cwd ?? '—'}
            </span>
            <span className="leftover-row__age list-row__meta" title={new Date(p.startedAt).toLocaleString()}>
              {span(p.ageMs)}
            </span>
            <span className="list-row__actions list-row__actions--shown">
              <Button size="sm" onClick={() => void stop([p.pid], false)}>
                Stop
              </Button>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function LeftoverEmpty(): React.JSX.Element {
  return <EmptyState compact text="No leftover processes." />
}
