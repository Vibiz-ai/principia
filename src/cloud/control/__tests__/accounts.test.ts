import { describe, expect, it } from 'vitest'
import { dumpText } from '../db'
import { consoleSession, startHarness, workflowFile } from './harness'

const GH = 'gho_SEEDEDgithubTOKENvalue0123456789abcdef'
const SHARED = 'SEEDED-shared-openai-key-0000111122223333'
const CODEX = JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'SEEDED-refresh-abcdef123456', access_token: 'SEEDED-access-zyxwvu987654', id_token: 'x' } })

describe('workspace accounts and shared keys (docs/ACCOUNTS.md)', () => {
  it('signs every run in once: GitHub as GH_TOKEN and the repo token, shared keys under company keys', async () => {
    const h = await startHarness({ config: { lookup: async () => ['93.184.216.34'] } })
    try {
      const dev = await h.pair()
      await h.call('PUT', '/v1/companies/co_a', { token: dev, body: { name: 'A', slug: 'a' } })
      await h.call('PUT', '/v1/providers/codex/credential', { token: dev, body: { kind: 'codex_auth_json', value: CODEX } })
      expect((await h.call('GET', '/v1/accounts', { token: dev })).json).toEqual({ github: null, secrets: [] })

      // GitHub: the token shape is checked, the login comes back, the token never does
      expect((await h.call('PUT', '/v1/accounts/github', { token: dev, body: { token: 'not-a-token' } })).status).toBe(400)
      const put = await h.call('PUT', '/v1/accounts/github', { token: dev, body: { token: GH, login: 'octo-founder' } })
      expect(put.status).toBe(200)
      expect(put.json).toMatchObject({ login: 'octo-founder' })
      expect(put.text).not.toContain(GH)

      // shared keys: names only; a company key of the same name wins for that company
      expect((await h.call('PUT', '/v1/secrets/bad-name', { token: dev, body: { value: 'x' } })).status).toBe(400)
      expect((await h.call('PUT', '/v1/secrets/OPENAI_API_KEY', { token: dev, body: { value: SHARED } })).status).toBe(200)
      expect((await h.call('PUT', '/v1/secrets/FAL_KEY', { token: dev, body: { value: 'shared-fal-value-1234567' } })).status).toBe(200)
      await h.call('PUT', '/v1/companies/co_a/secrets/FAL_KEY', { token: dev, body: { value: 'company-fal-value-7654321' } })
      const list = (await h.call('GET', '/v1/accounts', { token: dev })).json
      expect(list.github.login).toBe('octo-founder')
      expect(list.secrets.map((s: { name: string }) => s.name)).toEqual(['FAL_KEY', 'OPENAI_API_KEY'])

      // a public repo and a repo with its own token
      await h.call('PUT', '/v1/companies/co_a/repos/pub', { token: dev, body: { name: 'pub', url: 'https://github.com/a/pub', credential: { kind: 'public' } } })
      await h.call('PUT', '/v1/companies/co_a/repos/own', { token: dev, body: { name: 'own', url: 'https://github.com/a/own', credential: { kind: 'github_pat', value: 'github_pat_OWNrepoTOKEN0123456789abcdefghij' } } })
      await h.call('PUT', '/v1/companies/co_a/workflows/w1', { token: dev, body: { file: workflowFile('Brief'), baseRev: null } })
      const first = await h.call('POST', '/v1/companies/co_a/runs', { token: dev, body: { kind: 'workflow', workflowId: 'w1' } })
      expect(first.status).toBe(202)
      await new Promise((r) => setTimeout(r, 30))
      const req = h.rt.started[0]!
      expect(req.materials.secrets).toEqual({ GH_TOKEN: GH, GITHUB_TOKEN: GH, OPENAI_API_KEY: SHARED, FAL_KEY: 'company-fal-value-7654321' })
      const token = (id: string) => req.materials.repos.find((r) => r.id === id)!.token
      expect(token('pub')).toBe(GH)
      expect(token('own')).toBe('github_pat_OWNrepoTOKEN0123456789abcdefghij')

      // never in a response, the audit log or a text column, also not through the console
      const s = await consoleSession(h, dev)
      const texts = [
        (await h.call('GET', '/v1/accounts', { token: dev })).text,
        (await h.call('GET', '/v1/audit', { token: dev })).text,
        (await h.call('GET', '/v1/summary', { headers: { cookie: s.cookie } })).text,
        h.logs.join('\n'),
        dumpText(h.app.ctx.db)
      ].join('\n')
      for (const v of [GH, SHARED]) expect(texts.includes(v)).toBe(false)

      // removing them takes them out of the next run (the first one ends first: it holds the Codex sign-in)
      h.app.ports.runStatus(first.json.id, 'passed', 'done')
      expect((await h.call('DELETE', '/v1/accounts/github', { token: dev })).status).toBe(200)
      expect((await h.call('DELETE', '/v1/accounts/github', { token: dev })).status).toBe(404)
      expect((await h.call('DELETE', '/v1/secrets/OPENAI_API_KEY', { token: dev })).status).toBe(200)
      expect((await h.call('POST', '/v1/companies/co_a/runs', { token: dev, body: { kind: 'workflow', workflowId: 'w1' } })).status).toBe(202)
      await new Promise((r) => setTimeout(r, 30))
      expect(h.rt.started).toHaveLength(2)
      const next = h.rt.started[1]!
      expect(next.materials.secrets).toEqual({ FAL_KEY: 'company-fal-value-7654321' })
      expect(next.materials.repos.find((r) => r.id === 'pub')!.token).toBeNull()
    } finally {
      await h.close()
    }
  })

  it('a console session cannot read or change accounts (device only)', async () => {
    const h = await startHarness()
    try {
      const dev = await h.pair()
      const s = await consoleSession(h, dev)
      expect((await h.call('GET', '/v1/accounts', { headers: { cookie: s.cookie } })).status).toBe(403)
      expect((await h.call('PUT', '/v1/accounts/github', { headers: { cookie: s.cookie, 'x-csrf-token': s.csrf }, body: { token: GH } })).status).toBe(403)
    } finally {
      await h.close()
    }
  })
})
