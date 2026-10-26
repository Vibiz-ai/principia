/**
 * RELEASING.md §4: app updates in main. electron-updater reads latest-mac.yml from the newest GitHub release
 * (electron-builder.yml `publish`), downloads the zip in the background and hands it to Squirrel.Mac, which checks
 * that the update is signed by the same Developer ID before it installs anything.
 *
 * Nothing here restarts the app on its own. Restart is the founder's button, refused while agents work; a ready
 * update otherwise installs on a normal quit (autoInstallOnAppQuit), and that quit already asks before stopping work.
 * The policy (when to check, when Restart is allowed, the words) is in shared/updates.ts.
 */
import type { EngineLogger } from '../shared/engine'
import {
  CHECK_EVERY_MS,
  FIRST_CHECK_DELAY_MS,
  initialUpdateState,
  plainUpdateError,
  restartBlockedBy,
  shouldCheck,
  type RestartResult,
  type UpdateState,
  type WorkCounts
} from '../shared/updates'

/** The part of electron-updater's AppUpdater this uses (a fake in tests). */
export interface Updater {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  disableDifferentialDownload: boolean
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
  /** electron-updater, loaded only when updates are on */
  load?: () => Promise<Updater>
  now?: () => Date
}

export class UpdateService {
  private s: UpdateState
  private updater: Updater | null = null
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

  /** The toast's and Settings' Restart. Never while anything works. */
  restart(): RestartResult {
    if (this.s.phase !== 'ready' || !this.updater) return { restarting: false, reason: 'No update is ready to install.' }
    const blocked = restartBlockedBy(this.o.work())
    if (blocked) return { restarting: false, reason: blocked }
    this.o.log.info('restarting to install update', { from: this.s.current, to: this.s.next })
    // isSilent false, forceRunAfter true: Squirrel.Mac relaunches Principia once the new version is in place
    setImmediate(() => this.updater?.quitAndInstall(false, true))
    return { restarting: true }
  }

  private async ensure(): Promise<Updater | null> {
    if (this.updater) return this.updater
    if (!this.o.load) return null
    this.loading ??= this.o.load().then(
      (u) => {
        this.wire(u)
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

  private wire(u: Updater): void {
    u.autoDownload = true
    u.autoInstallOnAppQuit = true
    // stable artifact names (Principia-arm64.zip in every release) would hand the differential download the new
    // blockmap twice; the zip is small enough to fetch whole
    u.disableDifferentialDownload = true
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
    u.on('update-available', (info) => this.set({ phase: 'downloading', next: info.version, percent: 0, checkedAt: this.now() }))
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
    // a failure after the download finished does not take the ready update away; the error event and the rejected
    // check report the same failure once
    if (this.s.phase === 'ready' || this.s.phase === 'error') return
    const raw = e instanceof Error ? e.message : String(e)
    this.o.log.warn('update check failed', { e: raw.split('\n')[0].slice(0, 300) })
    this.set({ phase: 'error', error: plainUpdateError(raw), percent: null, checkedAt: this.now() })
  }

  private now(): string {
    return (this.o.now?.() ?? new Date()).toISOString()
  }

  private set(patch: Partial<UpdateState>): void {
    this.s = { ...this.s, ...patch }
    this.o.emit(this.s)
  }
}
