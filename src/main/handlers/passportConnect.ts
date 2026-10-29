/**
 * "Use this Passport in other apps" and "Import into Passport" (open-passport docs/connect.md; PASSPORT.md §12b).
 *
 * - company:passportConnect: the configs other apps need to run the bundled stdio server (out/main/mcp-passport.js)
 *   on Principia's runtime against the live vault, the host's MCP URL when Cloud sync is set, one-click installs that
 *   run only on the user's click (Claude Desktop's config; Cursor and VS Code install links), a one-time host sign-in
 *   link (for the OAuth consent page), and moving writes other apps queued into the Inbox.
 * - company:passportImport: the Open Passport importers, their candidates filed as Inbox proposals.
 * Queued writes are also picked up every 30 seconds for companies whose vault has some.
 */
import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, dialog, shell } from 'electron'
import { HiveError } from '../../shared/errors'
import type { Id } from '../../shared/types'
import type { PassportConnectInfo, PassportConnectRequest, PassportConnectResult, PassportImportRequest, PassportImportResult } from '../../shared/passport'
import type { Hive } from '../hive'
import { emit, handle } from '../ipc'
import { appLocationProblem } from '../appLocation'
import { hubNote } from '../memory/brief'
import {
  claudeDesktopConfigPath,
  claudeDesktopHas,
  cursorDeeplink,
  fileProposals,
  hostedSnippets,
  importIntoInbox,
  ingestQueued,
  installClaudeDesktop,
  localSnippets,
  queuedCount,
  serverNameFor,
  stdioEntry,
  vscodeInstallLink,
  PASSPORT_MCP_SCRIPT,
  type ConnectHost
} from '../memory/openPassportConnect'
import { PassportSync } from '../memory/openPassportSync'

const INGEST_EVERY_MS = 30_000

/** out/main/mcp-passport.js, asar-unpacked when that copy exists (Electron-as-node also reads app.asar). */
export function passportServerScript(mainDir = __dirname): string {
  const p = path.join(mainDir, PASSPORT_MCP_SCRIPT)
  const unpacked = p.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
  return unpacked !== p && fs.existsSync(unpacked) ? unpacked : p
}

