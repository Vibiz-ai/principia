import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { computeReadiness, type ReadinessInput } from '../readiness'
import { workflowDeps } from '../deps'
import { startFakeHost, TINY_ZIP } from './fakePassportHost'
import { startHarness, workflowFile } from './harness'

const base = (): ReadinessInput => ({
  workflows: [{ id: 'w1', name: 'Morning brief', problems: [], deps: { adapters: ['codex'], secrets: ['FAL_KEY'], connections: ['notion'] } }],
  providers: { claude: 'missing', codex: 'ok', gemini: 'missing' },
  secretNames: ['FAL_KEY'],
  connections: [{ id: 'notion', name: 'Notion', authentication: 'headers', authStatus: null }],
  repos: [{ id: 'r1', name: 'quest', url: 'https://github.com/vibiz-ai/quest', status: 'ready', detail: null, lastSyncOk: true }],
  passport: { configured: true, hostUp: true, passportId: 'p1' }
})

describe('readiness (CLOUD.md §7.9)', () => {
  it('is ready when everything the workflows use is there', () => {
    expect(computeReadiness(base())).toEqual({ ready: true, fixes: [] })
  })

  it('account: missing, expired and failing credentials, in founder words', () => {
    const r = base()
    r.providers.codex = 'missing'
    expect(computeReadiness(r).fixes).toEqual([{ kind: 'account', ref: 'codex', message: 'Morning brief uses Codex. Sign in with ChatGPT.' }])
    r.providers.codex = 'expired'
    expect(computeReadiness(r).fixes[0]!.message).toBe('Your Codex sign-in expired. Sign in with ChatGPT.')
    r.providers.codex = 'failing'
    expect(computeReadiness(r).fixes[0]!.message).toBe('Codex rejected the saved sign-in. Sign in with ChatGPT.')
    r.providers.codex = 'expiring'
    expect(computeReadiness(r).ready).toBe(true)
    r.workflows.push({ id: 'w2', name: 'Weekly', problems: [], deps: { adapters: ['claude', 'gemini'], secrets: [], connections: [] } }, { id: 'w3', name: 'Daily', problems: [], deps: { adapters: ['claude'], secrets: [], connections: [] } })
    expect(computeReadiness(r).fixes).toEqual([
      { kind: 'account', ref: 'claude', message: 'Weekly and 1 more use Claude. Connect Claude.' },
      { kind: 'account', ref: 'gemini', message: 'Weekly uses Gemini. Add a Gemini key.' }
    ])
  })

  it('key: a referenced secret name is missing', () => {
    const r = base(); r.secretNames = []
    expect(computeReadiness(r).fixes).toEqual([{ kind: 'key', ref: 'FAL_KEY', message: 'Morning brief uses the fal.ai key (FAL_KEY), which is not in the cloud yet. Copy it from your Mac.' }])
    r.workflows[0]!.deps.secrets = ['ACME_PARTNER_TOKEN']
    expect(computeReadiness(r).fixes[0]!.message).toBe('Morning brief uses the key ACME_PARTNER_TOKEN, which is not in the cloud yet. Copy it from your Mac.')
  })

  it('account: a usage limit a real run hit is a fix with nothing to click, until it resets', () => {
    const r = base()
    r.providers.codex = 'failing'
    r.providerDetails = { codex: 'Codex hit its usage limit. It resets at 14:00 UTC.' }
    expect(computeReadiness(r)).toEqual({ ready: false, fixes: [{ kind: 'account', ref: 'codex', message: 'Codex hit its usage limit. It resets at 14:00 UTC. Morning brief waits until then.', action: 'wait' }] })
  })

  it('key detection: the Vibiz Quest workflows name their keys in plain prose, not only as $NAME', () => {
    // the founder's own steps (CLOUD.md §7.9): bare names, env references, generic words that are not a key
    const quest = workflowFile('Quest content', [
      { id: 'img', type: 'agent', profileId: 'prof_codex', prompt: 'Use FAL_KEY for images' },
      { id: 'render', type: 'agent', profileId: 'prof_claude', prompt: 'Read the key from the FIRECRAWL_API_KEY environment variable with headers `Authorization: Key $FAL_KEY`. Never print an API_KEY.' },
      { id: 'ship', type: 'shell', command: 'node post.js "$RESEND_API_KEY" && echo $HOME $GITHUB_TOKEN' }
    ])
    expect(workflowDeps(quest).secrets).toEqual(['FAL_KEY', 'FIRECRAWL_API_KEY', 'RESEND_API_KEY'])
    // what the desktop declares (its vault names found in the steps) is merged, never the runtime's own variables
    expect(workflowDeps(workflowFile('Brief', [{ id: 'a', type: 'agent', profileId: 'prof_codex', prompt: 'brief' }]), ['PARTNER_SECRET', 'OPENAI_API_KEY', 'PRINCIPIA_X']).secrets).toEqual(['PARTNER_SECRET'])
    // the marketplace's own fal.ai workflow
    const yt = JSON.parse(readFileSync(resolve(__dirname, '../../../../resources/marketplace/workflows/youtube-thumbnail.hive.json'), 'utf8'))
    expect(workflowDeps(yt).secrets).toEqual(['FAL_KEY'])
  })

  it('connection: missing, or OAuth not authorized', () => {
    const r = base(); r.connections = []
    expect(computeReadiness(r).fixes).toEqual([{ kind: 'connection', ref: 'notion', message: 'Morning brief uses the notion connection. Copy it to the cloud from your Mac.' }])
    r.connections = [{ id: 'notion', name: 'Notion', authentication: 'oauth', authStatus: 'disconnected' }]
    expect(computeReadiness(r).fixes).toEqual([{ kind: 'connection', ref: 'notion', message: 'Notion needs you to sign in. Press Authorize.' }])
    r.connections[0]!.authStatus = 'error'
    expect(computeReadiness(r).fixes[0]!.message).toBe('Notion needs you to sign in again. Press Authorize.')
    r.connections[0]!.authStatus = 'connected'
    expect(computeReadiness(r).ready).toBe(true)
  })

  it('repo: never cloned, or the last sync failed', () => {
    const r = base(); r.repos[0]!.status = 'pending'; r.repos[0]!.lastSyncOk = null
    expect(computeReadiness(r).fixes).toEqual([{ kind: 'repo', ref: 'r1', message: 'The quest repo has not been cloned yet. Press Sync.' }])
    r.repos[0]!.status = 'failed'; r.repos[0]!.lastSyncOk = false; r.repos[0]!.detail = 'GitHub said the token cannot read vibiz-ai/quest'
    expect(computeReadiness(r).fixes[0]!.message).toBe('The quest repo did not sync: GitHub said the token cannot read vibiz-ai/quest.')
  })

  it('passport: no host, host down, or no passport for the company', () => {
    const r = base()
    r.passport = { configured: false, hostUp: false, passportId: null }
    expect(computeReadiness(r).fixes[0]).toMatchObject({ kind: 'passport', message: expect.stringContaining('no passport host') })
    r.passport = { configured: true, hostUp: false, passportId: 'p1' }
    expect(computeReadiness(r).fixes[0]).toEqual({ kind: 'passport', ref: 'p1', message: 'The passport host is not answering. Check that the passport container is running.' })
    r.passport = { configured: true, hostUp: true, passportId: null }
    expect(computeReadiness(r).fixes[0]!.message).toBe('This company has no passport in the cloud yet. Move it to the cloud again from your Mac.')
  })

  it('workflow: validateWorkflow problems', () => {
    const r = base(); r.workflows[0]!.problems = ['Worktrees are not available in the cloud yet.']
    expect(computeReadiness(r).fixes).toEqual([{ kind: 'workflow', ref: 'w1', message: 'Morning brief cannot run in the cloud: Worktrees are not available in the cloud yet.' }])
  })

  it('GET /v1/companies shows readiness computed from stored data only', async () => {
    const host = await startFakeHost()
    const h = await startHarness({ config: { passport: { internalUrl: host.url, publicUrl: host.url, adminToken: host.admin } } })
    try {
      const dev = await h.pair()
      await h.call('PUT', '/v1/companies/co_a', { token: dev, body: { name: 'A', slug: 'a', passportBundle: TINY_ZIP.toString('base64') } })
      await h.call('PUT', '/v1/companies/co_a/workflows/w1', { token: dev, body: { file: workflowFile('Morning brief', [{ id: 'm', type: 'agent', profileId: 'prof_codex', prompt: 'Use $FAL_KEY' }]), baseRev: null } })
      const started = h.rt.started.length
      let c = (await h.call('GET', '/v1/companies', { token: dev })).json[0]
      expect(c.readiness.fixes.map((f: { kind: string }) => f.kind)).toEqual(['account', 'key'])
      await h.call('PUT', '/v1/providers/codex/credential', { token: dev, body: { kind: 'openai_api_key', value: 'sk-proj-abcdefghijklmnopqrstuvwxyz' } })
      await h.call('PUT', '/v1/companies/co_a/secrets/FAL_KEY', { token: dev, body: { value: 'fal-123456789' } })
      await h.call('PUT', '/v1/companies/co_a/repos/r1', { token: dev, body: { name: 'quest', url: 'https://github.com/vibiz-ai/quest.git', credential: { kind: 'github_pat', value: 'bad-token' } } })
      c = (await h.call('GET', '/v1/companies', { token: dev })).json[0]
      expect(c.readiness.fixes).toEqual([{ kind: 'repo', ref: 'r1', message: 'The quest repo has not been cloned yet. Press Sync.' }])
      const sync = await h.call('POST', '/v1/companies/co_a/repos/r1/sync', { token: dev })
      expect(sync.json).toMatchObject({ status: 'failed', detail: 'GitHub said the token cannot read https://github.com/vibiz-ai/quest.git' })
      await h.call('PUT', '/v1/companies/co_a/repos/r1', { token: dev, body: { name: 'quest', url: 'https://github.com/vibiz-ai/quest', credential: { kind: 'github_pat', value: 'good-token' } } })
      expect((await h.call('POST', '/v1/companies/co_a/repos/r1/sync', { token: dev })).json.status).toBe('ready')
      c = (await h.call('GET', '/v1/companies', { token: dev })).json[0]
      expect(c.readiness).toEqual({ ready: true, fixes: [] })
      expect(h.rt.started.length).toBe(started)

      // CLOUD.md §7.9: a key a workflow names in prose, left unticked on the Mac, is a fix (not Ready)
      await h.call('PUT', '/v1/companies/co_a/workflows/w2', { token: dev, body: { file: workflowFile('Quest content', [{ id: 'img', type: 'agent', profileId: 'prof_codex', prompt: 'Use FAL_KEY for images and FIRECRAWL_API_KEY to crawl' }]), baseRev: null, keys: ['PARTNER_SECRET'] } })
      c = (await h.call('GET', '/v1/companies', { token: dev })).json[0]
      expect(c.readiness.ready).toBe(false)
      expect(c.readiness.fixes.map((f: { ref: string }) => f.ref)).toEqual(['FIRECRAWL_API_KEY', 'PARTNER_SECRET'])
      expect((await h.call('PUT', '/v1/companies/co_a/workflows/w3', { token: dev, body: { file: workflowFile('X', []), baseRev: null, keys: ['not a name'] } })).status).toBe(400)
      await h.call('DELETE', '/v1/companies/co_a/workflows/w2', { token: dev })

      // an expired token seen by a real run: the Accounts row is not OK and the company is not Ready
      const cred = (await h.call('GET', '/v1/providers', { token: dev })).json.find((p: { adapter: string }) => p.adapter === 'codex').credential.id
      h.app.ports.providerStatus!({ credentialId: 'cred_replaced_since', adapter: 'codex', status: 'expired', detail: 'stale' })
      expect((await h.call('GET', '/v1/companies', { token: dev })).json[0].readiness.ready).toBe(true)
      h.app.ports.providerStatus!({ credentialId: cred, adapter: 'codex', status: 'expired', detail: 'OpenAI rejected the API key.' })
      const codex = (await h.call('GET', '/v1/providers', { token: dev })).json.find((p: { adapter: string }) => p.adapter === 'codex')
      expect(codex).toMatchObject({ status: 'expired', detail: 'OpenAI rejected the API key.' })
      c = (await h.call('GET', '/v1/companies', { token: dev })).json[0]
      expect(c.readiness).toEqual({ ready: false, fixes: [{ kind: 'account', ref: 'codex', message: 'Your Codex sign-in expired. Sign in with ChatGPT.' }] })
      // a usage limit says when it resets; a passed step on the same credential clears it
      await h.call('PUT', '/v1/providers/codex/credential', { token: dev, body: { kind: 'openai_api_key', value: 'sk-proj-abcdefghijklmnopqrstuvwxyz2' } })
      const fresh = (await h.call('GET', '/v1/providers', { token: dev })).json.find((p: { adapter: string }) => p.adapter === 'codex').credential.id
      h.app.ports.providerStatus!({ credentialId: fresh, adapter: 'codex', status: 'limited', detail: 'Codex hit its usage limit. It resets at 14:00 UTC.' })
      c = (await h.call('GET', '/v1/companies', { token: dev })).json[0]
      expect(c.readiness.fixes).toEqual([{ kind: 'account', ref: 'codex', message: 'Codex hit its usage limit. It resets at 14:00 UTC. Morning brief waits until then.', action: 'wait' }])
      h.app.ports.providerStatus!({ credentialId: fresh, adapter: 'codex', status: 'ok', detail: null })
      expect((await h.call('GET', '/v1/companies', { token: dev })).json[0].readiness).toEqual({ ready: true, fixes: [] })
      expect((await h.call('PUT', '/v1/companies/co_a/repos/r2', { token: dev, body: { name: 'x', url: 'https://gitlab.com/a/b', credential: { kind: 'public' } } })).status).toBe(400)
    } finally { await h.close(); await host.close() }
  })
})
