/**
 * DEPARTMENTS.md §9: chats that know the company. SessionManager places a company or department chat (cwd, --add-dir
 * folders, trust), passes the department slot and the chat brief to the spawn, persists `departmentId` and keeps it
 * on Restart; an interactive task session gets the department slot only. The adapters' --add-dir args; the engine
 * appending the brief after the Passport block.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../db'
import { Store } from '../db/store'
import { SessionManager, type PtyLike, type SessionDeps } from '../sessions'
import type { ChatPlacement } from '../company/chatContext'
import type { InteractiveSpawnOptions } from '../../shared/engine'
import { addDirArgs, claudeAdapter, codexAdapter } from '../engine/adapters'

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
  private exitCb: (e: { exitCode: number }) => void = () => {}
  constructor(public file: string, public args: string[], public opts: { cwd: string }) {
    FakePty.last = this
  }
  onData() {}
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCb = cb
  }
  exit(code: number) {
    this.exitCb({ exitCode: code })
  }
  write() {}
  resize() {}
  kill() {}
}

let db: DB
let store: Store
let tmp: string
let spawns: InteractiveSpawnOptions[]
let trusted: string[]
let authored: { chat?: boolean }[]
let mgr: SessionManager
let repoA: string
let repoB: string
const COMPANY = 'co_acme'
const DEPT = 'dep_mkt'

beforeEach(() => {
  if (!nativeOk) return
  db = openDatabase(':memory:')
  store = new Store(db)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-depchat-'))
  const paths = { userData: tmp, artifactsRoot: path.join(tmp, 'artifacts'), sessionLogsDir: path.join(tmp, 'logs'), scratchDir: path.join(tmp, 'scratch') }
  for (const p of Object.values(paths)) fs.mkdirSync(p, { recursive: true })
  repoA = path.join(tmp, 'acme-web')
  repoB = path.join(tmp, 'acme-api')
  fs.mkdirSync(repoA)
  fs.mkdirSync(repoB)
  const workspace = path.join(tmp, 'companies', 'acme', 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  spawns = []
  trusted = []
  authored = []
  const deps: SessionDeps = {
    store,
    paths,
    spawnPty: (file, args, opts) => new FakePty(file, args, opts),
    interactiveSpawn: (_p, opts) => {
      spawns.push(opts)
      return { file: '/bin/claude', args: [], stripEnv: [], agentSessionId: 'uuid-1' }
    },
    baseEnv: () => ({ PATH: '/usr/bin' }),
    secrets: { resolve: () => ({}), redact: (t) => t },
    company: {
      resolve: (q) => q.companyId ?? COMPANY,
      crossCompany: () => null,
      enforced: () => true,
      workspaceDir: () => workspace,
      repoIds: () => []
    },
    // the company's placement: Marketing chats run in acme-web, company chats in the workspace with both repos reachable
    chat: ({ departmentId }): ChatPlacement | null => {
      if (departmentId && departmentId !== DEPT) return null
      return departmentId
        ? { cwd: repoA, addDirs: [repoB], brief: '## This chat: the Marketing department of Acme', department: { id: DEPT, key: 'marketing', name: 'Marketing' } }
        : { cwd: null, addDirs: [repoA, repoB], brief: '## This chat: Acme', department: null }
    },
    author: { server: (_id, _dir, _co, o) => (authored.push(o ?? {}), null), tools: [], spawnDir: tmp },
    live: { open: () => ({ dir: tmp, hookCommand: 'x' }) as never, start: () => {}, data: () => {}, input: () => {}, exit: () => {} },
    emitData: () => {},
    emitExit: () => {},
    emitUpdated: () => {},
    trustFolder: (cwd) => void trusted.push(cwd)
  }
  mgr = new SessionManager(deps)
})
afterEach(() => {
  if (!nativeOk) return
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

d('department and company chats', () => {
  it('a department chat runs where its company places it, with the department slot, the brief and the other repo folders', () => {
    const s = mgr.create({ adapter: 'claude', companyId: COMPANY, departmentId: DEPT, cols: 80, rows: 24 })
    expect(s).toMatchObject({ cwd: repoA, repoId: null, departmentId: DEPT, title: 'Marketing · Claude', companyId: COMPANY })
    expect(spawns[0]).toMatchObject({ cwd: repoA, departmentId: DEPT, chatBrief: '## This chat: the Marketing department of Acme', addDirs: [repoB] })
    expect(trusted).toEqual([repoA, repoB])
    expect(authored[0]).toEqual({ chat: true })
    // persisted, so the sidebar lists it under its department after a reload
    expect(store.getSession(s.id)?.departmentId).toBe(DEPT)
  })

  it('a company chat gets the company brief and every repo folder; its row has no department', () => {
    const s = mgr.create({ adapter: 'claude', companyId: COMPANY, cols: 80, rows: 24 })
    expect(s.title).toBe('Chat · Claude')
    expect(s.departmentId).toBeUndefined()
    expect(spawns[0]).toMatchObject({ chatBrief: '## This chat: Acme', addDirs: [repoA, repoB] })
    expect(spawns[0]!.departmentId).toBeUndefined()
  })

  it("refuses a department that is not the company's, and ignores a repo or cwd sent with a department", () => {
    expect(() => mgr.create({ adapter: 'claude', companyId: COMPANY, departmentId: 'dep_other', cols: 80, rows: 24 })).toThrow(/not one of this company/)
    const s = mgr.create({ adapter: 'claude', companyId: COMPANY, departmentId: DEPT, cwd: repoB, cols: 80, rows: 24 })
    expect(s.cwd).toBe(repoA)
  })

  it('Restart keeps the department, the folder and the brief', () => {
    const s = mgr.create({ adapter: 'claude', companyId: COMPANY, departmentId: DEPT, cols: 80, rows: 24 })
    FakePty.last.exit(0)
    const again = mgr.restart(s.id)
    expect(again).toMatchObject({ departmentId: DEPT, cwd: repoA, title: 'Marketing · Claude' })
    expect(spawns[1]).toMatchObject({ departmentId: DEPT, chatBrief: '## This chat: the Marketing department of Acme' })
  })

  it('an interactive task session gets the department slot only: no chat brief, no company tools', () => {
    const s = mgr.create({ adapter: 'claude', companyId: COMPANY, cols: 80, rows: 24, task: true, taskDepartmentId: DEPT, initialPrompt: 'Work on PRN-1' })
    expect(s.departmentId).toBeUndefined()
    expect(spawns[0]!.departmentId).toBe(DEPT)
    expect(spawns[0]!.chatBrief).toBeUndefined()
    expect(spawns[0]!.addDirs).toBeUndefined()
    expect(authored[0]).toEqual({ chat: false })
  })
})

describe('--add-dir for chat folders', () => {
  const profile = { id: 'p', name: 'Claude', adapter: 'claude', model: null, extraArgs: [], permissionMode: 'default', secretNames: [], useApiKeyAuth: false } as never
  it('claude: one variadic --add-dir right before --session-id; codex: one flag per folder', () => {
    const c = claudeAdapter.interactive({ profile, artifactsDir: '/tmp/a/', resumeId: null, sessionId: 'uuid-1', addDirs: ['/r/a', '/r/b', 'relative', '/r/a'] })
    const i = c.args.indexOf('--add-dir')
    expect(c.args.slice(i, i + 4)).toEqual(['--add-dir', '/r/a', '/r/b', '--session-id'])
    const x = codexAdapter.interactive({ profile: { ...(profile as object), adapter: 'codex' } as never, artifactsDir: '/tmp/a/', resumeId: null, addDirs: ['/r/a', '/r/b'] })
    expect(x.args.filter((a) => a === '--add-dir')).toHaveLength(2)
    expect(x.args.slice(x.args.indexOf('/r/a') - 1, x.args.indexOf('/r/a') + 3)).toEqual(['--add-dir', '/r/a', '--add-dir', '/r/b'])
    expect(addDirArgs([], 'many')).toEqual([])
    expect(addDirArgs(['-rf'], 'each')).toEqual([])
  })
})
