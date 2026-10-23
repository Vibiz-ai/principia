// Cloud pane view models (docs/CLOUD.md §13.1): tesserae, billing badges, expiry, account rows, setup strip, fix
// actions, the dependency-aware move checklist reducer and the ask answer payload.
import { describe, expect, it } from 'vitest'
import type { CloudAsk, ProviderAccount } from '@shared/cloud'
import type { CloudMovePlan } from '@shared/types'
import {
  accountRow,
  agentParts,
  andList,
  askAnswer,
  billingBadge,
  expiryLabel,
  fixAction,
  initChecklist,
  loginLine,
  pasteProblem,
  readinessLabel,
  recentRuns,
  reduceChecklist,
  runTessera,
  runTimeLabel,
  setupSteps,
  statusLine,
  toChoices,
  usageLine,
  visibleNeeds,
  type Checklist
} from './cloud'

const NOW = new Date('2026-10-21T10:00:00Z')
const acct = (p: Partial<ProviderAccount> & Pick<ProviderAccount, 'adapter'>): ProviderAccount => ({ credential: null, status: 'missing', detail: null, cliVersion: null, ...p })
const cred = (kind: NonNullable<ProviderAccount['credential']>['kind'], p: Partial<NonNullable<ProviderAccount['credential']>> = {}) => ({ id: 'cred', kind, label: '', createdAt: '', lastUsedAt: null, expiresAt: null, ...p })

describe('status tesserae and badges', () => {
  it('maps run statuses to tiles', () => {
    expect(['passed', 'needs_input', 'failed', 'running', 'queued', 'canceled', 'weird'].map(runTessera)).toEqual(['ok', 'needs', 'fail', 'running', 'q', 'q', 'q'])
  })
  it('Subscription vs API billing from the credential kind (SUBSCRIPTION_KINDS)', () => {
    expect(billingBadge('claude_oauth_token')).toBe('Subscription')
    expect(billingBadge('codex_auth_json')).toBe('Subscription')
    expect(billingBadge('anthropic_api_key')).toBe('API billing')
    expect(billingBadge('openai_api_key')).toBe('API billing')
    expect(billingBadge('gemini_api_key')).toBe('API billing')
    expect(billingBadge(null)).toBeNull()
  })
  it('expiry: month and year, expired, or nothing for refreshing sign-ins', () => {
    expect(expiryLabel('2027-10-21T00:00:00Z', NOW)).toBe('expires Oct 2027')
    expect(expiryLabel('2026-01-01T00:00:00Z', NOW)).toBe('expired')
    expect(expiryLabel(null, NOW)).toBeNull()
  })
})

