import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, clipboard, nativeImage, shell } from 'electron'
import type { Artifact, Id } from '../../shared/types'
import { HiveError } from '../../shared/errors'
import type { Hive } from '../hive'
import { handle, onSend } from '../ipc'
import { isInside, safeRealpath } from '../pathGuard'
import { thumbPath, thumbnailFor } from '../thumbnails'
import { resourcePath } from '../tray'

/** Resolve an artifact row and confirm its real path is inside the artifacts root (CONTRACT §7). */
export function guardedArtifact(h: Hive, id: Id): Artifact {
  const a = h.store.getArtifact(id)
  if (!a) throw new HiveError('not_found', 'Artifact not found')
  if (!isInside(safeRealpath(a.path), safeRealpath(h.paths.artifactsRoot))) {
    throw new HiveError('forbidden', 'Artifact is outside the artifacts folder')
  }
  if (!fs.existsSync(a.path)) {
    h.indexer.removeFile(a.path)
    throw new HiveError('not_found', 'The file no longer exists')
  }
  return a
}

export function registerArtifactHandlers(h: Hive): void {
  handle('artifacts:list', (q) => h.store.listArtifacts(q ?? {}))
  handle('artifacts:thumbnail', async ({ id, size }) => {
    const a = guardedArtifact(h, id)
    return { dataUrl: await thumbnailFor(h.paths.thumbsDir, a, size ?? 320) }
  })
  handle('artifacts:peek', async ({ id, bytes }) => {
    const a = guardedArtifact(h, id)
    if (a.kind !== 'markdown' && a.kind !== 'html' && a.kind !== 'code') throw new HiveError('bad_request', 'Not a text artifact')
    const fh = await fs.promises.open(a.path, 'r')
    try {
      const buf = Buffer.alloc(bytes ?? 2048)
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      // drop a trailing partial UTF-8 sequence
      return { text: buf.subarray(0, bytesRead).toString('utf8').replace(/\uFFFD+$/, '') }
    } finally {
      await fh.close()
    }
  })
  handle('artifacts:trash', async ({ id }) => {
    const a = guardedArtifact(h, id)
    await shell.trashItem(a.path)
    h.indexer.removeFile(a.path) // emits artifact:removed, deletes thumbs
  })
  handle('artifacts:quickLook', ({ id }, sender) => {
    const a = guardedArtifact(h, id)
    const win = BrowserWindow.fromWebContents(sender) ?? h.windows.get()
    if (!win) throw new HiveError('internal', 'No window for Quick Look')
    win.previewFile(a.path, a.name)
  })
  handle('artifacts:open', async ({ id }) => {
    const a = guardedArtifact(h, id)
    const err = await shell.openPath(a.path)
    if (err) throw new HiveError('internal', err)
  })
  handle('artifacts:reveal', ({ id }) => shell.showItemInFolder(guardedArtifact(h, id).path))
  handle('artifacts:copyPath', ({ id }) => clipboard.writeText(guardedArtifact(h, id).path))
  handle('artifacts:openDir', async ({ runId, sessionId }) => {
    const owner = (runId ?? sessionId)!
    const known = runId ? h.store.getRun(runId) : h.store.getSession(sessionId!)
    if (!known) throw new HiveError('not_found', runId ? 'Run not found' : 'Session not found')
    const dir = path.join(h.paths.artifactsRoot, owner)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const err = await shell.openPath(dir)
    if (err) throw new HiveError('internal', err)
  })
  onSend('artifacts:startDrag', ({ id }, sender) => {
    let a: Artifact
    try {
      a = guardedArtifact(h, id)
    } catch {
      return
    }
    const cached = thumbPath(h.paths.thumbsDir, a.id, 320)
    let icon = fs.existsSync(cached) ? nativeImage.createFromPath(cached).resize({ width: 64 }) : nativeImage.createEmpty()
    if (icon.isEmpty()) icon = nativeImage.createFromPath(resourcePath('trayTemplate@2x.png'))
    sender.startDrag({ file: a.path, icon })
  })
}
