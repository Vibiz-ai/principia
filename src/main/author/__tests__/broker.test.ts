/** Author broker: identity, drafts, one-card approvals (PO2), standing run permissions (PO3), PO1 refusal. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ask } from '../../../shared/live'
import type { AgentProfile, Repo, Run, Schedule, ScheduleWhen, Workflow, WorkflowDraft, WorkflowOrigin } from '../../../shared/types'
import { EXAMPLES } from '../../../shared/authoring'
import { openDatabase, type DB } from '../../db'
import { validateWorkflow } from '../../engine/validate'
import { AuthorBroker, type BrokerDeps } from '../broker'
import { AuthorDrafts, workflowHash } from '../drafts'

const ts = '2026-10-16T00:00:00.000Z'
const prof = (id: string, adapter: AgentProfile['adapter']): AgentProfile => ({
  id,
  name: adapter,
  adapter,
  model: null,
  extraArgs: [],
  permissionMode: 'default',
  secretNames: [],
  useApiKeyAuth: false,
  createdAt: ts,
  updatedAt: ts
})
const PROFILES = [prof('prof_claude0001', 'claude'), prof('prof_codex00001', 'codex')]
const REPO: Repo = { id: 'repo_4n8w2k1p0q', name: 'example-project', path: '/tmp/example-project', addedAt: ts, exists: true, isGit: true, liveSessions: 0 }

const SIMPLE = {
  name: 'Todo scan',
  inputs: [{ name: 'cmd', label: 'Command', default: 'grep -rn TODO .' }],
  nodes: [
    { id: 'scan', type: 'shell', command: '{{inputs.cmd}} || echo "HIVE_STOP: no todos"' },
    { id: 'tell', type: 'notify', title: 'TODOs', message: '{{scan.output}}' }
  ]
}

interface Harness {
  db: DB
  broker: AuthorBroker
  workflows: Map<string, Workflow>
  schedules: Schedule[]
  runs: Run[]
  asks: Ask[]
  closed: { askId: string; how: unknown }[]
  origins: WorkflowOrigin[]
}

function harness(over: Partial<BrokerDeps> = {}): Harness {
  const db = openDatabase(':memory:')
  const workflows = new Map<string, Workflow>()
  const schedules: Schedule[] = []
  const runs: Run[] = []
  const asks: Ask[] = []
  const closed: { askId: string; how: unknown }[] = []
  const origins: WorkflowOrigin[] = []
  let n = 0
  const id = (p: string) => `${p}_${String(++n).padStart(10, '0')}`
  const deps: BrokerDeps = {
    drafts: new AuthorDrafts(db),
    owner: (sessionId) =>
      sessionId === 's_0000000001'
        ? { kind: 'session', sessionId, agentId: 'ag_0000000001', ownerKey: 'claude:conv-1', ownerLabel: 'example-project · Claude', adapter: 'claude' }
        : sessionId === 's_0000000002'
          ? { kind: 'session', sessionId, agentId: null, ownerKey: 'claude:conv-2', ownerLabel: 'other · Claude', adapter: 'claude' }
          : null,
    ctx: () => ({
      profiles: PROFILES.map((p) => ({ id: p.id, name: p.name, adapter: p.adapter, permissionMode: p.permissionMode })),
      defaults: { claude: 'prof_claude0001', codex: 'prof_codex00001' },
      repos: [{ id: REPO.id, name: REPO.name, path: REPO.path, isGit: true }]
    }),
    providers: () => [],
    engineValidate: (d) => validateWorkflow(d, { getProfile: (pid) => PROFILES.find((p) => p.id === pid) ?? null, getRepo: (rid) => (rid === REPO.id ? REPO : null) }),
    defaultBranch: async () => 'main',
    listWorkflows: () => [...workflows.values()],
    getWorkflow: (wid) => workflows.get(wid) ?? null,
    listSchedules: () => schedules,
    lastRun: () => null,
    getRunDetail: (rid) => {
      const r = runs.find((x) => x.id === rid)
      return r ? { run: r, steps: [], workflow: null } : null
    },
    activeAgentRuns: (key) => runs.filter((r) => r.startedBy?.ownerKey === key && (r.status === 'queued' || r.status === 'running')).length,
    previewSchedule: (when: ScheduleWhen) =>
      when.kind === 'cron' && when.cron === '* * * * *'
        ? { ok: false, sentence: '', next: [], error: 'Minimum interval is 5 minutes' }
        : { ok: true, sentence: 'Every weekday at 9:00', next: [ts], error: null },
    saveWorkflow: (draft: WorkflowDraft, origin) => {
      origins.push(origin)
      const wf: Workflow = { ...draft, id: id('wf'), createdAt: ts, updatedAt: ts, origin }
      workflows.set(wf.id, wf)
      return wf
    },
    updateWorkflow: (wid, draft) => {
      const cur = workflows.get(wid)!
      const wf: Workflow = { ...cur, ...draft, updatedAt: ts }
      workflows.set(wid, wf)
      return wf
    },
    setOrigin: (wid, origin) => {
      const cur = workflows.get(wid)!
      workflows.set(wid, { ...cur, origin })
    },
    createSchedule: (input) => {
      const s = { id: id('sch'), name: input.name, target: { kind: 'workflow', workflowId: input.workflowId, inputs: input.inputs }, when: input.when, enabled: input.enabled !== false, sentence: 'Every weekday at 9:00', nextFireAt: ts } as unknown as Schedule
      schedules.push(s)
      return s
    },
    startRun: (workflowId, inputs, startedBy) => {
      const r = { id: id('r'), workflowId, status: 'running', target: { kind: 'workflow', workflowId, inputs }, startedBy } as unknown as Run
      runs.push(r)
      return r
    },
    openAsk: (rec) => {
      const a = { id: id('ask'), draftId: rec.id, status: 'open' } as unknown as Ask
      asks.push(a)
      return a
    },
    closeAsk: (askId, how) => closed.push({ askId, how }),
    emitDraft: () => undefined,
    changed: () => undefined,
    tz: () => 'Europe/Madrid',
    ...over
  }
  return { db, broker: new AuthorBroker(deps), workflows, schedules, runs, asks, closed, origins }
}

const signal = () => new AbortController().signal
const flush = () => new Promise((r) => setTimeout(r, 0))

let h: Harness
beforeEach(() => {
  h = harness()
})

describe('PO1 and the tool surface', () => {
  it('refuses step owners and unknown tools; answers through the owner channel only', async () => {
    const answers: [string, unknown][] = []
    h.broker.handleCall({ stepId: 'st_0000000001', runId: 'r_0000000001' }, { hive: 'author_call', call_id: 'hac_0000000001', tool: 'hive_workflow_create', args: {} }, (c, p) => answers.push([c, p]))
    h.broker.handleCall({ sessionId: 's_0000000001' }, { hive: 'author_call', call_id: 'hac_0000000002', tool: 'hive_secrets_set', args: {} }, (c, p) => answers.push([c, p]))
    await flush()
    // SLACK.md SA2 / §13.2 #15: a step owner may call only the slack toolset; an authoring tool is unknown to it
    expect(answers[0]).toEqual(['hac_0000000001', { ok: false, error: 'Unknown tool: hive_workflow_create' }])
    expect(answers[1]).toEqual(['hac_0000000002', { ok: false, error: 'Unknown tool: hive_secrets_set' }])
    expect(h.db.prepare('SELECT count(*) AS n FROM author_drafts').get()).toEqual({ n: 0 })
  })

  it('read tools: schema, profiles (no secrets), repos with default branch', async () => {
    const answers: unknown[] = []
    for (const [i, tool] of ['hive_workflow_schema', 'hive_profiles_list', 'hive_repos_list'].entries()) {
      h.broker.handleCall({ sessionId: 's_0000000001' }, { hive: 'author_call', call_id: `hac_000000000${i}`, tool, args: {} }, (_c, p) => answers.push(p))
    }
    await flush()
    await flush()
    const [schema, profiles, repos] = answers as { ok: true; result: Record<string, unknown> }[]
    expect(schema.result.examples).toBeDefined()
    expect(JSON.stringify(profiles.result)).not.toMatch(/secretNames|extraArgs/)
    expect((profiles.result.defaults as Record<string, string>).claude).toBe('prof_claude0001')
    expect((repos.result.repos as { defaultBranch: string }[])[0].defaultBranch).toBe('main')
  })
})

describe('create / decide (PO2: one card, one click)', () => {
  it('blocks until approved; one click saves with provenance and creates the schedule', async () => {
    const p = h.broker.dispatch(
      's_0000000001',
      'hive_workflow_create',
      { workflow: SIMPLE, summary: 'Scans TODOs every weekday', schedule: { when: { kind: 'cron', cron: '0 9 * * 1-5' } }, wait_s: 60 },
      signal()
    )
    await flush()
    expect(h.asks).toHaveLength(1)
    const draftId = (h.asks[0] as unknown as { draftId: string }).draftId
    const detail = h.broker.get(draftId)
    expect(detail.flags.scheduleSentence).toBe('Every weekday at 9:00')
    expect(detail.flags.shellInputs).toEqual(['cmd'])
    expect(detail.scheduleRequest?.when).toEqual({ kind: 'cron', cron: '0 9 * * 1-5', tz: 'Europe/Madrid' })
    expect(h.broker.approveLabel(draftId)).toBe('Approve & schedule')
    h.broker.decide({ id: draftId, decision: 'approve', allowRun: true })
    const r = await p
    expect(r).toMatchObject({ status: 'approved', draft_id: draftId, edited: false, run_allowed: true, schedule_id: expect.any(String) })
    expect(h.workflows.size).toBe(1)
    expect(h.schedules).toHaveLength(1)
    expect(h.origins[0]).toMatchObject({ kind: 'agent', ownerKey: 'claude:conv-1', ownerLabel: 'example-project · Claude', draftId })
    expect(h.closed[0].how).toMatchObject({ status: 'answered', optionId: 'approve' })
    expect(() => h.broker.decide({ id: draftId, decision: 'reject' })).toThrow(/already approved/)
  })

  it('schedule.enabled:false creates the schedule paused ("schedule it but don\'t enable it yet")', async () => {
    const p = h.broker.dispatch(
      's_0000000001',
      'hive_workflow_create',
      { workflow: SIMPLE, summary: 'Scans TODOs every weekday, paused', schedule: { when: { kind: 'cron', cron: '0 9 * * 1-5' }, enabled: false }, wait_s: 60 },
      signal()
    )
    await flush()
    const draftId = (h.asks[0] as unknown as { draftId: string }).draftId
    const detail = h.broker.get(draftId)
    expect(detail.scheduleRequest).toMatchObject({ enabled: false, next: [] })
    expect(detail.flags.scheduleSentence).toMatch(/paused/)
    expect(h.broker.approveLabel(draftId)).toBe('Approve & add paused schedule')
    h.broker.decide({ id: draftId, decision: 'approve' })
    expect(await p).toMatchObject({ status: 'approved', schedule_id: expect.any(String), schedule_enabled: false })
    expect(h.schedules[0].enabled).toBe(false)
    const bad = await h.broker.dispatch('s_0000000001', 'hive_workflow_create', { workflow: SIMPLE, summary: 'Scans TODOs every weekday', schedule: { when: { kind: 'cron', cron: '0 9 * * 1-5' }, enabled: 'no' } }, signal())
    expect(bad).toMatchObject({ status: 'invalid', errors: [{ path: 'schedule.enabled' }] })
  })

  it('a check may wait for a node downstream of its target (loop body); anything else is an error, never a silent rewrite', async () => {
    const wf = (after: string[]) => ({
      name: 'Combine and review',
      nodes: [
        { id: 'scan', type: 'shell', command: 'gh pr list > "$ARTIFACTS_DIR/prs.txt"' },
        { id: 'combine', type: 'agent', profileId: 'claude', prompt: 'combine', after: ['scan'] },
        { id: 'wait_codex', type: 'wait', command: 'test -s "$ARTIFACTS_DIR/codex.txt"', after: ['combine'], intervalSec: 60, onTimeout: 'continue' },
        { id: 'review', type: 'check', target: 'combine', profileId: 'claude', criteria: 'ok', after }
      ]
    })
    const ok = await h.broker.dispatch('s_0000000001', 'hive_workflow_validate', { workflow: wf(['wait_codex']) }, signal())
    expect(ok).toMatchObject({ ok: true })
    const review = (ok.normalized as { nodes: { id: string; after: string[] }[] }).nodes.find((n) => n.id === 'review')!
    expect(review.after).toEqual(['wait_codex'])
    expect(JSON.stringify(ok.warnings)).toMatch(/combine -> wait_codex/)
    const def = await h.broker.dispatch('s_0000000001', 'hive_workflow_validate', { workflow: wf([]) }, signal())
    expect((def.normalized as { nodes: { id: string; after: string[] }[] }).nodes.find((n) => n.id === 'review')!.after).toEqual(['combine'])
    const bad = await h.broker.dispatch('s_0000000001', 'hive_workflow_validate', { workflow: wf(['scan']) }, signal())
    expect(bad).toMatchObject({ ok: false })
    expect(JSON.stringify(bad.errors)).toMatch(/scan.{0,6} is not downstream of .{0,6}combine/)
  })

  it('reject with a note goes back to the agent', async () => {
    const p = h.broker.dispatch('s_0000000001', 'hive_workflow_create', { workflow: SIMPLE, summary: 'Scans TODOs on demand', wait_s: 60 }, signal())
    await flush()
    const draftId = (h.asks[0] as unknown as { draftId: string }).draftId
    h.broker.decide({ id: draftId, decision: 'reject', note: 'Use rg instead of grep' })
    expect(await p).toEqual({ status: 'rejected', draft_id: draftId, note: 'Use rg instead of grep' })
    expect(h.workflows.size).toBe(0)
  })

  it('invalid drafts never reach a card; PO4 output-in-shell is an error', async () => {
    const bad = { name: 'x', nodes: [{ id: 'a', type: 'agent', profileId: 'claude', prompt: 'p' }, { id: 'b', type: 'shell', command: 'gh pr view {{a.output}}' }] }
    const r = await h.broker.dispatch('s_0000000001', 'hive_workflow_create', { workflow: bad, summary: 'does a thing with a PR' }, signal())
    expect(r.status).toBe('invalid')
    expect(JSON.stringify(r.errors)).toMatch(/ARTIFACTS_DIR/)
    const bs = await h.broker.dispatch('s_0000000001', 'hive_workflow_create', { workflow: SIMPLE, summary: 'Scans TODOs every minute', schedule: { when: { kind: 'cron', cron: '* * * * *' } } }, signal())
    expect(bs).toMatchObject({ status: 'invalid', errors: [{ path: 'schedule.when', message: 'Minimum interval is 5 minutes' }] })
    expect(h.asks).toHaveLength(0)
  })

  it('wait_s 0 returns pending; identical drafts are reused; draft_status follows the decision', async () => {
    const a = await h.broker.dispatch('s_0000000001', 'hive_workflow_create', { workflow: SIMPLE, summary: 'Scans TODOs on demand', wait_s: 0 }, signal())
    const b = await h.broker.dispatch('s_0000000001', 'hive_workflow_create', { workflow: SIMPLE, summary: 'Scans TODOs on demand', wait_s: 0 }, signal())
    expect(a.status).toBe('pending')
    expect(b.draft_id).toBe(a.draft_id)
    expect(h.asks).toHaveLength(1)
    const waiting = h.broker.dispatch('s_0000000001', 'hive_draft_status', { draft_id: a.draft_id, wait_s: 30 }, signal())
    await expect(h.broker.dispatch('s_0000000002', 'hive_draft_status', { draft_id: a.draft_id }, signal())).rejects.toThrow(/own drafts/)
    h.broker.decide({ id: String(a.draft_id), decision: 'approve' })
    expect(await waiting).toMatchObject({ status: 'approved' })
  })

  it('the full Superlog paragraph example is one card and one click (PO10 shape)', async () => {
    const p = h.broker.dispatch(
      's_0000000001',
      'hive_workflow_create',
      {
        workflow: EXAMPLES[0].workflow,
        summary: 'Weekday PR roundup with Claude and Codex, fix in a worktree, text me',
        schedule: { name: 'PR roundup weekdays', when: { kind: 'cron', cron: '0 9 * * 1-5' }, inputs: { repo: REPO.id } },
        wait_s: 60
      },
      signal()
    )
    await flush()
    expect(h.asks).toHaveLength(1)
    h.broker.decide({ id: (h.asks[0] as unknown as { draftId: string }).draftId, decision: 'approve' })
    expect(await p).toMatchObject({ status: 'approved', schedule_id: expect.any(String) })
    expect(h.schedules[0].target).toMatchObject({ kind: 'workflow', inputs: { repo: REPO.id } })
  })

  it('a canceled call stops waiting and writes nothing; the draft stays pending', async () => {
    const answers: unknown[] = []
    h.broker.handleCall({ sessionId: 's_0000000001' }, { hive: 'author_call', call_id: 'hac_00000000aa', tool: 'hive_workflow_create', args: { workflow: SIMPLE, summary: 'Scans TODOs on demand' } }, (_c, p) => answers.push(p))
    await flush()
    h.broker.handleCancel({ sessionId: 's_0000000001' }, { hive: 'author_cancelled', call_id: 'hac_00000000aa' })
    await flush()
    expect(answers).toEqual([])
    expect(h.broker.list()).toHaveLength(1)
  })
})

describe('update (PO8) and run permissions (PO3)', () => {
  async function created(allowRun: boolean): Promise<string> {
    const p = h.broker.dispatch('s_0000000001', 'hive_workflow_create', { workflow: SIMPLE, summary: 'Scans TODOs on demand', wait_s: 60 }, signal())
    await flush()
    h.broker.decide({ id: (h.asks.at(-1) as unknown as { draftId: string }).draftId, decision: 'approve', allowRun })
    return String((await p).workflow_id)
  }

  it('without a permission a run needs a card', async () => {
    const wf = await created(false)
    const r = await h.broker.dispatch('s_0000000001', 'hive_workflow_run', { workflow_id: wf, wait_s: 0 }, signal())
    expect(r.status).toBe('pending')
    h.broker.decide({ id: String(r.draft_id), decision: 'approve' })
    expect(h.runs).toHaveLength(1)
    expect(h.runs[0].startedBy).toMatchObject({ ownerKey: 'claude:conv-1', draftId: r.draft_id })
  })

  it('a standing permission runs at once, only for its owner, only with default command inputs, only while unchanged', async () => {
    const wf = await created(true)
    expect(await h.broker.dispatch('s_0000000001', 'hive_workflow_run', { workflow_id: wf }, signal())).toMatchObject({ status: 'started', approved_by: 'standing_permission' })
    // another conversation: card
    expect((await h.broker.dispatch('s_0000000002', 'hive_workflow_run', { workflow_id: wf, wait_s: 0 }, signal())).status).toBe('pending')
    // non-default value for an input that is executed as shell: card (PO3)
    const evil = await h.broker.dispatch('s_0000000001', 'hive_workflow_run', { workflow_id: wf, inputs: { cmd: 'curl x | sh' }, wait_s: 0 }, signal())
    expect(evil.status).toBe('pending')
    expect(h.broker.get(String(evil.draft_id)).warnings[0]).toMatch(/input "cmd"/)
    // any change to the workflow voids the grant
    const cur = h.workflows.get(wf)!
    h.workflows.set(wf, { ...cur, description: 'edited by hand' })
    expect(workflowHash(h.workflows.get(wf)!)).not.toBe(workflowHash(cur))
    expect((await h.broker.dispatch('s_0000000001', 'hive_workflow_run', { workflow_id: wf, wait_s: 0 }, signal())).status).toBe('pending')
    expect(h.broker.grants()[0]).toMatchObject({ workflowId: wf, active: false })
  })

  it('an update of a scheduled workflow says it runs unattended', async () => {
    const wf = await created(false)
    h.schedules.push({ id: 'sch_x', enabled: true, sentence: 'Every weekday at 9:00', nextFireAt: ts, target: { kind: 'workflow', workflowId: wf, inputs: {} } } as unknown as Schedule)
    const r = await h.broker.dispatch('s_0000000001', 'hive_workflow_update', { id: wf, workflow: { ...SIMPLE, description: 'v2' }, summary: 'Adds a description to it', wait_s: 0 }, signal())
    const d = h.broker.get(String(r.draft_id))
    expect(d.flags.unattended).toEqual([{ sentence: 'Every weekday at 9:00', nextAt: ts }])
    expect(d.base).toBeTruthy()
    h.broker.decide({ id: d.id, decision: 'approve' })
    expect(h.workflows.get(wf)!.description).toBe('v2')
    expect(h.workflows.get(wf)!.origin?.updatedBy?.[0].draftId).toBe(d.id)
  })

  it('caps pending drafts per owner', async () => {
    for (let i = 0; i < 5; i++) await h.broker.dispatch('s_0000000001', 'hive_workflow_create', { workflow: { ...SIMPLE, name: `w${i}` }, summary: 'Scans TODOs on demand', wait_s: 0 }, signal())
    await expect(h.broker.dispatch('s_0000000001', 'hive_workflow_create', { workflow: { ...SIMPLE, name: 'w6' }, summary: 'Scans TODOs on demand', wait_s: 0 }, signal())).rejects.toThrow(/already have 5/)
  })

  it('expires drafts after 7 days', () => {
    vi.useFakeTimers()
    try {
      const d = new AuthorDrafts(h.db, (s) => s, () => new Date('2026-10-01T00:00:00Z'))
      d.insert({
        kind: 'run',
        owner: { kind: 'session', sessionId: 's_0000000001', agentId: null, ownerKey: 'k', ownerLabel: 'l', adapter: 'claude' },
        summary: 'run it please',
        workflowId: 'wf_0000000001',
        workflowName: 'x',
        payload: { inputs: {}, reason: null },
        base: null,
        schedule: null,
        runNow: null,
        flags: { shellCommands: 0, worktreeRepo: null, pushes: false, bypassAgents: 0, memoryWrite: false, scheduleSentence: null, inputs: null },
        warnings: []
      })
      expect(h.broker.sweep()).toBe(1)
      expect(h.broker.list({ status: ['expired'] })).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('typed dry_run (item 1)', () => {
  const PUSHER = (dry: Record<string, unknown>) => ({
    name: 'Ship fix',
    inputs: [{ name: 'repo', label: 'Repository', type: 'repo', default: REPO.id }, dry],
    worktree: { repo: '{{inputs.repo}}' },
    nodes: [
      { id: 'fix', type: 'agent', profileId: 'claude', isolate: 'worktree', prompt: 'Fix it and commit.' },
      { id: 'push', type: 'shell', isolate: 'worktree', after: ['fix'], command: 'if [ "{{inputs.dry_run}}" = true ]; then echo would push; else git push origin HEAD:refs/heads/hive/fix; fi' }
    ]
  })

  it('hive_workflow_validate rejects a push step gated on a free-text dry_run; a boolean one passes', async () => {
    const bad = await h.broker.dispatch('s_0000000001', 'hive_workflow_validate', { workflow: PUSHER({ name: 'dry_run', label: 'Dry run', default: 'true' }) }, signal())
    expect(bad).toMatchObject({ ok: false })
    expect(JSON.stringify(bad.errors)).toMatch(/Input \\"dry_run\\" is a free-text flag but node \\"push\\" pushes/)
    const ok = await h.broker.dispatch('s_0000000001', 'hive_workflow_validate', { workflow: PUSHER({ name: 'dry_run', label: 'Dry run', type: 'boolean', default: true }) }, signal())
    expect(ok.errors).toEqual([])
    const input = (ok.normalized as WorkflowDraft).inputs.find((i) => i.name === 'dry_run')
    expect(input).toEqual({ name: 'dry_run', label: 'Dry run', type: 'boolean', default: 'true' })
    // the card shows the enforced policy, with the dry-run rule and the repo name (never a raw template)
    const create = h.broker.dispatch('s_0000000001', 'hive_workflow_create', { workflow: PUSHER({ name: 'dry_run', label: 'Dry run', type: 'boolean', default: 'true' }), summary: 'Fixes and pushes to a hive branch', wait_s: 60 }, signal())
    await flush()
    const detail = h.broker.get((h.asks.at(-1) as unknown as { draftId: string }).draftId)
    expect(detail.flags.pushPolicy).toMatch(/Can push only hive\/\*; never the default or base branch/)
    expect(detail.flags.pushPolicy).toMatch(/with dry_run checked every push is refused/)
    expect(detail.flags.worktreeRepo).toBe('example-project')
    h.broker.decide({ id: detail.id, decision: 'reject' })
    await create
    // an unknown type is reported, never silently turned into free text
    const typo = await h.broker.dispatch('s_0000000001', 'hive_workflow_validate', { workflow: PUSHER({ name: 'dry_run', label: 'Dry run', type: 'checkbox' }) }, signal())
    expect(typo).toMatchObject({ ok: false })
    expect(JSON.stringify(typo.errors)).toMatch(/inputs\.1\.type/)
  })

  it('run inputs: true/false (or booleans) only; anything else is refused', async () => {
    const wf = { ...(PUSHER({ name: 'dry_run', label: 'Dry run', type: 'boolean', default: 'true' }) as unknown as WorkflowDraft), id: 'wf_00000000dr', createdAt: ts, updatedAt: ts } as Workflow
    wf.inputs = [{ name: 'repo', label: 'Repository', type: 'repo', default: REPO.id }, { name: 'dry_run', label: 'Dry run', type: 'boolean', default: 'true' }]
    h.workflows.set(wf.id, wf)
    const typo = await h.broker.dispatch('s_0000000001', 'hive_workflow_run', { workflow_id: wf.id, inputs: { dry_run: 'flase' }, wait_s: 0 }, signal())
    expect(typo).toMatchObject({ status: 'invalid' })
    expect(JSON.stringify(typo.errors)).toMatch(/must be true or false/)
    const ok = await h.broker.dispatch('s_0000000001', 'hive_workflow_run', { workflow_id: wf.id, inputs: { dry_run: false }, wait_s: 0 }, signal())
    expect(ok.status).toBe('pending')
    expect(h.broker.get(String(ok.draft_id)).run?.inputs).toEqual({ dry_run: 'false' })
  })

  it('hive_workflow_schema teaches boolean inputs and the check loop body with a wait node', () => {
    const s = JSON.stringify(h.broker.schema('all'))
    expect(s).toMatch(/'text'\|'multiline'\|'repo'\|'boolean'/)
    expect(s).toMatch(/MUST be type 'boolean'/)
    expect(s).toMatch(/wait_codex \(wait, after \['combine'\]\) -> pr_review \(check, target 'combine', after \['wait_codex'\]\)/)
    expect(s).toMatch(/never poll or sleep inside an agent prompt/)
  })

  it('hive_workflow_schema teaches Slack triggers in all and in its own slack topic (never a polling schedule)', () => {
    for (const topic of ['all', 'slack']) {
      const s = JSON.stringify(h.broker.schema(topic))
      expect(s).toContain('slack_trigger')
      expect(s).toContain('{{trigger.text}}')
      expect(s).toContain('{{trigger.thread}}')
      expect(s).toMatch(/NEVER build a polling schedule/)
      expect(s).toMatch(/unsafe_full_permissions/)
      expect(s).toContain('Answer @hive mentions in #support')
    }
    // templating no longer says "Nothing else" without the trigger variables
    expect(JSON.stringify(h.broker.schema('templating'))).toContain('{{trigger.channel}}')
  })
})

describe('SLACK.md §9.5: slack_trigger rides on create (one card, one click)', () => {
  const triggerDeps = (saved: unknown[]): BrokerDeps['slackTriggers'] => ({
    prepare: (raw) => {
      const r = raw as { reply_mode?: string; on?: string[]; channels?: string[] }
      if (r.reply_mode === 'auto' && r.on?.includes('message')) return { errors: [{ path: 'slack_trigger.reply.mode', message: 'Auto replies on "any message" need at least one keyword, regex or person filter' }] }
      return {
        input: { name: 'Support', workflowId: 'wf_pending0000', match: { on: (r.on ?? ['mention']) as never, channels: r.channels ?? [], keywords: [], regex: null, fromUsers: [] }, reply: { mode: (r.reply_mode ?? 'draft') as never, autoChannels: [], replyNode: 'scan' } },
        flag: { sentence: 'When @hive is mentioned · replies as drafts', replyMode: (r.reply_mode ?? 'draft') as never, autoChannels: [] }
      }
    },
    save: (input, workflowId) => saved.push({ input, workflowId }),
    connected: () => false,
    alertUserId: () => null,
    channelName: (id) => id
  })

  it('auto on `message` without a filter never reaches a card; a draft-mode trigger is created on approve', async () => {
    const saved: unknown[] = []
    const hh = harness({ slackTriggers: triggerDeps(saved) })
    const bad = await hh.broker.dispatch('s_0000000001', 'hive_workflow_create', { workflow: SIMPLE, summary: 'scan todos and tell me', slack_trigger: { on: ['message'], channels: ['C1'], reply_mode: 'auto' }, wait_s: 0 }, signal())
    expect(bad.status).toBe('invalid')
    expect(hh.asks).toHaveLength(0)
    const ok = await hh.broker.dispatch('s_0000000001', 'hive_workflow_create', { workflow: SIMPLE, summary: 'scan todos and tell me', slack_trigger: { on: ['mention'] }, wait_s: 0 }, signal())
    expect(ok.status).toBe('pending')
    const id = ok.draft_id as string
    const detail = hh.broker.get(id)
    expect(detail.slackTrigger?.match.on).toEqual(['mention'])
    expect(detail.flags.slackTrigger).toEqual({ sentence: 'When @hive is mentioned · replies as drafts', replyMode: 'draft', autoChannels: [] })
    expect(detail.flags.slackNotConnected).toBe(true)
    hh.broker.decide({ id, decision: 'approve' })
    expect(saved).toHaveLength(1)
    expect((saved[0] as { workflowId: string }).workflowId).toMatch(/^wf_/)
  })

  it('a step owner can call slack tools but never authoring tools', async () => {
    const calls: string[] = []
    const hh = harness({ slack: { call: async (_o, tool) => (calls.push(tool), { ok: 1 }) } })
    const answers: [string, unknown][] = []
    hh.broker.handleCall({ stepId: 'st_0000000001', runId: 'r_0000000001' }, { hive: 'author_call', call_id: 'hac_0000000009', tool: 'slack_list_channels', args: {} }, (c, p) => answers.push([c, p]))
    hh.broker.handleCall({ stepId: 'st_0000000001', runId: 'r_0000000001' }, { hive: 'author_call', call_id: 'hac_0000000010', tool: 'hive_workflow_run', args: {} }, (c, p) => answers.push([c, p]))
    await flush()
    expect(calls).toEqual(['slack_list_channels'])
    expect(answers).toEqual([
      ['hac_0000000010', { ok: false, error: 'Unknown tool: hive_workflow_run' }],
      ['hac_0000000009', { ok: true, result: { ok: 1 } }]
    ])
  })
})