describe('account rows: one primary action each', () => {
  it('not connected: Connect Claude, Sign in with ChatGPT, Add key', () => {
    expect(['claude', 'codex', 'gemini'].map((a) => accountRow(acct({ adapter: a as 'claude' }), NOW).primary.label)).toEqual(['Connect Claude', 'Sign in with ChatGPT', 'Add key'])
    expect(accountRow(acct({ adapter: 'gemini' }), NOW)).toMatchObject({ line: 'Not connected', badge: null, status: { tone: 'off', label: 'Off' } })
  })
  it('connected Claude: subscription badge, expiry, Test', () => {
    const r = accountRow(acct({ adapter: 'claude', status: 'ok', credential: cred('claude_oauth_token', { expiresAt: '2027-10-21T00:00:00Z' }) }), NOW)
    expect(r).toMatchObject({ line: 'Connected · expires Oct 2027', badge: 'Subscription', status: { tone: 'ok' }, primary: { kind: 'test', label: 'Test' } })
  })
  it('a signed-out ChatGPT sign-in says when, and offers to sign in again', () => {
    const r = accountRow(acct({ adapter: 'codex', status: 'failing', credential: cred('codex_auth_json', { lastUsedAt: new Date(2026, 9, 21, 1, 40).toISOString() }) }), NOW)
    expect(r).toMatchObject({ line: 'Signed out at 01:40', status: { tone: 'err', label: 'Signed out' }, primary: { label: 'Sign in with ChatGPT' } })
  })
  it('paste checks the shape without echoing the value', () => {
    expect(pasteProblem('claude_oauth_token', 'sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxx')).toMatch(/sk-ant-oat01/)
    expect(pasteProblem('claude_oauth_token', 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz')).toBeNull()
    expect(pasteProblem('google_service_account', '{"type":"service_account","private_key":"k"}')).toBeNull()
    expect(pasteProblem('openai_api_key', ' ')).toBe('Paste a key or token.')
    expect(pasteProblem('openai_api_key', 'sk-secretvalue-that-is-wrong!!')).not.toContain('secretvalue')
  })
  it('login progress shows on its own row only while it runs or failed', () => {
    const l = { adapter: 'codex' as const, phase: 'waiting' as const, message: 'Your browser is open on ChatGPT.', reason: null, installHint: null, browserUrl: null }
    expect(loginLine(l, 'codex')).toEqual({ busy: true, text: 'Your browser is open on ChatGPT.', failed: false })
    expect(loginLine(l, 'claude')).toBeNull()
    expect(loginLine({ ...l, phase: 'done' }, 'codex')).toBeNull()
    expect(loginLine({ ...l, phase: 'failed', message: 'x' }, 'codex')?.failed).toBe(true)
  })
})

describe('header and setup strip', () => {
  it('Online, or Offline since a time; usage over 24 h', () => {
    expect(statusLine({ online: true, offlineSince: null })).toEqual({ tone: 'ok', label: 'Online' })
    expect(statusLine({ online: false, offlineSince: new Date(2026, 9, 21, 3, 12).toISOString() })).toEqual({ tone: 'err', label: 'Offline since 03:12' })
    expect(usageLine({ runs: 14, runMinutes: 96.4 })).toBe('24 h · 14 runs · 96 min')
  })
  it('the strip ticks steps as they are done and disappears when all three are', () => {
    const ok = (a: 'claude' | 'codex') => acct({ adapter: a, status: 'ok', credential: cred(a === 'claude' ? 'claude_oauth_token' : 'codex_auth_json') })
    const login = { adapter: 'codex' as const, phase: 'waiting' as const, message: null, reason: null, installHint: null, browserUrl: null }
    expect(setupSteps({ providers: [ok('claude')], companies: [] }, login)?.map((s) => s.state)).toEqual(['done', 'running', 'todo'])
    expect(setupSteps({ providers: [ok('claude'), ok('codex')], companies: [{} as never] }, null)).toBeNull()
  })
})

describe('readiness fixes', () => {
  it('each fix kind maps to its one-click action', () => {
    expect(fixAction({ kind: 'account', ref: 'codex', message: '' })).toEqual({ label: 'Sign in with ChatGPT', kind: 'signInChatGPT' })
    expect(fixAction({ kind: 'account', ref: 'claude', message: '' }).kind).toBe('connectClaude')
    expect(fixAction({ kind: 'account', ref: 'gemini', message: '' }).label).toBe('Add key')
    expect(fixAction({ kind: 'key', ref: 'FAL_KEY', message: '' })).toEqual({ label: 'Copy FAL_KEY', kind: 'copyKey' })
    expect(fixAction({ kind: 'connection', ref: 'notion', message: '' }).kind).toBe('authorize')
    expect(fixAction({ kind: 'repo', ref: 'r', message: '' }).kind).toBe('repoToken')
    expect(fixAction({ kind: 'workflow', ref: 'w', message: '' }).kind).toBe('manage')
    expect(readinessLabel({ ready: false, fixes: [{ kind: 'key', ref: 'A', message: '' }] })).toEqual({ tone: 'fail', label: '1 fix' })
    expect(readinessLabel({ ready: true, fixes: [] }).label).toBe('Ready')
  })
})

const PLAN: CloudMovePlan = {
  companyId: 'co',
  companyName: 'Vibiz Quest',
  inCloud: false,
  workflows: [
    { id: 'wf_a', name: 'Daily standup', ok: true, reason: null, adapters: ['codex'] },
    { id: 'wf_b', name: 'Quest content', ok: true, reason: null, adapters: ['claude'] },
    { id: 'wf_c', name: 'Bug sweep', ok: false, reason: 'Bug sweep runs in a worktree on this Mac.', adapters: ['claude'] }
  ],
  schedules: [
    { id: 's_a', name: 'Daily standup', sentence: 'weekdays 09:00', workflowId: 'wf_a', ok: true, reason: null, placement: 'local' },
    { id: 's_c', name: 'Bug sweep', sentence: 'every 6 h', workflowId: 'wf_c', ok: false, reason: 'stays', placement: 'local' }
  ],
  repos: [
    { id: 'r1', name: 'quest', url: 'https://github.com/vibiz-ai/quest', ownerRepo: 'vibiz-ai/quest', ok: true, reason: null, tokenUrl: 'https://github.com/settings/personal-access-tokens/new' },
    { id: 'r2', name: 'notes', url: null, ownerRepo: null, ok: false, reason: 'no origin', tokenUrl: '' }
  ],
  needs: { keys: [{ name: 'FAL_KEY', usedBy: ['wf_b'] }, { name: 'FIRECRAWL_API_KEY', usedBy: ['wf_a'] }], connections: [{ id: 'linear', name: 'Linear', hasCredentials: true, usedBy: ['wf_a', 'wf_b'] }] },
  oauth: [{ id: 'notion', name: 'Notion', usedBy: ['wf_b'] }]
}

describe('move checklist', () => {
  it('starts with runnable workflows, their schedules, GitHub repos and every needed key and connection ticked', () => {
    const s = initChecklist(PLAN)
    expect(s).toEqual({ workflows: ['wf_a', 'wf_b'], schedules: ['s_a'], repos: { r1: { on: true, token: '' } }, keys: ['FAL_KEY', 'FIRECRAWL_API_KEY'], connections: ['linear'] })
  })
  it('unticking a workflow hides what only it needs and drops its schedules; unused secrets are never sent', () => {
    let s = initChecklist(PLAN)
    s = reduceChecklist(PLAN, s, { type: 'workflow', id: 'wf_b', on: false })
    expect(visibleNeeds(PLAN, s)).toEqual({ keys: ['FIRECRAWL_API_KEY'], connections: [{ id: 'linear', name: 'Linear' }], oauth: [] })
    expect(toChoices(PLAN, s).keys).toEqual(['FIRECRAWL_API_KEY'])
    s = reduceChecklist(PLAN, s, { type: 'workflow', id: 'wf_a', on: false })
    expect(s.schedules).toEqual([])
    expect(toChoices(PLAN, s)).toMatchObject({ workflows: [], schedules: [], keys: [], connections: [] })
  })
  it('ticking a schedule ticks its workflow; refused rows cannot be ticked', () => {
    let s: Checklist = { ...initChecklist(PLAN), workflows: [], schedules: [] }
    s = reduceChecklist(PLAN, s, { type: 'schedule', id: 's_a', on: true })
    expect(s.workflows).toEqual(['wf_a'])
    expect(reduceChecklist(PLAN, s, { type: 'workflow', id: 'wf_c', on: true })).toBe(s)
    expect(reduceChecklist(PLAN, s, { type: 'schedule', id: 's_c', on: true })).toBe(s)
  })
  it('an unticked key stays on this Mac; repo tokens are trimmed, blank = public', () => {
    let s = initChecklist(PLAN)
    s = reduceChecklist(PLAN, s, { type: 'key', id: 'FAL_KEY', on: false })
    s = reduceChecklist(PLAN, s, { type: 'repoToken', id: 'r1', token: '  github_pat_x  ' })
    const c = toChoices(PLAN, s, ['wf_a'])
    expect(c.keys).toEqual(['FIRECRAWL_API_KEY'])
    expect(c.repos).toEqual([{ id: 'r1', token: 'github_pat_x' }])
    expect(c.overwrite).toEqual(['wf_a'])
    expect(toChoices(PLAN, reduceChecklist(PLAN, s, { type: 'repoToken', id: 'r1', token: ' ' })).repos).toEqual([{ id: 'r1', token: null }])
    expect(toChoices(PLAN, reduceChecklist(PLAN, s, { type: 'repo', id: 'r1', on: false })).repos).toEqual([])
  })
  it('a second move ticks the schedules already in the cloud only', () => {
    const plan = { ...PLAN, inCloud: true, schedules: [{ ...PLAN.schedules[0], placement: 'cloud' as const }, { ...PLAN.schedules[0], id: 's_x', placement: 'local' as const }] }
    expect(initChecklist(plan).schedules).toEqual(['s_a'])
  })
  it('andList', () => {
    expect(andList(['FAL_KEY', 'FIRECRAWL_API_KEY'])).toBe('FAL_KEY and FIRECRAWL_API_KEY')
    expect(andList(['A', 'B', 'C'])).toBe('A, B and C')
  })
})

describe('needs you and runs', () => {
  const ask: CloudAsk = { id: 'cask_1', companyId: 'co', runId: 'r', agentName: 'Marcus · Copywriter', question: 'Today or Thursday?', options: ['Today', 'Thursday'], createdAt: '', status: 'open', answer: null }
  it('the answer payload: an offered option, or trimmed free text; nothing for a closed ask', () => {
    expect(askAnswer(ask, { option: 'Thursday' })).toEqual({ id: 'cask_1', answer: 'Thursday' })
    expect(askAnswer(ask, { option: 'Friday' })).toBeNull()
    expect(askAnswer(ask, { text: '  after the newsletter  ' })).toEqual({ id: 'cask_1', answer: 'after the newsletter' })
    expect(askAnswer(ask, { text: '   ' })).toBeNull()
    expect(askAnswer({ ...ask, status: 'answered' }, { option: 'Today' })).toBeNull()
  })
  it('agent name and role', () => {
    expect(agentParts('Marcus · Copywriter')).toEqual({ name: 'Marcus', role: 'Copywriter' })
    expect(agentParts(null)).toEqual({ name: 'An agent', role: null })
  })
  it('run time labels and the last 8', () => {
    const local = (h: number, m: number) => new Date(2026, 9, 21, h, m).toISOString()
    const now = new Date(2026, 9, 21, 10, 0)
    const base = { createdAt: local(9, 0), startedAt: local(9, 0), endedAt: local(9, 4), summary: null }
    expect(runTimeLabel({ ...base, status: 'passed' }, now)).toBe('09:00 · 4 min')
    expect(runTimeLabel({ ...base, status: 'needs_input' }, now)).toBe('09:00 · needs you')
    expect(runTimeLabel({ ...base, status: 'failed', summary: 'Codex signed out' }, now)).toBe('09:00 · Codex signed out')
    expect(runTimeLabel({ ...base, status: 'passed', createdAt: new Date(2026, 9, 20, 9).toISOString(), startedAt: new Date(2026, 9, 20, 9).toISOString() }, now)).toBe('yesterday')
    const runs = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, createdAt: `2026-10-21T0${i}:00:00Z` }) as never)
    expect(recentRuns(runs).map((r: { id: string }) => r.id)).toEqual(['r9', 'r8', 'r7', 'r6', 'r5', 'r4', 'r3', 'r2'])
  })
})

