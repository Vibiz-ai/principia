/**
 * WORKTREE.md: the taskWork:* channels. Merge… and Remove Worktree… are confirmed with a native dialog here in main,
 * so the renderer can never merge or drop work on its own. Open in Editor opens the worktree in Cursor, VS Code or Zed
 * when one is installed, else in Finder.
 */
import { spawn } from 'node:child_process'
import { app, BrowserWindow, dialog, shell, type MessageBoxOptions } from 'electron'
import { HiveError } from '../../shared/errors'
import { workStarted } from '../../shared/taskWork'
import type { TaskWorkService } from '../company/taskWork'
import { which } from '../engine/util'
import type { Hive } from '../hive'
import { handle } from '../ipc'
import { baseChildEnv } from '../loginEnv'
import { log } from '../log'

const EDITORS = ['cursor', 'code', 'zed']

/** A native confirm. HIVE_TEST_CONFIRM=yes|no answers it in a dev build (QA through CDP cannot click native dialogs). */
async function confirm(sender: Electron.WebContents | undefined, opts: MessageBoxOptions): Promise<boolean> {
  const test = process.env.HIVE_TEST_CONFIRM
  if (!app.isPackaged && (test === 'yes' || test === 'no')) {
    log.info('taskWork: confirm answered by HIVE_TEST_CONFIRM', { answer: test, message: opts.message, detail: opts.detail })
    return test === 'yes'
  }
  const win = (sender && BrowserWindow.fromWebContents(sender)) || BrowserWindow.getFocusedWindow()
  const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
  return r.response === 0
}

export function registerTaskWorkHandlers(h: Hive): void {
  const svc = (): TaskWorkService => h.taskWork ?? (() => { throw new HiveError('not_implemented', 'Task worktrees are not available') })()

  handle('taskWork:start', ({ id, profileId }) => svc().startTask(id, profileId))

  handle('taskWork:merge', async ({ id }, sender) => {
    const t = h.company.task(id)
    const pr = t.work?.pr
    if (!pr || pr.state !== 'OPEN') throw new HiveError('bad_request', 'There is no open pull request to merge')
    const ok = await confirm(sender, {
      type: 'question',
      buttons: ['Merge', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Merge #${pr.number} into ${(t.work?.baseRef ?? 'the base branch').replace(/^origin\//, '')}?`,
      detail: `${t.identifier} · ${t.title}\nSquash-merges the pull request on GitHub (gh pr merge --squash). ${t.identifier} becomes Done with “Merged #${pr.number}”. Your checkout is not touched.`
    })
    return ok ? svc().merge(id) : null
  })

  handle('taskWork:remove', async ({ id }, sender) => {
    const t = h.company.task(id)
    if (!workStarted(t.work)) throw new HiveError('bad_request', 'This task has no worktree')
    const loss = await svc().loss(id)
    const lines: string[] = []
    if (loss.dirty.length) lines.push(`${loss.dirty.length} uncommitted change${loss.dirty.length === 1 ? '' : 's'}:`, ...loss.dirty.slice(0, 8).map((l) => `  ${l}`), ...(loss.dirty.length > 8 ? [`  …and ${loss.dirty.length - 8} more`] : []))
    if (loss.unpushed.length) lines.push(`${loss.unpushed.length} commit${loss.unpushed.length === 1 ? '' : 's'} on no remote:`, ...loss.unpushed.slice(0, 8).map((l) => `  ${l}`), ...(loss.unpushed.length > 8 ? [`  …and ${loss.unpushed.length - 8} more`] : []))
    const lossy = lines.length > 0
    const ok = await confirm(sender, {
      type: lossy ? 'warning' : 'question',
      buttons: [lossy ? 'Remove and Lose This Work' : 'Remove Worktree', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Remove the worktree for ${t.identifier}?`,
      detail: lossy
        ? `This would be lost:\n${lines.join('\n')}\n\n${t.work!.worktreePath}`
        : `Nothing is lost: there are no uncommitted changes and every commit is on a remote.\n\n${t.work!.worktreePath}`
    })
    return ok ? svc().removeWorktree(id, lossy) : null
  })

  handle('taskWork:resolveGone', ({ id, choice }) => svc().resolveGone(id, choice))

  handle('taskWork:refresh', async () => {
    void svc().focus().catch((e) => log.warn('taskWork: refresh failed', { error: String(e) }))
    return { ok: true as const }
  })

  handle('taskWork:openEditor', async ({ id }) => {
    const t = h.company.task(id)
    const p = t.work?.worktreePath
    if (!p || !workStarted(t.work)) throw new HiveError('bad_request', 'This task has no worktree')
    const env = baseChildEnv()
    for (const bin of EDITORS) {
      const full = which(bin, env.PATH)
      if (!full) continue
      const child = spawn(full, [p], { env, detached: true, stdio: 'ignore' })
      child.on('error', (e) => log.warn('taskWork: editor failed', { bin, error: String(e) }))
      child.unref()
      return { opened: 'editor' as const }
    }
    const err = await shell.openPath(p)
    if (err) throw new HiveError('internal', err)
    return { opened: 'finder' as const }
  })
}
