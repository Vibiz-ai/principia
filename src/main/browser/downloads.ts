/**
 * BROWSER.md §5.4: a company browser download lands in that company's Downloads folder, under a size cap; a file
 * that can run code waits for the founder's yes. The item is Electron's DownloadItem (a fake in tests).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { BrowserDownload } from '../../shared/browser'
import { DOWNLOAD_MAX_BYTES, isExecutableName, safeDownloadName, uniquePath } from './policy'

export interface DownloadItemLike {
  getFilename(): string
  getTotalBytes(): number
  getReceivedBytes(): number
  setSavePath(p: string): void
  pause(): void
  resume(): void
  cancel(): void
  on(ev: 'updated', fn: (e: unknown, state: string) => void): unknown
  once(ev: 'done', fn: (e: unknown, state: string) => void): unknown
}

export interface DownloadContext {
  dir: string
  maxBytes?: number
  exists?: (p: string) => boolean
  mkdir?: (dir: string) => void
  /** move a held file into place (defaults to fs.renameSync) */
  rename?: (from: string, to: string) => void
  /** delete a held file (defaults to fs.rmSync, force) */
  remove?: (p: string) => void
  /** the founder's yes for a file that can run code */
  confirm(name: string): Promise<boolean>
  /** every change (the panel's list) */
  update(d: BrowserDownload): void
  /** a line for the agent's next tool result */
  note(text: string): void
}

/** Where a file that can run code waits for the founder's yes: a hidden folder, a name with no runnable extension. */
export const HOLD_DIR = '.waiting'

let seq = 0

export function handleDownload(item: DownloadItemLike, ctx: DownloadContext): BrowserDownload {
  const max = ctx.maxBytes ?? DOWNLOAD_MAX_BYTES
  const name = safeDownloadName(item.getFilename())
  const mkdir = ctx.mkdir ?? ((d: string) => void fs.mkdirSync(d, { recursive: true }))
  const rename = ctx.rename ?? ((a: string, b: string) => fs.renameSync(a, b))
  const remove = ctx.remove ?? ((p: string) => fs.rmSync(p, { force: true }))
  const exists = ctx.exists ?? fs.existsSync
  mkdir(ctx.dir)
  const id = `dl${++seq}`
  const held = isExecutableName(name)
  // A file that can run code is never written under its own name before the founder's yes: a small file finishes in
  // its first chunk, before pause() takes hold, so it is saved to a holding name and moved into place only on yes.
  let target = uniquePath(ctx.dir, name, exists)
  let holdPath: string | null = null
  if (held) {
    const holdDir = path.join(ctx.dir, HOLD_DIR)
    mkdir(holdDir)
    holdPath = path.join(holdDir, `${id}.part`)
  }
  // always set: without a path Electron would show its own save dialog
  item.setSavePath(holdPath ?? target)
  const d: BrowserDownload = { id, name, path: target, state: 'progressing', bytes: 0 }
  const set = (patch: Partial<BrowserDownload>): void => {
    Object.assign(d, patch)
    ctx.update({ ...d })
  }
  const mb = Math.round(max / 1024 / 1024)
  const tooBig = (n: number): boolean => n > max
  /** yes / no from the founder (null = not answered yet) */
  let answer: boolean | null = held ? null : true
  /** how the transfer ended (null = still going) */
  let finished: 'completed' | 'cancelled' | 'interrupted' | null = null
  let stopped = false
  const dropHeld = (): void => {
    if (!holdPath) return
    try {
      remove(holdPath)
    } catch {
      /* already gone */
    }
  }
  const stop = (patch: Partial<BrowserDownload>): void => {
    stopped = true
    set({ state: 'cancelled', ...patch })
    if (!finished) item.cancel()
    dropHeld()
  }
  const finish = (): void => {
    if (holdPath) {
      try {
        target = uniquePath(ctx.dir, name, exists)
        rename(holdPath, target)
      } catch (e) {
        dropHeld()
        set({ state: 'interrupted', note: 'Could not save the file' })
        ctx.note(`Download of ${name} failed: ${e instanceof Error ? e.message : String(e)}`)
        return
      }
    }
    set({ state: 'completed', path: target, note: undefined, bytes: item.getReceivedBytes() })
    ctx.note(`Downloaded ${name} to ${target}.`)
  }

  if (tooBig(item.getTotalBytes())) {
    stop({ note: `Larger than ${mb} MB` })
    ctx.note(`Download of ${name} was stopped: it is larger than ${mb} MB.`)
    return d
  }
  item.on('updated', () => {
    if (stopped) return
    const n = item.getReceivedBytes()
    if (tooBig(n)) {
      stop({ bytes: n, note: `Larger than ${mb} MB` })
      return
    }
    // keep "Waiting for your yes" until the founder answers
    if (answer === null) Object.assign(d, { bytes: n })
    else set({ bytes: n })
  })
  item.once('done', (_e, state) => {
    finished = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted'
    if (stopped) {
      dropHeld()
      ctx.update({ ...d })
      return
    }
    if (finished !== 'completed') {
      dropHeld()
      set({ state: finished, bytes: item.getReceivedBytes() })
      ctx.note(`Download of ${name} ${finished === 'cancelled' ? 'was cancelled' : 'failed'}.`)
      return
    }
    // finished before the founder answered: it stays in the holding folder until the yes
    if (answer === null) {
      Object.assign(d, { bytes: item.getReceivedBytes() })
      return
    }
    finish()
  })
  if (held) {
    item.pause()
    set({ state: 'waiting', note: 'Waiting for your yes: this file can run programs' })
    const decide = (yes: boolean, why: string): void => {
      if (stopped || (finished && finished !== 'completed')) return
      answer = yes
      if (!yes) {
        stop({ note: why })
        if (why === 'You said no') ctx.note(`The founder declined the download of ${name}.`)
        return
      }
      if (finished === 'completed') finish()
      else {
        set({ state: 'progressing', note: undefined })
        item.resume()
      }
    }
    void ctx.confirm(name).then(
      (yes) => decide(yes, 'You said no'),
      () => decide(false, 'Not confirmed')
    )
  } else ctx.update({ ...d })
  return d
}
