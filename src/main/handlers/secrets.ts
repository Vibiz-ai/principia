import fs from 'node:fs'
import { BrowserWindow, clipboard, dialog, safeStorage } from 'electron'
import { HiveError } from '../../shared/errors'
import type { Hive } from '../hive'
import { emit, handle } from '../ipc'
import { CompanySecrets, KeyNamespaces } from '../db/companySecrets'

/** Clipboard holding a secret is cleared after 60 s if it still holds that value (SPEC A11, fixed). */
const CLIPBOARD_CLEAR_MS = 60_000

export function registerSecretHandlers(h: Hive): void {
  const changed = () => emit('data:changed', { domain: 'secrets' })
  // COMPANY.md §4: Shared = vault.ts `secrets`; companies = company_secrets, same Keychain-backed safeStorage key
  const keys = new KeyNamespaces(
    h.vault,
    new CompanySecrets(h.db, {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (s: string) => safeStorage.encryptString(s),
      decrypt: (b: Buffer) => safeStorage.decryptString(b)
    }),
    // company values join memory's secret fingerprints (the boot-time build ran before they were registered)
    () => h.memory?.refreshFingerprints()
  )
  handle('secrets:list', (q) => keys.list(q?.companyId))
  handle('secrets:set', ({ name, value, label, companyId }) => {
    const m = keys.set(companyId, name, value, label)
    changed()
    return m
  })
  handle('secrets:remove', ({ name, companyId }) => {
    keys.remove(companyId, name)
    changed()
  })
  handle('secrets:move', ({ name, from, to }) => {
    const m = keys.move(name, from, to)
    changed()
    return m
  })
  handle('secrets:reveal', ({ name, companyId }) => ({ value: keys.reveal(companyId, name) }))
  handle('secrets:copy', async ({ name, companyId }) => {
    const value = keys.reveal(companyId, name)
    await clipboard.writeText(value)
    setTimeout(async () => {
      if ((await clipboard.readText()) === value) await clipboard.clear()
    }, CLIPBOARD_CLEAR_MS)
  })
  handle('secrets:parseEnv', ({ text, companyId }) => keys.parseEnv(companyId, text))
  handle('secrets:importEnv', ({ text, names, companyId }) => {
    const metas = keys.importEnv(companyId, text, names)
    changed()
    return metas
  })
  handle('secrets:pickEnvFile', async (q, sender) => {
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
    return { path: p, entries: keys.parseEnv(q?.companyId, text), text }
  })
}
