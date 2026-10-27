/**
 * RELEASING.md §4: app updates in main. electron-updater reads latest-mac.yml from the newest GitHub release
 * (electron-builder.yml `publish`), downloads the zip in the background and hands it to Squirrel.Mac, which checks
 * that the update is signed by the same Developer ID before it installs anything.
 *
 * Nothing here restarts the app on its own. Restart is the founder's button, refused while agents work; a ready
 * update otherwise installs on a normal quit (autoInstallOnAppQuit), and that quit already asks before stopping work.
 * The policy (when to check, when Restart is allowed, the words) is in shared/updates.ts.
 */
import { execFile } from 'node:child_process'
import path from 'node:path'
import type { EngineLogger } from '../shared/engine'
import {
  CHECK_EVERY_MS,
  cannotSelfUpdate,
  FIRST_CHECK_DELAY_MS,
  initialUpdateState,
  plainUpdateError,
  restartBlockedBy,
  shouldCheck,
  updateChannelPolicy,
  type RestartResult,
  type UpdateFeed,
  type UpdateState,
  type WorkCounts
} from '../shared/updates'

/** The part of electron-updater's AppUpdater this uses (a fake in tests). */
export interface Updater {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  disableDifferentialDownload: boolean
  /** RELEASING.md §4.1: the channel's manifest (latest-mac.yml / beta-mac.yml); setting it turns allowDowngrade on */
  channel: string | null
  allowPrerelease: boolean
  allowDowngrade: boolean
  setFeedURL(feed: UpdateFeed): void
  logger: unknown
  on(event: 'checking-for-update' | 'update-not-available', fn: () => void): unknown
  on(event: 'update-available' | 'update-downloaded', fn: (info: { version: string }) => void): unknown
  on(event: 'download-progress', fn: (p: { percent: number }) => void): unknown
  on(event: 'error', fn: (e: Error) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdateServiceOptions {
  current: string
  /** shared/updates.ts updatesOffReason(); non-null = this build never loads the updater */
  offReason: string | null
  /** what is working right now (sessions, runs): Restart waits for none */
  work: () => WorkCounts
  emit: (s: UpdateState) => void
  log: EngineLogger
  /**
   * The app's normal quit (Hive.requestQuit: confirm if anything works, stop sessions and the engine, let windows
   * close), which calls `install` instead of app.quit() once everything is down. Without it the native updater's
   * window close is refused by the hide-to-menu-bar handler and Restart only hides Principia.
   */
  quit?: (install: () => void) => Promise<void>
  /** electron-updater, loaded only when updates are on */
  load?: () => Promise<Updater>
  /**
   * True when this build cannot install updates itself (an ad-hoc signed preview, shared/updates.ts cannotSelfUpdate):
   * checks still run, but a newer version is only announced (phase 'available', download it from the website) and
   * never downloaded. Asked once, when the updater loads.
   */
  manualInstall?: () => Promise<boolean>
  /** Settings › About › "Get beta updates" (Settings.betaUpdates, off by default) */
  beta?: () => boolean
  now?: () => Date
}

/**
 * Whether the running app is signed without a Developer ID (an ad-hoc preview build), from `codesign -dv` of the .app
 * that contains `execPath` (…/Principia.app/Contents/MacOS/Principia). codesign failing to answer = assume it can.
 */
export function appCannotSelfUpdate(execPath: string, run: typeof execFile = execFile): Promise<boolean> {
  const bundle = path.resolve(execPath, '..', '..', '..')
  return new Promise((resolve) => {
    run('/usr/bin/codesign', ['-dv', '--verbose=2', bundle], { timeout: 10_000 }, (err, stdout, stderr) => {
      const info = `${String(stdout ?? '')}\n${String(stderr ?? '')}`
      // "code object is not signed at all" comes with a non-zero exit; any other failure answers false
      resolve(cannotSelfUpdate(info) || (!!err && /not signed at all/.test(String(err.message))))
    })
  })
}

export class UpdateService {
  private s: UpdateState
  private updater: Updater | null = null
  private manual = false
  private loading: Promise<Updater | null> | null = null
  private timers: NodeJS.Timeout[] = []

  constructor(private readonly o: UpdateServiceOptions) {
    this.s = initialUpdateState(o.current, o.offReason)
  }

  state(): UpdateState {
    return this.s
  }

  /** First check once startup settled, then every few hours. */
  start(): void {
    if (this.s.phase === 'off') {
      this.o.log.info('updates off', { reason: this.s.offReason })
      return
    }
    const first = setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS)
    const every = setInterval(() => void this.check(), CHECK_EVERY_MS)
    first.unref?.()
    every.unref?.()
    this.timers.push(first, every)
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
  }

  /** Settings › Check for updates and the timers. Answers with the state once the check started. */
  async check(): Promise<UpdateState> {
    if (!shouldCheck(this.s.phase)) return this.s
    const u = await this.ensure()
    if (!u) return this.s
    this.set({ phase: 'checking', error: null })
    // the outcome arrives as events; the promise only carries errors the events may not
    u.checkForUpdates().catch((e: unknown) => this.failed(e))
    return this.s
  }

  /**
   * Settings › About › "Get beta updates" changed: the next check reads the other channel. Checks right away, unless a
   * check or download is in flight or an update is already waiting (that one still installs; the next check after it
   * uses the new channel).
   */
  setBeta(on: boolean): void {
    if (this.updater) this.applyChannel(this.updater, on)
    if (this.s.phase !== 'off' && shouldCheck(this.s.phase)) void this.check()
  }

  private applyChannel(u: Updater, beta: boolean): void {
    const p = updateChannelPolicy(beta)
    u.setFeedURL(p.feed)
    u.channel = p.channel
    u.allowPrerelease = p.allowPrerelease
    // after `channel`: electron-updater's channel setter turns allowDowngrade on. Leaving beta never downgrades.
    u.allowDowngrade = p.allowDowngrade
    this.o.log.info('update channel', { channel: p.channel })
  }

  /** The toast's and Settings' Restart. Never while anything works. */
  restart(): RestartResult {
    if (this.s.phase !== 'ready' || !this.updater) return { restarting: false, reason: 'No update is ready to install.' }
    const blocked = restartBlockedBy(this.o.work())
    if (blocked) return { restarting: false, reason: blocked }
    this.o.log.info('restarting to install update', { from: this.s.current, to: this.s.next })
    // isSilent false, forceRunAfter true: Squirrel.Mac relaunches Principia once the new version is in place
    const install = (): void => this.updater?.quitAndInstall(false, true)
    if (this.o.quit) void this.o.quit(install).catch((e: unknown) => this.o.log.error('restart to update failed', { e: String(e) }))
    else setImmediate(install)
    return { restarting: true }
  }

  private async ensure(): Promise<Updater | null> {
    if (this.updater) return this.updater
    if (!this.o.load) return null
    const load = this.o.load
    this.loading ??= Promise.all([load(), this.o.manualInstall?.().catch(() => false) ?? false]).then(
      ([u, manual]) => {
        this.wire(u, manual)
        this.updater = u
        return u
      },
      (e: unknown) => {
        this.loading = null
        this.o.log.error('updater unavailable', { e: String(e) })
        this.set({ phase: 'error', error: 'The updater could not start. Principia tries again later.' })
        return null
      }
    )
    return this.loading
  }

  private wire(u: Updater, manual = false): void {
    this.manual = manual
    // a build that cannot install updates never downloads one: it says a new version is out (phase 'available')
    u.autoDownload = !manual
    u.autoInstallOnAppQuit = !manual
    if (manual) this.o.log.info('updates: this build cannot install updates itself; new versions are announced only')
    // stable artifact names (Principia-arm64.zip in every release) would hand the differential download the new
    // blockmap twice; the zip is small enough to fetch whole
    u.disableDifferentialDownload = true
    this.applyChannel(u, this.o.beta?.() ?? false)
    const log = this.o.log
    // one line each: electron-updater's errors carry stacks and the server's response headers
    const line = (m: unknown): string => `updater: ${String(m).split('\n')[0].slice(0, 300)}`
    u.logger = {
      info: (m: unknown) => log.info(line(m)),
      warn: (m: unknown) => log.warn(line(m)),
      error: (m: unknown) => log.error(line(m)),
      debug: () => undefined
    }
    u.on('checking-for-update', () => this.set({ phase: 'checking', error: null }))
    u.on('update-not-available', () => this.set({ phase: 'current', next: null, percent: null, checkedAt: this.now() }))
    u.on('update-available', (info) =>
      this.set(this.manual ? { phase: 'available', next: info.version, percent: null, checkedAt: this.now() } : { phase: 'downloading', next: info.version, percent: 0, checkedAt: this.now() })
    )
    u.on('download-progress', (p) => {
      if (this.s.phase === 'downloading') this.set({ percent: p.percent })
    })
    u.on('update-downloaded', (info) => {
      log.info('update ready', { version: info.version })
      this.set({ phase: 'ready', next: info.version, percent: 100 })
    })
    u.on('error', (e) => this.failed(e))
  }

  private failed(e: unknown): void {
    // the error event and the rejected check report the same failure once
    if (this.s.phase === 'error') return
    const raw = e instanceof Error ? e.message : String(e)
    // No check runs while an update is ready, so an error then is Squirrel.Mac failing to stage or validate the
    // download (electron-updater reports update-downloaded before Squirrel takes it). Restart could not install
    // it: leave 'ready' so the next check fetches it again.
    const staging = this.s.phase === 'ready'
    this.o.log.warn(staging ? 'update could not be staged' : 'update check failed', { e: raw.split('\n')[0].slice(0, 300) })
    const plain = plainUpdateError(raw)
    const error = staging && plain === plainUpdateError('') ? 'The update could not be prepared to install. Principia tries again later.' : plain
    this.set({ phase: 'error', error, next: staging ? null : this.s.next, percent: null, checkedAt: this.now() })
  }

  private now(): string {
    return (this.o.now?.() ?? new Date()).toISOString()
  }

  private set(patch: Partial<UpdateState>): void {
    this.s = { ...this.s, ...patch }
    this.o.emit(this.s)
  }
}
