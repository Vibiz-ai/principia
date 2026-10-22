// Cloud pane states as server markup (docs/CLOUD.md §13.1, docs/cloud.html): not connected, connected (header, setup
// strip, Needs you, Companies with readiness, runs, accounts with billing badges), and Home's CloudNeedsYou (one inbox,
// nothing when not linked). Agent text renders as text. No warm colours in the stylesheet.
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { WorkspaceSummary } from '@shared/cloud'
import { DEFAULT_QUOTAS } from '@shared/cloud'
import type { CloudLinkState } from '@shared/types'

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const useSyncExternalStore = <T,>(sub: (cb: () => void) => () => void, get: () => T): T => actual.useSyncExternalStore(sub, get, get)
  return { ...actual, default: { ...actual, useSyncExternalStore }, useSyncExternalStore }
})
const mem = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) })
vi.stubGlobal('window', { hive: {}, addEventListener: () => {}, removeEventListener: () => {} })

const LINKED: CloudLinkState = {
  linked: true,
  url: 'https://cloud.lautaro.dev',
  workspace: { id: 'ws_1', name: 'lautaro-cloud' },
  deviceId: 'dev_mac',
  encryption: true,
  online: true,
  offlineSince: null,
  lastSyncAt: '2026-10-21T09:00:00Z',
  error: null,
  cloudCompanyIds: ['co_vibiz', 'co_cortie'],
  cloudScheduleIds: ['s_1'],
  openAsks: 1,
  login: null
}
const company = (id: string, name: string, color: string) => ({ id, name, slug: id, color, sortOrder: 0, system: null, archivedAt: null, repoIds: [], createdAt: '', updatedAt: '', mission: '', brandVoice: '', audience: '', products: '', goals: '', context: '', constraints: '' })
const SUMMARY: WorkspaceSummary = {
  workspace: { id: 'ws_1', name: 'lautaro-cloud', createdAt: '', paused: false, quotas: DEFAULT_QUOTAS, publicUrl: 'https://cloud.lautaro.dev', mode: 'self-host' },
  companies: [
    { id: 'co_vibiz', name: 'Vibiz', slug: 'vibiz', color: null, createdAt: '', paused: false, passport: { hostUrl: 'h', passportId: 'p', mcpUrl: 'h/mcp', revision: 48, pendingProposals: 3 }, counts: { workflows: 3, schedules: 2, repos: 1, connections: 1, openAsks: 1, running: 0 }, readiness: { ready: true, fixes: [] } },
    { id: 'co_cortie', name: 'Cortie Moodboard', slug: 'cortie', color: null, createdAt: '', paused: false, passport: { hostUrl: 'h', passportId: 'p2', mcpUrl: 'h/mcp2', revision: 12, pendingProposals: 0 }, counts: { workflows: 1, schedules: 1, repos: 0, connections: 0, openAsks: 0, running: 0 }, readiness: { ready: false, fixes: [{ kind: 'account', ref: 'codex', message: 'Moodboard digest uses Codex. Sign in with ChatGPT.' }] } }
  ],
  providers: [
    { adapter: 'claude', credential: { id: 'c1', kind: 'claude_oauth_token', label: '', createdAt: '', lastUsedAt: null, expiresAt: '2027-10-21T00:00:00Z' }, status: 'ok', detail: null, cliVersion: '2.1' },
    { adapter: 'codex', credential: { id: 'c2', kind: 'openai_api_key', label: '', createdAt: '', lastUsedAt: null, expiresAt: null }, status: 'ok', detail: null, cliVersion: '0.1' },
    { adapter: 'gemini', credential: null, status: 'missing', detail: null, cliVersion: null }
  ],
  runtime: { status: 'ok', version: '1.0.0', sandbox: 'process', detail: null },
  passportHost: { status: 'ok', url: 'https://passport.lautaro.dev' },
  usage24h: { runs: 14, runMinutes: 96 }
}
const ASK = { id: 'cask_1', companyId: 'co_vibiz', runId: 'crun_1', agentName: 'Marcus · Copywriter', question: 'Ship the launch post today or Thursday? <script>alert(1)</script>', options: ['Today', 'Thursday'], createdAt: '2026-10-21T06:12:00Z', status: 'open' as const, answer: null }

