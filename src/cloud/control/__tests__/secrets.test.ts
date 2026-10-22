import { describe, expect, it } from 'vitest'
import { dumpText } from '../db'
import { startFakeHost, TINY_ZIP } from './fakePassportHost'
import { consoleSession, startHarness, workflowFile } from './harness'

const SEEDED = {
  claude: 'sk-ant-oat01-SEEDEDclaudeTOKENvalue000111222',
  codexRefresh: 'SEEDED-codex-refresh-token-abcdef123456',
  codexAccess: 'SEEDED-codex-access-token-zyxwvu987654',
  gemini: 'AIzaSEEDEDgeminiKEYvalue0123456789abc',
  companyKey: 'SEEDED-fal-key-value-5551234',
  pat: 'github_pat_SEEDEDpatVALUE0123456789abcdefghij',
  connHeader: 'SEEDED-connection-header-secret-777'
}

describe('secrets are write-only (CLOUD.md §6, §11)', () => {
  it('no response, log line or db text column ever contains a seeded secret', async () => {
    const host = await startFakeHost()
    const h = await startHarness({ config: { passport: { internalUrl: host.url, publicUrl: host.url, adminToken: host.admin }, lookup: async () => ['93.184.216.34'] } })
    const responses: string[] = []
    const call = async (...a: Parameters<typeof h.call>) => { const r = await h.call(...a); const hs: string[] = []; r.headers.forEach((v, k) => hs.push(`${k}: ${v}`)); responses.push(r.text, hs.join('\n')); return r }
    try {
      const dev = await h.pair()
      const s = await consoleSession(h, dev)
      const co = await call('PUT', '/v1/companies/co_a', { token: dev, body: { name: 'A', slug: 'a', passportBundle: TINY_ZIP.toString('base64') } })
      const desktopKey = co.json.desktopPassportGrant.token as string
      expect((await call('PUT', '/v1/providers/claude/credential', { token: dev, body: { kind: 'claude_oauth_token', value: SEEDED.claude } })).status).toBe(200)
      const auth = JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: SEEDED.codexRefresh, access_token: SEEDED.codexAccess, id_token: 'x' } })
      expect((await call('PUT', '/v1/providers/codex/credential', { token: dev, body: { kind: 'codex_auth_json', value: auth } })).status).toBe(200)
      expect((await call('PUT', '/v1/providers/gemini/credential', { token: dev, body: { kind: 'gemini_api_key', value: SEEDED.gemini, label: 'Gemini (work)' } })).status).toBe(200)
      expect((await call('PUT', '/v1/providers/gemini/credential', { token: dev, body: { kind: 'gemini_api_key', value: SEEDED.gemini, label: 'key 0123456789abc' } })).status).toBe(400)
      expect((await call('PUT', '/v1/companies/co_a/secrets/FAL_KEY', { token: dev, body: { value: SEEDED.companyKey } })).status).toBe(200)
      expect((await call('PUT', '/v1/companies/co_a/repos/quest', { token: dev, body: { name: 'quest', url: 'https://github.com/vibiz-ai/quest', credential: { kind: 'github_pat', value: SEEDED.pat } } })).status).toBe(200)
      expect((await call('PUT', '/v1/companies/co_a/connections/notion', { token: dev, body: { name: 'Notion', transport: 'http', url: 'https://mcp.notion.example/mcp', enabled: true, authentication: 'headers', credentials: { Authorization: `Bearer ${SEEDED.connHeader}` } } })).status).toBe(200)
      await call('PUT', '/v1/companies/co_a/workflows/w1', { token: dev, body: { file: workflowFile('Brief'), baseRev: null } })
      // a run gets the decrypted materials; the runtime echoes secrets in its summary, steps and logs
      const run = await call('POST', '/v1/companies/co_a/runs', { token: dev, body: { kind: 'workflow', workflowId: 'w1' } })
      await new Promise(r => setTimeout(r, 30))
      const req = h.rt.started[0]!
      expect(req.materials.providers.map(p => p.value)).toEqual([auth])
      expect(req.materials.secrets).toEqual({ FAL_KEY: SEEDED.companyKey })
      expect(req.materials.repos[0]!.token).toBe(SEEDED.pat)
      expect(req.materials.connections[0]!.credentials.Authorization).toBe(`Bearer ${SEEDED.connHeader}`)
      expect(req.materials.passport?.token).toMatch(/^opk_/)
      h.app.ports.runStep(run.json.id, { id: 's1', nodeId: 'main', title: `uses ${SEEDED.companyKey}`, adapter: 'codex', status: 'running', startedAt: null, endedAt: null, usage: null })
      h.app.ports.runLog(run.json.id, 's1', [`token=${SEEDED.codexAccess}`])
      h.app.ports.openAsk({ companyId: 'co_a', runId: run.json.id, agentName: 'Marcus', question: `Is ${SEEDED.pat} right?`, options: [] })
      h.app.ports.runStatus(run.json.id, 'failed', `401 with ${SEEDED.claude} and ${SEEDED.gemini}`)
      h.app.ports.log.error('runtime said', { detail: SEEDED.connHeader })

      for (const [m, p] of [['GET', '/v1/providers'], ['GET', '/v1/summary'], ['GET', '/v1/companies'], ['GET', '/v1/companies/co_a/secrets'], ['GET', '/v1/companies/co_a/repos'], ['GET', '/v1/companies/co_a/connections'], ['GET', `/v1/runs/${run.json.id}`], ['GET', '/v1/runs'], ['GET', '/v1/asks'], ['GET', '/v1/audit'], ['GET', '/v1/sync/changes'], ['GET', '/v1/usage'], ['POST', '/v1/providers/claude/test']] as const) {
        const r = await call(m, p, { token: dev, body: m === 'POST' ? {} : undefined })
        expect([p, r.status]).toEqual([p, 200])
      }
      await call('GET', '/v1/summary', { headers: { cookie: s.cookie } })
      const everything = [responses.join('\n'), h.logs.join('\n'), dumpText(h.app.ctx.db)].join('\n')
      for (const [k, v] of Object.entries(SEEDED)) expect([k, everything.includes(v)]).toEqual([k, false])
      // the desktop key is returned exactly once, in that PUT, and nowhere else
      expect(responses.filter(t => t.includes(desktopKey))).toHaveLength(1)
      expect(dumpText(h.app.ctx.db)).not.toContain(desktopKey)
      // provider list shows names, kinds, dates and status only
      const prov = (await h.call('GET', '/v1/providers', { token: dev })).json
      expect(prov.find((p: { adapter: string }) => p.adapter === 'claude')).toMatchObject({ status: 'ok', credential: { kind: 'claude_oauth_token', label: 'Claude subscription' } })
      expect(prov.find((p: { adapter: string }) => p.adapter === 'gemini').credential.label).toBe('Gemini (work)')
    } finally { await h.close(); await host.close() }
  })
})

