import { describe, expect, it } from 'vitest'
import { baseChildEnv, isInheritedMarker, mergePath, parseEnvDump } from '../loginEnv'
import { slotLabel } from '../engine/scheduler'
import { buildChildEnv } from '../childEnv'
import { maskSecret, parseEnvText } from '../envParse'
import { classify, isIgnoredRel } from '../artifactKinds'
import { isInside } from '../pathGuard'
import { TailBuffer } from '../tailBuffer'
import { nextFireLabel, shortDuration, trayMenuModel, trayTitle } from '../trayModel'
import type { StatusSnapshot } from '../../shared/types'

describe('loginEnv (SPEC A14)', () => {
  it('parses env -0 output between markers and drops shell noise', () => {
    const out =
      'motd junk\n__HIVE_ENV_START__PATH=/a:/b\0HOME=/Users/x\0PWD=/tmp\0SHLVL=2\0_=/usr/bin/env\0OLDPWD=/\0TERM_PROGRAM=iTerm\0CLAUDE_CONFIG_DIR=/c\0MULTI=line1\nline2\0__HIVE_ENV_END__trailing'
    const env = parseEnvDump(out)!
    expect(env).toEqual({ PATH: '/a:/b', HOME: '/Users/x', CLAUDE_CONFIG_DIR: '/c', MULTI: 'line1\nline2' })
  })
  it('returns null without markers', () => {
    expect(parseEnvDump('nothing here')).toBeNull()
  })
  it('merges PATH in order without duplicates', () => {
    expect(mergePath('/a:/b', '/b:/c', null, '/a:/d')).toBe('/a:/b:/c:/d')
  })
  it('base child env strips Electron internals and sets terminal vars', () => {
    const env = baseChildEnv({ PATH: '/x', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x', VITE_DEV: '1', HOME: '/h' })
    expect(env).toEqual({ PATH: '/x', HOME: '/h', TERM: 'xterm-256color', COLORTERM: 'truecolor', HIVE: '1' })
  })
  it('strips a parent Claude Code session markers but keeps user Claude config', () => {
    const env = baseChildEnv({
      PATH: '/x',
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/sock',
      CLAUDE_CODE_MESSAGING_TOKEN: 'tok',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CONFIG_DIR: '/cfg',
      CLAUDE_CODE_USE_BEDROCK: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
      npm_lifecycle_event: 'dev',
      HIVE_RESOLVING_ENV: '1'
    })
    expect(env).toEqual({
      PATH: '/x',
      CLAUDE_CONFIG_DIR: '/cfg',
      CLAUDE_CODE_USE_BEDROCK: '1',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      HIVE: '1'
    })
    expect(isInheritedMarker('CLAUDE_CODE_MESSAGING_TOKEN')).toBe(true)
    expect(isInheritedMarker('ANTHROPIC_API_KEY')).toBe(false)
  })
})

describe('catch-up slot label (SPEC 8.2)', () => {
  const when = { kind: 'cron' as const, cron: '0 9 * * *', tz: 'Europe/Madrid' }
  it('formats the slot in the schedule tz as HH:mm on the same day', () => {
    expect(slotLabel(new Date('2026-10-15T07:00:00.000Z'), when, new Date('2026-10-15T12:00:00.000Z'))).toBe('09:00')
  })
  it('adds the weekday when the slot is not today', () => {
    expect(slotLabel(new Date('2026-10-14T07:00:00.000Z'), when, new Date('2026-10-15T08:00:00.000Z'))).toBe('Wed 09:00')
  })
})

describe('child env (CONTRACT §2.2, SPEC A6)', () => {
  const base = { PATH: '/bin', ANTHROPIC_API_KEY: 'from-shell' }
  const secrets = { ANTHROPIC_API_KEY: 'sk-ant-1', OPENAI_API_KEY: 'sk-oai', FAL_KEY: 'fal' }
  const hive = { ARTIFACTS_DIR: '/a/', HIVE_SESSION_ID: 's_1' }
  it('claude never receives Anthropic auth vars unless useApiKeyAuth', () => {
    const env = buildChildEnv({ base, secrets, profile: { adapter: 'claude', useApiKeyAuth: false }, hive })
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBe('sk-oai')
    expect(env.FAL_KEY).toBe('fal')
    expect(env.ARTIFACTS_DIR).toBe('/a/')
  })
  it('useApiKeyAuth keeps them', () => {
    const env = buildChildEnv({ base, secrets, profile: { adapter: 'claude', useApiKeyAuth: true }, hive })
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-1')
  })
  it('codex loses OPENAI_API_KEY, shell keeps everything', () => {
    expect(buildChildEnv({ base, secrets, profile: { adapter: 'codex', useApiKeyAuth: false }, hive }).OPENAI_API_KEY).toBeUndefined()
    const sh = buildChildEnv({ base, secrets, profile: { adapter: 'shell', useApiKeyAuth: false }, hive })
    expect(sh.OPENAI_API_KEY).toBe('sk-oai')
    expect(sh.ANTHROPIC_API_KEY).toBe('sk-ant-1')
  })
  it('honours SpawnSpec.stripEnv and lets Hive vars win', () => {
    const env = buildChildEnv({
      base,
      specEnv: { ARTIFACTS_DIR: '/wrong', X: '1' },
      secrets,
      stripEnv: ['FAL_KEY'],
      profile: { adapter: 'gemini', useApiKeyAuth: false },
      hive
    })
    expect(env.FAL_KEY).toBeUndefined()
    expect(env.X).toBe('1')
    expect(env.ARTIFACTS_DIR).toBe('/a/')
  })
})

describe('.env parsing (SPEC K4)', () => {
  it('parses 5 lines with one comment into 4 entries', () => {
    const text = `# my keys\nexport OPENAI_API_KEY="sk-abc123456789"\nFAL_KEY='fal-xyz'\nSTRIPE_SECRET_KEY=sk_live_1234 # prod\nREPLICATE_API_TOKEN=r8_token\n`
    const e = parseEnvText(text)
    expect(e.map((x) => x.name)).toEqual(['OPENAI_API_KEY', 'FAL_KEY', 'STRIPE_SECRET_KEY', 'REPLICATE_API_TOKEN'])
    expect(e.find((x) => x.name === 'STRIPE_SECRET_KEY')!.value).toBe('sk_live_1234')
    expect(e.find((x) => x.name === 'OPENAI_API_KEY')!.value).toBe('sk-abc123456789')
    expect(e.every((x) => x.valid)).toBe(true)
  })
  it('flags invalid names and empty values', () => {
    const e = parseEnvText('lower_case=1\nEMPTY=\n')
    expect(e.map((x) => x.valid)).toEqual([false, false])
  })
  it('handles multi-line double-quoted values', () => {
    const e = parseEnvText('PEM="-----BEGIN\nabc\n-----END"\nNEXT=1')
    expect(e[0].value).toBe('-----BEGIN\nabc\n-----END')
    expect(e[1].name).toBe('NEXT')
  })
  it('masks without revealing more than the last 4 chars', () => {
    expect(maskSecret('sk-abcdefghijklmnop1a2b')).toBe('sk-…1a2b')
    expect(maskSecret('short')).toBe('••••')
    expect(maskSecret('abcdefghijklmnop')).toBe('…mnop')
  })
})

describe('artifacts', () => {
  it('classifies by extension', () => {
    expect(classify('/x/a.PNG')).toEqual({ kind: 'image', mime: 'image/png' })
    expect(classify('b.mov').kind).toBe('video')
    expect(classify('c.md').kind).toBe('markdown')
    expect(classify('d.html').kind).toBe('html')
    expect(classify('e.ts').kind).toBe('code')
    expect(classify('f.pdf').kind).toBe('pdf')
    expect(classify('g.m4a').kind).toBe('audio')
    expect(classify('noext')).toEqual({ kind: 'other', mime: 'application/octet-stream' })
  })
  it('ignores dotfiles, node_modules', () => {
    expect(isIgnoredRel('r_1/.DS_Store')).toBe(true)
    expect(isIgnoredRel('r_1/node_modules/x.js')).toBe(true)
    expect(isIgnoredRel('r_1/.git/HEAD')).toBe(true)
    expect(isIgnoredRel('r_1/out/a.png')).toBe(false)
  })
  it('path confinement', () => {
    expect(isInside('/root/a/b', '/root')).toBe(true)
    expect(isInside('/root', '/root')).toBe(true)
    expect(isInside('/root2/a', '/root')).toBe(false)
    expect(isInside('/root/../etc', '/root')).toBe(false)
  })
})

describe('TailBuffer', () => {
  it('keeps at most max chars, cut at a line start', () => {
    const t = new TailBuffer(100)
    for (let i = 0; i < 100; i++) t.append(`line ${i}\n`)
    const s = t.toString()
    expect(s.length).toBeLessThanOrEqual(100)
    expect(s.endsWith('line 99\n')).toBe(true)
    expect(s.startsWith('line ')).toBe(true)
  })
})

describe('tray (SPEC A12)', () => {
  const base: StatusSnapshot = {
    runningSessions: 0,
    runningRuns: 0,
    queuedRuns: 0,
    schedulesPaused: false,
    nextFire: null,
    last24h: { passed: 0, failed: 0 },
    unseenFailures: 0
  }
  it('title: empty idle, ● N running, ✕ unseen, ⏸ paused', () => {
    expect(trayTitle(base)).toBe('')
    expect(trayTitle({ ...base, runningSessions: 2, runningRuns: 1 })).toBe('● 3')
    expect(trayTitle({ ...base, runningSessions: 1, unseenFailures: 2 })).toBe('● 1 ✕')
    expect(trayTitle({ ...base, schedulesPaused: true })).toBe('⏸')
  })
  it('menu has the exact A12 structure and no Run Workflow / Launch at Login', () => {
    const now = new Date('2026-10-15T09:00:00Z')
    const items = trayMenuModel({
      status: { ...base, runningSessions: 1, unseenFailures: 1, nextFire: { scheduleId: 'sch_1', name: 'Daily ads', at: '2026-10-15T09:41:00Z' } },
      running: [{ kind: 'session', id: 's_1', label: 'example-project · Claude', startedAt: '2026-10-15T08:46:00Z' }],
      lastFailure: { runId: 'r_1', title: 'Daily ads', endedAt: '2026-10-15T06:02:00Z' },
      recentRepos: [{ id: 'repo_1', name: 'example-project' }],
      now
    })
    const labels = items.map((i) => i.label ?? '---')
    expect(labels[0]).toBe('Open Hive')
    expect(labels).toContain('Running')
    expect(labels.some((l) => l.includes('example-project · Claude · 14m'))).toBe(true)
    expect(labels.some((l) => l.startsWith('Last: ✕ Daily ads failed'))).toBe(true)
    expect(labels).toContain('Next: Daily ads in 41m')
    expect(labels).toContain('New Session')
    expect(labels).toContain('Pause All Schedules')
    expect(labels[labels.length - 1]).toBe('Quit Hive')
    expect(labels.join('|')).not.toMatch(/Run Workflow|Launch at Login/)
    const ns = items.find((i) => i.label === 'New Session')!
    expect(ns.submenu![0].action).toEqual({ kind: 'newSession', repoId: 'repo_1' })
  })
  it('no Last line when failures are seen', () => {
    const items = trayMenuModel({ status: base, running: [], lastFailure: null, recentRepos: [], now: new Date() })
    expect(items.some((i) => i.label?.startsWith('Last:'))).toBe(false)
    expect(items.some((i) => i.label === 'Nothing running')).toBe(true)
  })
  it('durations and next label', () => {
    expect(shortDuration(14 * 60_000)).toBe('14m')
    expect(shortDuration(125 * 60_000)).toBe('2h 5m')
    expect(shortDuration(3 * 86400_000)).toBe('3d')
    expect(nextFireLabel(null, true, new Date())).toBe('Schedules paused')
  })
})