async function setup(p: { state?: CloudLinkState | null; summary?: WorkspaceSummary | null; asks?: (typeof ASK)[]; proposals?: Record<string, { id: string; kind: 'delta'; app: string; created: string; summary: string }[]> } = {}): Promise<void> {
  const { setState } = await import('../../state/store')
  setState({ settings: { experimental: { companies: true } } as never, companies: [company('co_vibiz', 'Vibiz', '#4c9cff'), company('co_cortie', 'Cortie Moodboard', '#3ecf8e'), company('co_quest', 'Vibiz Quest', '#6e8cff')] as never, companiesLoaded: true, view: { name: 'cloud' } })
  const { resetCloud } = await import('../../state/cloud')
  resetCloud({ state: p.state === undefined ? LINKED : p.state, summary: p.summary === undefined ? SUMMARY : p.summary, asks: p.asks ?? [ASK], proposals: p.proposals ?? { co_vibiz: [{ id: 'pr1', kind: 'delta', app: 'cloud', created: '', summary: '"Pricing page converts best with annual first"' }] }, runs: [] })
}
const html = async (): Promise<string> => {
  const { CloudView } = await import('../../views/CloudView')
  return renderToStaticMarkup(createElement(CloudView))
}

describe('Cloud pane', () => {
  beforeEach(() => vi.resetModules())

  it('not connected: the arch, one connect-link field, Connect, one hosted button and one downloadable compose file', async () => {
    await setup({ state: { ...LINKED, linked: false, url: null, workspace: null, cloudCompanyIds: [] } })
    const out = await html()
    expect(out).toContain('Keep your agents working while your Mac sleeps')
    expect(out).toContain('Paste your connect link')
    expect(out).toContain('>Connect<')
    // the connect link is the one string: URL and code only after a paste fails
    expect(out).not.toContain('Enter URL and code')
    expect(out).toContain('>Deploy on Render<')
    expect(out).toContain('always-on cloud with its own https address')
    // one file, no clone of the hive repo
    expect(out).toContain('curl -fsSL https://raw.githubusercontent.com/Vibiz-ai/principia/main/cloud/compose.yml -o compose.yml\ndocker compose up -d')
    expect(out).not.toContain('-f cloud/compose.yml')
    expect(out).toContain('Managed Principia Cloud is coming. Self-hosting is free forever.')
    expect(out).not.toMatch(/principia-cloud pair|docker exec/)
    expect(out).toContain('cl-arch rm-la')
  })

  it('connected: header, Needs you, Companies with Ready and one fix, Accounts with billing badges, in mockup order', async () => {
    await setup()
    const out = await html()
    expect(out).toContain('lautaro-cloud')
    expect(out).toContain('Online')
    // the address and the usage are not header text: the URL is in Workspace ▾, usage on hover and in that menu
    expect(out).not.toContain('>https://cloud.lautaro.dev<')
    expect(out).not.toContain('cl-url')
    expect(out).not.toMatch(/>24 h · 14 runs/)
    expect(out).toContain('Last 24 h · 14 runs · 96 min')
    expect(out).toContain('Workspace ▾')
    expect(out).toContain('Pause cloud')
    // runtime detail only on hover
    expect(out).toMatch(/title="Runtime 1\.0\.0 · process sandbox/)
    expect(out).not.toContain('>Runtime 1.0.0')
    const order = ['Needs you', 'Companies', 'Cloud runs', 'Accounts'].map((t) => out.indexOf(`>${t}<`))
    expect(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1]))).toBe(true)
    expect(out).toContain('<b>Marcus</b> · Copywriter')
    expect(out).toContain('Answer in thread')
    expect(out).toContain('3 new facts')
    expect(out).toContain('Accept all')
    expect(out).toContain('Ready')
    expect(out).toContain('Run once now')
    expect(out).toContain('1 fix')
    expect(out).toContain('Sign in with ChatGPT')
    expect(out).toContain('Run in the cloud…')
    // passport in words; the revision only on hover
    expect(out).toContain('Passport · 3 new facts')
    expect(out).toContain('Passport · in sync')
    expect(out).toContain('title="Passport revision 48"')
    expect(out).not.toMatch(/Passport r\d/)
    // no lecturing subtitles on the cards
    expect(out).not.toContain('Each account is yours alone')
    expect(out).not.toContain('Each schedule fires in exactly one place')
    expect(out).toContain('>Subscription<')
    expect(out).toContain('>API billing<')
    expect(out).toContain('Connected · expires Oct 2027')
    // two account rows: Gemini (no key) is under the card's ⋯ menu
    expect(out).not.toContain('>Gemini<')
    expect(out).not.toContain('Add key')
    expect(out).toContain('aria-label="More accounts"')
    // no Devices card, no "Use the passport anywhere" card
    expect(out).not.toMatch(/>Devices<|Use the passport anywhere|Use passport anywhere/)
  })

  it('agent text is text, never markup', async () => {
    await setup()
    const out = await html()
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('no setup strip: the Accounts card holds the only Connect and Sign in buttons, and shows a sign-in in progress', async () => {
    await setup({ summary: { ...SUMMARY, providers: SUMMARY.providers.map((p) => (p.adapter === 'codex' ? { ...p, credential: null, status: 'missing' as const } : p)) }, state: { ...LINKED, login: { adapter: 'codex', phase: 'waiting', message: 'Your browser is open on ChatGPT. Approve there and come back.', reason: null, installHint: null, browserUrl: 'https://auth.openai.com/x' } } })
    const out = await html()
    expect(out).not.toContain('cl-strip')
    expect(out).toContain('Your browser is open on ChatGPT. Approve there and come back.')
    expect(out).toContain('This is a separate sign-in for your cloud. Codex on this Mac stays signed in.')
    expect(out).toContain('Use an API key instead')
    await setup({ summary: { ...SUMMARY, providers: SUMMARY.providers.map((p) => (p.adapter === 'claude' ? { ...p, credential: null, status: 'missing' as const } : p)) } })
    const two = await html()
    expect(two.match(/>Connect Claude</g)).toHaveLength(1)
  })

  it('an account a real run found expired shows Expired with Connect Claude, and the company its fix', async () => {
    const summary: WorkspaceSummary = {
      ...SUMMARY,
      providers: SUMMARY.providers.map((p) => (p.adapter === 'claude' ? { ...p, status: 'expired' as const, detail: 'Claude token expired. Connect Claude again.' } : p)),
      companies: [{ ...SUMMARY.companies[0]!, readiness: { ready: false, fixes: [{ kind: 'account', ref: 'claude', message: 'Your Claude sign-in expired. Connect Claude.' }] } }, { ...SUMMARY.companies[1]!, readiness: { ready: false, fixes: [{ kind: 'account', ref: 'codex', message: 'Codex hit its usage limit. It resets at 14:00 UTC. Moodboard digest waits until then.', action: 'wait' }] } }]
    }
    await setup({ summary })
    const out = await html()
    expect(out).toContain('>Expired<')
    expect(out).toContain('Claude token expired. Connect Claude again.')
    expect(out).not.toMatch(/>Ready</)
    // a usage limit has nothing to click: no button next to it
    expect(out).toContain('1 fix')
    expect(out).not.toMatch(/Moodboard[\s\S]*?<button[^>]*>Sign in with ChatGPT</)
  })

  it('offline since a time, and an empty Needs you', async () => {
    await setup({ state: { ...LINKED, online: false, offlineSince: new Date(2026, 9, 21, 3, 12).toISOString() }, asks: [], proposals: {} })
    const out = await html()
    expect(out).toContain('Offline since 03:12')
    expect(out).toContain('Nothing needs you. Agents are working.')
  })
})

