import { describe, expect, it } from 'vitest'
import { scheduleProblem } from '../sync'
import { workflowDeps } from '../deps'
import { startHarness, workflowFile } from './harness'

describe('workflow sync with baseRev (CLOUD.md §8)', () => {
  it('creates at rev 1, updates on the current rev, and answers 409 with rev when stale', async () => {
    const h = await startHarness()
    try {
      const dev = await h.pair()
      await h.call('PUT', '/v1/companies/co_a', { token: dev, body: { name: 'A', slug: 'a' } })
      const put = (baseRev: number | null, name = 'Brief') => h.call('PUT', '/v1/companies/co_a/workflows/w1', { token: dev, body: { file: workflowFile(name), baseRev } })
      const c = await put(null)
      expect(c.status).toBe(200)
      expect(c.json).toMatchObject({ id: 'w1', companyId: 'co_a', name: 'Brief', rev: 1, problems: [] })
      const dup = await put(null)
      expect([dup.status, dup.json.error, dup.json.rev]).toEqual([409, 'conflict', 1])
      expect((await put(1, 'Morning brief')).json.rev).toBe(2)
      const stale = await put(1)
      expect([stale.status, stale.json.rev]).toEqual([409, 2])
      const missing = await h.call('PUT', '/v1/companies/co_a/workflows/w2', { token: dev, body: { file: workflowFile('X'), baseRev: 3 } })
      expect([missing.status, missing.json.rev]).toEqual([409, 0])
      // problems come from runtime.validateWorkflow
      const bad = await h.call('PUT', '/v1/companies/co_a/workflows/w3', { token: dev, body: { file: workflowFile('Wt', [{ id: 'a', type: 'agent', profileId: 'prof_local_123', prompt: 'x' }]), baseRev: null } })
      expect(bad.json.problems).toEqual(['Step a uses a profile the cloud does not know.'])
      expect((await h.call('PUT', '/v1/companies/co_a/workflows/w4', { token: dev, body: { file: { not: 'a workflow' }, baseRev: null } })).status).toBe(400)
      const list = await h.call('GET', '/v1/companies/co_a/workflows', { token: dev })
      expect(list.json.map((w: { id: string }) => w.id).sort()).toEqual(['w1', 'w3'])
    } finally { await h.close() }
  })

  it('derives adapters, key names and connection references from a workflow', () => {
    const d = workflowDeps(workflowFile('X', [
      { id: 'a', type: 'agent', profileId: 'prof_claude', prompt: 'Use $FIRECRAWL_API_KEY and connection: "notion" please' },
      { id: 'b', type: 'shell', command: 'curl -H "x: ${FAL_KEY}" $HOME $OPENAI_API_KEY && node -e "process.env.SLACK_WEBHOOK_SECRET"' },
      { id: 'c', type: 'room', participants: [{ profileId: 'prof_gemini', label: 'A' }, { profileId: 'prof_codex', label: 'B' }], topic: 'os.getenv("STRIPE_SECRET")' }
    ]))
    expect(d).toEqual({ adapters: ['claude', 'codex', 'gemini'], secrets: ['FAL_KEY', 'FIRECRAWL_API_KEY', 'SLACK_WEBHOOK_SECRET', 'STRIPE_SECRET'], connections: ['notion'] })
  })
})

