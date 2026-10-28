/** CONTRACT §13: spawn tagging + reaper. Pure tree math on a ps fixture, a fake process table, and real fake processes. */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Reaper, attachEnv, collectTree, findLeftovers, parseEtime, parsePs, spawnIdOf, systemProcessTable, type ProcRow, type ProcessTable } from '../reaper'

const UD = '/Users/u/Library/Application Support/Hive'
const tag = (id: string, ud = UD): string => `PATH=/usr/bin HIVE_SPAWN_ID=${id} HIVE_USER_DATA=${ud} TERM=xterm-256color`

// pid ppid pgid etime command   (self = Hive = 500)
const PS = `
    1     0     1 10-01:02:03 /sbin/launchd
  400     1   400    09:00:00 /bin/zsh -l
  500   400   500    02:00:00 /Applications/Hive.app/Contents/MacOS/Hive
  501   500   500    01:59:00 /Applications/Hive.app/Contents/Frameworks/Hive Helper (Renderer).app/Contents/MacOS/Hive Helper (Renderer)
  600   500   600       10:00 /Users/u/.local/bin/claude --settings x
  601   600   600       09:00 /bin/zsh -c npm run dev
  602   601   600       08:59 node /x/node_modules/.bin/vite
  603     1   603       08:00 node server.js
  604   603   603       07:59 /bin/sleep 600
  700     1   700    05:00:00 node old-dev-server.js
  701   700   700    05:00:00 /usr/bin/python3 -m http.server
  800     1   800       01:00 node other.js
  900   400   900       03:00 /usr/bin/vim notes.md
`
// with -E the env follows the command; macOS hides it for platform binaries (/bin/sleep, /bin/zsh)
const PS_E = `
  500 /Applications/Hive.app/Contents/MacOS/Hive HIVE_USER_DATA=${UD} PATH=/usr/bin
  600 /Users/u/.local/bin/claude --settings x ${tag('s_aaa')}
  602 node /x/node_modules/.bin/vite ${tag('s_aaa')}
  603 node server.js ${tag('s_aaa')}
  700 node old-dev-server.js ${tag('s_old')}
  701 /usr/bin/python3 -m http.server ${tag('s_old')}
  800 node other.js ${tag('s_x', '/tmp/other hive')}
  900 /usr/bin/vim notes.md PATH=/usr/bin
`
const rows = (): ProcRow[] => attachEnv(parsePs(PS), PS_E)
const pids = (l: ProcRow[]): number[] => l.map((r) => r.pid).sort((a, b) => a - b)

describe('ps parsing', () => {
  it('parses etime and rows, and joins the env after the command', () => {
    expect(parseEtime('07:59')).toBe((7 * 60 + 59) * 1000)
    expect(parseEtime('01:59:00')).toBe(7140_000)
    expect(parseEtime('10-01:02:03')).toBe(((10 * 24 + 1) * 3600 + 2 * 60 + 3) * 1000)
    const r = rows()
    expect(r).toHaveLength(13)
    const helper = r.find((x) => x.pid === 501)!
    expect(helper.command).toContain('Hive Helper (Renderer)')
    expect(spawnIdOf(r.find((x) => x.pid === 603)!.env)).toBe('s_aaa')
    expect(r.find((x) => x.pid === 604)!.env).toBeNull() // hidden by macOS
    expect(spawnIdOf(r.find((x) => x.pid === 900)!.env)).toBeNull()
  })
})

describe('collectTree', () => {
  it("an owner's tree = its group + descendants + env-tagged escapees and their groups", () => {
    const t = collectTree(rows(), { spawnIds: ['s_aaa'], userData: UD, rootPids: [600], selfPid: 500 })
    expect(pids(t)).toEqual([600, 601, 602, 603, 604])
  })

  it('finds the tree even after the leader died (group id = its pid)', () => {
    const r = rows().filter((x) => x.pid !== 600)
    const t = collectTree(r, { spawnIds: ['s_aaa'], userData: UD, rootPids: [600], selfPid: 500 })
    expect(pids(t)).toEqual([601, 602, 603, 604])
  })

  it('known pids (pre-kill snapshot / sampler) count only while the command still matches', () => {
    const t = collectTree(rows(), { spawnIds: [], userData: UD, known: [{ pid: 900, command: '/usr/bin/vim notes.md' }, { pid: 401, command: 'gone' }], selfPid: 500 })
    expect(pids(t)).toEqual([900])
    const reused = collectTree(rows(), { spawnIds: [], userData: UD, known: [{ pid: 900, command: 'node dev' }], selfPid: 500 })
    expect(reused).toEqual([])
  })

  it('never touches Hive, its ancestors, its group, launchd, or another Hive’s tags', () => {
    const all = collectTree(rows(), { spawnIds: 'any', userData: UD, rootPids: [500, 400, 1], selfPid: 500 })
    expect(pids(all)).toEqual([600, 601, 602, 603, 604, 700, 701])
  })
})

