/** USAGE.md §1-2: usage:summary over seeded agents rows (cost rule, days, company / department / agent, plan limits). */
import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../db'
import { localDay, planLimits, rootCost, usageSummary } from './summary'

let db: DB
const NOW = new Date(2026, 9, 25, 15, 0, 0) // local
const daysAgo = (n: number, h = 10) => new Date(2026, 9, 25 - n, h, 0, 0).toISOString()

function agent(o: { id: string; company?: string | null; runId?: string; sessionId?: string; kind?: 'step' | 'session'; model?: string | null; tin?: number | null; tout?: number | null; cost?: number | null; at: string; parent?: string; split?: unknown }) {
  db.prepare(
    `INSERT INTO agents (id, kind, parent_id, root_id, session_id, run_id, provider, cwd, title, model, status, tokens_in, tokens_out, cost_usd, model_usage_json, started_at, updated_at, company_id)
     VALUES (?, ?, ?, ?, ?, ?, 'claude', '/tmp', 't', ?, 'done', ?, ?, ?, ?, ?, ?, ?)`
  ).run(o.id, o.parent ? 'subagent' : (o.kind ?? 'step'), o.parent ?? null, o.parent ?? o.id, o.sessionId ?? null, o.runId ?? null, o.model ?? null, o.tin ?? null, o.tout ?? null, o.cost ?? null, o.split ? JSON.stringify(o.split) : null, o.at, o.at, o.company === undefined ? 'co_acme' : o.company)
}
function run(id: string, o: { company?: string; taskId?: string; agentId?: string; stop?: boolean; reset?: string; ended?: string } = {}) {
  db.prepare(
    `INSERT INTO runs (id, kind, title, target_json, trigger, status, created_at, ended_at, artifacts_dir, company_id, task_id, agent_id, stop_reason, reset_at)
     VALUES (?, 'prompt', ?, '{}', 'manual', 'failed', ?, ?, '/tmp/a', ?, ?, ?, ?, ?)`
  ).run(id, `Run ${id}`, o.ended ?? daysAgo(1), o.ended ?? daysAgo(1), o.company ?? 'co_acme', o.taskId ?? null, o.agentId ?? null, o.stop ? 'rate_limited' : null, o.reset ?? null)
}

beforeEach(() => {
  db = openDatabase(':memory:')
  db.prepare("INSERT INTO company_passports (id, data) VALUES ('co_acme', ?)").run(JSON.stringify({ name: 'Acme' }))
  db.prepare("INSERT INTO company_departments (id, company_id, key, name) VALUES ('dep_mkt', 'co_acme', 'marketing', 'Marketing'), ('dep_eng', 'co_acme', 'eng', 'Engineering')").run()
  db.prepare("INSERT INTO company_agents (id, company_id, department_id, kind, ref_id, name) VALUES ('agt_copy', 'co_acme', 'dep_mkt', 'profile', 'prof_1', 'Copywriter')").run()
  db.prepare("INSERT INTO company_tasks (id, company_id, data, department_id, status) VALUES ('task_1', 'co_acme', '{}', 'dep_eng', 'done')").run()
})

const names = (id: string) => (id === 'co_acme' ? 'Acme' : id === 'co_personal' ? 'Personal' : id)

describe('rootCost', () => {
  it('reported cost wins, tokens only are estimated, unknown models are unpriced', () => {
    expect(rootCost({ model: 'claude-opus-5-5', tokens_in: 1_000_000, tokens_out: 0, cost_usd: 1.5, model_usage_json: null })).toEqual({ usd: 1.5, estimated: false, unpriced: false })
    expect(rootCost({ model: 'claude-opus-5-5', tokens_in: 1_000_000, tokens_out: 0, cost_usd: null, model_usage_json: null })).toEqual({ usd: 4, estimated: true, unpriced: false })
    expect(rootCost({ model: 'gpt-5-codex', tokens_in: 500, tokens_out: 500, cost_usd: null, model_usage_json: null })).toEqual({ usd: null, estimated: false, unpriced: true })
    expect(rootCost({ model: null, tokens_in: null, tokens_out: null, cost_usd: null, model_usage_json: null })).toEqual({ usd: null, estimated: false, unpriced: false })
  })
  it('uses the per-model split when the root has no cost', () => {
    const c = rootCost({ model: null, tokens_in: 2_000_000, tokens_out: 0, cost_usd: null, model_usage_json: JSON.stringify({ 'claude-opus-5-5': { tokensIn: 1_000_000, tokensOut: 0, costUsd: null }, 'claude-haiku-5-5': { tokensIn: 1_000_000, tokensOut: 0, costUsd: 0.2 } }) })
    expect(c.usd).toBeCloseTo(4.2)
    expect(c.estimated).toBe(true)
  })
})