describe('the move checklist and the readiness sheet', () => {
  beforeEach(() => vi.resetModules())
  const PLAN = {
    companyId: 'co_quest', companyName: 'Vibiz Quest', inCloud: false,
    workflows: [{ id: 'wf_content', name: 'Quest content', ok: true, reason: null, adapters: ['claude'] }, { id: 'wf_crawl', name: 'Crawl', ok: true, reason: null, adapters: ['shell'] }],
    schedules: [], repos: [],
    needs: { keys: [{ name: 'FAL_KEY', usedBy: ['wf_content'] }, { name: 'ACME_PARTNER_TOKEN', usedBy: ['wf_content', 'wf_crawl'] }], connections: [{ id: 'linear', name: 'Linear', hasCredentials: true, usedBy: ['wf_crawl'] }] },
    oauth: [{ id: 'notion', name: 'Notion', usedBy: ['wf_content'] }],
    passport: { ready: true, reason: null as string | null }
  }
  const render = async (plan: typeof PLAN): Promise<string> => {
    await setup()
    const { MoveChecklist } = await import('./Companies')
    const { initChecklist } = await import('../../lib/cloud')
    return renderToStaticMarkup(createElement(MoveChecklist, { plan: plan as never, list: initChecklist(plan as never), dispatch: () => {}, companyId: plan.companyId, onTurnOnPassport: () => {} }))
  }

  it('Passport is a plain line, keys have human names and say who uses them, nothing locked looks like a control', async () => {
    const out = await render(PLAN)
    expect(out).toContain('<b>Passport:</b> created on your cloud and kept in sync. Always on.')
    expect(out).not.toMatch(/<input[^>]*disabled[^>]*>\s*<i[^>]*><\/i>\s*<div><b>Passport/)
    expect(out).toContain('<b>fal.ai key (FAL_KEY)</b>')
    expect(out).toContain('Used by Quest content')
    expect(out).toContain('<b>ACME_PARTNER_TOKEN</b>')
    expect(out).toContain('Used by Quest content and Crawl')
    expect(out).toContain('Connection, used by Crawl')
    expect(out).not.toMatch(/<span>Key<\/span>/)
    expect(out).toContain('fal.ai key, ACME_PARTNER_TOKEN and Linear are copied encrypted')
    // OAuth: a line with what happens, not a checkbox that cannot change
    expect(out).toContain('<b>Notion:</b> signs in on its own in the cloud. Authorize it right after.')
    expect(out.match(/type="checkbox"/g)).toHaveLength(5)
  })

  it('a fresh profile with the Passport vault off shows the fix and one button before Run in the cloud', async () => {
    const out = await render({ ...PLAN, passport: { ready: false, reason: "Your cloud agents read this company's Passport, and the Passport vault is off on this Mac. Turn it on first." } })
    expect(out).toContain('the Passport vault is off on this Mac. Turn it on first.')
    expect(out).toContain('>Turn on Passport<')
    expect(out).not.toContain('<b>Passport:</b>')
  })

  it('readiness: no repeated heading, Ready in words, a usage limit without a button, and Run once now lives in the footer', async () => {
    await setup()
    const { ReadinessCard } = await import('./Companies')
    const ready = renderToStaticMarkup(createElement(ReadinessCard, { company: SUMMARY.companies[0]! as never, onFix: () => {}, runId: null }))
    expect(ready).not.toMatch(/is in the cloud/)
    expect(ready).toContain('Ready. It runs without this Mac.')
    expect(ready).toContain('Passport · 3 new facts')
    expect(ready).not.toContain('Run once now')
    const limited = renderToStaticMarkup(createElement(ReadinessCard, { company: { ...SUMMARY.companies[1]!, readiness: { ready: false, fixes: [{ kind: 'account', ref: 'codex', message: 'Codex hit its usage limit.', action: 'wait' }, { kind: 'key', ref: 'FAL_KEY', message: 'Quest content uses the fal.ai key (FAL_KEY), which is not in the cloud yet. Copy it from your Mac.' }] } } as never, onFix: () => {}, runId: null }))
    expect(limited).toContain('Codex hit its usage limit.')
    expect(limited.match(/<button/g)).toHaveLength(1)
    expect(limited).toContain('>Copy FAL_KEY<')
  })

  it('the one-account rule is said once, in the confirm before a browser sign-in', async () => {
    await setup()
    const { LOGIN_CONFIRM } = await import('./Accounts')
    expect(LOGIN_CONFIRM.claude.detail).toContain('Use your own account: never share a subscription.')
    expect(LOGIN_CONFIRM.codex.detail).toContain('Use your own account: never share a subscription.')
    expect(LOGIN_CONFIRM.codex.detail).toContain('Codex on this Mac stays signed in')
  })

  it('a finished run shows its result inline, and never "No log yet." once it ended', async () => {
    const { emptyLogText } = await import('./Runs')
    expect(emptyLogText('running')).toBe('No log yet.')
    expect(emptyLogText('passed')).toBe('This run wrote no output.')
  })
})

