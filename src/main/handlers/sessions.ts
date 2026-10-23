import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { HiveError } from '../../shared/errors'
import type { Hive } from '../hive'
import { handle, onSend } from '../ipc'
import { readTranscript } from '../history/transcript'
import { requireCompany } from './companyScope'

export function registerSessionHandlers(h: Hive): void {
  handle('sessions:list', (req) => {
    const since = new Date(Date.now() - 7 * 86400_000).toISOString()
    return h.store.listSessions(req?.status ?? 'all', since, req?.companyId)
  })
  handle('sessions:create', (req) => {
    // an unknown company would stamp a row no company lists (COMPANY.md §1.4: nothing disappears)
    if (req.companyId) requireCompany(h, req.companyId)
    const s = h.sessions.create(req)
    h.statusChanged()
    return s
  })
  handle('sessions:attach', ({ id }) => h.sessions.attach(id))
  handle('sessions:kill', async ({ id }) => {
    const s = await h.sessions.kill(id)
    h.statusChanged()
    return s
  })
  handle('sessions:remove', ({ id }) => h.sessions.remove(id))
  // CONTRACT §13: resume a rate-limited session now / at the reset, or cancel a pending resume
  handle('sessions:retry', ({ id, when }) => {
    if (!h.store.getSession(id)) throw new HiveError('not_found', 'Session not found')
    h.sessionRetry(id, when)
  })
  // CONTRACT §13: tagged processes left over from an earlier Hive run (listed, never killed on their own)
  handle('processes:leftovers', () => h.leftovers())
  handle('processes:stop', async ({ pids }) => ({ stopped: await h.stopLeftovers(pids) }))
  handle('sessions:rename', ({ id, title }) => h.sessions.rename(id, title))
  handle('sessions:restart', ({ id }) => {
    const s = h.sessions.restart(id)
    h.statusChanged()
    return s
  })
  handle('sessions:handoff', ({ id, adapter }) => {
    const source = h.store.getSession(id)
    if (!source) throw new HiveError('not_found', 'Session not found')
    let transcript = ''
    const history = source.adapter === 'claude' && source.agentSessionId && h.settings().claudeHistory !== false
      ? h.history?.byId(source.agentSessionId) : null
    if (history && h.history?.isInsideRoot(history.path) && fs.existsSync(history.path)) {
      try { transcript = readTranscript(history, (t) => h.vault.redact(t)).entries.map((e) => `${e.role}: ${e.text}`).join('\n\n') } catch { /* terminal output remains available */ }
    }
    const s = h.sessions.handoff(id, adapter, transcript)
    h.statusChanged()
    return s
  })
  // pasted / dropped images with no file behind them: the agent CLIs take image paths, so give them one
  handle('sessions:saveImage', ({ id, data, type }) => {
    if (!h.store.getSession(id)) throw new HiveError('not_found', 'Session not found')
    const dir = path.join(h.paths.userData, 'pastes')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const ext = type === 'image/jpeg' ? 'jpg' : type.slice('image/'.length)
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}.${ext}`)
    fs.writeFileSync(file, data, { mode: 0o600 })
    return { path: file }
  })
  handle('runs:openAsSession', ({ runId, stepId }) => {
    const d = h.store.getRunDetail(runId)
    if (!d) throw new HiveError('not_found', 'Run not found')
    const agentSteps = d.steps.filter((s) => s.adapter !== 'shell' || s.nodeType === 'prompt')
    const step = stepId
      ? d.steps.find((s) => s.id === stepId)
      : ([...agentSteps].reverse().find((s) => s.status === 'failed') ?? agentSteps[agentSteps.length - 1] ?? d.steps[d.steps.length - 1])
    if (!step) throw new HiveError('not_found', 'This run has no steps to open')
    const profileId = step.profileId && h.store.getProfile(step.profileId) ? step.profileId : undefined
    const repo = h.store.getRepoByPath(step.cwd)
    const s = h.sessions.create({
      profileId,
      adapter: profileId ? undefined : step.adapter,
      repoId: repo?.id,
      cwd: repo ? undefined : step.cwd,
      cols: 120,
      rows: 32,
      title: `${d.run.title} · ${step.nodeId}`,
      // the run's company, so the pane gets the same keys and Passport the run had (COMPANY.md §6)
      companyId: d.run.companyId,
      fromRunId: runId,
      resumeAgentSessionId: step.agentSessionId
    })
    h.statusChanged()
    return s
  })
  onSend('sessions:write', ({ id, data, typed }) => h.sessions.write(id, data, typed))
  onSend('sessions:resize', ({ id, cols, rows }) => h.sessions.resize(id, cols, rows))
}