export function passportConnectActions(h: Hive, opts: { userData: string; execPath?: string; script?: string; fetch?: typeof fetch; claudeConfig?: string }) {
  const rt = () => {
    if (!h.memory) throw new HiveError('vault_unavailable', 'Company memory is not available')
    return h.memory.openPassport()
  }
  const host = (): ConnectHost => {
    const r = rt()
    return {
      db: r.openPassportHost().db,
      root: (c) => r.ensure(c),
      departments: (c) => h.company.scope.passportDepartments(c),
      taste: (c, input, source) => r.taste(c, input, { stated: false, source: { kind: 'user' }, proposalSource: source }),
      now: () => new Date()
    }
  }
  const execPath = opts.execPath ?? process.execPath
  const script = opts.script ?? passportServerScript()
  const claudeConfig = opts.claudeConfig ?? claudeDesktopConfigPath()
  const nameOf = (companyId: Id) => {
    const c = h.company.passport(companyId)
    return serverNameFor(c.slug, c.name)
  }
  const hosted = (companyId: Id): { mcpUrl: string; base: string; passportId: string; token: string } | null => {
    const c = new PassportSync({ userData: opts.userData, exportZip: () => fail(), merge: () => fail(), remember: () => fail() }).config(companyId)
    if (!c?.url || !c.passportId) return null
    const base = c.url.replace(/\/+$/, '')
    return { base, passportId: c.passportId, token: c.token, mcpUrl: `${base}/v1/passports/${encodeURIComponent(c.passportId)}/mcp` }
  }
  const location = appLocationProblem(execPath)
  const stablePath = () => {
    if (location) throw new Error('Move Principia to your Applications folder first: the path it runs from now goes away when the disk image is ejected or the Mac restarts')
  }
  const pendingChanged = (companyId: Id) => emit('memory:changed', { seq: 0, runIds: [], entityIds: [], pendingDelta: true, companyId })

  const info = (companyId: Id): PassportConnectInfo => {
    const vault = rt().ensure(companyId)
    const name = nameOf(companyId)
    const hs = hosted(companyId)
    return {
      serverName: name,
      vault,
      local: localSnippets(name, execPath, script, vault),
      hosted: hs ? { mcpUrl: hs.mcpUrl, snippets: hostedSnippets(name, hs.mcpUrl) } : null,
      claudeDesktop: { configPath: claudeConfig, installed: claudeDesktopHas(claudeConfig, name) },
      location,
      queued: queuedCount(vault)
    }
  }

  return {
    info,
    async connect(q: PassportConnectRequest): Promise<PassportConnectResult> {
      h.company.passport(q.companyId)
      try {
        switch (q.op) {
          case 'info':
            return { info: info(q.companyId) }
          case 'install': {
            stablePath()
            const vault = rt().ensure(q.companyId)
            const installed = installClaudeDesktop(claudeConfig, nameOf(q.companyId), stdioEntry(execPath, script, vault, 'claude-desktop'))
            return { installed, info: info(q.companyId) }
          }
          case 'open': {
            const name = nameOf(q.companyId)
            let entry: object
            if (q.hosted) {
              const hs = hosted(q.companyId)
              if (!hs) throw new Error('Turn on Cloud sync first: the hosted URL comes from it')
              entry = q.app === 'vscode' ? { type: 'http', url: hs.mcpUrl } : { url: hs.mcpUrl }
            } else {
              stablePath()
              const e = stdioEntry(execPath, script, rt().ensure(q.companyId), q.app)
              entry = q.app === 'vscode' ? { type: 'stdio', ...e } : e
            }
            await shell.openExternal(q.app === 'cursor' ? cursorDeeplink(name, entry) : vscodeInstallLink(name, entry))
            return { opened: true }
          }
          case 'hostSignIn': {
            const hs = hosted(q.companyId)
            if (!hs || !hs.token) throw new Error('Set the host, passport id and an owner key under Cloud sync first')
            const f = opts.fetch ?? fetch
            const res = await f(`${hs.base}/v1/passports/${encodeURIComponent(hs.passportId)}/login-links`, { method: 'POST', headers: { authorization: `Bearer ${hs.token}` }, signal: AbortSignal.timeout(15_000) })
            if (res.status === 403) throw new Error('The Cloud sync key is not an owner key; make one with the owner scope to sign in on the host')
            if (!res.ok) throw new Error(`The host answered ${res.status}`)
            const link = ((await res.json()) as { url?: string }).url ?? ''
            if (!/^https?:\/\//.test(link)) throw new Error('The host sent no sign-in link')
            await shell.openExternal(link)
            return { opened: true }
          }
          case 'ingest': {
            const ingested = await ingestQueued(host(), q.companyId)
            if (ingested.filed) pendingChanged(q.companyId)
            return { ingested, info: info(q.companyId) }
          }
        }
      } catch (e) {
        if (e instanceof HiveError) throw e
        throw new HiveError('bad_request', e instanceof Error ? e.message : String(e))
      }
    },
    async importInto(q: PassportImportRequest & { source?: string }): Promise<PassportImportResult> {
      const c = h.company.passport(q.companyId)
      const ch = host()
      const cardTitle = hubNote(ch.db, q.companyId, c.name)?.title ?? c.name
      try {
        const r = await importIntoInbox(ch, q.companyId, { kind: q.kind, source: q.source, text: q.text, max: q.max, cardTitle }, { fetch: opts.fetch })
        if (r.filed) pendingChanged(q.companyId)
        return r
      } catch (e) {
        throw new HiveError('bad_request', e instanceof Error ? e.message : String(e))
      }
    },
    /** One pass of the background pickup: companies whose vault holds queued writes. Never throws. */
    async ingestAll(): Promise<number> {
      if (!h.memory?.vaultMode()) return 0
      let filed = 0
      for (const c of h.company.listPassports()) {
        try {
          if (!queuedCount(h.company.scope.vaultPathFor(c.id))) continue
          const r = await ingestQueued(host(), c.id)
          if (r.filed) pendingChanged(c.id)
          filed += r.filed
        } catch {
          // a missing or read-only vault: try again next time
        }
      }
      return filed
    },
    fileProposals
  }
}

function fail(): never {
  throw new Error('not available here')
}

export function registerPassportConnectHandlers(h: Hive, userData: string): void {
  const a = passportConnectActions(h, { userData })
  handle('company:passportConnect', (q) => a.connect(q))
  handle('company:passportImport', async (q, sender) => {
    let source = q.source
    if ((q.kind === 'export' || q.kind === 'folder') && !source) {
      const win = BrowserWindow.fromWebContents(sender)
      const o: Electron.OpenDialogOptions =
        q.kind === 'export'
          ? { title: 'Import a ChatGPT or Claude export', message: 'Choose the export .zip (or its unzipped folder)', properties: ['openFile', 'openDirectory'], filters: [{ name: 'Data export', extensions: ['zip', 'json'] }] }
          : { title: 'Import a folder', message: 'Choose a Notion export, an Obsidian vault or any folder of notes', properties: ['openDirectory'] }
      const r = win ? await dialog.showOpenDialog(win, o) : await dialog.showOpenDialog(o)
      if (r.canceled || !r.filePaths[0]) return null
      source = r.filePaths[0]
    }
    return a.importInto({ ...q, source })
  })
  let busy = false
  const timer = setInterval(() => {
    if (busy) return
    busy = true
    void a.ingestAll().finally(() => {
      busy = false
    })
  }, INGEST_EVERY_MS)
  timer.unref?.()
}