describe('findLeftovers', () => {
  it('tagged processes of this userData whose owner is gone; children fold into their parent', () => {
    const l = findLeftovers(rows(), { userData: UD, live: new Set(['s_aaa']), selfPid: 500 })
    expect(pids(l)).toEqual([700])
  })
  it('descendants of the running Hive are never leftovers, even with an unknown owner', () => {
    const l = findLeftovers(rows(), { userData: UD, live: new Set(), selfPid: 500 })
    // 600/602 descend from Hive (500); 603 escaped to launchd so it is a leftover once s_aaa is not live
    expect(pids(l)).toEqual([603, 700])
  })

  it("a dev copy started from an agent pane never lists its own launcher, helpers or untagged processes", () => {
    // PR-27: `HIVE_USER_DATA=/tmp/dev node electron .` run from pane s_pane of the installed app. The launcher and the
    // dev Electron (2100) inherit s_pane; crashpad re-parents to launchd but keeps the env; 2300 is a real leftover.
    const DEV = '/tmp/dev hive'
    const ps = `
    1     0     1 10-01:02:03 /sbin/launchd
 2000   400  2000       05:00 node /x/node_modules/.bin/electron .
 2100  2000  2000       04:59 /x/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .
 2101  2100  2000       04:59 /x/Electron Helper (Renderer)
 2200     1  2200       04:59 /x/Electron.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler
 2300     1  2300       30:00 node old-dev.js
 2400     1  2400       30:00 node untagged.js
`
    const env = `
 2000 node /x/node_modules/.bin/electron . ${tag('s_pane', DEV)}
 2100 /x/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . ${tag('s_pane', DEV)}
 2101 /x/Electron Helper (Renderer) ${tag('s_pane', DEV)}
 2200 /x/Electron.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler ${tag('s_pane', DEV)}
 2300 node old-dev.js ${tag('s_gone', DEV)}
 2400 node untagged.js HIVE_USER_DATA=${DEV} PATH=/usr/bin
`
    const r = attachEnv(parsePs(ps), env)
    expect(pids(findLeftovers(r, { userData: DEV, live: new Set(), selfPid: 2100 }))).toEqual([2300])
    // the inherited tag also counts when macOS hides Hive's own env from ps
    const hidden = r.map((x) => (x.pid === 2100 ? { ...x, env: null } : x))
    expect(pids(findLeftovers(hidden, { userData: DEV, live: new Set(), selfPid: 2100, selfSpawnId: 's_pane' }))).toEqual([2300])
  })

  it('Reaper.stopLeftovers never signals the dev copy’s own launcher or crashpad', async () => {
    const DEV = '/tmp/dev hive'
    const own = (pid: number, ppid: number, pgid: number, command: string): ProcRow => ({ pid, ppid, pgid, etimeMs: 1000, command, env: ` ${tag('s_pane', DEV)} ` })
    const t = fakeTable([own(2000, 400, 2000, 'node electron .'), own(2200, 1, 2200, 'chrome_crashpad_handler'), { ...own(2300, 1, 2300, 'node old.js'), env: ` ${tag('s_gone', DEV)} ` }])
    const reaper = new Reaper({ userData: DEV, table: t, selfPid: 2100, selfSpawnId: 's_pane', graceMs: 50, sampleMs: 0 })
    expect((await reaper.leftovers(new Set())).map((l) => l.pid)).toEqual([2300])
    expect(await reaper.stopLeftovers([2000, 2200, 2300], new Set())).toBe(1)
    expect(t.signals.map(([p]) => Math.abs(p))).not.toContain(2000)
    expect(t.signals.map(([p]) => Math.abs(p))).not.toContain(2200)
    expect(t.alive.has(2000) && t.alive.has(2200) && !t.alive.has(2300)).toBe(true)
  })
})

