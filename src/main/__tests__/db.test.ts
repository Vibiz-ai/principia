import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Run, RunStep } from '../../shared/types'
import { openDatabase, currentVersion, type DB } from '../db'
import { SCHEMA_VERSION } from '../db/schema'
import { Store, DEFAULT_SETTINGS } from '../db/store'
import { createEngineStore } from '../db/engineStore'
import { ensureDefaultProfile, seedProfiles, seedWorkflows } from '../db/seed'
import { seedWorkflows as engineSeeds } from '../engine'
import { Vault, type Cipher } from '../vault'
import { ArtifactIndexer } from '../artifacts'

let nativeOk = true
try {
  openDatabase(':memory:').close()
} catch {
  nativeOk = false // better-sqlite3 built for Electron only: covered by `npm run smoke`
}
const d = nativeOk ? describe : describe.skip

/** Reversible fake standing in for safeStorage. */
const fakeCipher = (available = true): Cipher => ({
  available: () => available,
  encrypt: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
  decrypt: (b) => Buffer.from(b.toString().slice(4), 'base64').toString()
})

let db: DB
let store: Store
let tmp: string
beforeEach(() => {
  if (!nativeOk) return
  db = openDatabase(':memory:')
  store = new Store(db)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-test-'))
})
afterEach(() => {
  if (!nativeOk) return
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

d('migrations', () => {
  it('stamps schema_version and is idempotent', () => {
    expect(currentVersion(db)).toBe(SCHEMA_VERSION)
    const file = path.join(tmp, 'hive.db')
    openDatabase(file).close()
    const again = openDatabase(file)
    expect(currentVersion(again)).toBe(SCHEMA_VERSION)
    again.close()
  })
})

d('settings', () => {
  it('defaults are exactly the Settings type and updates persist', () => {
    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS)
    const s = store.updateSettings({ terminalFontSize: 15, schedulesPaused: true })
    expect(s.terminalFontSize).toBe(15)
    expect(store.getSettings().schedulesPaused).toBe(true)
    store.updateSettings({ bogus: 1 } as never)
    expect(Object.keys(store.getSettings()).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort())
  })
})

d('repos', () => {
  it('adds once per path, computes exists/isGit', () => {
    fs.mkdirSync(path.join(tmp, 'proj', '.git'), { recursive: true })
    const [r, created] = store.addRepo(path.join(tmp, 'proj'))
    expect(created).toBe(true)
    expect(r).toMatchObject({ name: 'proj', exists: true, isGit: true, liveSessions: 0 })
    const [again, created2] = store.addRepo(path.join(tmp, 'proj'))
    expect(created2).toBe(false)
    expect(again.id).toBe(r.id)
    fs.rmSync(path.join(tmp, 'proj'), { recursive: true })
    expect(store.getRepo(r.id)!.exists).toBe(false)
  })
})

d('profiles + seeds', () => {
  const providers = (ids: string[]) =>
    ids.map((id) => ({ id, label: id, available: true, version: '1', binPath: `/bin/${id}`, installHint: '', checkedAt: '' })) as never

  it('seeds one bypass default per available adapter + shell, with secretNames ["*"], once', () => {
    expect(seedProfiles(store, providers(['claude']))).toEqual(['claude', 'shell'])
    const p = store.defaultProfileFor('claude')!
    expect(p).toMatchObject({ permissionMode: 'bypass', secretNames: ['*'], useApiKeyAuth: false })
    expect(seedProfiles(store, providers(['claude']))).toEqual([])
    // codex installed later -> seeded then
    expect(seedProfiles(store, providers(['claude', 'codex']))).toEqual(['codex'])
    // user deletes the codex default: not re-seeded
    store.removeProfile(store.defaultProfileFor('codex')!.id)
    expect(seedProfiles(store, providers(['claude', 'codex']))).toEqual([])
  })

  it('seeds the engine workflows once; deleted seeds stay deleted', () => {
    seedProfiles(store, providers(['claude']))
    const created = seedWorkflows(store, engineSeeds)
    expect(created.length).toBeGreaterThan(0)
    const names = store.listWorkflows().map((w) => w.name)
    expect(names).toContain('Build until tests pass')
    expect(names).not.toContain('Ship check')
    expect(names).toContain('Morning brief')
    expect(names).toHaveLength(4)
    const first = store.listWorkflows()[0]
    store.removeWorkflow(first.id)
    expect(seedWorkflows(store, engineSeeds)).toEqual([])
  })

  it('profile removal conflicts when a workflow or schedule uses it', () => {
    const p = ensureDefaultProfile(store, 'claude')
    const wf = store.createWorkflow({
      name: 'w',
      description: '',
      inputs: [],
      nodes: [{ id: 'a', type: 'agent', label: 'a', after: [], cwd: null, timeoutMin: 5, profileId: p.id, prompt: 'x' }]
    })
    expect(() => store.removeProfile(p.id)).toThrow(/Used by: workflow "w"/)
    store.removeWorkflow(wf.id)
    store.insertSchedule({ name: 's', target: { kind: 'prompt', profileId: p.id, repoId: null, prompt: 'x' }, when: { kind: 'at', at: '2030-01-01T00:00:00Z' } })
    expect(() => store.removeProfile(p.id)).toThrow(/schedule "s"/)
  })

  it('workflow removal conflicts when scheduled', () => {
    const wf = store.createWorkflow({ name: 'w', description: '', inputs: [], nodes: [] })
    store.insertSchedule({ name: 'nightly', target: { kind: 'workflow', workflowId: wf.id, inputs: {} }, when: { kind: 'cron', cron: '0 3 * * *', tz: 'UTC' } })
    expect(() => store.removeWorkflow(wf.id)).toThrow(/nightly/)
  })
})

d('EngineStore', () => {
  const run = (id: string, status: Run['status'] = 'queued'): Run => ({
    id,
    kind: 'prompt',
    title: 'hello',
    target: { kind: 'prompt', profileId: 'prof_1', repoId: null, prompt: 'hello' },
    workflowId: null,
    scheduleId: null,
    parentRunId: null,
    trigger: 'manual',
    status,
    reason: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
    artifactsDir: `/tmp/artifacts/${id}/`,
    artifactCount: 0
  })
  const step = (id: string, runId: string): RunStep => ({
    id,
    runId,
    seq: 1,
    nodeId: 'prompt',
    nodeType: 'prompt',
    attempt: 1,
    round: null,
    profileId: 'prof_1',
    participantLabel: null,
    adapter: 'claude',
    cwd: '/tmp',
    prompt: 'hello',
    output: null,
    verdict: null,
    exitCode: null,
    pid: null,
    status: 'pending',
    error: null,
    sourceStepIds: ['st_a'],
    agentSessionId: 'uuid-1',
    logPath: '/tmp/x.log',
    startedAt: null,
    endedAt: null
  })
  it('round-trips runs, steps, patches and active list', () => {
    const es = createEngineStore(db, { describe: () => () => 'sentence' })
    es.insertRun(run('r_1'), { name: 'snap', description: '', inputs: [], nodes: [] })
    es.insertStep(step('st_1', 'r_1'))
    expect(es.listActiveRuns().map((r) => r.id)).toEqual(['r_1'])
    const r = es.updateRun('r_1', { status: 'passed', endedAt: '2026-10-15T10:00:00.000Z' })
    expect(r.status).toBe('passed')
    expect(es.listActiveRuns()).toEqual([])
    const s = es.updateStep('st_1', { status: 'passed', verdict: 'PASS', output: 'done', sourceStepIds: ['st_a', 'st_b'] })
    expect(s).toMatchObject({ status: 'passed', verdict: 'PASS', output: 'done', sourceStepIds: ['st_a', 'st_b'], agentSessionId: 'uuid-1' })
    const detail = es.getRunDetail('r_1')!
    expect(detail.workflow!.name).toBe('snap')
    expect(detail.steps).toHaveLength(1)
    expect(store.countEndedSince('2026-10-15T00:00:00.000Z')).toEqual({ passed: 1, failed: 0 })
  })
  it('a run that fails at the gate gets startedAt = endedAt; a started run keeps its startedAt', () => {
    const es = createEngineStore(db, { describe: () => () => 'sentence' })
    es.insertRun(run('r_gate'), null)
    const r = es.updateRun('r_gate', { status: 'failed', reason: 'Codex not installed', endedAt: '2026-10-15T10:00:00.000Z' })
    expect(r.startedAt).toBe('2026-10-15T10:00:00.000Z')
    es.insertRun(run('r_ok'), null)
    es.updateRun('r_ok', { status: 'running', startedAt: '2026-10-15T09:00:00.000Z' })
    expect(es.updateRun('r_ok', { status: 'passed', endedAt: '2026-10-15T09:05:00.000Z' }).startedAt).toBe('2026-10-15T09:00:00.000Z')
  })
  it('schedule fire-state + events, sentence via describe, lastRunStatus joined', () => {
    const es = createEngineStore(db, { describe: () => () => 'Every day at 9:00' })
    const id = store.insertSchedule({ name: 's', target: { kind: 'prompt', profileId: 'p', repoId: null, prompt: 'x' }, when: { kind: 'cron', cron: '0 9 * * *', tz: 'UTC' } })
    es.insertRun({ ...run('r_9'), status: 'failed' }, null)
    const s = es.setScheduleFireState(id, { lastFireAt: '2026-10-15T09:00:00.000Z', lastRunId: 'r_9', nextFireAt: '2026-10-16T09:00:00.000Z', enabled: false })
    expect(s).toMatchObject({ sentence: 'Every day at 9:00', enabled: false, lastRunStatus: 'failed', nextFireAt: '2026-10-16T09:00:00.000Z' })
    const ev = es.insertScheduleEvent({ scheduleId: id, kind: 'missed', slotAt: '2026-10-15T09:00:00.000Z', runId: null, message: '12 slots missed' })
    expect(ev.id.startsWith('sev_')).toBe(true)
    expect(store.scheduleEvents(id)).toHaveLength(1)
  })
})

d('Vault (SPEC 9.4)', () => {
  it('never stores plaintext, masks, resolves, redacts', () => {
    const v = new Vault(db, fakeCipher())
    const meta = v.set('MY_KEY', 'supersecretvalue123', 'Mine')
    expect(meta).toMatchObject({ name: 'MY_KEY', label: 'Mine', masked: '…e123' })
    const raw = db.prepare('SELECT * FROM secrets').all() as Record<string, unknown>[]
    expect(JSON.stringify(raw)).not.toContain('supersecretvalue123')
    expect(v.resolve(['*'])).toEqual({ MY_KEY: 'supersecretvalue123' })
    expect(v.resolve(['OTHER'])).toEqual({})
    expect(v.list()[0].lastUsedAt).not.toBeNull()
    expect(v.redact('echo supersecretvalue123!')).toBe('echo ••••MY_KEY!')
    expect(v.reveal('MY_KEY')).toBe('supersecretvalue123')
    v.remove('MY_KEY')
    expect(v.redact('supersecretvalue123')).toBe('supersecretvalue123')
  })
  it('validates names', () => {
    const v = new Vault(db, fakeCipher())
    expect(() => v.set('bad-name', 'x')).toThrow(/Invalid key name/)
  })
  it('refuses to store when Keychain encryption is unavailable (K5)', () => {
    const v = new Vault(db, fakeCipher(false))
    expect(() => v.set('A_KEY', 'value')).toThrow(/unavailable/)
    expect(db.prepare('SELECT COUNT(*) AS n FROM secrets').get()).toEqual({ n: 0 })
  })
  it('imports selected .env entries and marks existing ones', () => {
    const v = new Vault(db, fakeCipher())
    v.set('FAL_KEY', 'old-value-1')
    const text = '# c\nFAL_KEY=new-value-2\nOPENAI_API_KEY=sk-12345678901\nIGNORED=yes'
    const preview = v.parseEnv(text)
    expect(preview.find((e) => e.name === 'FAL_KEY')!.exists).toBe(true)
    const metas = v.importEnv(text, ['FAL_KEY', 'OPENAI_API_KEY'])
    expect(metas.map((m) => m.name)).toEqual(['FAL_KEY', 'OPENAI_API_KEY'])
    expect(v.reveal('FAL_KEY')).toBe('new-value-2')
    expect(v.list().map((m) => m.name)).not.toContain('IGNORED')
  })
})

d('ArtifactIndexer', () => {
  it('indexes owner dirs, ignores dotfiles/root files, rescans removals', () => {
    const root = path.join(tmp, 'artifacts')
    fs.mkdirSync(path.join(root, 'r_abc', 'sub'), { recursive: true })
    fs.mkdirSync(path.join(root, 's_def'), { recursive: true })
    fs.writeFileSync(path.join(root, 'r_abc', 'a.png'), 'png')
    fs.writeFileSync(path.join(root, 'r_abc', 'sub', 'b.html'), '<p>')
    fs.writeFileSync(path.join(root, 'r_abc', '.hidden'), 'x')
    fs.writeFileSync(path.join(root, 's_def', 'notes.md'), '# hi')
    fs.writeFileSync(path.join(root, 'orphan.txt'), 'x')
    const added: string[] = []
    const removed: string[] = []
    const idx = new ArtifactIndexer(root, store, { added: (a) => added.push(a.relPath), removed: (id) => removed.push(id) })
    expect(idx.rescan()).toEqual({ added: 3, removed: 0 })
    expect(added.sort()).toEqual(['r_abc/a.png', 'r_abc/sub/b.html', 's_def/notes.md'])
    const runArts = store.listArtifacts({ runId: 'r_abc' })
    expect(runArts.map((a) => a.kind).sort()).toEqual(['html', 'image'])
    expect(store.listArtifacts({ sessionId: 's_def' })[0]).toMatchObject({ kind: 'markdown', runId: null })
    // unchanged rescan emits nothing
    added.length = 0
    expect(idx.rescan(path.join(root, 'r_abc'))).toEqual({ added: 0, removed: 0 })
    expect(added).toEqual([])
    fs.rmSync(path.join(root, 'r_abc', 'a.png'))
    expect(idx.rescan(path.join(root, 'r_abc'))).toEqual({ added: 0, removed: 1 })
    expect(removed).toHaveLength(1)
  })
})
