/**
 * Authoring IPC (CONTRACT §14.5): author:* (approval cards, run permissions), worktrees:*,
 * history:* (read-only Claude history + Resume in Hive). Every channel answers even when its service is missing.
 */
import fs from 'node:fs'
import { HiveError } from '../../shared/errors'
import type { WorkflowDraft } from '../../shared/types'
import type { Hive } from '../hive'
import { emit, handle } from '../ipc'
import { readTranscript } from '../history/transcript'

export function registerAuthorHandlers(h: Hive): void {
  const broker = () => {
    if (!h.author) throw new HiveError('internal', 'Authoring is not available')
    return h.author
  }
  handle('author:list', (q) => broker().list(q ?? {}))
  handle('author:get', ({ id }) => broker().get(id))
  handle('author:decide', (req) => {
    const d = broker().decide({ ...req, draft: req.draft as WorkflowDraft | undefined })
    h.statusChanged()
    return d
  })
  handle('author:grants', () => broker().grants())
  handle('author:revokeRun', ({ workflowId, ownerKey }) => broker().revokeRun(workflowId, ownerKey))

  handle('worktrees:list', (q) => (h.worktrees ? h.worktrees.list(q?.status) : []))
  handle('worktrees:remove', async ({ id, discardWork }) => {
    if (!h.worktrees) throw new HiveError('internal', 'Worktrees are not available')
    const wt = await h.worktrees.remove(id, { discardWork })
    const run = h.store.getRun(wt.runId)
    if (run) emit('run:updated', run)
    return wt
  })

  handle('worktrees:branches', ({ runId }) => (h.worktrees ? h.worktrees.branches(runId) : []))
  handle('worktrees:deleteBranches', async ({ runId, branches }) => {
    if (!h.worktrees) throw new HiveError('internal', 'Worktrees are not available')
    const run = h.store.getRun(runId)
    if (run && (run.status === 'queued' || run.status === 'running')) throw new HiveError('conflict', 'The run is still running')
    return h.worktrees.deleteBranches(runId, branches)
  })

  handle('history:list', (q) => {
    if (!h.history || h.settings().claudeHistory === false) return { items: [], total: 0, indexing: false }
    return h.history.list(q ?? {})
  })
  handle('history:get', ({ id }) => {
    if (!h.history || h.settings().claudeHistory === false) throw new HiveError('not_found', 'Claude history is off')
    const s = h.history.byId(id)
    if (!s || !h.history.isInsideRoot(s.path) || !fs.existsSync(s.path)) throw new HiveError('not_found', 'Conversation not found')
    return readTranscript(s, (t) => h.vault.redact(t))
  })
  handle('history:resume', ({ id, profileId, cols, rows }) => {
    if (!h.history || h.settings().claudeHistory === false) throw new HiveError('not_found', 'Claude history is off')
    const s = h.history.byId(id)
    if (!s) throw new HiveError('not_found', 'Conversation not found')
    if (!s.cwd || !fs.existsSync(s.cwd) || !fs.statSync(s.cwd).isDirectory()) throw new HiveError('not_found', 'Folder no longer exists')
    if (profileId) {
      const p = h.store.getProfile(profileId)
      if (!p) throw new HiveError('not_found', 'Agent profile not found')
      if (p.adapter !== 'claude') throw new HiveError('bad_request', 'Only a Claude profile can resume a Claude conversation')
    }
    const repo = h.store.getRepoByPath(s.cwd)
    const session = h.sessions.create({
      profileId,
      adapter: profileId ? undefined : 'claude',
      repoId: repo?.id,
      cwd: repo ? undefined : s.cwd,
      cols,
      rows,
      resumeAgentSessionId: s.id
    })
    h.statusChanged()
    return session
  })
}
