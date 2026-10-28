import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, dialog: {} }))

import { appLocationProblem, offerMoveToApplications, type MoveToApplicationsDeps } from './appLocation'

describe('appLocationProblem', () => {
  it('flags the mounted DMG', () => {
    expect(appLocationProblem('/Volumes/Principia/Principia.app/Contents/MacOS/Principia')).toBe('dmg')
    expect(appLocationProblem('/Volumes/Principia 0.3.0-arm64/Principia.app/Contents/MacOS/Principia')).toBe('dmg')
  })
  it('flags App Translocation', () => {
    expect(appLocationProblem('/private/var/folders/xy/abc/T/AppTranslocation/1F2E-3D4C/d/Principia.app/Contents/MacOS/Principia')).toBe('translocated')
  })
  it('leaves paths that stay put alone', () => {
    expect(appLocationProblem('/Applications/Principia.app/Contents/MacOS/Principia')).toBeNull()
    expect(appLocationProblem('/Users/me/Applications/Principia.app/Contents/MacOS/Principia')).toBeNull()
    expect(appLocationProblem('/Users/me/Downloads/Principia.app/Contents/MacOS/Principia')).toBeNull()
    expect(appLocationProblem('/Users/me/Volumes/x/Principia')).toBeNull()
    expect(appLocationProblem('/usr/local/bin/node')).toBeNull()
  })
})

describe('offerMoveToApplications', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })
  const deps = (o: Partial<MoveToApplicationsDeps> = {}) => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pr40-'))
    dirs.push(userData)
    return {
      platform: 'darwin' as NodeJS.Platform,
      packaged: true,
      env: {} as NodeJS.ProcessEnv,
      execPath: '/Volumes/Principia/Principia.app/Contents/MacOS/Principia',
      userData,
      inApplications: () => false,
      warn: vi.fn(),
      ...o,
      ask: vi.fn(o.ask ?? (async () => ({ response: 0, checkboxChecked: false }))),
      move: vi.fn(o.move ?? (() => true))
    }
  }

  it('asks first and moves only on yes', async () => {
    const d = deps()
    expect(await offerMoveToApplications(d)).toBe(true)
    expect(d.ask).toHaveBeenCalledOnce()
    expect(d.move).toHaveBeenCalledOnce()
  })
  it('never moves on Not Now', async () => {
    const d = deps({ ask: async () => ({ response: 1, checkboxChecked: false }) })
    expect(await offerMoveToApplications(d)).toBe(false)
    expect(d.move).not.toHaveBeenCalled()
  })
  it('does nothing in dev, off macOS, already in Applications, in a separate instance or the smoke test', async () => {
    for (const o of [{ packaged: false }, { platform: 'win32' as const }, { inApplications: () => true }, { env: { HIVE_USER_DATA: '/tmp/x' } }, { env: { HIVE_SMOKE: '1' } }]) {
      const d = deps(o)
      expect(await offerMoveToApplications(d)).toBe(false)
      expect(d.ask).not.toHaveBeenCalled()
    }
  })
  it("remembers Don't ask again outside the DMG, but keeps asking from the DMG", async () => {
    const ud = deps().userData
    const no = async () => ({ response: 1, checkboxChecked: true })
    const downloads = deps({ userData: ud, execPath: '/Users/me/Downloads/Principia.app/Contents/MacOS/Principia', ask: no })
    await offerMoveToApplications(downloads)
    expect(downloads.ask.mock.calls[0][0].checkboxLabel).toBeTruthy()
    const again = deps({ userData: ud, execPath: '/Users/me/Downloads/Principia.app/Contents/MacOS/Principia' })
    expect(await offerMoveToApplications(again)).toBe(false)
    expect(again.ask).not.toHaveBeenCalled()
    const dmg = deps({ userData: ud, ask: no })
    await offerMoveToApplications(dmg)
    expect(dmg.ask).toHaveBeenCalledOnce()
    expect(dmg.ask.mock.calls[0][0].checkboxLabel).toBeUndefined()
  })
  it('keeps starting when the move fails', async () => {
    const d = deps({
      move: () => {
        throw new Error('a running copy')
      }
    })
    expect(await offerMoveToApplications(d)).toBe(false)
    expect(d.warn).toHaveBeenCalled()
  })
})
