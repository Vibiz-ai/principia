import fs from 'node:fs'
import { BrowserWindow, clipboard, dialog } from 'electron'
import { HiveError } from '../../shared/errors'
import type { Hive } from '../hive'
import { emit, handle } from '../ipc'

/** Clipboard holding a secret is cleared after 60 s if it still holds that value (SPEC A11, fixed). */
const CLIPBOARD_CLEAR_MS = 60_000

export function registerSecretHandlers(h: Hive): void {
  const changed = () => emit('data:changed', { domain: 'secrets' })
  handle('secrets:list', () => h.vault.list())
  handle('secrets:set', ({ name, value, label }) => {
    const m = h.vault.set(name, value, label)
    changed()
    return m
  })
  handle('secrets:remove', ({ name }) => {
    h.vault.remove(name)
    changed()
  })
  handle('secrets:reveal', ({ name }) => ({ value: h.vault.reveal(name) }))
  handle('secrets:copy', async ({ name }) => {
    const value = h.vault.reveal(name)
    await clipboard.writeText(value)
    setTimeout(async () => {
      if ((await clipboard.readText()) === value) await clipboard.clear()
    }, CLIPBOARD_CLEAR_MS)
  })
  handle('secrets:parseEnv', ({ text }) => h.vault.parseEnv(text))
  handle('secrets:importEnv', ({ text, names }) => {
    const metas = h.vault.importEnv(text, names)
    changed()
    return metas
  })
  handle('secrets:pickEnvFile', async (_req, sender) => {
    const win = BrowserWindow.fromWebContents(sender)
    const opts: Electron.OpenDialogOptions = {
      title: 'Import .env file',
      buttonLabel: 'Import',
      properties: ['openFile', 'showHiddenFiles']
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return null
    const p = r.filePaths[0]
    const st = fs.statSync(p)
    if (st.size > 1024 * 1024) throw new HiveError('bad_request', 'That file is larger than 1 MB; is it really a .env file?')
    const text = fs.readFileSync(p, 'utf8')
    return { path: p, entries: h.vault.parseEnv(text), text }
  })
}
