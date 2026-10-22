import { describe, expect, it } from 'vitest'
import { CSRF_HEADER } from '../../../shared/cloud'
import { consoleSession, startHarness, workflowFile, type Harness } from './harness'

const tick = () => new Promise(r => setTimeout(r, 15))
async function setup(h: Harness, quotas: Record<string, unknown> = {}) {
  const dev = await h.pair()
  for (const c of ['co_a', 'co_b']) await h.call('PUT', `/v1/companies/${c}`, { token: dev, body: { name: c.toUpperCase(), slug: c } })
  for (const c of ['co_a', 'co_b']) {
    await h.call('PUT', `/v1/companies/${c}/workflows/codex`, { token: dev, body: { file: workflowFile('Codex brief'), baseRev: null } })
    await h.call('PUT', `/v1/companies/${c}/workflows/claude`, { token: dev, body: { file: workflowFile('Claude brief', [{ id: 'm', type: 'agent', profileId: 'prof_claude', prompt: 'x' }]), baseRev: null } })
    await h.call('PUT', `/v1/companies/${c}/workflows/shell`, { token: dev, body: { file: workflowFile('Shell job', [{ id: 's', type: 'shell', command: 'echo hi' }]), baseRev: null } })
  }
  await h.call('PUT', '/v1/providers/claude/credential', { token: dev, body: { kind: 'anthropic_api_key', value: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz' } })
  if (Object.keys(quotas).length) expect((await h.call('PATCH', '/v1/workspace', { token: dev, body: { quotas } })).status).toBe(200)
  const run = async (cid: string, workflowId: string) => (await h.call('POST', `/v1/companies/${cid}/runs`, { token: dev, body: { kind: 'workflow', workflowId } }))
  const status = async (id: string) => (await h.call('GET', `/v1/runs/${id}`, { token: dev })).json.status as string
  return { dev, run, status }
}

describe('queue and dispatcher (CLOUD.md §9, §10)', () => {
  it('starts runs up to maxConcurrentRuns, oldest first, then the next when one ends', async () => {
    const h = await startHarness()
    try {
      const { run, status } = await setup(h, { maxConcurrentRuns: 2 })
      const ids: string[] = []
      for (let i = 0; i < 4; i++) { const r = await run('co_a', 'shell'); expect(r.status).toBe(202); ids.push(r.json.id) }
      await tick()
      expect(await Promise.all(ids.map(status))).toEqual(['running', 'running', 'queued', 'queued'])
      expect(h.rt.started.map(r => r.runId)).toEqual(ids.slice(0, 2))
      h.rt.finish(ids[1]!, 'passed', 'ok')
      await tick()
      expect(await Promise.all(ids.map(status))).toEqual(['running', 'passed', 'running', 'queued'])
      const req = h.rt.started[0]!
      expect(req).toMatchObject({ companyId: 'co_a', companyName: 'CO_A', trigger: 'desktop', timeoutMs: 60 * 60_000, target: { kind: 'workflow', workflowId: 'shell' } })
      expect((req.workflowFile as { workflow: { name: string } }).workflow.name).toBe('Shell job')
    } finally { await h.close() }
  })

  it('serializes runs that share one ChatGPT sign-in (codex_auth_json), but not API-key runs', async () => {
    const h = await startHarness()
    try {
      const { dev, run, status } = await setup(h, { maxConcurrentRuns: 4 })
      await h.call('PUT', '/v1/providers/codex/credential', { token: dev, body: { kind: 'codex_auth_json', value: JSON.stringify({ tokens: { refresh_token: 'rt-0123456789abcdef' } }) } })
      const a = (await run('co_a', 'codex')).json.id
      const b = (await run('co_b', 'codex')).json.id
      const c = (await run('co_a', 'claude')).json.id
      await tick()
      expect([await status(a), await status(b), await status(c)]).toEqual(['running', 'queued', 'running'])
      h.rt.finish(a, 'passed')
      await tick()
      expect(await status(b)).toBe('running')
      h.rt.finish(b, 'passed')
      // an API key does not serialize
      await h.call('PUT', '/v1/providers/codex/credential', { token: dev, body: { kind: 'openai_api_key', value: 'sk-proj-abcdefghijklmnopqrstuvwxyz' } })
      const d = (await run('co_a', 'codex')).json.id
      const e = (await run('co_b', 'codex')).json.id
      await tick()
      expect([await status(d), await status(e)]).toEqual(['running', 'running'])
    } finally { await h.close() }
  })

  it('a run whose account is missing fails with the readiness sentence instead of starting', async () => {
    const h = await startHarness()
    try {
      const { run, status } = await setup(h)
      const id = (await run('co_a', 'codex')).json.id
      await tick()
      expect(await status(id)).toBe('failed')
      expect(h.rt.started).toHaveLength(0)
      expect((await h.call('GET', `/v1/runs/${id}`, { token: (await h.pair()) })).json.summary).toBe('Codex brief uses Codex. Sign in with ChatGPT.')
    } finally { await h.close() }
  })

  it('refuses runs over maxRunsPerDay (429) and holds queued runs over maxRunMinutesPerDay', async () => {
    let t = Date.parse('2026-10-21T09:00:00Z')
    const h = await startHarness({ now: () => new Date(t) })
    try {
      const { run, status } = await setup(h, { maxRunsPerDay: 2, maxRunMinutesPerDay: 30, maxConcurrentRuns: 4 })
      const a = (await run('co_a', 'shell')).json.id
      const b = (await run('co_a', 'shell')).json.id
      const third = await run('co_a', 'shell')
      expect([third.status, third.json.error]).toEqual([429, 'quota_exceeded'])
      expect((await run('co_b', 'shell')).status).toBe(202)
      t += 31 * 60_000
      await tick()
      h.rt.finish(a, 'passed')
      await h.call('PATCH', '/v1/workspace', { token: (await h.pair()), body: { quotas: { maxRunsPerDay: 100 } } })
      const refusedByMinutes = await run('co_a', 'shell')
      expect([refusedByMinutes.status, refusedByMinutes.json.message]).toEqual([429, 'CO_A used its 30 run minutes for the last 24 hours.'])
      h.rt.finish(b, 'passed')
      t += 24 * 3600_000
      const later = await run('co_a', 'shell')
      expect(later.status).toBe(202)
      await tick()
      expect(await status(later.json.id)).toBe('running')
      const audit = (await h.call('GET', '/v1/audit?limit=500', { token: (await h.pair()) })).json
      expect(audit.some((e: { action: string }) => e.action === 'run.refused')).toBe(true)
    } finally { await h.close() }
  })

  it('pausing the workspace cancels running and queued runs, refuses new ones, and resumes cleanly', async () => {
    const h = await startHarness()
    try {
      const { dev, run, status } = await setup(h, { maxConcurrentRuns: 1 })
      const a = (await run('co_a', 'shell')).json.id
      const b = (await run('co_a', 'shell')).json.id
      await tick()
      const s = await consoleSession(h, dev)
      const p = await h.call('PATCH', '/v1/workspace', { headers: { cookie: s.cookie, [CSRF_HEADER]: s.csrf }, body: { paused: true } })
      expect(p.json.paused).toBe(true)
      expect([await status(a), await status(b)]).toEqual(['canceled', 'canceled'])
      expect(h.rt.calls.some(c => c.method === 'cancelRun' && c.args[0] === a)).toBe(true)
      const refused = await run('co_a', 'shell')
      expect([refused.status, refused.json.error]).toEqual([409, 'paused'])
      expect(h.app.ports.requestRun({ companyId: 'co_a', trigger: 'schedule', target: { kind: 'workflow', workflowId: 'shell', inputs: {} } }).refused).toMatch(/paused/)
      await h.call('PATCH', '/v1/workspace', { token: dev, body: { paused: false } })
      const c = (await run('co_a', 'shell')).json.id
      await tick()
      expect(await status(c)).toBe('running')
      // company pause cancels only that company
      const other = (await run('co_b', 'shell')).json.id
      await h.call('PATCH', '/v1/companies/co_a', { token: dev, body: { paused: true } })
      expect(await status(c)).toBe('canceled')
      await tick()
      expect(await status(other)).toBe('running')
      // cancel from the console
      const cc = await h.call('POST', `/v1/runs/${other}/cancel`, { headers: { cookie: s.cookie, [CSRF_HEADER]: s.csrf } })
      expect(cc.json.status).toBe('canceled')
    } finally { await h.close() }
  })

  it('the monthly API spend cap pauses the company and opens an ask; answering Resume resumes it', async () => {
    const h = await startHarness()
    try {
      const { dev, run } = await setup(h, { monthlyApiUsdPerCompany: 5 })
      const a = (await run('co_a', 'claude')).json.id
      await tick()
      h.app.ports.usage({ runId: a, companyId: 'co_a', adapter: 'claude', inputTokens: 1000, outputTokens: 200, usd: 5.5 })
      const co = (await h.call('GET', '/v1/companies', { token: dev })).json.find((c: { id: string }) => c.id === 'co_a')
      expect(co.paused).toBe(true)
      const asks = (await h.call('GET', '/v1/asks', { token: dev })).json
      expect(asks).toHaveLength(1)
      expect(asks[0]).toMatchObject({ companyId: 'co_a', agentName: 'Principia Cloud', options: ['Resume', 'Keep paused'], status: 'open' })
      expect((await run('co_a', 'shell')).status).toBe(409)
      const ans = await h.call('POST', `/v1/asks/${asks[0].id}/answer`, { token: dev, body: { answer: 'Resume' } })
      expect(ans.json.status).toBe('answered')
      expect(h.rt.calls.some(c => c.method === 'answerAsk')).toBe(false)
      // still over the cap: the next request pauses again
      expect((await run('co_a', 'shell')).status).toBe(429)
    } finally { await h.close() }
  })

  it('agent asks: open through ports, answer from the console wakes the runtime, a second answer is 409', async () => {
    const h = await startHarness()
    try {
      const { dev, run, status } = await setup(h)
      const id = (await run('co_a', 'shell')).json.id
      await tick()
      const askId = h.app.ports.openAsk({ companyId: 'co_a', runId: id, agentName: 'Marcus · Copywriter', question: 'Ship today or Thursday?', options: ['Today', 'Thursday'] })
      h.rt.finish(id, 'needs_input', 'Waiting for an answer')
      expect(await status(id)).toBe('needs_input')
      const s = await consoleSession(h, dev)
      expect((await h.call('POST', `/v1/asks/${askId}/answer`, { headers: { cookie: s.cookie, [CSRF_HEADER]: s.csrf }, body: { answer: '' } })).status).toBe(400)
      const a = await h.call('POST', `/v1/asks/${askId}/answer`, { headers: { cookie: s.cookie, [CSRF_HEADER]: s.csrf }, body: { answer: 'Thursday' } })
      expect(a.json).toMatchObject({ status: 'answered', answer: 'Thursday' })
      expect(h.rt.calls.find(c => c.method === 'answerAsk')!.args).toEqual([askId, 'Thursday'])
      expect((await h.call('POST', `/v1/asks/${askId}/answer`, { token: dev, body: { answer: 'Today' } })).status).toBe(409)
      expect((await h.call('GET', '/v1/asks', { token: dev })).json).toEqual([])
      expect((await h.call('GET', '/v1/asks?status=all', { token: dev })).json).toHaveLength(1)
      // the runtime asks for a resume run with trigger 'answer'
      const resume = h.app.ports.requestRun({ companyId: 'co_a', trigger: 'answer', target: { kind: 'workflow', workflowId: 'shell', inputs: {} } })
      expect(resume.runId).toMatch(/^crun_/)
      // a restart marks runs left running as failed
      await tick()
      h.app.queue.recover()
      expect(await status(resume.runId!)).toBe('failed')
    } finally { await h.close() }
  })

  it('validates run requests: prompt size, adapter and a missing workflow', async () => {
    const h = await startHarness()
    try {
      const { dev } = await setup(h)
      const post = (body: unknown) => h.call('POST', '/v1/companies/co_a/runs', { token: dev, body })
      expect((await post({ kind: 'prompt', adapter: 'cursor', prompt: 'x' })).status).toBe(400)
      expect((await post({ kind: 'prompt', adapter: 'claude', prompt: 'x'.repeat(32_001) })).status).toBe(400)
      expect((await post({ kind: 'workflow', workflowId: 'nope' })).status).toBe(404)
      const p = await post({ kind: 'prompt', adapter: 'claude', prompt: 'Summarize   the\nweek' })
      expect(p.json).toMatchObject({ kind: 'prompt', title: 'Summarize the week', adapters: ['claude'], trigger: 'desktop' })
    } finally { await h.close() }
  })

  it('a finished run keeps its proof of work: the step named after its node and agent, and the log it streamed', async () => {
    const h = await startHarness()
    try {
      const { dev, run } = await setup(h)
      const r = (await run('co_a', 'claude')).json
      await tick()
      h.rt.finish(r.id, 'passed', 'Drafted the brief.')
      await tick()
      const d = (await h.call('GET', `/v1/runs/${r.id}`, { token: dev })).json
      expect(d.steps).toEqual([expect.objectContaining({ nodeId: 'm', title: 'm', adapter: 'claude', status: 'passed' })])
      // even when the runtime keeps no file for it, the lines it streamed are the run's log (never "No log yet.")
      h.rt.runLog = () => []
      const log = (await h.call('GET', `/v1/runs/${r.id}/log?tail=200`, { token: dev })).json
      expect(log.lines).toEqual(['m started', 'This cloud runs with PRINCIPIA_RUNTIME=fake: no agent ran.', 'Drafted the brief.'])
      expect((await h.call('GET', `/v1/runs/${r.id}/log?tail=1`, { token: dev })).json.lines).toEqual(['Drafted the brief.'])
      // capped per run; secrets are redacted on the way in
      for (let i = 0; i < 5; i++) h.app.ports.runLog(r.id, `${r.id}_s1`, Array.from({ length: 500 }, (_, j) => `line ${i}-${j} sk-ant-api03-abcdefghijklmnopqrstuvwxyz`))
      const all = (await h.call('GET', `/v1/runs/${r.id}/log?tail=2000`, { token: dev })).json.lines as string[]
      expect(all).toHaveLength(2000)
      expect(all.at(-1)).toMatch(/^line 4-499 /)
      expect(all.join('\n')).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz')
    } finally { await h.close() }
  })
})