/** A process table in memory: signals record and (optionally) kill. */
function fakeTable(initial: ProcRow[], stubborn = new Set<number>()): ProcessTable & { signals: [number, string][]; alive: Set<number> } {
  const alive = new Set(initial.map((r) => r.pid))
  const signals: [number, string][] = []
  const cur = (): ProcRow[] => initial.filter((r) => alive.has(r.pid))
  return {
    signals,
    alive,
    snapshot: async () => cur(),
    snapshotSync: () => cur(),
    signal(pid, sig) {
      signals.push([pid, sig])
      const kill = (p: number): void => {
        if (sig === 'SIGKILL' || !stubborn.has(p)) alive.delete(p)
      }
      if (pid < 0) for (const r of initial) r.pgid === -pid && kill(r.pid)
      else kill(pid)
      return true
    },
    cwds: async (p) => new Map(p.map((x) => [x, `/work/${x}`]))
  }
}

describe('Reaper (fake process table)', () => {
  it('reap: SIGTERM the tree and its groups, SIGKILL what survives the grace', async () => {
    const t = fakeTable(rows(), new Set([603]))
    const r = new Reaper({ userData: UD, table: t, selfPid: 500, graceMs: 50, sampleMs: 0 })
    const n = await r.reap('s_aaa', { rootPids: [600] })
    expect(n).toBe(5)
    expect(t.signals).toContainEqual([-600, 'SIGTERM'])
    expect(t.signals).toContainEqual([-603, 'SIGTERM'])
    expect(t.signals).toContainEqual([603, 'SIGKILL'])
    expect([...t.alive].sort((a, b) => a - b)).toEqual([1, 400, 500, 501, 700, 701, 800, 900])
  })

  it('tag() names the owner and this userData', () => {
    const r = new Reaper({ userData: UD, table: fakeTable([]), selfPid: 500, sampleMs: 0 })
    expect(r.tag('st_1')).toEqual({ HIVE_SPAWN_ID: 'st_1', HIVE_USER_DATA: UD })
  })

  it('reapAllSync (quit) kills every tagged tree of this userData only', () => {
    const t = fakeTable(rows())
    const r = new Reaper({ userData: UD, table: t, selfPid: 500, sampleMs: 0 })
    expect(r.reapAllSync()).toBe(7)
    expect([...t.alive].sort((a, b) => a - b)).toEqual([1, 400, 500, 501, 800, 900])
  })

  it('leftovers list command, cwd and age; stop re-verifies and skips live owners', async () => {
    const t = fakeTable(rows())
    const r = new Reaper({ userData: UD, table: t, selfPid: 500, graceMs: 20, sampleMs: 0 })
    const l = await r.leftovers(new Set(['s_aaa']))
    expect(l).toEqual([{ pid: 700, spawnId: 's_old', command: 'node old-dev-server.js', cwd: '/work/700', etimeMs: 5 * 3600_000 }])
    expect(await r.stopLeftovers([602, 900], new Set(['s_aaa']))).toBe(0)
    expect(await r.stopLeftovers([700], new Set(['s_aaa']))).toBe(2)
    expect(t.alive.has(700) || t.alive.has(701)).toBe(false)
    expect(t.alive.has(602)).toBe(true)
  })

  it('the sampler remembers descendants so a hidden escapee is reaped after its parent re-parented it', async () => {
    // st_1 leads 1000; its child 1001 (platform binary, env hidden) later escapes to its own group under launchd
    const before = attachEnv(parsePs(`  1000   500  1000   00:10 /bin/sh -c x\n  1001  1000  1000   00:09 /bin/sleep 600\n  500 400 500 01:00 hive\n  400 1 400 01:00 zsh\n`), '')
    const t = fakeTable(before)
    const r = new Reaper({ userData: UD, table: t, selfPid: 500, graceMs: 20, sampleMs: 0 })
    r.register('st_1', 1000)
    await r.sample()
    // leader exits; 1001 setsid()s away and is re-parented to launchd
    t.alive.delete(1000)
    const moved = before.find((x) => x.pid === 1001)!
    moved.ppid = 1
    moved.pgid = 1001
    expect(await r.reap('st_1', { rootPids: [1000] })).toBe(1)
    expect(t.alive.has(1001)).toBe(false)
  })
})

// ---------- real fake processes (macOS ps -E; skipped where env is not visible, e.g. a sandbox) ----------

