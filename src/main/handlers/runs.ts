import fs from 'node:fs'
import { HiveError } from '../../shared/errors'
import { readableLog } from '../engine/adapters'
import type { RunTarget } from '../../shared/types'
import type { Hive } from '../hive'
import { handle } from '../ipc'
import { isInsideAny } from '../pathGuard'
import { trimToLineStart } from '../tailBuffer'

export function checkTarget(h: Hive, t: RunTarget): void {
  if (t.kind === 'workflow') {
    if (!h.store.getWorkflow(t.workflowId)) throw new HiveError('not_found', 'Workflow not found')
  } else {
    if (!h.store.getProfile(t.profileId)) throw new HiveError('not_found', 'Agent profile not found')
    if (t.repoId && !h.store.getRepo(t.repoId)) throw new HiveError('not_found', 'Repository not found')
  }
}

export function registerRunHandlers(h: Hive): void {
  handle('runs:start', ({ target }) => {
    checkTarget(h, target as RunTarget)
    const run = h.engine.runs.start(target as RunTarget, { trigger: 'manual' })
    h.statusChanged()
    return run
  })
  handle('runs:list', (q) => h.store.listRuns(q ?? {}))
  handle('runs:get', ({ id }) => {
    const d = h.store.getRunDetail(id)
    if (!d) throw new HiveError('not_found', 'Run not found')
    return d
  })
  handle('runs:cancel', async ({ id }) => {
    if (!h.store.getRun(id)) throw new HiveError('not_found', 'Run not found')
    await h.engine.runs.cancel(id)
    h.statusChanged()
  })
  handle('runs:rerun', ({ id }) => {
    if (!h.store.getRun(id)) throw new HiveError('not_found', 'Run not found')
    const run = h.engine.runs.rerun(id)
    h.statusChanged()
    return run
  })
  // CONTRACT §13: one-off retry at the usage-limit reset (Hive's scheduler fires it), or cancel it
  handle('runs:retryAt', ({ id, when }) => {
    const run = h.runRetry(id, when)
    h.statusChanged()
    return run
  })
  handle('runs:stepLog', ({ runId, stepId, tailBytes, view }) => {
    const d = h.store.getRunDetail(runId)
    const step = d?.steps.find((s) => s.id === stepId)
    if (!step) throw new HiveError('not_found', 'Step not found')
    if (!isInsideAny(step.logPath, [h.paths.runLogsDir])) throw new HiveError('forbidden', 'Log path outside Hive logs')
    const max = tailBytes ?? 1024 * 1024
    let st: fs.Stats
    try {
      st = fs.statSync(step.logPath)
    } catch {
      return { text: '', truncated: false }
    }
    const start = Math.max(0, st.size - max)
    const fd = fs.openSync(step.logPath, 'r')
    try {
      const buf = Buffer.alloc(st.size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      let text = buf.toString('utf8')
      if (start > 0) text = trimToLineStart(text)
      if (view === 'readable') text = readableLog(step.adapter, text)
      return { text: h.vault.redact(text), truncated: start > 0 }
    } finally {
      fs.closeSync(fd)
    }
  })
}
