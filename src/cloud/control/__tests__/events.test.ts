import { describe, expect, it } from 'vitest'
import { usageSummary } from '../usage'
import { consoleSession, startHarness, workflowFile, type Harness } from './harness'

/** reads an SSE stream into text until `until` matches or the timeout passes */
async function stream(h: Harness, path: string, headers: Record<string, string>) {
  const ctrl = new AbortController()
  const res = await fetch(h.url + path, { headers, signal: ctrl.signal })
  const reader = res.body!.getReader()
  let text = ''
  const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value) } } catch { /* aborted */ } })()
  return {
    res,
    get text() { return text },
    async until(re: RegExp, ms = 1000) { const end = Date.now() + ms; while (!re.test(text) && Date.now() < end) await new Promise(r => setTimeout(r, 5)); return re.test(text) },
    async close() { ctrl.abort(); await pump }
  }
}

describe('GET /v1/events (SSE)', () => {
  it('frames events as `event:` + `data:` JSON, sends heartbeats, and gives log events only to ?runId= subscribers', async () => {
    const h = await startHarness({ heartbeatMs: 40 })
    try {
      const dev = await h.pair()
      await h.call('PUT', '/v1/companies/co_a', { token: dev, body: { name: 'A', slug: 'a' } })
      await h.call('PUT', '/v1/companies/co_a/workflows/w', { token: dev, body: { file: workflowFile('Shell', [{ id: 's', type: 'shell', command: 'true' }]), baseRev: null } })
      const all = await stream(h, '/v1/events', { authorization: `Bearer ${dev}` })
      expect(all.res.status).toBe(200)
      expect(all.res.headers.get('content-type')).toMatch(/^text\/event-stream/)
      expect(all.res.headers.get('cache-control')).toBe('no-store')
      const run = (await h.call('POST', '/v1/companies/co_a/runs', { token: dev, body: { kind: 'workflow', workflowId: 'w' } })).json
      const s = await consoleSession(h, dev)
      const one = await stream(h, `/v1/events?runId=${run.id}`, { cookie: s.cookie })
      await all.until(/event: step/)
      expect(await one.until(/: connected/)).toBe(true)
      h.app.ports.runLog(run.id, 's1', ['hello from the step', 'secret pdt_abcdefghijklmnopqrstuvwxyz'])
      h.app.ports.openAsk({ companyId: 'co_a', runId: run.id, agentName: null, question: 'Ok?', options: ['Yes'] })
      expect(await one.until(/event: ask/)).toBe(true)
      expect(await all.until(/event: ask/)).toBe(true)
      expect(await all.until(/: heartbeat\n\n/, 500)).toBe(true)
      expect(one.text).toMatch(/event: log\ndata: \{"kind":"log","runId":"[^"]+","stepId":"s1","lines":\["hello from the step","secret \[redacted\]"\]\}\n\n/)
      expect(all.text).not.toContain('event: log')
      const frames = all.text.split('\n\n').filter(f => f.startsWith('event: '))
      for (const f of frames) {
        const [ev, data] = f.split('\n')
        const body = JSON.parse(data!.replace(/^data: /, ''))
        expect(ev).toBe(`event: ${body.kind}`)
      }
      expect(frames.some(f => f.startsWith('event: run\n'))).toBe(true)
      await all.close(); await one.close()
      await new Promise(r => setTimeout(r, 20))
      expect(h.app.ctx.events.size).toBe(0)
      expect((await fetch(h.url + '/v1/events')).status).toBe(401)
    } finally { await h.close() }
  })
})

describe('usage ledger', () => {
  it('aggregates runs, run minutes, tokens and API dollars per company; subscription runs report no dollars', async () => {
    let t = Date.parse('2026-10-21T09:00:00Z')
    const h = await startHarness({ now: () => new Date(t) })
    try {
      const dev = await h.pair()
      for (const c of ['co_a', 'co_b']) {
        await h.call('PUT', `/v1/companies/${c}`, { token: dev, body: { name: c, slug: c } })
        await h.call('PUT', `/v1/companies/${c}/workflows/w`, { token: dev, body: { file: workflowFile('Shell', [{ id: 's', type: 'shell', command: 'true' }]), baseRev: null } })
      }
      const r1 = (await h.call('POST', '/v1/companies/co_a/runs', { token: dev, body: { kind: 'workflow', workflowId: 'w' } })).json.id
      const r2 = (await h.call('POST', '/v1/companies/co_b/runs', { token: dev, body: { kind: 'workflow', workflowId: 'w' } })).json.id
      await new Promise(r => setTimeout(r, 15))
      h.app.ports.usage({ runId: r1, companyId: 'co_a', adapter: 'claude', inputTokens: 1200, outputTokens: 300, usd: 0.25 })
      h.app.ports.usage({ runId: r1, companyId: 'co_a', adapter: 'codex', inputTokens: 800, outputTokens: 100, usd: null })
      h.app.ports.usage({ runId: r2, companyId: 'co_b', adapter: 'codex', inputTokens: 10, outputTokens: 5, usd: null })
      t += 6 * 60_000
      h.rt.finish(r1, 'passed')
      t += 6 * 60_000
      h.rt.finish(r2, 'passed')
      const u = await h.call('GET', '/v1/usage', { token: dev })
      expect(u.json.companies).toEqual([
        { companyId: 'co_a', runs: 1, runMinutes: 6, apiUsd: 0.25, inputTokens: 2000, outputTokens: 400 },
        { companyId: 'co_b', runs: 1, runMinutes: 12, apiUsd: 0, inputTokens: 10, outputTokens: 5 }
      ])
      const s = await h.call('GET', '/v1/summary', { token: dev })
      expect(s.json.usage24h).toEqual({ runs: 2, runMinutes: 18 })
      expect(s.json.runtime).toEqual({ status: 'ok', version: 'dev-0', sandbox: 'process', detail: null })
      // a window clips minutes
      const clipped = usageSummary(h.app.ctx.db, new Date(Date.parse('2026-10-21T09:03:00Z')), new Date(Date.parse('2026-10-21T09:30:00Z')), new Date(t))
      expect(clipped.companies.map(c => [c.companyId, c.runs, c.runMinutes])).toEqual([['co_a', 0, 3], ['co_b', 0, 9]])
      expect((await h.call('GET', '/v1/usage?from=bad', { token: dev })).status).toBe(400)
    } finally { await h.close() }
  })

  it('records run minutes in the billing sink at each run end', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { randomBytes } = await import('node:crypto')
    const { createControlApp } = await import('../server')
    const { createFakeRuntime } = await import('./fakeRuntime')
    const recorded: { metric: string; quantity: number }[] = []
    let rt!: ReturnType<typeof createFakeRuntime>
    const dir = mkdtempSync(join(tmpdir(), 'pbill-'))
    const app = createControlApp({ config: { publicUrl: 'http://127.0.0.1:1', adminToken: null, workspaceName: 'b', consoleDir: dir, dataDir: dir, workspaceDir: dir, logRetentionDays: 30, connectorAllowPrivate: [], passport: null }, masterKey: randomBytes(32), createRuntime: p => (rt = createFakeRuntime(p)), tickMs: 0, logWrite: () => {}, billing: { record: e => recorded.push(e) } })
    await app.start()
    try {
      app.ctx.db.run("INSERT INTO companies (id, workspace_id, name, slug, created_at, updated_at) VALUES ('c', ?, 'C', 'c', '2026-01-01', '2026-01-01')", app.ctx.workspaceId)
      const out = app.ports.requestRun({ companyId: 'c', trigger: 'manual', target: { kind: 'prompt', adapter: 'claude', prompt: 'x' } })
      expect(out.runId).toMatch(/^crun_/)
      app.ports.runStatus(out.runId!, 'running', null)
      app.ports.runStatus(out.runId!, 'passed', 'ok')
      expect(recorded).toHaveLength(1)
      expect(recorded[0]!.metric).toBe('run_minutes')
      void rt
    } finally { await app.close() }
  })
})
