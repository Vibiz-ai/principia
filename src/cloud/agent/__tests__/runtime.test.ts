/**
 * The runtime end to end, in process, with fake CLIs (no model is ever called): workflow and prompt runs, usage,
 * redaction, the passport card, Forum posts in the run detail, asks and their resume, the codex sign-in write-back and
 * its serialization. Needs better-sqlite3 loadable by this Node (the cloud smoke covers the Electron/Node 24 build).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CloudRuntime, RunMaterials, RuntimeRunRequest } from '../../contract'
import { createCloudRuntime } from '../index'
import { CloudRuntimeError } from '../errors'
import { FAKE_BINS, fakePassportHost, fakePorts, tmp, waitFor, type FakeHost } from './fakes'

const sqliteOk = (() => {
  try {
    const Database = createRequire(__filename)('better-sqlite3') as new (f: string) => { close(): void }
    new Database(':memory:').close()
    return true
  } catch {
    return false
  }
})()

const CLAUDE_TOKEN = 'sk-ant-oat01-runtime-test-token-0123456789'
const AUTH_JSON = JSON.stringify({ tokens: { id_token: 'id-token-value-0123456789', access_token: 'access-token-original-0123456789', refresh_token: 'refresh-token-0123456789abc', account_id: 'acct_1' }, last_refresh: '2026-10-20T10:00:00Z' })

describe.skipIf(!sqliteOk)('cloud runtime (fake CLIs)', () => {
  let rt: CloudRuntime
  let ports: ReturnType<typeof fakePorts>
  let host: FakeHost
  let root: string
  let n = 0
  const materials = (o: Partial<RunMaterials> = {}): RunMaterials => ({
    providers: [{ credentialId: 'cred_claude', adapter: 'claude', kind: 'claude_oauth_token', value: CLAUDE_TOKEN }],
    repos: [],
    connections: [],
    passport: { internalUrl: host.url, publicUrl: 'https://passport.example.com', passportId: 'pp_acme', token: host.token },
    secrets: { ACME_KEY: 'acme-company-key-value' },
    ...o
  })
  const request = (target: RuntimeRunRequest['target'], o: Partial<RuntimeRunRequest> = {}): RuntimeRunRequest => ({
    runId: `crun_t${++n}`,
    workspaceId: 'ws_1',
    companyId: 'co_acme',
    companyName: 'Acme',
    trigger: 'manual',
    target,
    workflowFile: null,
    timeoutMs: 60_000,
    untrustedInputs: [],
    materials: materials(),
    ...o
  })
  const settled = (runId: string) => waitFor(() => ['passed', 'failed', 'canceled', 'needs_input'].includes(ports.finalStatus(runId) ?? ''), 20_000)

  beforeAll(async () => {
    process.env.PRINCIPIA_SECRET = 'planted-control-plane-secret'
    host = await fakePassportHost()
    root = tmp()
    ports = fakePorts({ secrets: ['known-secret-from-control-plane'] })
    rt = createCloudRuntime({ dataDir: join(root, 'data'), workspaceDir: join(root, 'workspace'), ports, bins: { ...FAKE_BINS, git: 'git' } })
    await rt.start()
    await rt.ensureCompany({ workspaceId: 'ws_1', companyId: 'co_acme', name: 'Acme', slug: 'acme' })
  })
  afterAll(async () => {
    await rt?.close()
    await host?.close()
    delete process.env.PRINCIPIA_SECRET
  })

  it('ensureCompany makes the company folder; health is ok', () => {
    expect(existsSync(join(root, 'workspace', 'co_acme'))).toBe(true)
    expect(rt.health().status).toBe('ok')
    expect(rt.version).toBe('1.0.0')
    expect(rt.sandbox).toBe('process')
  })

  it('runs a two-node workflow (shell + claude): statuses, steps, usage, redaction, the passport card, Forum posts', async () => {
    const file = {
      hive: 'workflow',
      version: 1,
      workflow: {
        name: 'Launch email',
        description: '',
        inputs: [],
        nodes: [
          { id: 'prep', type: 'shell', label: 'Prepare', command: 'echo "key=$ACME_KEY"; echo prep-ok', cwd: null, after: [], timeoutMin: 1 },
          { id: 'draft', type: 'agent', label: 'Draft', profileId: 'prof_claude', prompt: 'PRINT_SECRET FAKE_FORUM_POST WRITE_NOTES draft it', cwd: null, after: ['prep'], timeoutMin: 2, memory: 'read-write' }
        ]
      }
    }
    expect(rt.validateWorkflow('co_acme', file)).toEqual([])
    const req = request({ kind: 'workflow', workflowId: 'wf_launch', inputs: {} }, { workflowFile: file })
    rt.startRun(req)
    await settled(req.runId)
    const statuses = ports.rec.runStatus.filter((s) => s.runId === req.runId)
    expect(statuses.map((s) => s.status)).toEqual(['running', 'passed'])
    const final = statuses.at(-1)!
    expect(final.summary).toContain('fake-claude-ok')
    expect(final.summary).toContain('PASSPORT_SEEN')
    expect(final.summary).not.toContain(CLAUDE_TOKEN)
    expect(final.summary).not.toContain('acme-company-key-value')
    // steps and usage (subscription: no dollars)
    const detail = rt.runDetail(req.runId)!
    expect(detail.steps.map((s) => [s.nodeId, s.title, s.adapter, s.status])).toEqual([
      ['prep', 'Prepare', 'shell', 'passed'],
      ['draft', 'Draft', 'claude', 'passed']
    ])
    await waitFor(() => ports.rec.usage.some((u) => u.runId === req.runId))
    expect(ports.rec.usage.filter((u) => u.runId === req.runId)).toEqual([{ runId: req.runId, companyId: 'co_acme', adapter: 'claude', inputTokens: 120, outputTokens: 30, usd: null }])
    expect(rt.runDetail(req.runId)!.steps[1]!.usage).toEqual({ inputTokens: 120, outputTokens: 30, usd: null })
    // logs: streamed in batches and readable afterwards, always redacted
    const streamed = ports.rec.runLog.filter((l) => l.runId === req.runId).flatMap((l) => l.lines).join('\n')
    expect(streamed).toContain('prep-ok')
    const log = rt.runLog(req.runId, null, 200).join('\n')
    expect(log).toContain('prep-ok')
    for (const text of [streamed, log, JSON.stringify(detail)]) {
      expect(text).not.toContain(CLAUDE_TOKEN)
      expect(text).not.toContain('acme-company-key-value')
    }
    expect(log).toContain('••••ACME_KEY')
    // what the agent saw: its own home, the token, no control-plane variable, dontAsk, never --bare
    const env = JSON.parse(readFileSync(rt.artifactPath(req.runId, 'claude-env.json')!, 'utf8')) as { names: string[]; home: string; claudeConfigDir: string; cwd: string; args: string[] }
    expect(env.names).toContain('CLAUDE_CODE_OAUTH_TOKEN')
    expect(env.names).not.toContain('PRINCIPIA_SECRET')
    expect(env.names.filter((k) => k.startsWith('PRINCIPIA_') && !k.startsWith('PRINCIPIA_FORUM_'))).toEqual([])
    expect(env.home).toBe(join(root, 'data', 'runtime', 'runs', req.runId, 'home'))
    expect(env.claudeConfigDir).toBe(join(env.home, '.claude'))
    expect(env.cwd).toBe(join(root, 'workspace', 'co_acme'))
    expect(env.args).toContain('dontAsk')
    expect(env.args).not.toContain('--bare')
    expect(detail.artifacts.map((a) => a.name)).toContain('claude-env.json')
    expect(rt.artifactPath(req.runId, '../../etc/passwd')).toBeNull()
    // the run home is gone; logs and artifacts stay
    expect(existsSync(env.home)).toBe(false)
    // the passport card was fetched with the runtime grant; the harvested note went back as a write
    expect(host.requests.some((r) => r.path === '/v1/passports/pp_acme' && r.auth === `Bearer ${host.token}`)).toBe(true)
    await waitFor(() => host.notes.length > 0)
    expect(host.notes[0]).toMatchObject({ note: 'Launch', facts: [{ category: 'decision', text: 'The launch email goes out on Tuesdays' }] })
    // Forum: what the run posted is in its detail
    expect(detail.forumPosts!.map((p) => [p.text, p.author.kind, p.author.name])).toEqual([['Drafted the launch email.', 'agent', 'Launch email']])
    expect(ports.rec.forum.length).toBeGreaterThan(0)
  })

  it('a prompt run with Codex signed in with ChatGPT writes the refreshed sign-in back', async () => {
    const req = request(
      { kind: 'prompt', adapter: 'codex', prompt: 'REFRESH_AUTH summarise the week' },
      { materials: materials({ providers: [{ credentialId: 'cred_codex', adapter: 'codex', kind: 'codex_auth_json', value: AUTH_JSON }] }) }
    )
    rt.startRun(req)
    await settled(req.runId)
    expect(ports.finalStatus(req.runId)).toBe('passed')
    const summary = ports.rec.runStatus.filter((s) => s.runId === req.runId).at(-1)!.summary!
    expect(summary).toContain('fake-codex-ok auth=chatgpt store=file sandbox=workspace-write refreshed PASSPORT_SEEN')
    expect(ports.rec.saved).toHaveLength(1)
    expect(ports.rec.saved[0]).toMatchObject({ credentialId: 'cred_codex', adapter: 'codex', kind: 'codex_auth_json' })
    // a passed step proves the sign-in works (it clears an earlier usage limit on the account)
    expect(ports.rec.accounts).toContainEqual({ credentialId: 'cred_codex', adapter: 'codex', status: 'ok', detail: null })
    expect(JSON.parse(ports.rec.saved[0]!.value).tokens.access_token).toBe('refreshed-access-token-0123456789')
    await waitFor(() => ports.rec.usage.some((u) => u.runId === req.runId))
    expect(ports.rec.usage.find((u) => u.runId === req.runId)).toMatchObject({ adapter: 'codex', inputTokens: 200, outputTokens: 40, usd: null })
  })

  it('runs that share one ChatGPT sign-in are serialized', async () => {
    const mk = () => request({ kind: 'prompt', adapter: 'codex', prompt: 'SLOW work' }, { materials: materials({ providers: [{ credentialId: 'cred_shared', adapter: 'codex', kind: 'codex_auth_json', value: AUTH_JSON }] }) })
    const a = mk()
    const b = mk()
    rt.startRun(a)
    rt.startRun(b)
    await settled(a.runId)
    await settled(b.runId)
    const times = [a, b].map((r) => JSON.parse(readFileSync(rt.artifactPath(r.runId, 'codex-times.json')!, 'utf8')) as { start: number; end: number })
    const [first, second] = times.sort((x, y) => x.start - y.start)
    expect(second!.start).toBeGreaterThanOrEqual(first!.end)
  })

  it('an ask opens Needs you; the run ends needs_input; the answer is posted and a resume run is requested', async () => {
    const req = request({ kind: 'prompt', adapter: 'claude', prompt: 'FAKE_FORUM_ASK plan the launch' })
    rt.startRun(req)
    await settled(req.runId)
    const ask = ports.rec.asks.find((x) => x.runId === req.runId)!
    expect(ask).toMatchObject({ companyId: 'co_acme', agentName: 'Claude', question: 'Which plan should the launch email push?', options: ['Monthly', 'Yearly'] })
    const final = ports.rec.runStatus.filter((s) => s.runId === req.runId).at(-1)!
    expect(final).toEqual({ runId: req.runId, status: 'needs_input', summary: 'Waiting for your answer: Which plan should the launch email push?' })
    await rt.answerAsk(ask.id, 'Yearly')
    const resume = ports.rec.requests.at(-1)!
    expect(resume).toMatchObject({ companyId: 'co_acme', trigger: 'answer', target: { kind: 'prompt', adapter: 'claude' } })
    const prompt = (resume.target as { prompt: string }).prompt
    expect(prompt).toContain('Which plan should the launch email push?')
    expect(prompt).toContain('Answer: Yearly')
    // the answer is in the thread, so it is part of the run's Forum posts' replies
    expect(rt.runDetail(req.runId)!.forumPosts!.find((p) => p.kind === 'ask')!.replies).toBe(1)
  })

  it('fails plainly when an account is missing, the workflow is not runnable, or time runs out', async () => {
    const codexFile = { hive: 'workflow', version: 1, workflow: { name: 'Weekly review', description: '', inputs: [], nodes: [{ id: 'r', type: 'agent', label: 'Review', profileId: 'prof_codex', prompt: 'x', cwd: null, after: [], timeoutMin: 1 }] } }
    const missing = request({ kind: 'workflow', workflowId: 'wf_review', inputs: {} }, { workflowFile: codexFile })
    rt.startRun(missing)
    await settled(missing.runId)
    expect(ports.rec.runStatus.filter((s) => s.runId === missing.runId).at(-1)).toEqual({ runId: missing.runId, status: 'failed', summary: 'Weekly review uses Codex, which is not connected to the cloud.' })
    const escaping = { ...codexFile, workflow: { ...codexFile.workflow, nodes: [{ ...codexFile.workflow.nodes[0], cwd: '../../' }] } }
    expect(rt.validateWorkflow('co_acme', escaping)).toEqual(['Node "r": that folder is outside the company folder.'])
    const slow = { hive: 'workflow', version: 1, workflow: { name: 'Slow', description: '', inputs: [], nodes: [{ id: 's', type: 'shell', label: 'Sleep', command: 'sleep 20', cwd: null, after: [], timeoutMin: 1 }] } }
    const timed = request({ kind: 'workflow', workflowId: 'wf_slow', inputs: {} }, { workflowFile: slow, timeoutMs: 400 })
    rt.startRun(timed)
    await settled(timed.runId)
    expect(ports.rec.runStatus.filter((s) => s.runId === timed.runId).at(-1)).toEqual({ runId: timed.runId, status: 'failed', summary: 'Stopped at the 1-second limit.' })
  })

  it('cancelRun stops a running run', async () => {
    const slow = { hive: 'workflow', version: 1, workflow: { name: 'Slow', description: '', inputs: [], nodes: [{ id: 's', type: 'shell', label: 'Sleep', command: 'sleep 20', cwd: null, after: [], timeoutMin: 1 }] } }
    const req = request({ kind: 'workflow', workflowId: 'wf_slow2', inputs: {} }, { workflowFile: slow })
    rt.startRun(req)
    await waitFor(() => ports.rec.runStatus.some((s) => s.runId === req.runId && s.status === 'running'))
    await rt.cancelRun(req.runId)
    await settled(req.runId)
    expect(ports.finalStatus(req.runId)).toBe('canceled')
    expect(readdirSync(join(root, 'data', 'runtime', 'runs', req.runId))).not.toContain('home')
  })

  it('removeCompany deletes the company folder and its Forum', async () => {
    await rt.ensureCompany({ workspaceId: 'ws_1', companyId: 'co_gone', name: 'Gone', slug: 'gone' })
    expect(existsSync(join(root, 'workspace', 'co_gone'))).toBe(true)
    await rt.removeCompany('ws_1', 'co_gone')
    expect(existsSync(join(root, 'workspace', 'co_gone'))).toBe(false)
    await rt.ensureCompany({ workspaceId: 'ws_1', companyId: 'co_gone', name: 'Gone', slug: 'gone' })
  })

  it('v1 stubs: webhooks 501, server-side device login and the Forum console are not_in_v1', async () => {
    expect((await rt.triggers.webhook({ id: 'h', companyId: 'co_acme', workflowId: 'w', verify: 'github', secret: 's', inputs: {} }, { headers: {}, rawBody: Buffer.from('{}') })).status).toBe(501)
    await expect(rt.providers.startDeviceLogin('codex')).rejects.toMatchObject({ error: 'not_in_v1' })
    expect(rt.providers.deviceLoginStatus('lgn_1')).toBeNull()
    for (const call of [() => rt.forum.channels('co_acme'), () => rt.forum.messages('co_acme', 'c', { limit: 1 }), () => rt.forum.post('co_acme', 'c', 'hi', null)]) {
      let err: unknown
      try {
        call()
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(CloudRuntimeError)
      expect((err as CloudRuntimeError).error).toBe('not_in_v1')
    }
    expect(await rt.providers.cliVersions()).toEqual({ claude: '2.1.290', codex: '0.120.0', gemini: '0.9.0' })
  })
})
