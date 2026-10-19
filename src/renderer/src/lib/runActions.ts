import type { Run } from '@shared/types'
import { confirmNative, hive, nativeMenu } from './hive'
import { runTitle } from './format'
import { attempt, focusSession, getState, navigate, setState, toast } from '../state/store'

export async function cancelRun(run: Run): Promise<void> {
  const longRunning = run.startedAt && Date.now() - new Date(run.startedAt).getTime() > 60_000
  if (longRunning) {
    const ok = await confirmNative({ message: `Cancel “${runTitle(run)}”?`, detail: 'Running agents are stopped.', confirmLabel: 'Cancel Run', destructive: true }).catch(() => false)
    if (!ok) return
  }
  await attempt(() => hive.runs.cancel({ id: run.id }), 'Cancel run')
}

export async function rerun(run: Run, open = true): Promise<void> {
  const r = await attempt(() => hive.runs.rerun({ id: run.id }), 'Re-run')
  if (r && open) void navigate({ name: 'canvas', focusRunId: r.id })
}

export async function openAsSession(runId: string, stepId?: string): Promise<void> {
  const s = await attempt(() => hive.runs.openAsSession({ runId, stepId }), 'Open as session')
  if (!s) return
  if (!getState().sessions.some((x) => x.id === s.id)) setState((st) => ({ sessions: [s, ...st.sessions] }))
  focusSession(s.id)
}

export async function runContextMenu(run: Run): Promise<void> {
  const active = run.status === 'running' || run.status === 'queued'
  const id = await nativeMenu([
    { id: 'open', label: 'Open Run' },
    { id: 'canvas', label: 'Show on Canvas' },
    { type: 'separator' },
    active ? { id: 'cancel', label: 'Cancel Run' } : { id: 'rerun', label: 'Re-run' },
    { id: 'session', label: 'Open as Session' },
    { id: 'artifacts', label: `Show Artifacts (${run.artifactCount})` },
    { id: 'copyId', label: 'Copy Run ID' }
  ])
  if (id === 'open') void navigate({ name: 'run', runId: run.id })
  if (id === 'canvas') void navigate({ name: 'canvas', focusRunId: run.id })
  if (id === 'cancel') void cancelRun(run)
  if (id === 'rerun') void rerun(run)
  if (id === 'session') void openAsSession(run.id)
  if (id === 'artifacts') void navigate({ name: 'artifacts', runId: run.id })
  if (id === 'copyId') {
    await attempt(() => hive.clipboard.writeText({ text: run.id }))
    toast('Copied')
  }
}
