import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../db'
import { Store } from '../db/store'
import { SessionManager, type PtyLike, type SessionDeps } from '../sessions'

let nativeOk = true
try {
  openDatabase(':memory:').close()
} catch {
  nativeOk = false
}
const d = nativeOk ? describe : describe.skip

class FakePty implements PtyLike {
  static last: FakePty
  pid = 4242
  written: string[] = []
  size: [number, number] = [0, 0]
  private dataCb: (d: string) => void = () => {}
  private exitCb: (e: { exitCode: number; signal?: number }) => void = () => {}
  constructor(
    public file: string,
    public args: string[],
    public opts: { cwd: string; env: Record<string, string>; cols: number; rows: number }
  ) {
    FakePty.last = this
  }
  onData(cb: (d: string) => void) {
    this.dataCb = cb
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void) {
    this.exitCb = cb
  }
  write(d: string) {
    this.written.push(d)
  }
  resize(c: number, r: number) {
    this.size = [c, r]
  }
  kill() {
    this.exit(129)
  }
  emit(d: string) {
    this.dataCb(d)
  }
  exit(code: number) {
    this.exitCb({ exitCode: code })
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let db: DB
let store: Store
let tmp: string
let mgr: SessionManager
let events: { data: string[]; exits: number; updated: number }
let trusted: string[] = []
let lastSpawnOpts: { resumeAgentSessionId?: string | null; freshAgentSessionId?: string | null; artifactsDir: string } | null
let convExists = true

beforeEach(() => {
  if (!nativeOk) return
  db = openDatabase(':memory:')
  store = new Store(db)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-sess-'))
  const paths = {
    userData: tmp,
    artifactsRoot: path.join(tmp, 'artifacts'),
    sessionLogsDir: path.join(tmp, 'logs'),
    scratchDir: path.join(tmp, 'scratch')
  }
  for (const p of Object.values(paths)) fs.mkdirSync(p, { recursive: true })
  events = { data: [], exits: 0, updated: 0 }
  lastSpawnOpts = null
  convExists = true
  trusted = []
  const deps: SessionDeps = {
    store,
    paths,
    spawnPty: (file, args, opts) => new FakePty(file, args, opts),
    interactiveSpawn: (profile, opts) => {
      lastSpawnOpts = opts
      return {
        file: `/bin/${profile.adapter}`,
        args: opts.resumeAgentSessionId ? ['--resume', opts.resumeAgentSessionId] : ['--session-id', opts.freshAgentSessionId ?? 'uuid-new'],
        stripEnv: profile.adapter === 'claude' ? ['ANTHROPIC_API_KEY'] : [],
        agentSessionId: opts.resumeAgentSessionId ?? opts.freshAgentSessionId ?? 'uuid-new'
      }
    },
    baseEnv: () => ({ PATH: '/usr/bin', HOME: '/Users/x' }),
    secrets: {
      resolve: () => ({ ANTHROPIC_API_KEY: 'sk-ant-secret', FAL_KEY: 'fal-secret-value' }),
      redact: (t) => t.split('fal-secret-value').join('••••FAL_KEY')
    },
    emitData: (_id, data) => events.data.push(data),
    emitExit: () => events.exits++,
    emitUpdated: () => events.updated++,
    trustFolder: (cwd) => trusted.push(cwd),
    conversationExists: () => convExists,
    killGroup: () => {
      FakePty.last.exit(129)
      return true
    }
  }
  mgr = new SessionManager(deps)
})
afterEach(() => {
  if (!nativeOk) return
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

d('SessionManager', () => {
  it('pre-accepts Claude folder trust only for scratch and user-added repos', () => {
    fs.mkdirSync(path.join(tmp, 'picked'))
    fs.mkdirSync(path.join(tmp, 'adhoc'))
    const [repo] = store.addRepo(path.join(tmp, 'picked'))
    mgr.create({ adapter: 'claude', cols: 80, rows: 24 })
    mgr.create({ adapter: 'claude', repoId: repo.id, cols: 80, rows: 24 })
    mgr.create({ adapter: 'claude', cwd: path.join(tmp, 'adhoc'), cols: 80, rows: 24 })
    expect(trusted).toEqual([path.join(tmp, 'scratch'), repo.path])
  })

  it('Chat session: scratch cwd, env per A6, ARTIFACTS_DIR, agentSessionId', () => {
    const s = mgr.create({ adapter: 'claude', cols: 100, rows: 30 })
    expect(s).toMatchObject({ status: 'running', cwd: path.join(tmp, 'scratch'), title: 'Chat · Claude', agentSessionId: 'uuid-new', repoId: null })
    const env = FakePty.last.opts.env
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.FAL_KEY).toBe('fal-secret-value')
    expect(env.ARTIFACTS_DIR).toBe(path.join(tmp, 'artifacts', s.id) + '/')
    expect(env.HIVE_SESSION_ID).toBe(s.id)
    expect(fs.existsSync(env.ARTIFACTS_DIR)).toBe(true)
    expect(lastSpawnOpts!.artifactsDir).toBe(env.ARTIFACTS_DIR)
    expect(store.defaultProfileFor('claude')).not.toBeNull()
  })

  it('repo session title, coalesced redacted output, attach replays scrollback', async () => {
    fs.mkdirSync(path.join(tmp, 'example-project'))
    const [repo] = store.addRepo(path.join(tmp, 'example-project'))
    const s = mgr.create({ repoId: repo.id, adapter: 'claude', cols: 80, rows: 24 })
    expect(s.title).toBe('example-project · Claude')
    expect(mgr.liveCountForRepo(repo.id)).toBe(1)
    FakePty.last.emit('hello ')
    FakePty.last.emit('key=fal-secret-value\r\n')
    await sleep(40)
    expect(events.data).toEqual(['hello key=••••FAL_KEY\r\n'])
    const a = mgr.attach(s.id)
    expect(a.scrollback).toContain('••••FAL_KEY')
    expect(a.scrollback).not.toContain('fal-secret-value')
    expect(store.getSettings().lastRepoId).toBe(repo.id)
  })

  it('write + debounced resize, exit marks row exited and log survives for attach', async () => {
    const s = mgr.create({ adapter: 'shell', cols: 80, rows: 24 })
    const pty = FakePty.last
    mgr.write(s.id, 'ls\r')
    expect(pty.written).toEqual(['ls\r'])
    mgr.resize(s.id, 120, 40)
    mgr.resize(s.id, 130, 40)
    await sleep(80)
    expect(pty.size).toEqual([130, 40])
    pty.emit('bye\r\n')
    pty.exit(0)
    expect(mgr.isLive(s.id)).toBe(false)
    expect(store.getSession(s.id)).toMatchObject({ status: 'exited', exitCode: 0, pid: null })
    expect(events.exits).toBe(1)
    expect(mgr.attach(s.id).scrollback).toContain('bye')
    mgr.write(s.id, 'ignored')
    expect(pty.written).toEqual(['ls\r'])
  })

  it('kill resolves with exited session; remove only when exited', async () => {
    const s = mgr.create({ adapter: 'claude', cols: 80, rows: 24 })
    expect(() => mgr.remove(s.id)).toThrow(/Kill the session/)
    const k = await mgr.kill(s.id)
    expect(k.status).toBe('exited')
    mgr.remove(s.id)
    expect(store.getSession(s.id)).toBeNull()
  })

  it('restart resumes the agent conversation (SPEC A3)', async () => {
    const s = mgr.create({ adapter: 'claude', cols: 80, rows: 24 })
    await mgr.kill(s.id)
    const r = mgr.restart(s.id)
    expect(r.id).not.toBe(s.id)
    expect(lastSpawnOpts!.resumeAgentSessionId).toBe('uuid-new')
    expect(FakePty.last.args).toEqual(['--resume', 'uuid-new'])
    expect(r).toMatchObject({ cwd: s.cwd, profileId: s.profileId, agentSessionId: 'uuid-new' })
    expect(() => mgr.restart(r.id)).toThrow(/still running/)
  })

  it('restart with no stored conversation starts fresh under the same --session-id', async () => {
    const s = mgr.create({ adapter: 'claude', cols: 80, rows: 24 })
    await mgr.kill(s.id)
    convExists = false
    const r = mgr.restart(s.id)
    expect(lastSpawnOpts!.resumeAgentSessionId).toBeNull()
    expect(FakePty.last.args).toEqual(['--session-id', 'uuid-new'])
    expect(r.agentSessionId).toBe('uuid-new')
  })

  it('restart keeps the previous scrollback above a "— restarted —" divider', async () => {
    const s = mgr.create({ adapter: 'claude', cols: 80, rows: 24 })
    FakePty.last.emit('hello from the first run\r\n')
    await sleep(40)
    await mgr.kill(s.id)
    const r = mgr.restart(s.id)
    FakePty.last.emit('second run')
    await sleep(40)
    const back = mgr.attach(r.id).scrollback
    const a = back.indexOf('hello from the first run')
    const b = back.indexOf('— restarted —')
    const c = back.indexOf('second run')
    expect(a).toBeGreaterThanOrEqual(0)
    expect(b).toBeGreaterThan(a)
    expect(c).toBeGreaterThan(b)
  })

  it('boot recovery marks running rows exited; prune deletes >7 day old exited sessions', async () => {
    const s = mgr.create({ adapter: 'claude', cols: 80, rows: 24 })
    expect(store.recoverSessions()).toEqual([s.id])
    expect(store.getSession(s.id)!.status).toBe('exited')
    db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', s.id)
    expect(mgr.pruneOld(7)).toBe(1)
    expect(store.getSession(s.id)).toBeNull()
  })

  it('rejects missing repo folders', () => {
    fs.mkdirSync(path.join(tmp, 'gone'))
    const [repo] = store.addRepo(path.join(tmp, 'gone'))
    fs.rmdirSync(path.join(tmp, 'gone'))
    expect(() => mgr.create({ repoId: repo.id, cols: 80, rows: 24 })).toThrow(/moved or deleted/)
  })

  it('CONTRACT §13: tags the PTY env and hivemem, collects the tree before the kill and reaps it after; natural exits reap too', async () => {
    const calls: string[] = []
    const reaper = {
      userData: tmp,
      tag: (id: string) => ({ HIVE_SPAWN_ID: id, HIVE_USER_DATA: tmp }),
      register: (id: string, pid: number | null | undefined) => void calls.push(`register ${id} ${pid}`),
      collect: async (id: string, roots?: number[]) => {
        calls.push(`collect ${id} ${roots?.join(',')}`)
        return [{ pid: 5000, ppid: 4242, pgid: 4242, etimeMs: 1000, command: 'node dev-server', env: null }]
      },
      reap: async (id: string, o?: { rootPids?: number[]; pre?: unknown[] }) => {
        calls.push(`reap ${id} ${o?.rootPids?.join(',')} pre=${o?.pre?.length ?? 0}`)
        return 1
      },
      reapAllSync: () => 0,
      leftovers: async () => [],
      stopLeftovers: async () => 0
    }
    const m = new SessionManager({ ...(mgr as unknown as { d: SessionDeps }).d, reaper })
    const s = m.create({ adapter: 'claude', cols: 80, rows: 24 })
    expect(FakePty.last.opts.env.HIVE_SPAWN_ID).toBe(s.id)
    expect(FakePty.last.opts.env.HIVE_USER_DATA).toBe(tmp)
    expect((lastSpawnOpts as { spawnTag?: Record<string, string> }).spawnTag).toEqual({ HIVE_SPAWN_ID: s.id, HIVE_USER_DATA: tmp })
    await m.kill(s.id)
    expect(calls).toEqual([`register ${s.id} 4242`, `collect ${s.id} 4242`, `reap ${s.id} 4242 pre=1`])
    expect(m.liveIds()).toEqual([])
    calls.length = 0
    const s2 = m.create({ adapter: 'claude', cols: 80, rows: 24 })
    FakePty.last.exit(0)
    await sleep(5)
    expect(calls).toEqual([`register ${s2.id} 4242`, `reap ${s2.id} 4242 pre=0`])
  })
})
