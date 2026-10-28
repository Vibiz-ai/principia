/**
 * Where the running Principia.app lives, and asking to move it to /Applications.
 *
 * Knowledge → Connect writes process.execPath into other apps' configs (openPassportConnect.ts stdioEntry). Opened
 * straight from the DMG window that path is /Volumes/Principia/…, and a quarantined app macOS runs translocated sits
 * under …/AppTranslocation/…: both vanish once the DMG is ejected or the Mac restarts, and the other app's Passport
 * server breaks with them. So on a packaged Mac build outside /Applications we offer the move (never silently), and
 * the Connect panel turns its one-click installs off while the path is one of those.
 */
import fs from 'node:fs'
import path from 'node:path'
import { app, dialog } from 'electron'
import type { AppLocationProblem } from '../shared/passport'
import { log } from './log'

/** 'dmg' for a mounted disk image, 'translocated' for macOS App Translocation, null for a path that stays put. */
export function appLocationProblem(execPath: string): AppLocationProblem | null {
  const p = execPath.replace(/\\/g, '/')
  if (/\/AppTranslocation\//.test(p)) return 'translocated'
  if (p.startsWith('/Volumes/')) return 'dmg'
  return null
}

const DECLINED_FILE = 'move-to-applications-declined'

export interface MoveToApplicationsDeps {
  platform: NodeJS.Platform
  packaged: boolean
  execPath: string
  userData: string
  inApplications: () => boolean
  move: () => boolean
  /** resolves with the button index (0 Move, 1 Not now) and the "Don't ask again" box */
  ask: (o: Electron.MessageBoxOptions) => Promise<{ response: number; checkboxChecked: boolean }>
  warn: (m: string, meta?: Record<string, unknown>) => void
}

/**
 * On a packaged Mac build outside /Applications, ask to move it there. Returns true when the move started (Electron
 * relaunches from /Applications, so startup should stop). "Don't ask again" is remembered, except while the app runs
 * from the DMG or translocated: that path breaks other apps' configs, so it is always worth asking.
 */
export async function offerMoveToApplications(d: MoveToApplicationsDeps): Promise<boolean> {
  if (d.platform !== 'darwin' || !d.packaged) return false
  try {
    if (d.inApplications()) return false
  } catch {
    return false
  }
  const problem = appLocationProblem(d.execPath)
  const declined = path.join(d.userData, DECLINED_FILE)
  if (!problem && fs.existsSync(declined)) return false
  const r = await d.ask({
    type: 'question',
    buttons: ['Move to Applications', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
    message: 'Move Principia to your Applications folder?',
    detail:
      problem === 'dmg'
        ? 'Principia is running from the disk image. Once you eject it, apps you connect to Knowledge (Claude Desktop, Cursor) can no longer reach it. Principia will restart from Applications.'
        : 'Apps you connect to Knowledge (Claude Desktop, Cursor) start Principia from where it is now. In Applications that path stays the same after a restart. Principia will restart from there.',
    ...(problem ? {} : { checkboxLabel: "Don't ask again" })
  })
  if (r.response !== 0) {
    if (!problem && r.checkboxChecked) {
      try {
        fs.writeFileSync(declined, new Date().toISOString())
      } catch (e) {
        d.warn('could not remember the move-to-Applications answer', { error: String(e) })
      }
    }
    return false
  }
  try {
    return d.move()
  } catch (e) {
    // e.g. a copy in /Applications that is running: keep going from here, Connect warns about the path
    d.warn('move to Applications failed', { error: String(e) })
    return false
  }
}

export function offerMoveToApplicationsNow(userData: string): Promise<boolean> {
  return offerMoveToApplications({
    platform: process.platform,
    packaged: app.isPackaged,
    execPath: process.execPath,
    userData,
    inApplications: () => app.isInApplicationsFolder(),
    move: () => app.moveToApplicationsFolder(),
    ask: (o) => dialog.showMessageBox(o),
    warn: (m, meta) => log.warn(m, meta)
  })
}