describe('usageSummary', () => {
  beforeEach(() => {
    run('r_task', { taskId: 'task_1' })
    run('r_seat', { agentId: 'agt_copy' })
    run('r_plain')
    agent({ id: 'agent_a', runId: 'r_task', model: 'claude-opus-5-5', tin: 1000, tout: 100, cost: 0.5, at: daysAgo(0) })
    agent({ id: 'agent_b', runId: 'r_seat', model: 'claude-opus-5-5', tin: 1_000_000, tout: 0, cost: null, at: daysAgo(1) })
    agent({ id: 'agent_c', runId: 'r_plain', model: 'gpt-5-codex', tin: 300, tout: 200, cost: null, at: daysAgo(2) })
    agent({ id: 'agent_d', company: null, kind: 'session', model: 'claude-sonnet-5', tin: 10, tout: 10, cost: 0.25, at: daysAgo(3) })
    agent({ id: 'agent_old', model: 'claude-opus-5-5', cost: 9, tin: 1, tout: 1, at: daysAgo(20) })
    // a subagent never counts on its own (its root's numbers include it)
    agent({ id: 'agent_sub', parent: 'agent_a', model: 'claude-opus-5-5', cost: 7, at: daysAgo(0) })
  })

  it('daily bars add up to reported cost plus estimates', () => {
    const s = usageSummary({ db, companyName: names, now: () => NOW }, { range: '7d' })
    expect(s.days).toHaveLength(7)
    expect(s.days[6]!.date).toBe(localDay(NOW))
    const sum = s.days.reduce((n, d) => n + (d.usd ?? 0), 0)
    expect(sum).toBeCloseTo(0.5 + 4 + 0.25)
    expect(s.total.usd).toBeCloseTo(4.75)
    expect(s.total.estimated).toBe(true)
    expect(s.total.unpriced).toBe(true)
    const codexDay = s.days.find((d) => d.date === localDay(new Date(daysAgo(2))))!
    expect(codexDay.usd).toBeNull()
    expect(codexDay.tokensIn + codexDay.tokensOut).toBe(500)
    expect(s.priceSource).toMatch(/Anthropic/)
  })

  it('groups by company, department (task, then seat) and agent', () => {
    const s = usageSummary({ db, companyName: names, now: () => NOW }, { range: '7d' })
    expect(s.byCompany.map((r) => r.label).sort()).toEqual(['Acme', 'Personal'])
    const dep = Object.fromEntries(s.byDepartment.filter((r) => r.companyId === 'co_acme').map((r) => [r.label, r.usd]))
    expect(dep.Engineering).toBeCloseTo(0.5)
    expect(dep.Marketing).toBeCloseTo(4)
    expect(dep['No department']).toBeNull()
    expect(s.byAgent.find((r) => r.key === 'agt_copy')?.label).toBe('Copywriter')
  })

  it('30 days with a company: tables filter and departments add up to the company total', () => {
    const s = usageSummary({ db, companyName: names, now: () => NOW }, { range: '30d', companyId: 'co_acme' })
    expect(s.days).toHaveLength(30)
    expect(s.byCompany.map((r) => r.companyId)).toEqual(['co_acme'])
    const co = s.byCompany[0]!
    const depUsd = s.byDepartment.reduce((n, r) => n + (r.usd ?? 0), 0)
    const depTok = s.byDepartment.reduce((n, r) => n + r.tokensIn + r.tokensOut, 0)
    expect(depUsd).toBeCloseTo(co.usd!)
    expect(depTok).toBe(co.tokensIn + co.tokensOut)
    expect(co.usd).toBeCloseTo(0.5 + 4 + 9)
    expect(s.byDepartment.every((r) => r.companyId === 'co_acme')).toBe(true)
  })

  it('five doors §4.9: the calendar week (since Monday) and month (since the 1st), and chats read as your own', () => {
    // NOW is Sunday Oct 25: the week is Mon 19 to Sun 25, the month Oct 1 to 25
    const w = usageSummary({ db, companyName: names, now: () => NOW }, { range: 'week' })
    expect(w.days).toHaveLength(7)
    expect(w.days[0]!.date).toBe('2026-10-19')
    expect(w.total.agents).toBe(4)
    const m = usageSummary({ db, companyName: names, now: () => NOW }, { range: 'month' })
    expect(m.days).toHaveLength(25)
    expect(m.days[0]!.date).toBe('2026-10-01')
    expect(m.total.agents).toBe(5)
    expect(m.total.usd).toBeCloseTo(4.75 + 9)
    // a chat with no agent seat is "Your own chats", a run with none "Other runs"
    expect(w.byAgent.map((r) => r.label)).toEqual(expect.arrayContaining(['Your own chats', 'Other runs', 'Copywriter']))
    expect(w.byAgent.some((r) => /no agent seat/.test(r.label))).toBe(false)
  })

  it('an agent row reads "Persona · Role" unless personas are off', () => {
    db.prepare("UPDATE company_agents SET data = ? WHERE id = 'agt_copy'").run(JSON.stringify({ persona: { name: 'Marcus', bust: 1 } }))
    expect(usageSummary({ db, companyName: names, now: () => NOW }, { range: '7d' }).byAgent.find((r) => r.key === 'agt_copy')?.label).toBe('Marcus · Copywriter')
    expect(usageSummary({ db, companyName: names, now: () => NOW, personas: false }, { range: '7d' }).byAgent.find((r) => r.key === 'agt_copy')?.label).toBe('Copywriter')
  })

  it('plan limits: unknown until a run hit one, then its reset time', () => {
    expect(planLimits(db)).toEqual({ state: 'unknown', lastHitAt: null, resetAt: null, source: null })
    const reset = new Date(NOW.getTime() + 3600_000).toISOString()
    run('r_limit', { stop: true, reset, ended: daysAgo(0, 14) })
    const l = usageSummary({ db, companyName: names, now: () => NOW }, { range: '7d' }).limits
    expect(l.state).toBe('seen')
    expect(l.resetAt).toBe(reset)
    expect(l.source?.runId).toBe('r_limit')
  })

  it('plan limits in another company scope: the time shows, the other company\'s run is not linked', () => {
    run('r_limit', { stop: true, reset: daysAgo(-1), ended: daysAgo(0, 14) })
    const beta = usageSummary({ db, companyName: names, now: () => NOW }, { range: '7d', companyId: 'co_beta' }).limits
    expect(beta.state).toBe('seen')
    expect(beta.lastHitAt).toBe(daysAgo(0, 14))
    expect(beta.source).toBeNull()
    expect(planLimits(db, 'co_acme').source?.runId).toBe('r_limit')
  })
})