describe('schedules: placement and the 5-minute floor', () => {
  it('enforces the floor with the desktop scheduler helpers', () => {
    const now = new Date('2026-10-21T08:00:00Z')
    expect(scheduleProblem({ kind: 'cron', cron: '*/5 * * * *', tz: 'UTC' }, now)).toBeNull()
    expect(scheduleProblem({ kind: 'cron', cron: '*/4 * * * *', tz: 'UTC' }, now)).toMatch(/every 5 minutes/)
    expect(scheduleProblem({ kind: 'cron', cron: '* * * * *', tz: 'UTC' }, now)).toMatch(/every 5 minutes/)
    expect(scheduleProblem({ kind: 'cron', cron: '0 9 * * 1-5', tz: 'Europe/Madrid' }, now)).toBeNull()
    expect(scheduleProblem({ kind: 'cron', cron: '0 9 * * *', tz: 'Mars/Olympus' }, now)).toMatch(/time zone/)
    expect(scheduleProblem({ kind: 'cron', cron: 'not cron', tz: 'UTC' }, now)).not.toBeNull()
    expect(scheduleProblem({ kind: 'at', at: '2026-10-22T09:00:00Z' }, now)).toBeNull()
  })

  it('stores placement, reloads triggers, lists only cloud schedules to the runtime, and reports changes', async () => {
    const h = await startHarness()
    try {
      const dev = await h.pair()
      await h.call('PUT', '/v1/companies/co_a', { token: dev, body: { name: 'A', slug: 'a' } })
      await h.call('PUT', '/v1/companies/co_a/workflows/w1', { token: dev, body: { file: workflowFile('Brief'), baseRev: null } })
      const spec = (cron: string) => ({ name: 'Morning', when: { kind: 'cron', cron, tz: 'UTC' }, target: { kind: 'workflow', workflowId: 'w1', inputs: {} }, enabled: true })
      const floor = await h.call('PUT', '/v1/companies/co_a/schedules/s1', { token: dev, body: { schedule: spec('* * * * *'), placement: 'cloud', baseRev: null } })
      expect([floor.status, floor.json.message]).toEqual([400, 'Schedules can fire at most every 5 minutes.'])
      const reloads = () => h.rt.calls.filter(c => c.method === 'reloadSchedules').length
      const before = reloads()
      const cursor0 = (await h.call('GET', '/v1/sync/changes', { token: dev })).json.cursor
      const s = await h.call('PUT', '/v1/companies/co_a/schedules/s1', { token: dev, body: { schedule: spec('0 9 * * *'), placement: 'cloud', baseRev: null } })
      expect(s.json).toMatchObject({ id: 's1', placement: 'cloud', rev: 1, nextFireAt: expect.any(String), lastFireAt: null })
      expect(reloads()).toBe(before + 1)
      await h.call('PUT', '/v1/companies/co_a/schedules/s2', { token: dev, body: { schedule: spec('0 10 * * *'), placement: 'local', baseRev: null } })
      expect(h.app.ports.cloudSchedules().map(x => x.id)).toEqual(['s1'])
      expect((await h.call('PUT', '/v1/companies/co_a/schedules/s1', { token: dev, body: { schedule: spec('0 9 * * *'), placement: 'cloud', baseRev: 0 } })).status).toBe(409)
      const ch = await h.call('GET', `/v1/sync/changes?since=${cursor0}`, { token: dev })
      expect(ch.json.schedules.map((x: { id: string }) => x.id)).toEqual(['s1', 's2'])
      const ch2 = await h.call('GET', `/v1/sync/changes?since=${ch.json.cursor}`, { token: dev })
      expect(ch2.json).toMatchObject({ runs: [], asks: [], schedules: [], passports: [] })
      // a fired slot is unique, even when the runtime asks twice
      const slot = '2026-10-22T09:00:00.000Z'
      const r1 = h.app.ports.requestRun({ companyId: 'co_a', trigger: 'schedule', target: { kind: 'workflow', workflowId: 'w1', inputs: {} }, scheduleId: 's1', slot })
      const r2 = h.app.ports.requestRun({ companyId: 'co_a', trigger: 'schedule', target: { kind: 'workflow', workflowId: 'w1', inputs: {} }, scheduleId: 's1', slot })
      expect(r1.runId).toMatch(/^crun_/)
      expect(r2).toEqual({ runId: null, refused: 'This schedule slot already fired.' })
      h.app.ports.markScheduleFired('s1', slot, r1.runId)
      const ch3 = await h.call('GET', `/v1/sync/changes?since=${ch2.json.cursor}`, { token: dev })
      expect(ch3.json.schedules[0]).toMatchObject({ id: 's1', lastFireAt: slot, lastRunId: r1.runId })
      expect(ch3.json.runs.map((r: { id: string }) => r.id)).toContain(r1.runId)
      expect((await h.call('GET', '/v1/sync/changes?since=garbage', { token: dev })).status).toBe(400)
      // pausing the company hides its schedules from the runtime
      await h.call('PATCH', '/v1/companies/co_a', { token: dev, body: { paused: true } })
      expect(h.app.ports.cloudSchedules()).toEqual([])
    } finally { await h.close() }
  })
})

describe('GET /v1/sync/changes pages a large backlog', () => {
  it('never skips a row past one page: the cursor stops at the shortest page and `more` asks again', async () => {
    const h = await startHarness()
    try {
      const dev = await h.pair()
      await h.call('PUT', '/v1/companies/co_a', { token: dev, body: { name: 'A', slug: 'a' } })
      const cursor0 = (await h.call('GET', '/v1/sync/changes', { token: dev })).json.cursor
      const db = h.app.ctx.db
      const spec = JSON.stringify({ name: 'S', when: { kind: 'cron', cron: '0 9 * * *', tz: 'UTC' }, target: { kind: 'workflow', workflowId: 'w1', inputs: {} }, enabled: true })
      const at = '2026-10-21T08:00:00.000Z'
      // 700 schedules and 700 runs, interleaved on the one shared seq (more than one page of each)
      const N = 700
      for (let i = 0; i < N; i++) {
        db.run('INSERT INTO schedules (company_id, id, spec, placement, rev, seq, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)', 'co_a', `s${i}`, spec, i % 2 ? 'cloud' : 'local', db.nextSeq(), at)
        db.run("INSERT INTO cloud_runs (id, workspace_id, company_id, kind, title, status, trigger, adapters, target, untrusted, created_at, seq) VALUES (?, 'ws', 'co_a', 'workflow', 'R', 'passed', 'manual', '[]', '{}', '[]', ?, ?)", `crun_${i}`, at, db.nextSeq())
      }
      const schedules = new Set<string>(), runs = new Set<string>()
      let cursor = cursor0, pages = 0, more = true
      while (more) {
        const ch = (await h.call('GET', `/v1/sync/changes?since=${cursor}`, { token: dev })).json
        expect(ch.schedules.length).toBeLessThanOrEqual(500)
        expect(ch.runs.length).toBeLessThanOrEqual(500)
        for (const x of ch.schedules) schedules.add(x.id)
        for (const r of ch.runs) runs.add(r.id)
        if (pages === 0) expect(ch.more).toBe(true)
        more = ch.more
        cursor = ch.cursor
        if (++pages > 10) throw new Error('did not drain')
      }
      expect(pages).toBeGreaterThan(1)
      expect(schedules.size).toBe(N)
      expect(runs.size).toBe(N)
      const after = (await h.call('GET', `/v1/sync/changes?since=${cursor}`, { token: dev })).json
      expect(after).toMatchObject({ runs: [], asks: [], schedules: [], passports: [], more: false })
    } finally { await h.close() }
  })
})
