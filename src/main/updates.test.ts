import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateService, type Updater } from './updates'
import { CHECK_EVERY_MS, FIRST_CHECK_DELAY_MS, type UpdateState, type WorkCounts } from '../shared/updates'

type Handler = (...a: unknown[]) => void
function fakeUpdater() {
  const handlers = new Map<string, Handler>()
  const u = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    disableDifferentialDownload: false,
    logger: null as unknown,
    on: (e: string, fn: Handler) => handlers.set(e, fn),
    checkForUpdates: vi.fn(async () => undefined as unknown),
    quitAndInstall: vi.fn()
  }
  const fire = (e: string, ...a: unknown[]) => handlers.get(e)?.(...a)
  return { u: u as unknown as Updater & typeof u, fire }
}
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined }
const idle: WorkCounts = { runningSessions: 0, runningRuns: 0, queuedRuns: 0 }

function service(o: { offReason?: string | null; work?: () => WorkCounts } = {}) {
  const f = fakeUpdater()
  const emitted: UpdateState[] = []
  const load = vi.fn(async () => f.u)
  const s = new UpdateService({ current: '0.1.0', offReason: o.offReason ?? null, work: o.work ?? (() => idle), emit: (x) => emitted.push(x), log: quiet, load })
  return { s, f, emitted, load }
}

afterEach(() => vi.useRealTimers())

describe('UpdateService', () => {
  it('an off build never loads electron-updater, never checks and never restarts', async () => {
    vi.useFakeTimers()
    const { s, load } = service({ offReason: 'Development build: updates come from git.' })
    s.start()
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 2)
    expect((await s.check()).phase).toBe('off')
    expect(load).not.toHaveBeenCalled()
    expect(s.restart()).toEqual({ restarting: false, reason: 'No update is ready to install.' })
  })

  it('checks after startup settles, then every few hours, downloading in the background', async () => {
    vi.useFakeTimers()
    const { s, f } = service()
    s.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1)
    expect(f.u.checkForUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.u.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(f.u.autoDownload).toBe(true)
    expect(f.u.autoInstallOnAppQuit).toBe(true)
    expect(f.u.disableDifferentialDownload).toBe(true)
    f.fire('update-not-available')
    expect(s.state().phase).toBe('current')
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS)
    expect(f.u.checkForUpdates).toHaveBeenCalledTimes(2)
    s.stop()
  })

  it('found -> downloading -> ready; a ready update is not checked again', async () => {
    const { s, f, emitted } = service()
    await s.check()
    f.fire('update-available', { version: '0.2.0' })
    f.fire('download-progress', { percent: 50 })
    expect(s.state()).toMatchObject({ phase: 'downloading', next: '0.2.0', percent: 50 })
    f.fire('update-downloaded', { version: '0.2.0' })
    expect(s.state()).toMatchObject({ phase: 'ready', next: '0.2.0' })
    expect(emitted.at(-1)?.phase).toBe('ready')
    await s.check()
    expect(f.u.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('Squirrel failing to stage the downloaded update clears ready, says so plainly and lets the next check retry', async () => {
    const { s, f, emitted } = service()
    await s.check()
    f.fire('update-downloaded', { version: '0.2.0' })
    f.fire('error', new Error('Error: Could not get code signature for running application'))
    expect(s.state()).toMatchObject({ phase: 'error', next: null, error: 'The update did not pass the signature check, so it was not installed.' })
    expect(emitted.at(-1)?.phase).toBe('error')
    expect(s.restart()).toEqual({ restarting: false, reason: 'No update is ready to install.' })
    await s.check()
    expect(f.u.checkForUpdates).toHaveBeenCalledTimes(2)
    f.fire('update-downloaded', { version: '0.2.0' })
    f.fire('error', new Error('SQRLShipItRequest failed: The operation could not be completed'))
    expect(s.state()).toMatchObject({ phase: 'error', error: 'The update could not be prepared to install. Principia tries again later.' })
  })

  it('Restart goes through the app quit (sessions stopped, windows allowed to close) and installs at its end', async () => {
    const f = fakeUpdater()
    const order: string[] = []
    let finish: (() => void) | null = null
    const quit = vi.fn(async (install: () => void) => {
      order.push('quit started')
      finish = install
    })
    f.u.quitAndInstall.mockImplementation(() => order.push('quitAndInstall'))
    const s = new UpdateService({ current: '0.1.0', offReason: null, work: () => idle, emit: () => undefined, log: quiet, load: async () => f.u, quit })
    await s.check()
    f.fire('update-downloaded', { version: '0.2.0' })
    expect(s.restart()).toEqual({ restarting: true })
    await new Promise((res) => setImmediate(res))
    // the native updater is not called before the quit sequence hands over
    expect(order).toEqual(['quit started'])
    expect(f.u.quitAndInstall).not.toHaveBeenCalled()
    finish!()
    expect(order).toEqual(['quit started', 'quitAndInstall'])
    expect(f.u.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('never restarts while agents or runs work, and says why', async () => {
    let work: WorkCounts = { runningSessions: 1, runningRuns: 0, queuedRuns: 0 }
    const { s, f } = service({ work: () => work })
    await s.check()
    f.fire('update-downloaded', { version: '0.2.0' })
    const r = s.restart()
    expect(r.restarting).toBe(false)
    expect(r).toMatchObject({ reason: expect.stringMatching(/1 agent session is still working/) })
    await new Promise((res) => setImmediate(res))
    expect(f.u.quitAndInstall).not.toHaveBeenCalled()
    work = idle
    expect(s.restart()).toEqual({ restarting: true })
    await new Promise((res) => setImmediate(res))
    expect(f.u.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('nothing ready: Restart is refused', async () => {
    const { s } = service()
    await s.check()
    expect(s.restart().restarting).toBe(false)
  })

  it('errors land in plain words and the next check runs', async () => {
    const { s, f } = service()
    f.u.checkForUpdates.mockRejectedValueOnce(new Error('HttpError: 404 latest-mac.yml'))
    await s.check()
    await new Promise((res) => setImmediate(res))
    expect(s.state()).toMatchObject({ phase: 'error', error: 'No release is published yet.' })
    await s.check()
    expect(f.u.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('an updater that fails to load is an error, not a crash, and is retried', async () => {
    const emitted: UpdateState[] = []
    let calls = 0
    const s = new UpdateService({ current: '0.1.0', offReason: null, work: () => idle, emit: (x) => emitted.push(x), log: quiet, load: async () => {
      calls++
      throw new Error('Cannot find module electron-updater')
    } })
    expect((await s.check()).phase).toBe('error')
    await s.check()
    expect(calls).toBe(2)
  })
})