const spawned: number[] = []
afterAll(() => {
  for (const p of spawned) {
    try {
      process.kill(p, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
})

function envVisible(): boolean {
  const id = `probe_${process.pid}`
  const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{},4000)'], { env: { ...process.env, HIVE_SPAWN_ID: id }, stdio: 'ignore' })
  try {
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      const out = execFileSync('/bin/ps', ['-ww', '-E', '-o', 'command=', '-p', String(c.pid)], { encoding: 'utf8' })
      if (out.includes(`HIVE_SPAWN_ID=${id}`)) return true
      execFileSync('/bin/sleep', ['0.1'])
    }
    return false
  } catch {
    return false
  } finally {
    c.kill('SIGKILL')
  }
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const waitFor = async (f: () => boolean, ms = 5000): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (f()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return f()
}

const LEADER = `
const { spawn } = require('child_process')
const fs = require('fs')
const a = spawn('/bin/sleep', ['600'], { stdio: 'ignore' })                         // same group
const b = spawn(process.execPath, ['-e', "require('child_process').spawn('/bin/sleep',['601'],{stdio:'ignore'}); setInterval(()=>{},1000)"], { stdio: 'ignore', detached: true }) // escapes the group
b.unref()
setTimeout(() => fs.writeFileSync(process.argv[1], JSON.stringify({ a: a.pid, b: b.pid })), 300)
setInterval(() => {}, 1000)
`

describe.runIf(process.platform === 'darwin' && envVisible())('Reaper (real processes)', () => {
  it('kills a leader, its group, and a tagged escapee (+ its group) after the leader is gone', async () => {
    const ud = mkdtempSync(join(tmpdir(), 'hive reaper '))
    const out = join(ud, 'pids.json')
    const spawnId = `st_test${process.pid}`
    const r = new Reaper({ userData: ud, selfPid: process.pid, graceMs: 800, sampleMs: 0 })
    const leader = spawn(process.execPath, ['-e', LEADER, out], { env: { ...process.env, ...r.tag(spawnId) }, stdio: 'ignore', detached: true })
    spawned.push(leader.pid!)
    expect(await waitFor(() => existsSync(out))).toBe(true)
    const { a, b } = JSON.parse(readFileSync(out, 'utf8')) as { a: number; b: number }
    spawned.push(a, b)
    // b's own child, in b's group
    const snap = await systemProcessTable.snapshot(true)
    const bChild = snap.find((x) => x.ppid === b)?.pid
    expect(bChild).toBeTruthy()
    spawned.push(bChild!)
    expect(spawnIdOf(snap.find((x) => x.pid === b)!.env)).toBe(spawnId)
    // the leader dies on its own: a and b are re-parented; only the group and the env tag still tie them to it
    process.kill(leader.pid!, 'SIGKILL')
    await waitFor(() => !alive(leader.pid!))
    const n = await r.reap(spawnId, { rootPids: [leader.pid!] })
    expect(n).toBeGreaterThanOrEqual(3)
    expect(await waitFor(() => !alive(a) && !alive(b) && !alive(bChild!))).toBe(true)
    // nothing tagged for this userData survives
    const after = await systemProcessTable.snapshot(true)
    expect(after.filter((x) => x.env?.includes(`HIVE_SPAWN_ID=${spawnId}`))).toEqual([])
  }, 20_000)

  it('lists a tagged orphan as a leftover (never killed on its own) and Stop kills it', async () => {
    const ud = mkdtempSync(join(tmpdir(), 'hive leftover '))
    const r = new Reaper({ userData: ud, selfPid: process.pid, graceMs: 800, sampleMs: 0 })
    // an "earlier Hive run" left this behind: detached, re-parented to launchd once its parent shell exits
    const sh = spawn('/bin/sh', ['-c', `"${process.execPath}" -e "setInterval(()=>{},1000)" >/dev/null 2>&1 &`], { env: { ...process.env, ...r.tag('s_gone') }, stdio: 'ignore' })
    await new Promise((res) => sh.on('exit', res))
    let orphan = 0
    await waitFor(() => {
      const rows = systemProcessTable.snapshotSync(true)
      orphan = rows.find((x) => spawnIdOf(x.env) === 's_gone' && x.env?.includes(`HIVE_USER_DATA=${ud} `))?.pid ?? 0
      return orphan > 0
    })
    expect(orphan).toBeGreaterThan(0)
    spawned.push(orphan)
    const l = await r.leftovers(new Set())
    expect(l.map((x) => x.pid)).toContain(orphan)
    expect(l.find((x) => x.pid === orphan)?.cwd).toBeTruthy()
    expect(alive(orphan)).toBe(true)
    expect(await r.stopLeftovers([orphan], new Set())).toBe(1)
    expect(await waitFor(() => !alive(orphan))).toBe(true)
  }, 20_000)
})
