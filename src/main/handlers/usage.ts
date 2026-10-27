/**
 * docs/USAGE.md: usage:* (the Usage page: summary, token activity, disk, Clean Up…) and activity:* (the portfolio Activity canvas:
 * outside Claude Code sessions, read-only). The services are built on first use; every channel answers even when a
 * service it leans on (worktrees, history) is missing.
 */
import { app } from 'electron'
import path from 'node:path'
import { PERSONAL_COMPANY_ID } from '../../shared/company'
import type { Hive } from '../hive'
import { emit, handle } from '../ipc'
import { log } from '../log'
import { baseChildEnv } from '../loginEnv'
import { historyRoots } from '../history'
import { usageSummary } from '../usage/summary'
import { DiskUsageService } from '../usage/disk'
import { OutsideActivity } from '../usage/activity'
import { CACHE_FILE, TokenActivityService, codexRoots, principiaRows } from '../usage/tokens'
import { gitRunner } from '../worktrees'

export function registerUsageHandlers(h: Hive): void {
  const companyName = (id: string): string => {
    try {
      return h.company.listPassports({ includeArchived: true }).find((c) => c.id === id)?.name ?? (id === PERSONAL_COMPANY_ID ? 'Personal' : 'Archived company')
    } catch {
      return id === PERSONAL_COMPANY_ID ? 'Personal' : id
    }
  }
  let disk: DiskUsageService | null = null
  const diskSvc = (): DiskUsageService =>
    (disk ??= new DiskUsageService({
      db: h.db,
      paths: h.paths,
      companySlugs: () => h.company.listPassports({ includeArchived: true }).map((c) => ({ id: c.id, slug: c.slug })),
      git: gitRunner(() => baseChildEnv()),
      removeTaskWorktree: (taskId) => {
        if (!h.taskWork) throw new Error('task worktrees are unavailable')
        return h.taskWork.removeWorktree(taskId, false)
      },
      // read at call time: worktrees are wired after the handlers
      get worktrees() {
        return h.worktrees
      }
    }))

  handle('usage:summary', ({ range, companyId }) => usageSummary({ db: h.db, companyName, personas: h.settings().personas !== false }, { range, companyId }))
  handle('usage:disk', (q) => diskSvc().measure(!!q?.fresh))
  handle('usage:cleanupList', () => diskSvc().cleanupItems())
  handle('usage:cleanup', ({ ids }) => diskSvc().cleanup(ids))

  // §5 Token activity: every token on this Mac (Claude Code, Codex, Principia's own), cached in our data dir
  const tokens = new TokenActivityService({
    cachePath: path.join(h.paths.userData, CACHE_FILE),
    claudeRoots: () => historyRoots({ ...baseChildEnv(), HIVE_CLAUDE_DIRS: process.env.HIVE_CLAUDE_DIRS }),
    claudeEnabled: () => h.settings().claudeHistory !== false,
    codexRoots: () => codexRoots({ ...baseChildEnv(), HIVE_CODEX_DIRS: process.env.HIVE_CODEX_DIRS }),
    principia: () => principiaRows(h.db),
    log
  })
  handle('usage:tokens', () => tokens.get())

  const activity = new OutsideActivity({
    roots: () => historyRoots({ ...baseChildEnv(), HIVE_CLAUDE_DIRS: process.env.HIVE_CLAUDE_DIRS }),
    enabled: () => h.settings().claudeHistory !== false,
    inHiveIds: () => {
      try {
        const rows = h.db
          .prepare('SELECT agent_session_id AS id FROM sessions WHERE agent_session_id IS NOT NULL UNION SELECT agent_session_id FROM run_steps WHERE agent_session_id IS NOT NULL')
          .all() as { id: string }[]
        return new Set(rows.map((r) => r.id))
      } catch {
        return new Set()
      }
    },
    companyForCwd: (cwd) => {
      const at = h.company.scope.locate(cwd)
      return at.via === 'none' ? null : at.company.id
    },
    redact: (t) => h.vault.redact(t),
    emit: (snap) => emit('activity:changed', snap),
    // a session the index has not seen yet: let history:get (TranscriptSheet) find it
    onNewSession: () => void h.history?.refresh(),
    log
  })
  handle('activity:open', () => {
    const snap = activity.open()
    if (!snap.disabled) h.history?.refresh()
    return snap
  })
  handle('activity:close', () => activity.close())
  app.on('before-quit', () => activity.close())
}
