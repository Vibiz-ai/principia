/**
 * Authoring IPC (CONTRACT §14.5): author:* (approval cards, run permissions), worktrees:*,
 * history:* (read-only Claude history + Resume in Hive). Every channel answers even when its service is missing.
 */
import fs from 'node:fs'
import type { AuthorDraft } from '../../shared/authoring'
import { PERSONAL_COMPANY_ID } from '../../shared/company'
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
  // COMPANY.md §7: drafts list per company; author_drafts.company_id is stamped by wire.ts (empty = Personal)
  handle('author:list', (q) => {
    const { companyId, ...rest } = q ?? {}
    const tag = (list: AuthorDraft[]): AuthorDraft[] => {
      if (!list.length) return list
      const rows = h.db.prepare(`SELECT id, company_id FROM author_drafts WHERE id IN (${list.map(() => '?').join(',')})`).all(...list.map((d) => d.id)) as { id: string; company_id: string | null }[]
      const stamps = new Map(rows.map((r) => [r.id, r.company_id || PERSONAL_COMPANY_ID]))
      return list.map((d) => ({ ...d, companyId: stamps.get(d.id) ?? PERSONAL_COMPANY_ID }))
    }
    if (!companyId) return tag(broker().list(rest))
    return tag(broker().list({ ...rest, limit: 500 })).filter((d) => d.companyId === companyId).slice(0, rest.limit ?? 100)
  })
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
  handle('history:resume', ({ id, profileId, cols, rows, companyId }) => {
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
      // COMPANY.md §3: a repo decides its company; a loose folder lands in the company the user is in
      ...(!repo && companyId ? { companyId } : {}),
      cols,
      rows,
      resumeAgentSessionId: s.id
    })
    h.statusChanged()
    return session
  })
}
