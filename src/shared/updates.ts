/**
 * RELEASING.md §4: app updates. The packaged app asks GitHub Releases (example-org/principia) for a newer version on
 * launch and every few hours, downloads it in the background, and says "Update ready". It never restarts by itself:
 * the founder presses Restart, and Restart is refused while agents are working. A ready update also installs on a
 * normal quit (the quit already asks before stopping running work). Pure: the policy main and the renderer share.
 */
export type UpdatePhase = 'off' | 'idle' | 'checking' | 'downloading' | 'ready' | 'current' | 'error'

export interface UpdateState {
  phase: UpdatePhase
  /** the version running now */
  current: string
  /** the newer version found (downloading / ready) */
  next: string | null
  /** download progress 0-100 while downloading */
  percent: number | null
  /** ISO time of the last finished check */
  checkedAt: string | null
  /** plain words, phase 'error' only */
  error: string | null
  /** why updates are off in this build (phase 'off' only) */
  offReason: string | null
}

export type RestartResult = { restarting: true } | { restarting: false; reason: string }

type V = void
export interface UpdatesInvokeMap {
  'updates:state': [V, UpdateState]
  /** check now (Settings › About › Check for updates); answers with the state after the check started */
  'updates:check': [V, UpdateState]
  /** quit and install the ready update; refused (with the reason) while agents are working */
  'updates:restart': [V, RestartResult]
}
export const UPDATES_CHANNELS = ['updates:state', 'updates:check', 'updates:restart'] as const satisfies readonly (keyof UpdatesInvokeMap)[]
export interface UpdatesEventMap {
  'updates:changed': UpdateState
}
export const UPDATES_EVENTS = ['updates:changed'] as const satisfies readonly (keyof UpdatesEventMap)[]

/**
 * RELEASING.md §4.1: where updates come from. The public repository; the stable feed is its
 * releases/latest/download (electron-builder.yml publish.url, checked by a test), which GitHub never points at a
 * pre-release.
 */
export const RELEASE_REPO_URL = 'https://github.com/Vibiz-ai/principia'
export const STABLE_FEED_URL = `${RELEASE_REPO_URL}/releases/latest/download`

export type UpdateFeed = { provider: 'generic'; url: string; channel: 'latest' } | { provider: 'github'; owner: string; repo: string; channel: 'beta' }

export interface UpdateChannelPolicy {
  /** electron-updater `channel`: which manifest it reads (latest-mac.yml / beta-mac.yml) */
  channel: 'latest' | 'beta'
  allowPrerelease: boolean
  /** always false: setting `channel` turns electron-updater's allowDowngrade on, so it is set back after it */
  allowDowngrade: false
  feed: UpdateFeed
}

/**
 * Settings › About › "Get beta updates" (off by default).
 *   off: the stable feed (releases/latest/download/latest-mac.yml): stable releases only. Someone already on a beta
 *        stays on it until a stable version is newer (never a downgrade).
 *   on:  the repository's release list (releases.atom, no API rate limit), newest stable or beta release first, and
 *        its beta-mac.yml. Stable releases carry beta-mac.yml too, so beta users also get every stable release.
 */
export function updateChannelPolicy(beta: boolean): UpdateChannelPolicy {
  if (!beta) return { channel: 'latest', allowPrerelease: false, allowDowngrade: false, feed: { provider: 'generic', url: STABLE_FEED_URL, channel: 'latest' } }
  const [owner, repo] = new URL(RELEASE_REPO_URL).pathname.split('/').filter(Boolean)
  return { channel: 'beta', allowPrerelease: true, allowDowngrade: false, feed: { provider: 'github', owner, repo, channel: 'beta' } }
}

/** A prerelease version (0.3.0-beta.1) is a beta build. */
export function isPrereleaseVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(version)
}

/** The first check waits for startup to settle; then one every four hours. */
export const FIRST_CHECK_DELAY_MS = 30_000
export const CHECK_EVERY_MS = 4 * 60 * 60_000

