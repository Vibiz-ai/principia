import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  initialUpdateState,
  isPrereleaseVersion,
  plainUpdateError,
  RELEASE_REPO_URL,
  restartBlockedBy,
  shouldAnnounce,
  shouldCheck,
  STABLE_FEED_URL,
  updateChannelPolicy,
  updateLine,
  updatesOffReason,
  type UpdateState
} from './updates'

const env = (e: Record<string, string> = {}) => e
const ready = (next: string): UpdateState => ({ ...initialUpdateState('0.1.0', null), phase: 'ready', next, percent: 100 })

describe('updatesOffReason', () => {
  it('is on only for a packaged macOS build that is not a test instance', () => {
    expect(updatesOffReason({ packaged: true, platform: 'darwin', env: env() })).toBeNull()
    expect(updatesOffReason({ packaged: false, platform: 'darwin', env: env() })).toMatch(/Development build/)
    expect(updatesOffReason({ packaged: true, platform: 'linux', env: env() })).toMatch(/macOS only/)
    expect(updatesOffReason({ packaged: true, platform: 'darwin', env: env({ HIVE_NO_UPDATES: '1' }) })).toMatch(/HIVE_NO_UPDATES/)
  })
  it('a test instance never replaces the installed app unless release QA asks for it', () => {
    expect(updatesOffReason({ packaged: true, platform: 'darwin', env: env({ HIVE_USER_DATA: '/tmp/x' }) })).toMatch(/Test instance/)
    expect(updatesOffReason({ packaged: true, platform: 'darwin', env: env({ HIVE_SMOKE: '1' }) })).toMatch(/Test instance/)
    expect(updatesOffReason({ packaged: true, platform: 'darwin', env: env({ HIVE_USER_DATA: '/tmp/x', HIVE_UPDATES_IN_TEST: '1' }) })).toBeNull()
    // the opt-in never overrides an explicit off
    expect(updatesOffReason({ packaged: true, platform: 'darwin', env: env({ HIVE_NO_UPDATES: '1', HIVE_UPDATES_IN_TEST: '1' }) })).toMatch(/HIVE_NO_UPDATES/)
  })
  it('an off build starts in phase off with its reason', () => {
    const s = initialUpdateState('0.1.0', 'Development build: updates come from git.')
    expect(s.phase).toBe('off')
    expect(updateLine(s)).toBe('Development build: updates come from git.')
  })
})

describe('shouldCheck', () => {
  it('never checks while a check or download runs, a ready update waits, or updates are off', () => {
    expect(shouldCheck('idle')).toBe(true)
    expect(shouldCheck('current')).toBe(true)
    expect(shouldCheck('error')).toBe(true)
    for (const p of ['off', 'checking', 'downloading', 'ready'] as const) expect(shouldCheck(p), p).toBe(false)
  })
})

describe('restartBlockedBy', () => {
  it('allows Restart only when nothing works', () => {
    expect(restartBlockedBy({ runningSessions: 0, runningRuns: 0, queuedRuns: 0 })).toBeNull()
  })
  it('refuses with plain words while agents or runs work', () => {
    expect(restartBlockedBy({ runningSessions: 1, runningRuns: 0, queuedRuns: 0 })).toBe('1 agent session is still working. The update installs when they finish and you restart or quit.')
    expect(restartBlockedBy({ runningSessions: 2, runningRuns: 1, queuedRuns: 1 })).toBe('2 agent sessions and 2 runs are still working. The update installs when they finish and you restart or quit.')
    // a queued run counts: it would start the moment the app comes back
    expect(restartBlockedBy({ runningSessions: 0, runningRuns: 0, queuedRuns: 1 })).toMatch(/^1 run is still working/)
  })
})

describe('shouldAnnounce', () => {
  it('toasts once per ready version', () => {
    expect(shouldAnnounce(ready('0.2.0'), null)).toBe(true)
    expect(shouldAnnounce(ready('0.2.0'), '0.2.0')).toBe(false)
    expect(shouldAnnounce(ready('0.3.0'), '0.2.0')).toBe(true)
    expect(shouldAnnounce({ ...ready('0.2.0'), phase: 'downloading' }, null)).toBe(false)
  })
})

describe('plainUpdateError', () => {
  it('says what happened without stacks or URLs', () => {
    expect(plainUpdateError('HttpError: 404 "method: GET url: https://github.com/x/y/releases/latest/download/latest-mac.yml"')).toBe('No release is published yet.')
    expect(plainUpdateError('net::ERR_INTERNET_DISCONNECTED getaddrinfo ENOTFOUND github.com')).toBe('Could not reach the update server. Principia tries again later.')
    expect(plainUpdateError('Code signature at URL file:///... did not pass validation')).toBe('The update did not pass the signature check, so it was not installed.')
    expect(plainUpdateError('something else at ~/someone/secret')).toBe('The update check failed. Principia tries again later.')
  })
})

describe('updateLine', () => {
  it('reads the phase in one line', () => {
    const s = initialUpdateState('0.1.0', null)
    expect(updateLine(s)).toBe('Checks on launch and every few hours.')
    expect(updateLine({ ...s, phase: 'downloading', next: '0.2.0', percent: 41.6 })).toBe('Downloading 0.2.0 (42%)…')
    expect(updateLine(ready('0.2.0'))).toBe('0.2.0 is ready. Restart to install it.')
    expect(updateLine({ ...s, phase: 'current' })).toBe('Principia is up to date.')
  })
})

describe('updateChannelPolicy (Get beta updates)', () => {
  it('off by default: the stable feed through releases/latest/download, no prereleases, never a downgrade', () => {
    expect(updateChannelPolicy(false)).toEqual({
      channel: 'latest',
      allowPrerelease: false,
      allowDowngrade: false,
      feed: { provider: 'generic', url: `${RELEASE_REPO_URL}/releases/latest/download`, channel: 'latest' }
    })
  })

  it('on: the repository release list (pre-releases included) and beta-mac.yml, still never a downgrade', () => {
    expect(updateChannelPolicy(true)).toEqual({
      channel: 'beta',
      allowPrerelease: true,
      allowDowngrade: false,
      // the public export rewrites the organisation's name everywhere but in github.com links: derive it from the link
      feed: { provider: 'github', owner: new URL(RELEASE_REPO_URL).pathname.split('/')[1], repo: 'principia', channel: 'beta' }
    })
    expect(RELEASE_REPO_URL).toMatch(/^https:\/\/github\.com\/[^/]+\/principia$/)
  })

  it('the stable feed is the one electron-builder.yml writes into the app (app-update.yml)', () => {
    const yml = fs.readFileSync(path.join(__dirname, '../../electron-builder.yml'), 'utf8')
    expect(/^\s+url:\s*(\S+)\s*$/m.exec(yml)?.[1]).toBe(STABLE_FEED_URL)
  })

  it('a prerelease version is a beta build', () => {
    expect(isPrereleaseVersion('0.3.0-beta.1')).toBe(true)
    expect(isPrereleaseVersion('1.0.0-rc.1')).toBe(true)
    expect(isPrereleaseVersion('0.3.0')).toBe(false)
  })
})