describe('company scoping', () => {
  it('a child id of another company is 404, and runs cannot borrow another company\'s workflow or repo', async () => {
    const h = await startHarness({ config: { lookup: async () => ['93.184.216.34'] } })
    try {
      const dev = await h.pair()
      for (const c of ['co_a', 'co_b']) expect((await h.call('PUT', `/v1/companies/${c}`, { token: dev, body: { name: c, slug: c } })).status).toBe(200)
      await h.call('PUT', '/v1/companies/co_a/workflows/w1', { token: dev, body: { file: workflowFile('A brief'), baseRev: null } })
      await h.call('PUT', '/v1/companies/co_a/schedules/s1', { token: dev, body: { schedule: { name: 'Daily', when: { kind: 'cron', cron: '0 9 * * *', tz: 'UTC' }, target: { kind: 'workflow', workflowId: 'w1', inputs: {} }, enabled: true }, placement: 'cloud', baseRev: null } })
      await h.call('PUT', '/v1/companies/co_a/secrets/FAL_KEY', { token: dev, body: { value: 'v-123456789' } })
      await h.call('PUT', '/v1/companies/co_a/repos/r1', { token: dev, body: { name: 'q', url: 'https://github.com/a/q', credential: { kind: 'public' } } })
      await h.call('PUT', '/v1/companies/co_a/connections/c1', { token: dev, body: { name: 'C', transport: 'http', url: 'https://c.example.com/mcp', enabled: true, authentication: 'none' } })
      const cross: [string, string, unknown?][] = [
        ['DELETE', '/v1/companies/co_b/workflows/w1'], ['DELETE', '/v1/companies/co_b/schedules/s1'], ['DELETE', '/v1/companies/co_b/secrets/FAL_KEY'],
        ['DELETE', '/v1/companies/co_b/repos/r1'], ['POST', '/v1/companies/co_b/repos/r1/sync', {}], ['DELETE', '/v1/companies/co_b/connections/c1'],
        ['POST', '/v1/companies/co_b/connections/c1/authorize', {}], ['POST', '/v1/companies/co_b/runs', { kind: 'workflow', workflowId: 'w1' }],
        ['POST', '/v1/companies/co_b/runs', { kind: 'prompt', adapter: 'claude', prompt: 'hi', repoId: 'r1' }],
        ['PUT', '/v1/companies/co_b/schedules/s2', { schedule: { name: 'x', when: { kind: 'cron', cron: '0 9 * * *', tz: 'UTC' }, target: { kind: 'workflow', workflowId: 'w1', inputs: {} }, enabled: true }, placement: 'cloud', baseRev: null }],
        ['GET', '/v1/companies/co_zzz/workflows'], ['GET', '/v1/companies/co_zzz/secrets']
      ]
      for (const [m, p, b] of cross) expect([m, p, (await h.call(m, p, { token: dev, body: b })).status]).toEqual([m, p, 404])
      expect((await h.call('GET', '/v1/companies/co_b/workflows', { token: dev })).json).toEqual([])
      expect((await h.call('GET', '/v1/companies/co_b/secrets', { token: dev })).json).toEqual([])
      // the same id under its own company works
      expect((await h.call('DELETE', '/v1/companies/co_a/secrets/FAL_KEY', { token: dev })).status).toBe(200)
    } finally { await h.close() }
  })
})
