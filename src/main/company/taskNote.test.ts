/**
 * CHAT-UI.md §8.4: "Add a note for Julia…" in a task's chat is a task comment by you (tasks:comment). It reaches the
 * running agent the way a teammate's message does: coalesced into the task's wake while the run works, and in the
 * prompt of the turn that follows as soon as this one ends. Without a run, it is the next turn's wake.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../db'
import { Store } from '../db/store'
import { Dispatcher, HookedCompanyStore } from './dispatcher'
import type { StartRunOptions } from '../../shared/engine'
import type { Run, RunTarget } from '../../shared/types'

let db: DB; let store: Store; let c: HookedCompanyStore; let dir: string; let d: Dispatcher
let started: { target: RunTarget; opts: StartRunOptions; run: Run }[] = []
let seq = 0

function startRun(target: RunTarget, opts: StartRunOptions): Run {
  const id = `r_n${++seq}`
  db.prepare(`INSERT INTO runs(id,kind,title,target_json,trigger,status,created_at,artifacts_dir,company_id) VALUES(?,'prompt','Task',?,'manual','queued',?,?,?)`).run(id, JSON.stringify(target), new Date().toISOString(), dir, opts.companyId ?? null)
  const run: Run = { id, kind: 'prompt', title: 'Task', target, workflowId: null, scheduleId: null, parentRunId: null, trigger: 'manual', status: 'queued', reason: null, createdAt: new Date().toISOString(), startedAt: null, endedAt: null, artifactsDir: dir, artifactCount: 0, companyId: opts.companyId ?? undefined }
  started.push({ target, opts, run })
  return run
}
function end(runId: string, status: Run['status']) {
  db.prepare('UPDATE runs SET status=? WHERE id=?').run(status, runId)
  d.onRunUpdated({ ...started.find((s) => s.run.id === runId)!.run, status })
}
const flush = () => new Promise((r) => setTimeout(r, 0))
async function settle() { for (let i = 0; i < 5; i++) await flush() }
const prompt = (i: number) => { const t = started[i]!.target; return t.kind === 'prompt' ? t.prompt : '' }

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-note-'))
  db = openDatabase(path.join(dir, 'test.db')); store = new Store(db); c = new HookedCompanyStore(store)
  started = []
  d = new Dispatcher({ company: c, startRun, cancelRun: async () => {}, enabled: () => true, sessions: null })
  c.hooks = d.hooks()
})
afterEach(() => { d.dispose(); db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

function board() {
  const co = c.create({ name: 'Acme' })
  const dep = c.departments.save({ companyId: co.id, name: 'Marketing' })
  const profile = store.createProfile({ name: 'Claude', adapter: 'claude', permissionMode: 'default', secretNames: [], useApiKeyAuth: false })
  const agent = c.departments.saveAgent({ companyId: co.id, departmentId: dep.id, kind: 'profile', refId: profile.id, name: 'Julia', data: { autonomy: 'auto' } })
  c.setAutopilot(co.id, true)
  const t = c.createTask({ title: 'Launch post', description: 'Write the launch post', companyId: co.id, repoId: null, status: 'todo', priority: 3, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], departmentId: dep.id, agentId: agent.id })
  return { co, agent, t }
}

describe('a note from the task chat reaches the agent', () => {
  it('while the run works: in the thread at once, coalesced into the wake, in the prompt of the very next turn', async () => {
    const { t } = board()
    await settle()
    expect(started).toHaveLength(1)
    expect(c.task(t.id).status).toBe('in_progress')
    // tasks:comment (by you), what the composer sends
    const a = c.activity(t.id, 'comment', 'Use the blue logo, not the red one', 'human')
    expect(a).toMatchObject({ kind: 'comment', by: 'human' })
    expect(c.detail(t.id).activity.map((x) => x.kind)).toContain('coalesced')
    expect(c.task(t.id).pendingWake).toMatchObject({ count: 1 })
    // the turn ends with a review report: the note starts its follow-up turn at once
    c.patchInFlight(t.id, { report: { outcome: 'review', summary: 'Draft is ready', evidence: [], at: new Date().toISOString() } })
    end(started[0]!.run.id, 'passed')
    await settle()
    for (let i = 0; i < 3; i++) await d.tick()
    expect(started.length).toBeGreaterThanOrEqual(2)
    expect(prompt(1)).toContain('Use the blue logo, not the red one')
  })
})
