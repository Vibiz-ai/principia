/**
 * "Start a company from this chat" (shared/chatCompany.ts): the tool's schema and listing, argument checks, the
 * confirmation flow (pending → accepted / declined / expired / canceled), and a full round trip through the `hive`
 * server's mailbox and the broker.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CHAT_COMPANY_CODEX_HINT,
  CHAT_COMPANY_HINT,
  CHAT_COMPANY_TOOL,
  CHAT_COMPANY_TOOL_DEF,
  normalizeProposalArgs,
  parseProposalRepo,
  parseWebsite,
  proposalBrief,
  proposalResult,
  type CompanyProposal
} from '../../shared/chatCompany'
import { AuthorBroker, type BrokerDeps } from '../author/broker'
import { buildAuthorHandlers, callTimeoutMs, parseToolsets } from '../author/server/tools'
import { createLiveBridge } from '../live/bridge'
import { ChatProposals } from './chatProposals'

const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
const flush = () => new Promise((r) => setTimeout(r, 0))
const BRIEF = 'A sourdough bakery delivering to offices in Lisbon. First 20 office customers, a simple site, weekly Instagram posts.'

function service(over: Partial<ConstructorParameters<typeof ChatProposals>[0]> = {}) {
  const emitted: CompanyProposal[] = []
  let n = 0
  const svc = new ChatProposals({ emit: (p) => emitted.push(p), sessionTitle: (id) => (id === 's_0000000001' ? 'Chat about bakeries' : null), home: '/Users/me', newId: () => `cpr_${++n}`, now: () => Date.parse('2026-10-24T10:00:00Z'), ...over })
  return { svc, emitted }
}

describe('the tool', () => {
  it('schema: brief required, name / repo / website optional, nothing else', () => {
    expect(CHAT_COMPANY_TOOL_DEF.name).toBe('principia_propose_company')
    expect(CHAT_COMPANY_TOOL_DEF.inputSchema.required).toEqual(['brief'])
    expect(Object.keys(CHAT_COMPANY_TOOL_DEF.inputSchema.properties).sort()).toEqual(['brief', 'name', 'repo', 'website'])
    expect(CHAT_COMPANY_TOOL_DEF.inputSchema.additionalProperties).toBe(false)
    expect(CHAT_COMPANY_TOOL_DEF.description).toMatch(/Only after you asked/)
    expect(CHAT_COMPANY_TOOL_DEF.description).toMatch(/Creates nothing by itself/)
  })
  it('is listed with the newco toolset only, with its instructions; waits for the founder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-newco-'))
    tmp.push(dir)
    const names = (sets: string) => (buildAuthorHandlers({ HIVE_LIVE_DIR: dir, HIVE_TOOLSETS: sets }).listTools() as { name: string }[]).map((t) => t.name)
    expect(names('author,newco')).toContain(CHAT_COMPANY_TOOL)
    expect(names('author,task')).not.toContain(CHAT_COMPANY_TOOL)
    expect(parseToolsets('author,newco').has('newco')).toBe(true)
    const h = buildAuthorHandlers({ HIVE_LIVE_DIR: dir, HIVE_TOOLSETS: 'author,newco' })
    expect(typeof h.instructions === 'function' ? h.instructions() : h.instructions).toMatch(/first ASK "Want me to set this up as a new Principia company\?"/)
    expect(callTimeoutMs(CHAT_COMPANY_TOOL, {})).toBeGreaterThan(600_000)
  })
  it('the session hints: claude asks first and calls the tool after a yes; codex points at the button', () => {
    expect(CHAT_COMPANY_HINT).toMatch(/ask once/)
    expect(CHAT_COMPANY_HINT).toMatch(/Only after a yes, call mcp__hive__principia_propose_company/)
    expect(CHAT_COMPANY_CODEX_HINT).toMatch(/New company from chat/)
    expect(CHAT_COMPANY_CODEX_HINT).not.toMatch(/mcp__hive__/)
  })
})

describe('arguments', () => {
  it('needs a real brief', () => {
    expect(normalizeProposalArgs({}).ok).toBe(false)
    expect(normalizeProposalArgs({ brief: 'short' }).ok).toBe(false)
    const r = normalizeProposalArgs({ name: '  Sunday   Bakery ', brief: `  ${BRIEF}  `, extra: 1 })
    expect(r).toEqual({ ok: true, value: { name: 'Sunday Bakery', brief: BRIEF, repo: null, website: null } })
  })
  it('repo: absolute path, ~/ path, clone URL, github.com/x/y; anything else dropped', () => {
    expect(parseProposalRepo('/Users/me/code/bakery/')).toEqual({ kind: 'local', path: '/Users/me/code/bakery' })
    expect(parseProposalRepo('~/code/bakery', '/Users/me')).toEqual({ kind: 'local', path: '/Users/me/code/bakery' })
    expect(parseProposalRepo('https://github.com/acme/bakery.git')).toEqual({ kind: 'url', url: 'https://github.com/acme/bakery.git' })
    expect(parseProposalRepo('git@github.com:acme/bakery.git')).toEqual({ kind: 'url', url: 'git@github.com:acme/bakery.git' })
    expect(parseProposalRepo('github.com/acme/bakery')).toEqual({ kind: 'url', url: 'https://github.com/acme/bakery' })
    for (const bad of ['bakery', 'file:///etc', '-oProxy', '/a/../etc', '', 42]) expect(parseProposalRepo(bad)).toBeNull()
  })
  it('website: http(s) or a bare host', () => {
    expect(parseWebsite('sundaybakery.pt')).toBe('sundaybakery.pt')
    expect(parseWebsite('https://sunday.bakery/menu')).toBe('https://sunday.bakery/menu')
    expect(parseWebsite('javascript:alert(1)')).toBeNull()
    expect(parseWebsite('not a site')).toBeNull()
  })
})

describe('prompt to prefill', () => {
  it('puts the name on its own first line, then the brief, then the website', () => {
    expect(proposalBrief({ name: 'Sunday Bakery', brief: BRIEF, website: 'sundaybakery.pt' })).toBe(`Sunday Bakery\n${BRIEF}\nWebsite: sundaybakery.pt`)
  })
  it('does not repeat a name or website the brief already has', () => {
    const b = `Sunday Bakery: ${BRIEF} See sundaybakery.pt`
    expect(proposalBrief({ name: 'Sunday Bakery', brief: b, website: 'sundaybakery.pt' })).toBe(b)
    expect(proposalBrief({ name: '', brief: BRIEF, website: null })).toBe(BRIEF)
  })
  it('results tell the agent what happened and what to do next', () => {
    expect(proposalResult({ status: 'accepted', name: 'Sunday Bakery' }).note).toMatch(/^Opened onboarding for Sunday Bakery/)
    expect(proposalResult({ status: 'declined', name: '' }).note).toMatch(/declined/)
    expect(proposalResult({ status: 'expired', name: 'X' }).note).toMatch(/Do not call again/)
  })
})

describe('confirmation flow', () => {
  it('pending card → accepted with the founder edits; the call resolves "Opened onboarding"', async () => {
    const { svc, emitted } = service()
    const call = svc.propose('s_0000000001', { name: 'Sunday Bakery', brief: BRIEF, repo: '~/code/bakery', website: 'sundaybakery.pt' })
    await flush()
    expect(svc.list()).toHaveLength(1)
    const p = svc.list()[0]!
    expect(p).toMatchObject({ id: 'cpr_1', sessionId: 's_0000000001', sessionTitle: 'Chat about bakeries', status: 'pending', repo: { kind: 'local', path: '/Users/me/code/bakery' }, website: 'sundaybakery.pt' })
    expect(emitted.at(-1)?.status).toBe('pending')
    const out = svc.decide({ id: p.id, accept: true, name: 'Domingo Bakery', brief: 'Edited brief for the bakery.' })
    expect(out).toMatchObject({ status: 'accepted', name: 'Domingo Bakery', brief: 'Edited brief for the bakery.' })
    expect(await call).toMatchObject({ status: 'accepted', name: 'Domingo Bakery' })
    expect(svc.list()).toEqual([])
    expect(emitted.at(-1)?.status).toBe('accepted')
    // a second decision on the same card is refused
    expect(() => svc.decide({ id: p.id, accept: false })).toThrow(/already accepted/)
  })
  it('declined → the call says so; nothing else changes', async () => {
    const { svc } = service()
    const call = svc.propose('s_0000000001', { brief: BRIEF })
    await flush()
    svc.decide({ id: svc.list()[0]!.id, accept: false })
    expect(await call).toMatchObject({ status: 'declined' })
  })
  it('one open card per chat: a second call is answered busy without a new card', async () => {
    const { svc } = service()
    void svc.propose('s_0000000001', { brief: BRIEF, name: 'A' })
    await flush()
    expect(await svc.propose('s_0000000001', { brief: BRIEF, name: 'B' })).toMatchObject({ status: 'busy', name: 'A' })
    void svc.propose('s_0000000002', { brief: BRIEF, name: 'C' })
    await flush()
    expect(svc.list().map((p) => p.name)).toEqual(['A', 'C'])
  })
  it('no decision in time, or the agent stops waiting: the card closes as expired', async () => {
    const { svc } = service({ waitMs: 20 })
    expect(await svc.propose('s_0000000001', { brief: BRIEF })).toMatchObject({ status: 'expired' })
    expect(svc.list()).toEqual([])
    const s2 = service()
    const ac = new AbortController()
    const call = s2.svc.propose('s_0000000001', { brief: BRIEF }, ac.signal)
    ac.abort()
    expect(await call).toMatchObject({ status: 'expired' })
    expect(s2.emitted.at(-1)?.status).toBe('expired')
    expect(s2.svc.list()).toEqual([])
  })
  it('bad arguments are an error the agent sees, and open no card', async () => {
    const { svc, emitted } = service()
    await expect(svc.propose('s_0000000001', { brief: 'x' })).rejects.toThrow(/brief is required/)
    expect(emitted).toEqual([])
  })
  it('the "New company from chat" button opens a card nobody waits on; accepting needs a name or a brief', () => {
    const { svc } = service()
    const p = svc.openLocal({ sessionId: 's_0000000001' })
    expect(p).toMatchObject({ status: 'pending', sessionTitle: 'Chat about bakeries', name: '', brief: '' })
    expect(() => svc.decide({ id: p.id, accept: true })).toThrow(/Add a name/)
    expect(svc.decide({ id: p.id, accept: true, name: 'Sunday Bakery' }).status).toBe('accepted')
  })
})

describe('broker + mailbox round trip', () => {
  const brokerWith = (proposals: BrokerDeps['proposals']) => new AuthorBroker({ proposals } as unknown as BrokerDeps)

  it('a chat session reaches the card; a step owner or a broker without proposals does not', async () => {
    const { svc } = service()
    const b = brokerWith({ propose: (sid, args, signal) => svc.propose(sid, args, signal) })
    const answers: unknown[] = []
    b.handleCall({ stepId: 'st_0000000001', runId: 'r_0000000001' }, { hive: 'author_call', call_id: 'hac_0000000001', tool: CHAT_COMPANY_TOOL, args: { brief: BRIEF } }, (_c, p) => answers.push(p))
    brokerWith(undefined).handleCall({ sessionId: 's_0000000001' }, { hive: 'author_call', call_id: 'hac_0000000002', tool: CHAT_COMPANY_TOOL, args: { brief: BRIEF } }, (_c, p) => answers.push(p))
    await flush()
    expect(answers).toEqual([
      { ok: false, error: `Unknown tool: ${CHAT_COMPANY_TOOL}` },
      { ok: false, error: `Unknown tool: ${CHAT_COMPANY_TOOL}` }
    ])
    expect(svc.list()).toEqual([])
  })

  it('tools/call → events.jsonl → broker → card → decide → answers/<id>.json → the tool result', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-newco-'))
    tmp.push(userData)
    const { svc } = service()
    const broker = brokerWith({ propose: (sid, args, signal) => svc.propose(sid, args, signal) })
    const bridge = createLiveBridge({
      userData,
      execPath: process.execPath,
      hookScript: '/nonexistent/hive-hook.js',
      pollMs: 20,
      onAuthor: (owner, line, writeAnswer) => {
        if (line.hive === 'author_cancelled') broker.handleCancel(owner, line)
        else broker.handleCall(owner, line, writeAnswer)
      }
    })
    const ch = bridge.open({ sessionId: 's_0000000001' })
    const handlers = buildAuthorHandlers({ HIVE_LIVE_DIR: ch.dir, HIVE_TOOLSETS: 'author,newco' })
    const result = handlers.callTool(CHAT_COMPANY_TOOL, { name: 'Sunday Bakery', brief: BRIEF }, { requestId: 1, meta: null, signal: new AbortController().signal })
    for (let i = 0; i < 100 && !svc.list().length; i++) await new Promise((r) => setTimeout(r, 20))
    expect(svc.list()[0]).toMatchObject({ name: 'Sunday Bakery', sessionId: 's_0000000001' })
    svc.decide({ id: svc.list()[0]!.id, accept: true })
    const res = (await result) as { isError?: boolean; structuredContent?: Record<string, unknown> }
    expect(res.isError).toBeFalsy()
    expect(res.structuredContent).toMatchObject({ status: 'accepted', name: 'Sunday Bakery' })
    expect(String(res.structuredContent?.note)).toMatch(/^Opened onboarding for Sunday Bakery/)
    ch.close()
  })
})