describe("Home's Needs you (one inbox)", () => {
  beforeEach(() => vi.resetModules())
  it('renders nothing when this Mac is not linked', async () => {
    await setup({ state: { ...LINKED, linked: false } })
    const { CloudNeedsYou } = await import('./NeedsYou')
    expect(renderToStaticMarkup(createElement(CloudNeedsYou, {}))).toBe('')
  })
  it('linked: cloud asks and proposals marked with the cloud line, answerable inline; filtered by company', async () => {
    await setup()
    const { CloudNeedsYou } = await import('./NeedsYou')
    const out = renderToStaticMarkup(createElement(CloudNeedsYou, {}))
    expect(out).toContain('From your cloud')
    expect(out).toContain('cl-mark')
    expect(out).toContain('>Thursday<')
    expect(out).toContain('Vibiz Passport')
    expect(renderToStaticMarkup(createElement(CloudNeedsYou, { companyId: 'co_cortie' }))).toBe('')
  })
})

describe('cloud.css', () => {
  it('uses tokens only: no warm hex, no gradients, amber only on tiles and count pills', () => {
    const css = fs.readFileSync(path.join(__dirname, '../../styles/cloud.css'), 'utf8')
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(css).not.toMatch(/gradient\(/)
    expect(css).not.toMatch(/\b(brown|bronze|gold|beige|tan|orange)\b/i)
    const amber = css.split('\n').filter((l) => l.includes('--status-needs'))
    expect(amber.every((l) => /\.cl-tes--needs|\.cl-count/.test(l))).toBe(true)
    expect(amber.some((l) => /(border|outline|box-shadow)(-[a-z]+)?:[^;]*--status-needs/.test(l))).toBe(false)
  })
})
