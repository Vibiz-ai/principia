/**
 * Hive.requestQuit must never leave the app unquittable. A quit that arrived during startup (before the window manager
 * existed) used to throw after marking the app as shutting down, so every later Cmd+Q / tray Quit / SIGTERM returned
 * early while before-quit kept preventing the quit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  app: { dock: { setBadge: vi.fn() }, quit: vi.fn(), exit: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  powerSaveBlocker: { start: vi.fn(), stop: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  Notification: { isSupported: () => false }
}))
vi.mock('electron', () => electron)

import { Hive } from '../hive'

function makeHive(o: { running?: number; shutdown?: () => Promise<void> } = {}) {
  const store = { listRuns: () => [], getSettings: () => ({}) }
  const h = new Hive({} as never, store as never, { redact: (s: string) => s } as never, {} as never)
  const sessions = { runningCount: vi.fn(() => o.running ?? 0), shutdown: vi.fn(o.shutdown ?? (() => Promise.resolve())) }
  h.sessions = sessions as never
  const reaper = { reapAllSync: vi.fn(() => 0) }
  h.reaper = reaper as never
  return { h, sessions, reaper }
}

/** lets requestQuit's awaits and the deferred final quit (setImmediate) run */
const settle = () => vi.advanceTimersByTimeAsync(10)

describe('Hive.requestQuit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    electron.app.quit.mockReset()
    electron.app.exit.mockReset()
    electron.dialog.showMessageBox.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a quit before the window manager exists still completes', async () => {
    const { h, sessions, reaper } = makeHive()
    expect(h.windows).toBeUndefined()
    expect(h.tray).toBeNull()
    const done = h.requestQuit()
    await settle()
    await done
    expect(sessions.shutdown).toHaveBeenCalled()
    expect(reaper.reapAllSync).toHaveBeenCalled()
    expect(h.shutdownDone).toBe(true)
    expect(electron.app.quit).toHaveBeenCalledTimes(1)
  })

  it('a throw inside shutdown still finishes the quit, and later steps still run', async () => {
    const { h, sessions, reaper } = makeHive({
      shutdown: () => {
        throw new Error('pty boom')
      }
    })
    h.remote = { stop: () => Promise.reject(new Error('tunnel boom')) } as never
    h.tray = {
      destroy: () => {
        throw new Error('tray boom')
      }
    } as never
    const done = h.requestQuit()
    await settle()
    await done
    expect(sessions.shutdown).toHaveBeenCalled()
    expect(reaper.reapAllSync).toHaveBeenCalled()
    expect(h.shutdownDone).toBe(true)
    expect(electron.app.quit).toHaveBeenCalledTimes(1)
  })

  it('a throw outside the steps (the window manager itself) still finishes the quit', async () => {
    const { h } = makeHive()
    Object.defineProperty(h, 'windows', {
      get() {
        throw new TypeError("Cannot set properties of undefined (setting 'quitting')")
      }
    })
    const done = h.requestQuit()
    await settle()
    await done
    expect(h.shutdownDone).toBe(true)
    expect(h.quitting).toBe(true)
    expect(electron.app.quit).toHaveBeenCalledTimes(1)
  })

  it('a second quit after a failed first one goes through', async () => {
    const { h } = makeHive()
    Object.defineProperty(h, 'windows', {
      configurable: true,
      get() {
        throw new Error('boom')
      }
    })
    const finish = vi.fn(() => {
      throw new Error('quitAndInstall failed')
    })
    const first = h.requestQuit(finish)
    await settle()
    await first
    expect(finish).toHaveBeenCalled()
    // the final quit itself failed: exit instead of staying up
    expect(electron.app.exit).toHaveBeenCalledWith(0)
    // shutdownDone tells before-quit (index.ts) to stop preventing quits: the next Cmd+Q goes straight through
    expect(h.shutdownDone).toBe(true)
    await expect(h.requestQuit()).resolves.toBeUndefined()
  })

  it('a failed confirm dialog does not keep the app running', async () => {
    const { h, sessions } = makeHive({ running: 2 })
    electron.dialog.showMessageBox.mockRejectedValueOnce(new Error('no dialog'))
    const done = h.requestQuit()
    await settle()
    await done
    expect(sessions.shutdown).toHaveBeenCalled()
    expect(h.shutdownDone).toBe(true)
    expect(electron.app.quit).toHaveBeenCalledTimes(1)
  })

  it('Cancel keeps the app running, and the next quit asks again and quits', async () => {
    const { h, sessions } = makeHive({ running: 1 })
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({ response: 0 })
    await h.requestQuit()
    expect(sessions.shutdown).not.toHaveBeenCalled()
    expect(h.quitting).toBe(false)
    expect(h.shutdownDone).toBe(false)
    const second = h.requestQuit()
    await settle()
    await second
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(2)
    expect(sessions.shutdown).toHaveBeenCalled()
    expect(electron.app.quit).toHaveBeenCalledTimes(1)
  })

  it('a shutdown step that never settles does not block the quit', async () => {
    const { h } = makeHive()
    h.slack = { stop: () => new Promise<void>(() => undefined) } as never
    const done = h.requestQuit()
    await vi.advanceTimersByTimeAsync(30_000)
    await done
    expect(h.shutdownDone).toBe(true)
    expect(electron.app.quit).toHaveBeenCalledTimes(1)
  })
})
