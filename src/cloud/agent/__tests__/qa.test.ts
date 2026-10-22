/**
 * QA round on the agent runtime: the cases that broke or were missing after the build. Account failures read as the
 * fix, answers are idempotent, repo tokens reach git in runs (and only for their repo), companies stay apart, a
 * shutdown never loses a refreshed ChatGPT sign-in, the Forum keeps a long-lived seat's recent posts, and no seeded
 * secret reaches any port. Fake CLIs only; no model is ever called.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CloudRuntime, RunMaterials, RuntimeRunRequest } from '../../contract'
import { createCloudRuntime } from '../index'
import { CloudForum } from '../forum'
import { runFailureDetail } from '../providers/test'
import { runAskpass } from '../repos'
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

const CLAUDE_TOKEN = 'sk-ant-oat01-qa-test-token-0123456789abcdef'
const EXPIRED_TOKEN = 'sk-ant-oat01-qa-expired-token-0123456789abc'
const ACME_KEY = 'acme-only-company-key-value'
const BETA_KEY = 'beta-only-company-key-value'
const REPO_TOKEN = 'github_pat_11QAREPOTOKEN0123456789abcdefghij'
const OTHER_REPO_TOKEN = 'github_pat_11OTHERREPOTOKEN0123456789abcdef'

const at = new Date('2026-10-21T09:00:00Z')

describe('runFailureDetail: an account problem reads as its fix', () => {
  it('expired or rejected credentials, per kind', () => {
    expect(runFailureDetail({ adapter: 'claude', kind: 'claude_oauth_token' }, 'claude', 'Exited with code 1: OAuth token has expired. Please obtain a new token.', at)).toBe('Claude token expired. Connect Claude again.')
    expect(runFailureDetail({ adapter: 'claude', kind: 'anthropic_api_key' }, 'claude', 'Invalid API key · Please run /login\nAPI Error: 401', at)).toBe('Anthropic rejected the API key.')
    expect(runFailureDetail({ adapter: 'codex', kind: 'codex_auth_json' }, 'codex', 'Exited with code 1: Not logged in. Please run codex login', at)).toBe('Codex is signed out. Sign in with ChatGPT again.')
  })
  it('usage limits name the CLI and the reset time when it is known', () => {
    expect(runFailureDetail({ adapter: 'claude', kind: 'claude_oauth_token' }, 'claude', 'Exited with code 1: Claude AI usage limit reached|1792580400', at)).toBe('Claude Code hit its usage limit. It resets at 11:00 UTC.')
    expect(runFailureDetail({ adapter: 'codex', kind: 'openai_api_key' }, 'codex', "You've hit your usage limit. Upgrade to Pro or try again later.", at)).toMatch(/^Codex hit its usage limit\./)
  })
  it('an agent talking about a 401 in someone else\'s code, a shell step, or no error is not an account problem', () => {
    expect(runFailureDetail({ adapter: 'claude', kind: 'claude_oauth_token' }, 'claude', 'Exited with code 1: The billing API returned 401 Unauthorized, so I could not finish.', at)).toBeNull()
    expect(runFailureDetail(null, 'shell', 'Exited with code 1: OAuth token has expired', at)).toBeNull()
    expect(runFailureDetail(null, 'claude', null, at)).toBeNull()
  })
})

describe('runAskpass: a run\'s repo tokens reach git, each only for its own repo', () => {
  it('answers the username and the password of the repo git runs in; nothing elsewhere', () => {
    const root = tmp()
    const home = join(root, 'home')
    const repoA = join(root, 'co', 'quest')
    const repoB = join(root, 'co', "it's-other")
    for (const d of [home, join(repoA, 'src'), repoB]) mkdirSync(d, { recursive: true })
    const env = runAskpass(home, [
      { dir: repoA, token: REPO_TOKEN },
      { dir: repoB, token: OTHER_REPO_TOKEN }
    ])
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    const script = env.GIT_ASKPASS!
    expect(script.startsWith(home)).toBe(true)
    expect(statSync(script).mode & 0o777).toBe(0o700)
    const ask = (cwd: string, prompt: string): string | null => {
      try {
        return execFileSync(script, [prompt], { cwd }).toString().trim()
      } catch {
        return null
      }
    }
    expect(ask(repoA, "Username for 'https://github.com': ")).toBe('x-access-token')
    expect(ask(repoA, "Password for 'https://x-access-token@github.com': ")).toBe(REPO_TOKEN)
    expect(ask(join(repoA, 'src'), 'Password: ')).toBe(REPO_TOKEN)
    expect(ask(repoB, 'Password: ')).toBe(OTHER_REPO_TOKEN)
    expect(ask(join(root, 'co'), 'Password: ')).toBeNull()
    // the tokens are files in the run home, never in the script or the environment
    expect(readFileSync(script, 'utf8')).not.toContain(REPO_TOKEN)
    expect(JSON.stringify(env)).not.toContain(REPO_TOKEN)
  })

  it('git itself picks the token up from inside the repo (credential fill, no helper)', () => {
    const root = tmp()
    const repo = join(root, 'quest')
    mkdirSync(join(repo, 'deep'), { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: repo })
    const env = runAskpass(join(root, 'home'), [{ dir: repo, token: REPO_TOKEN }])
    const out = execFileSync('git', ['-c', 'credential.helper=', 'credential', 'fill'], {
      cwd: join(repo, 'deep'),
      input: 'protocol=https\nhost=github.com\n\n',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(root, 'home'), GIT_CONFIG_NOSYSTEM: '1', ...env }
    }).toString()
    expect(out).toContain('username=x-access-token')
    expect(out).toContain(`password=${REPO_TOKEN}`)
  })
})

describe.skipIf(!sqliteOk)('cloud Forum bookkeeping', () => {
  const mk = (): CloudForum => {
    const root = tmp()
    const ports = fakePorts()
    return new CloudForum({ dbPath: join(root, 'forum.db'), spawnRoot: join(root, 'shims'), cliScript: null, redact: (s) => s, now: () => new Date(), ports, cloudRun: () => null })
  }

  it('forumPosts keeps a long-lived seat\'s recent posts (a schedule that posted thousands of times)', () => {
    const f = mk()
    f.ensureCompany({ companyId: 'co_a', name: 'A', slug: 'a' })
    const seat = f.seat('co_a', 'workflow:wf_daily', 'Daily')
    const member = f.service.store.memberForAgent(seat)!
    const general = f.service.store.channelByName('co_a', 'general')!
    f.service.store.join(member.id, general.id)
    const insert = f.db.transaction(() => {
      for (let i = 0; i < 2100; i++) f.service.store.post(member.id, { channelId: general.id, text: `old post ${i}`, origin: `agent:step_old${i}` })
    })
    insert()
    f.service.store.post(member.id, { channelId: general.id, text: 'Posted today.', origin: 'agent:step_today' })
    expect(f.postsOf('co_a', seat, ['step_today'], 'run_today').map((p) => p.text)).toEqual(['Posted today.'])
    void f.shutdown()
  })

  it('removeCompany leaves no mention rows behind', () => {
    const f = mk()
    f.ensureCompany({ companyId: 'co_a', name: 'A', slug: 'a' })
    const seat = f.seat('co_a', 'workflow:wf_daily', 'Daily')
    const member = f.service.store.memberForAgent(seat)!
    const owner = f.service.store.owner('co_a')
    const general = f.service.store.channelByName('co_a', 'general')!
    f.service.store.post(owner.id, { channelId: general.id, text: `@${member.handle} please check the numbers` })
    const count = () => (f.db.prepare('SELECT COUNT(*) AS n FROM forum_mentions WHERE company_id=?').get('co_a') as { n: number }).n
    expect(count()).toBe(1)
    f.removeCompany('co_a')
    expect(count()).toBe(0)
    void f.shutdown()
  })
})

describe.skipIf(!sqliteOk)('cloud runtime QA (fake CLIs)', () => {
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
    secrets: { ACME_KEY },
    ...o
  })
  const request = (target: RuntimeRunRequest['target'], o: Partial<RuntimeRunRequest> = {}): RuntimeRunRequest => ({
    runId: `crun_qa${++n}`,
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
  const final = (runId: string) => ports.rec.runStatus.filter((s) => s.runId === runId).at(-1)!
  const shellFile = (name: string, command: string) => ({ hive: 'workflow', version: 1, workflow: { name, description: '', inputs: [], nodes: [{ id: 's', type: 'shell', label: 'Shell', command, cwd: null, after: [], timeoutMin: 1 }] } })

  beforeAll(async () => {
    host = await fakePassportHost()
    root = tmp()
    ports = fakePorts({ secrets: ['qa-known-secret-from-control-plane'] })
    rt = createCloudRuntime({ dataDir: join(root, 'data'), workspaceDir: join(root, 'workspace'), ports, bins: { ...FAKE_BINS, git: 'git' } })
    await rt.start()
    await rt.ensureCompany({ workspaceId: 'ws_1', companyId: 'co_acme', name: 'Acme', slug: 'acme' })
    await rt.ensureCompany({ workspaceId: 'ws_1', companyId: 'co_beta', name: 'Beta', slug: 'beta' })
  })
  afterAll(async () => {
    await rt?.close()
    await host?.close()
  })

  it('an expired Claude token fails the run with the fix, not a stack trace', async () => {
    const req = request({ kind: 'prompt', adapter: 'claude', prompt: 'draft the newsletter' }, { materials: materials({ providers: [{ credentialId: 'cred_old', adapter: 'claude', kind: 'claude_oauth_token', value: EXPIRED_TOKEN }] }) })
    rt.startRun(req)
    await settled(req.runId)
    expect(final(req.runId)).toEqual({ runId: req.runId, status: 'failed', summary: 'Claude token expired. Connect Claude again.' })
    // the engine's harness fallback never reaches a CLI this run has no account for (Codex, signed out here)
    expect(rt.runDetail(req.runId)!.steps.map((s) => s.adapter)).toEqual(['claude'])
    // CLOUD.md §7.9: the account itself is marked, so the Accounts row and readiness stop saying OK
    expect(ports.rec.accounts).toContainEqual({ credentialId: 'cred_old', adapter: 'claude', status: 'expired', detail: 'Claude token expired. Connect Claude again.' })
  })

  it('a usage limit says so with the reset time; an agent quoting a 401 keeps its own reason', async () => {
    const limit = request({ kind: 'prompt', adapter: 'claude', prompt: 'LIMIT_HIT work' })
    rt.startRun(limit)
    await settled(limit.runId)
    expect(final(limit.runId)).toMatchObject({ status: 'failed', summary: 'Claude Code hit its usage limit. It resets at 11:00 UTC.' })
    expect(ports.rec.accounts.at(-1)).toMatchObject({ adapter: 'claude', status: 'limited', detail: 'Claude Code hit its usage limit. It resets at 11:00 UTC.' })
    const prose = request({ kind: 'prompt', adapter: 'claude', prompt: 'MENTION_401 work' })
    rt.startRun(prose)
    await settled(prose.runId)
    expect(final(prose.runId).status).toBe('failed')
    expect(final(prose.runId).summary).toContain('The billing API returned 401 Unauthorized')
    // an agent's prose about someone else's 401 is not an account problem: nothing new is reported for that run
    expect(ports.rec.accounts.filter((a) => a.status === 'expired' && a.credentialId !== 'cred_old')).toEqual([])
  })

  it('answering an ask twice posts once and requests one resume run', async () => {
    const req = request({ kind: 'prompt', adapter: 'claude', prompt: 'FAKE_FORUM_ASK plan the launch' })
    rt.startRun(req)
    await settled(req.runId)
    expect(final(req.runId).status).toBe('needs_input')
    const ask = ports.rec.asks.find((x) => x.runId === req.runId)!
    const before = ports.rec.requests.length
    await rt.answerAsk(ask.id, 'Yearly')
    await rt.answerAsk(ask.id, 'Yearly')
    expect(ports.rec.requests.length).toBe(before + 1)
    expect(rt.runDetail(req.runId)!.forumPosts!.find((p) => p.kind === 'ask')!.replies).toBe(1)
    await expect(rt.answerAsk('cask_nope', 'x')).rejects.toMatchObject({ error: 'not_found' })
  })

  it('a run with a repo token can authenticate git in that repo; the token never shows in logs or the summary', async () => {
    const repoDir = join(root, 'workspace', 'co_acme', 'quest')
    mkdirSync(repoDir, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: repoDir })
    const repos = [{ id: 'repo_quest', name: 'quest', url: 'https://github.com/vibiz-ai/quest', branch: null, token: REPO_TOKEN }]
    const req = request({ kind: 'prompt', adapter: 'claude', prompt: 'GIT_TOKEN push the branch', repoId: 'repo_quest' }, { materials: materials({ repos }) })
    rt.startRun(req)
    await settled(req.runId)
    expect(final(req.runId).status).toBe('passed')
    // what git got inside the run (an artifact the agent wrote; the run's own logs are redacted)
    const cred = readFileSync(rt.artifactPath(req.runId, 'git-cred.txt')!, 'utf8')
    expect(cred).toContain('username=x-access-token')
    expect(cred).toContain(`password=${REPO_TOKEN}`)
    expect(final(req.runId).summary).not.toContain(REPO_TOKEN)
    expect(rt.runLog(req.runId, null, 500).join('\n')).not.toContain(REPO_TOKEN)
    expect(ports.rec.runLog.filter((l) => l.runId === req.runId).flatMap((l) => l.lines).join('\n')).not.toContain(REPO_TOKEN)
    // the askpass and its token file went with the run home
    expect(existsSync(join(root, 'data', 'runtime', 'runs', req.runId, 'home'))).toBe(false)
    const env = JSON.parse(readFileSync(rt.artifactPath(req.runId, 'claude-env.json')!, 'utf8')) as { names: string[] }
    expect(env.names).toContain('GIT_ASKPASS')
  })

  it('companies stay apart: keys, folders and workflows of one company never reach another', async () => {
    // Beta's run sees Beta's key only
    const beta = request(
      { kind: 'workflow', workflowId: 'wf_beta_env', inputs: {} },
      { companyId: 'co_beta', companyName: 'Beta', workflowFile: shellFile('Env', 'echo "acme=${ACME_KEY:-none} beta=${BETA_KEY:-none}"; pwd'), materials: materials({ secrets: { BETA_KEY } }) }
    )
    rt.startRun(beta)
    await settled(beta.runId)
    expect(final(beta.runId).status).toBe('passed')
    const log = rt.runLog(beta.runId, null, 50).join('\n')
    expect(log).toContain('acme=none')
    expect(log).toContain('beta=••••BETA_KEY')
    expect(log).toContain(join(root, 'workspace', 'co_beta'))
    // Beta's workflow cannot point at Acme's folder, by path or through a symlink
    expect(rt.validateWorkflow('co_beta', { ...shellFile('X', 'ls'), workflow: { ...shellFile('X', 'ls').workflow, nodes: [{ ...shellFile('X', 'ls').workflow.nodes[0], cwd: join(root, 'workspace', 'co_acme') }] } })).toEqual([
      'Node "s": that folder is outside the company folder.'
    ])
    const link = join(root, 'workspace', 'co_beta', 'acme-link')
    execFileSync('ln', ['-s', join(root, 'workspace', 'co_acme'), link])
    expect(rt.validateWorkflow('co_beta', { ...shellFile('X', 'ls'), workflow: { ...shellFile('X', 'ls').workflow, nodes: [{ ...shellFile('X', 'ls').workflow.nodes[0], cwd: 'acme-link' }] } })).toEqual([
      'Node "s": that folder leads outside the company folder.'
    ])
    // a prompt run cannot use another company's repo
    const repos = [{ id: 'repo_acme_only', name: 'acme-only', url: 'https://github.com/vibiz-ai/acme-only', branch: null, token: null }]
    mkdirSync(join(root, 'workspace', 'co_acme', 'acme-only'), { recursive: true })
    const own = request({ kind: 'prompt', adapter: 'claude', prompt: 'hello', repoId: 'repo_acme_only' }, { materials: materials({ repos }) })
    rt.startRun(own)
    await settled(own.runId)
    const cross = request({ kind: 'prompt', adapter: 'claude', prompt: 'hello', repoId: 'repo_acme_only' }, { companyId: 'co_beta', companyName: 'Beta' })
    rt.startRun(cross)
    await settled(cross.runId)
    expect(final(cross.runId)).toMatchObject({ status: 'failed', summary: 'That repository is not in this company' })
  })

  it('a duplicate startRun is ignored; a run started while the runtime is down fails plainly', async () => {
    const req = request({ kind: 'workflow', workflowId: 'wf_dup', inputs: {} }, { workflowFile: shellFile('Dup', 'echo once') })
    rt.startRun(req)
    rt.startRun(req)
    await settled(req.runId)
    expect(ports.rec.runStatus.filter((s) => s.runId === req.runId).map((s) => s.status)).toEqual(['running', 'passed'])
    const other = createCloudRuntime({ dataDir: join(root, 'down'), workspaceDir: join(root, 'down-ws'), ports, bins: { ...FAKE_BINS, git: 'git' } })
    other.startRun(request({ kind: 'prompt', adapter: 'claude', prompt: 'x' }, { runId: 'crun_down' }))
    expect(final('crun_down')).toMatchObject({ status: 'failed' })
    expect(other.health().status).toBe('down')
  })

  it('no seeded secret reaches any port: statuses, steps, logs, asks, audit, process logs', () => {
    const everything = JSON.stringify({ ...ports.rec, saved: [] })
    for (const secret of [CLAUDE_TOKEN, EXPIRED_TOKEN, ACME_KEY, BETA_KEY, REPO_TOKEN, host.token, 'qa-known-secret-from-control-plane']) expect(everything).not.toContain(secret)
  })
})

describe.skipIf(!sqliteOk)('shutdown never loses a refreshed ChatGPT sign-in', () => {
  it('a Codex run cut by close() still writes the refreshed auth.json back', async () => {
    const root = tmp()
    const ports = fakePorts()
    const rt = createCloudRuntime({ dataDir: join(root, 'data'), workspaceDir: join(root, 'ws'), ports, bins: { ...FAKE_BINS, git: 'git' } })
    await rt.start()
    await rt.ensureCompany({ workspaceId: 'ws_1', companyId: 'co_acme', name: 'Acme', slug: 'acme' })
    const auth = JSON.stringify({ tokens: { id_token: 'id-token-value-0123456789', access_token: 'access-token-original-0123456789', refresh_token: 'refresh-token-0123456789abc', account_id: 'acct_1' } })
    // the fake codex refreshes the sign-in first, then works slowly: the close lands mid-run
    rt.startRun({
      runId: 'crun_cut',
      workspaceId: 'ws_1',
      companyId: 'co_acme',
      companyName: 'Acme',
      trigger: 'manual',
      target: { kind: 'prompt', adapter: 'codex', prompt: 'REFRESH_AUTH HANG work' },
      workflowFile: null,
      timeoutMs: 60_000,
      untrustedInputs: [],
      materials: { providers: [{ credentialId: 'cred_codex', adapter: 'codex', kind: 'codex_auth_json', value: auth }], repos: [], connections: [], passport: null, secrets: {} }
    })
    await waitFor(() => ports.rec.runStatus.some((s) => s.runId === 'crun_cut' && s.status === 'running'))
    await new Promise((r) => setTimeout(r, 300))
    await rt.close()
    expect(ports.finalStatus('crun_cut')).toBe('canceled')
    expect(ports.rec.saved.map((s) => s.credentialId)).toEqual(['cred_codex'])
    expect(JSON.parse(ports.rec.saved[0]!.value).tokens.access_token).toBe('refreshed-access-token-0123456789')
  })
})