describe('passport, keys and the cloud start (CLOUD.md §7.1, §7.9, §12.1)', () => {
  it('copies a Passport URL only when ChatGPT and Claude.ai can reach it', async () => {
    const { passportCopy } = await import('./cloud')
    expect(passportCopy({ mcpUrl: 'https://cloud.acme.dev/v1/passports/co_a/mcp' })).toEqual({ ok: true, url: 'https://cloud.acme.dev/v1/passports/co_a/mcp' })
    for (const mcpUrl of ['http://127.0.0.1:8788/v1/passports/co_a/mcp', 'https://localhost/v1/passports/x/mcp', 'https://192.168.1.20/v1/passports/x/mcp', 'http://passport.acme.dev/v1/passports/x/mcp']) {
      const out = passportCopy({ mcpUrl })
      expect(out.ok, mcpUrl).toBe(false)
      if (!out.ok) {
        expect(out.message).toBe('ChatGPT and Claude.ai need a public HTTPS address')
        expect(out.detail).toMatch(/caddy profile|Render/)
      }
    }
    expect(passportCopy(null).ok).toBe(false)
  })

  it('passport lines in words, revisions on hover; keys with human names; who uses what', async () => {
    const { passportLine, keyLabel, usedByLine, fixAction } = await import('./cloud')
    expect(passportLine({ revision: 48, pendingProposals: 3 })).toEqual({ text: 'Passport · 3 new facts', title: 'Passport revision 48' })
    expect(passportLine({ revision: 2, pendingProposals: 0 }).text).toBe('Passport · in sync')
    expect(passportLine(null).text).toBe('No passport yet')
    expect(keyLabel('FAL_KEY')).toBe('fal.ai key (FAL_KEY)')
    expect(keyLabel('FIRECRAWL_API_KEY')).toBe('Firecrawl key (FIRECRAWL_API_KEY)')
    expect(keyLabel('ACME_PARTNER_TOKEN')).toBe('ACME_PARTNER_TOKEN')
    const wfs = [{ id: 'a', name: 'Quest content' }, { id: 'b', name: 'Crawl' }, { id: 'c', name: 'Brief' }]
    expect(usedByLine(['a'], wfs)).toBe('used by Quest content')
    expect(usedByLine(['a', 'b'], wfs)).toBe('used by Quest content and Crawl')
    expect(usedByLine(['a', 'b', 'c'], wfs)).toBe('used by Quest content and 2 more')
    expect(usedByLine([], wfs)).toBe('')
    expect(fixAction({ kind: 'account', ref: 'codex', message: 'x', action: 'wait' })).toEqual({ label: '', kind: 'none' })
    expect(fixAction({ kind: 'account', ref: 'claude', message: 'x' }).label).toBe('Connect Claude')
  })

  it('the start points need no clone: one Render button, one downloadable compose file', async () => {
    const { RENDER_DEPLOY_URL, COMPOSE_COMMANDS } = await import('./cloud')
    expect(RENDER_DEPLOY_URL).toBe('https://render.com/deploy?repo=https://github.com/Vibiz-ai/principia')
    expect(COMPOSE_COMMANDS.split('\n')).toEqual(['curl -fsSL https://raw.githubusercontent.com/Vibiz-ai/principia/main/cloud/compose.yml -o compose.yml', 'docker compose up -d'])
  })
})