/**
 * Why this build never updates itself, or null when it does. A development build has nothing to replace; a test
 * instance (HIVE_USER_DATA, HIVE_SMOKE) must never swap the app the founder runs; HIVE_NO_UPDATES=1 turns it off.
 * HIVE_UPDATES_IN_TEST=1 turns checks on in a test instance of a packaged copy (release QA: RELEASING.md §6); it
 * only ever replaces that copy, and only when Restart is pressed.
 */
export function updatesOffReason(o: { packaged: boolean; platform: string; env: Record<string, string | undefined> }): string | null {
  if (!o.packaged) return 'Development build: updates come from git.'
  if (o.platform !== 'darwin') return 'Updates are published for macOS only.'
  if (o.env.HIVE_NO_UPDATES === '1') return 'Turned off on this Mac (HIVE_NO_UPDATES).'
  if ((o.env.HIVE_USER_DATA || o.env.HIVE_SMOKE === '1') && o.env.HIVE_UPDATES_IN_TEST !== '1') return 'Test instance: updates are off so it never replaces the installed app.'
  return null
}

export function initialUpdateState(current: string, offReason: string | null): UpdateState {
  return { phase: offReason ? 'off' : 'idle', current, next: null, percent: null, checkedAt: null, error: null, offReason }
}

/** A timed or manual check starts only when nothing is in flight and no update is waiting to install. */
export function shouldCheck(phase: UpdatePhase): boolean {
  return phase === 'idle' || phase === 'current' || phase === 'error'
}

export interface WorkCounts {
  runningSessions: number
  runningRuns: number
  queuedRuns: number
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

/**
 * Restart is refused while anything works: an agent session, a running or queued workflow run. Returns the reason in
 * plain words, or null when restarting is safe.
 */
export function restartBlockedBy(w: WorkCounts): string | null {
  const runs = w.runningRuns + w.queuedRuns
  if (w.runningSessions + runs === 0) return null
  const parts = [w.runningSessions ? plural(w.runningSessions, 'agent session') : '', runs ? plural(runs, 'run') : ''].filter(Boolean)
  const verb = w.runningSessions + runs === 1 ? 'is' : 'are'
  return `${parts.join(' and ')} ${verb} still working. The update installs when they finish and you restart or quit.`
}

/** The "Update ready" toast shows once per version, never again for a version already offered. */
export function shouldAnnounce(s: UpdateState, announced: string | null): boolean {
  return s.phase === 'ready' && !!s.next && s.next !== announced
}

/** Errors in plain words: no release yet, offline, anything else. Never a stack or a URL with a token. */
export function plainUpdateError(raw: string): string {
  const m = raw.toLowerCase()
  if (/\b404\b|no published versions|cannot find latest|latest-mac\.yml/.test(m)) return 'No release is published yet.'
  if (/enotfound|eai_again|econnrefused|etimedout|network|offline|socket/.test(m)) return 'Could not reach the update server. Principia tries again later.'
  if (/code signature|signature|not signed|codesign/.test(m)) return 'The update did not pass the signature check, so it was not installed.'
  return 'The update check failed. Principia tries again later.'
}

/** Settings › About: one line for the update row. */
export function updateLine(s: UpdateState): string {
  switch (s.phase) {
    case 'off':
      return s.offReason ?? 'Updates are off.'
    case 'idle':
      return 'Checks on launch and every few hours.'
    case 'checking':
      return 'Checking for updates…'
    case 'downloading':
      return `Downloading ${s.next ?? 'the update'}${s.percent != null ? ` (${Math.round(s.percent)}%)` : ''}…`
    case 'ready':
      return `${s.next ?? 'An update'} is ready. Restart to install it.`
    case 'current':
      return 'Principia is up to date.'
    case 'error':
      return s.error ?? 'The update check failed.'
  }
}
