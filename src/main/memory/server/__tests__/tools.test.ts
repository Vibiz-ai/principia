// PASSPORT.md §7.1, §7.2, §7.4, §7.6 on the hivemem server: env mode detection, the grant/company binding, the spool
// client against a fake main and against the real bridge, the five vault tools ([[Title]] everywhere, autolink only on
// exact unambiguous matches, did_you_mean for near-miss ghosts, depth-2 reads), the 8000-char cap, the read-only error
// when main is down, and the engine-side write rules and tool lines.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CompanyPassport } from '../../../../shared/company'
import type { MemoryGrant } from '../../../../shared/engine'
import { MEM_RPC, MEM_UNREACHABLE, type MemRpcRequest } from '../../../../shared/memory'
import type { Repo } from '../../../../shared/types'
import { readPrivateJson, writePrivateJson } from '../../../gateway/files'
import { nativeOk } from '../../vault/__tests__/vaultTestKit'
import { MemoryService, type MemoryCompanies, type PassportRuntime } from '../../service'
import { buildHandlers, memoryServerMode, type BuiltHandlers } from '../build'
import { SpoolClient } from '../spool'
import { MAX_OUTPUT, type ToolResult } from '../tools'
import {
  LEGACY_MEMORY_WRITE_RULES,
  MEMORY_WRITE_RULES,
  PASSPORT_HARVEST_RULES,
  agentBrief,
  claudeMcpAttach,
  codexMcpAttach,
  memoryToolLine
} from '../../../engine/memory'

const d = nativeOk ? describe : describe.skip
const A = 'co_acme'
const B = 'co_globex'
const REPO_A: Repo = { id: 'repo_a000000001', name: 'acme-web', path: '/work/acme-web' } as Repo

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hive-hivemem-'))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------- the spool client against a fake main ----------

/** Answers every request in `dir` with `answer(req)` until stopped. */
function fakeMain(dir: string, answer: (req: MemRpcRequest) => unknown): { seen: MemRpcRequest[]; stop(): void } {
  const seen: MemRpcRequest[] = []
  let on = true
  const loop = async () => {
    while (on) {
      for (const f of fs.readdirSync(dir)) {
        const m = /^([a-z0-9]+)\.request$/.exec(f)
        if (!m) continue
        const file = path.join(dir, f)
        const req = readPrivateJson(file, MEM_RPC.maxBytes) as MemRpcRequest
        seen.push(req)
        writePrivateJson(path.join(dir, `${m[1]}${MEM_RPC.answerSuffix}`), answer(req))
        fs.unlinkSync(file)
      }
      await sleep(3)
    }
  }
  void loop()
  return { seen, stop: () => (on = false) }
}

describe('hivemem spool client (§7.1)', () => {
  let dir: string
  beforeEach(() => {
    dir = tmp()
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('round trip: the request names the grant, the company and the call id; the answer is read and dropped', async () => {
    const main = fakeMain(dir, (req) => ({ ok: true, result: { counted: (req.args as { notes: string[] }).notes.length } }))
    const c = new SpoolClient(dir, { grantId: 'mgr_0000000001', companyId: A })
    const ans = await c.call('hit', { notes: ['n-1', 'n-2'] }, { callId: 'tool-1' })
    main.stop()
    expect(ans).toEqual({ ok: true, result: { counted: 2 } })
    expect(main.seen[0]).toMatchObject({ v: 1, grantId: 'mgr_0000000001', companyId: A, method: 'hit', callId: 'tool-1' })
    expect(fs.readdirSync(dir)).toEqual([])
    // request files are private
    const probe = new SpoolClient(dir, { grantId: 'g', companyId: A })
    expect(probe.notify('hit', { notes: [] })).toBe(true)
    const [f] = fs.readdirSync(dir)
    expect(fs.statSync(path.join(dir, f)).mode & 0o777).toBe(0o600)
  })

  it('main down: no answer within the timeout resolves null and withdraws the request', async () => {
    const c = new SpoolClient(dir, { grantId: 'g', companyId: A, timeoutMs: 80 })
    const t0 = Date.now()
    expect(await c.call('write', { note: 'X', facts: [{ text: 'abc def' }] })).toBeNull()
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(fs.readdirSync(dir)).toEqual([])
    // a spool folder that does not exist (the grant ended) fails at once
    expect(await new SpoolClient(path.join(dir, 'gone'), { grantId: 'g', companyId: A }).call('hit', { notes: [] })).toBeNull()
  })

  it('refusals from main come back as answers', async () => {
    const main = fakeMain(dir, () => ({ ok: false, code: 'company', error: 'Refused: another company' }))
    const ans = await new SpoolClient(dir, { grantId: 'g', companyId: B }).call('link', { links: [{ from: 'a', to: 'b' }] })
    main.stop()
    expect(ans).toEqual({ ok: false, code: 'company', error: 'Refused: another company' })
  })
})

// ---------- mode detection ----------

describe('hivemem env mode (§7.1)', () => {
  it('vault when HIVE_MEM_INDEX is set, legacy with HIVE_MEM_DB, off without a grant', () => {
    expect(memoryServerMode({ HIVE_MEM_GRANT: 'g', HIVE_MEM_INDEX: '/x/passport-index.db', HIVE_MEM_DB: '/x/memory.db' })).toBe('vault')
    expect(memoryServerMode({ HIVE_MEM_GRANT: 'g', HIVE_MEM_DB: '/x/memory.db' })).toBe('legacy')
    expect(memoryServerMode({ HIVE_MEM_GRANT: '', HIVE_MEM_INDEX: '/x/i.db' })).toBe('off')
  })
})

// ---------- the vault tools on a real main (MemoryService + spool bridge) ----------

function passport(id: string, name: string, extra: Partial<CompanyPassport> = {}): CompanyPassport {
  return {
    id,
    name,
    slug: name.toLowerCase(),
    color: '#888',
    sortOrder: 0,
    mission: '',
    brandVoice: '',
    audience: '',
    products: '',
    goals: '',
    context: '',
    constraints: '',
    repoIds: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    system: null,
    vaultPath: null,
    ...extra
  }
}

function fakeCompanies(dir: string): MemoryCompanies & { vaultPathFor(id: string): string } {
  const list = [passport(A, 'Acme', { mission: 'Make billing boring', repoIds: [REPO_A.id] }), passport(B, 'Globex'), passport('co_personal', 'Personal', { system: 'personal' })]
  const get = (id: string) => {
    const c = list.find((x) => x.id === id)
    if (!c) throw new Error('Company not found')
    return c
  }
  const fake = {
    store: { getSettings: () => ({ experimental: { vault: true } }) },
    listPassports: () => list,
    passport: get,
    resolveCompany: (q: { cwd?: string | null }) => ({ company: q.cwd?.startsWith(REPO_A.path) ? get(A) : get('co_personal'), repo: null }),
    companyForRepo: (repoId: string) => (repoId === REPO_A.id ? get(A) : get('co_personal')),
    vaultPathFor: (id: string) => path.join(dir, 'companies', get(id).slug, 'Passport'),
    setPassportRenderer: () => {},
    setMemoryCounter: () => {},
    update: (id: string) => get(id)
  }
  return fake as unknown as MemoryCompanies & { vaultPathFor(id: string): string }
}

const text = (r: ToolResult) => r.content[0].text
const json = <T = Record<string, unknown>>(r: ToolResult): T => JSON.parse(text(r)) as T
/** Every `note`/`to`/`from` value and every string in a links/did_you_mean list is `[[Title]]`. */
function allWikilinks(v: unknown, key = ''): string[] {
  const bad: string[] = []
  const walk = (x: unknown, k: string) => {
    if (typeof x === 'string') {
      if (['note', 'to', 'from', 'links', 'did_you_mean', 'autolinked', 'ghost_referenced_by', 'candidates'].includes(k) && !/^\[\[[^[\]]+\]\]$/.test(x)) bad.push(`${k}=${x}`)
      return
    }
    if (Array.isArray(x)) for (const y of x) walk(y, k)
    else if (x && typeof x === 'object') for (const [kk, y] of Object.entries(x)) walk(y, kk)
  }
  walk(v, key)
  return bad
}

d('hivemem vault tools (§7.2)', () => {
  let dir: string
  let svc: MemoryService
  let rt: PassportRuntime
  let built: BuiltHandlers[]

  beforeEach(() => {
    dir = tmp()
    built = []
    svc = new MemoryService({
      userData: dir,
      serverScript: '/app/out/main/mcp-memory.js',
      execPath: '/app/Hive',
      listRepos: () => [REPO_A],
      redact: (s) => s,
      secretValues: () => [],
      emit: () => {},
      log: { info: () => {}, warn: () => {} },
      watchVaults: false
    })
    svc.start({ poll: false })
    svc.setCompanies(fakeCompanies(dir))
    rt = svc.passport()
  })
  afterEach(() => {
    for (const b of built) b.close()
    svc.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const grant = (mode: 'read' | 'read-write' = 'read-write', companyId = A): MemoryGrant =>
    svc.grant({ mode, adapter: 'claude', transport: 'mcp', profile: null, cwd: '/work/acme-web/src', companyId, runId: 'run_0000000001', briefQuery: 'billing' })!
  const server = (g: MemoryGrant, env: Record<string, string> = {}) => {
    const b = buildHandlers({ ...g.server.env, ...env }, { spool: { timeoutMs: 3000 } })
    built.push(b)
    return b
  }
  const callTool = async (b: BuiltHandlers, name: string, args: unknown, id = Math.floor(Math.random() * 1e9)) =>
    b.handlers.callTool(name, args, { requestId: id, meta: { 'claudecode/toolUseId': `toolu_${id}` }, signal: new AbortController().signal })

  it('binds the grant to HIVE_COMPANY_ID: read-write lists all five, read lists two, a mismatch lists only ask_user', async () => {
    const g = grant()
    const b = server(g)
    expect(b.mode).toBe('vault')
    expect(b.handlers.listTools().map((t) => t.name)).toEqual(['memory_search', 'memory_get', 'memory_write', 'memory_link', 'memory_invalidate', 'memory_taste'])
    expect(server(grant('read')).handlers.listTools().map((t) => t.name)).toEqual(['memory_search', 'memory_get'])

    const live = tmp()
    const wrong = server(g, { HIVE_COMPANY_ID: B, HIVE_LIVE_DIR: live })
    expect(wrong.handlers.listTools().map((t) => t.name)).toEqual(['ask_user'])
    expect(wrong.handlers.instructions()).toMatch(/another company/)
    const refused = await callTool(wrong, 'memory_search', { query: 'Acme' })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/another company/)
    // no company in the env at all: same
    expect(server(g, { HIVE_COMPANY_ID: '' }).handlers.listTools()).toEqual([])
    fs.rmSync(live, { recursive: true, force: true })
  })

  it('search, write with autolink and ghosts, link, get at depth 2 and invalidate; every note is [[Title]]', async () => {
    const g = grant()
    const b = server(g)
    expect(b.handlers.instructions()).toMatch(/Known notes \(link with these exact titles\): .*\[\[Acme\]\]/)

    // notes to link to: two Bobs share an alias (ambiguous), acme-web is unique
    for (const [note, type, extra] of [
      ['acme-web', 'repo', { summary: 'The Acme web app' }],
      ['Bob Smith', 'person', { aliases: ['Bob'] }],
      ['Bob Jones', 'person', { aliases: ['Bob'] }]
    ] as const) {
      const r = await callTool(b, 'memory_write', { note, type, ...extra })
      expect(r.isError, text(r)).toBeFalsy()
    }

    const w = await callTool(b, 'memory_write', {
      note: 'Stripe',
      type: 'product',
      facts: [{ text: 'Stripe webhooks hit acme-web; Bob verified the raw body rule', kind: 'gotcha' }],
      relations: [{ type: 'reviewed_by', to: 'Bob Smyth' }]
    })
    expect(w.isError, text(w)).toBeFalsy()
    const wr = json(w) as Record<string, unknown> & { written: { ref: string; text: string }[]; unresolved: { to: string; status: string; did_you_mean: string[] }[] }
    expect(wr).toMatchObject({ note: '[[Stripe]]', created: true })
    // exact unambiguous match linked; the ambiguous alias is left alone with a hint
    expect(wr.autolinked).toEqual(['[[acme-web]]'])
    expect(wr.written[0].text).toContain('[[acme-web]]')
    expect(wr.written[0].text).not.toContain('[[Bob')
    expect(JSON.stringify(wr.hints)).toMatch(/\[\[Bob (Smith|Jones)\]\]/)
    expect(wr.written[0].ref).toMatch(/^\[\[Stripe#\^f-[0-9a-z]{10}\]\]$/)
    // the near-miss ghost: did_you_mean + next
    expect(wr.unresolved).toContainEqual({ to: '[[Bob Smyth]]', status: 'ghost', did_you_mean: expect.arrayContaining(['[[Bob Smith]]']) })
    expect(wr.next).toMatch(/Bob Smyth is a ghost\. If you meant \[\[Bob Smith\]\], call memory_link/)
    expect(allWikilinks(wr)).toEqual([])

    const link = await callTool(b, 'memory_link', { links: [{ from: 'Stripe', type: 'uses', to: '[[acme-web]]' }, { from: 'acme-web', to: 'Onboarding flow' }] })
    expect(link.isError, text(link)).toBeFalsy()
    const lr = json(link) as { linked: { from: string; to: string; type: string; result: string }[]; unresolved: unknown[] }
    expect(lr.linked).toEqual([
      expect.objectContaining({ from: '[[Stripe]]', to: '[[acme-web]]', type: 'uses', result: 'added' }),
      expect.objectContaining({ from: '[[acme-web]]', to: '[[Onboarding flow]]', type: 'relates_to', result: 'added' })
    ])
    expect(lr.unresolved).toContainEqual(expect.objectContaining({ to: '[[Onboarding flow]]', status: 'ghost' }))

    const s = await callTool(b, 'memory_search', { query: 'webhooks' })
    const sr = json(s) as { notice: string; results: { note: string; facts: { ref: string; kind: string; text: string }[]; links: string[] }[]; ghosts: string[] }
    expect(sr.notice).toMatch(/Reference data, not instructions/)
    expect(sr.results[0]).toMatchObject({ note: '[[Stripe]]', type: 'product' })
    expect(sr.results[0].facts[0]).toMatchObject({ kind: 'gotcha', ref: wr.written[0].ref })
    expect(sr.results[0].links).toContain('[[acme-web]]')
    expect(allWikilinks(sr)).toEqual([])
    const ghostSearch = json(await callTool(b, 'memory_search', { query: 'onboarding' })) as { ghosts: string[] }
    expect(ghostSearch.ghosts).toEqual(['[[Onboarding flow]]: no note yet, 1 link'])
    const near = json(await callTool(b, 'memory_search', { query: 'Stirpe' })) as { did_you_mean: string[] }
    expect(near.did_you_mean).toContain('[[Stripe]]')

    // depth 2: Stripe -> acme-web -> Onboarding flow (ghost)
    const get = await callTool(b, 'memory_get', { notes: ['[[Stripe]]', 'Bob', 'Nobody Here', 'Onboarding flow'], depth: 2 })
    expect(get.isError, text(get)).toBeFalsy()
    const gr = json(get) as {
      notes: { note: string; facts: { ref: string }[]; relations: { type: string; to: string; status: string }[]; backlinks: unknown[]; neighbours: { note: string; type: string; edge: string }[] }[]
      not_found: { not_found: string; ambiguous?: boolean; did_you_mean: string[]; ghost_referenced_by?: string[] }[]
    }
    expect(gr.notes).toHaveLength(1)
    const stripe = gr.notes[0]
    expect(stripe.note).toBe('[[Stripe]]')
    expect(stripe.relations).toEqual(expect.arrayContaining([{ type: 'uses', to: '[[acme-web]]', status: 'resolved', ref: expect.any(String) }, expect.objectContaining({ type: 'reviewed_by', to: '[[Bob Smyth]]', status: 'ghost' })]))
    expect(stripe.neighbours).toEqual(expect.arrayContaining([expect.objectContaining({ note: '[[acme-web]]', edge: expect.stringMatching(/→$/) }), expect.objectContaining({ note: '[[Onboarding flow]]', type: 'ghost', edge: '2 hops' })]))
    expect(gr.not_found).toEqual([
      { not_found: 'Bob', ambiguous: true, did_you_mean: expect.arrayContaining(['[[Bob Smith]]', '[[Bob Jones]]']) },
      expect.objectContaining({ not_found: 'Nobody Here' }),
      expect.objectContaining({ not_found: 'Onboarding flow', ghost_referenced_by: ['[[acme-web]]'] })
    ])
    expect(allWikilinks(gr)).toEqual([])
    // depth 0 has no neighbour cards; acme-web's backlinks name Stripe
    const web = json(await callTool(b, 'memory_get', { notes: ['acme-web'], depth: 0 })) as { notes: { backlinks: { label: string; from: { note: string }[] }[]; neighbours?: unknown }[] }
    expect(web.notes[0].neighbours).toBeUndefined()
    expect(web.notes[0].backlinks.flatMap((x) => x.from.map((f) => f.note))).toContain('[[Stripe]]')

    const inv = await callTool(b, 'memory_invalidate', { refs: [wr.written[0].ref], reason: 'the raw body rule moved to a proxy' })
    expect(inv.isError, text(inv)).toBeFalsy()
    expect(json(inv)).toMatchObject({ items: [{ ref: wr.written[0].ref, result: 'invalidated' }] })
    const file = fs.readFileSync(path.join(rt.index.root(A), 'Products', 'Stripe.md'), 'utf8')
    expect(file).toMatch(/## History[\s\S]*raw body rule/)
    const after = json(await callTool(b, 'memory_get', { notes: ['Stripe'], depth: 0, include_history: true })) as { notes: { facts: { status?: string }[] }[] }
    expect(after.notes[0].facts.some((f) => f.status === 'invalid')).toBe(true)
  })

  it('a replayed MCP call (same tool-use id) never writes twice; the spool request carries the call id and the company', async () => {
    const g = grant()
    const b = server(g)
    const args = { note: 'Pricing', type: 'decision', facts: [{ text: 'Pro costs 49 dollars a month', kind: 'decision' }] }
    const one = json(await callTool(b, 'memory_write', args, 7)) as { written: unknown[] }
    const two = json(await callTool(b, 'memory_write', args, 7)) as { written: unknown[]; duplicates: unknown[] }
    expect(one.written).toHaveLength(1)
    expect([...two.written, ...two.duplicates]).toHaveLength(1)
    const file = fs.readFileSync(path.join(rt.index.root(A), 'Decisions', 'Pricing.md'), 'utf8')
    expect(file.match(/Pro costs 49 dollars a month/g)).toHaveLength(1)

    // what the server sends: the grant's company and the tool-use id (else a per-process id), never tool arguments
    const spool = tmp()
    const main = fakeMain(spool, () => ({ ok: true, result: { linked: [], unresolved: [], writes_left: 30 } }))
    const f = server(g, { HIVE_MEM_SPOOL: spool })
    expect(json(await callTool(f, 'memory_link', { links: [{ from: 'A', to: 'B' }] }, 9))).toEqual({ linked: [], unresolved: [], writes_left: 30 })
    await f.handlers.callTool('memory_link', { links: [{ from: 'A', to: 'C' }] }, { requestId: 10, meta: null, signal: new AbortController().signal })
    main.stop()
    expect(main.seen[0]).toMatchObject({ grantId: g.grantId, companyId: A, method: 'link', callId: 'toolu_9', args: { links: [{ from: 'A', to: 'B' }] } })
    expect(main.seen[1].callId).toMatch(/^[0-9a-f]{12}-10$/)
    fs.rmSync(spool, { recursive: true, force: true })
  })

  it('caps every result at 8000 characters', async () => {
    const b = server(grant())
    const long = (i: number) => `Fact number ${i} about the billing pipeline ${'and its many moving parts '.repeat(30)}`.slice(0, 990)
    for (let k = 0; k < 3; k++) {
      const r = await callTool(b, 'memory_write', { note: 'Billing', type: 'process', facts: Array.from({ length: 10 }, (_, i) => ({ text: long(k * 10 + i) })) })
      expect(r.isError, text(r)).toBeFalsy()
      expect(text(r).length).toBeLessThanOrEqual(MAX_OUTPUT)
    }
    const get = await callTool(b, 'memory_get', { notes: ['Billing', 'Acme'], depth: 2 })
    expect(text(get).length).toBeLessThanOrEqual(MAX_OUTPUT)
    const gr = json(get) as { notes: { note: string; facts: unknown[] }[]; truncated?: boolean }
    expect(gr.truncated).toBe(true)
    expect(gr.notes[0].note).toBe('[[Billing]]')
    expect(gr.notes[0].facts.length).toBeGreaterThan(0)
    const s = await callTool(b, 'memory_search', { query: 'billing pipeline moving parts', limit: 20 })
    expect(text(s).length).toBeLessThanOrEqual(MAX_OUTPUT)
  })

  it('main down: writes return the read-only error, reads keep working', async () => {
    const g = grant()
    const unserved = tmp()
    const b = buildHandlers({ ...g.server.env, HIVE_MEM_SPOOL: unserved }, { spool: { timeoutMs: 100 } })
    built.push(b)
    const w = await callTool(b, 'memory_write', { note: 'Stripe', facts: [{ text: 'Webhooks retry for three days' }] })
    expect(w.isError).toBe(true)
    expect(text(w)).toBe(MEM_UNREACHABLE)
    expect(text(await callTool(b, 'memory_link', { links: [{ from: 'Acme', to: 'Stripe' }] }))).toBe(MEM_UNREACHABLE)
    expect(fs.readdirSync(unserved)).toEqual([])
    const s = await callTool(b, 'memory_search', { query: 'Acme' })
    expect(s.isError).toBeFalsy()
    expect((json(s) as { results: { note: string }[] }).results[0].note).toBe('[[Acme]]')
    fs.rmSync(unserved, { recursive: true, force: true })
  })

  it("never reaches another company's notes, ghosts or did_you_mean, and tool arguments cannot name a company", async () => {
    const gb = grant('read-write', B)
    const bb = server(gb)
    const wb = await callTool(bb, 'memory_write', {
      note: 'Globex Launch Plan',
      type: 'decision',
      facts: [{ text: 'Globex launches the zeppelin line in March', kind: 'decision' }],
      relations: [{ type: 'relates_to', to: 'Zeppelin Roadmap' }]
    })
    expect(wb.isError, text(wb)).toBeFalsy()
    // B sees its own note
    expect((json(await callTool(bb, 'memory_search', { query: 'zeppelin' })) as { results: unknown[] }).results).toHaveLength(1)

    const ba = server(grant())
    const s = json(await callTool(ba, 'memory_search', { query: 'zeppelin' })) as { results: unknown[]; ghosts: string[]; did_you_mean: string[] }
    expect(s.results).toEqual([])
    expect(s.ghosts).toEqual([])
    expect(JSON.stringify(s)).not.toMatch(/Globex|Zeppelin/i)
    const near = json(await callTool(ba, 'memory_search', { query: 'Globex Launch Plam' })) as { did_you_mean: string[] }
    expect(near.did_you_mean).toEqual([])
    const g = json(await callTool(ba, 'memory_get', { notes: ['Globex Launch Plan', 'Zeppelin Roadmap'], depth: 2 })) as { notes: unknown[]; not_found: unknown[] }
    expect(g.notes).toEqual([])
    expect(JSON.stringify(g.not_found)).not.toMatch(/\[\[Globex/)
    expect(ba.handlers.instructions()).not.toMatch(/Globex/)
    // the note id from B is not reachable from A either
    const id = (rt.db.prepare(`SELECT id FROM mem_note WHERE company_id = ? AND title = 'Globex Launch Plan'`).get(B) as { id: string }).id
    expect((json(await callTool(ba, 'memory_get', { notes: [id] })) as { notes: unknown[] }).notes).toEqual([])
    // strict schemas: no company (or anything else) can be smuggled in through arguments
    for (const [tool, args] of [
      ['memory_search', { query: 'zeppelin', company_id: B }],
      ['memory_get', { notes: ['Globex Launch Plan'], companyId: B }],
      ['memory_write', { note: 'X', facts: [{ text: 'abc def' }], company: B }]
    ] as const) {
      const r = await callTool(ba, tool, args)
      expect(r.isError, `${tool}: ${text(r)}`).toBe(true)
      expect(text(r)).toMatch(/Invalid arguments/)
    }
  })

  it('brief-hit notifications leave no answer files behind in the spool', async () => {
    const g = grant()
    const b = server(g)
    const spool = g.server.env.HIVE_MEM_SPOOL
    await callTool(b, 'memory_get', { notes: ['Acme'] })
    await svc.passport().bridge.pollOnce()
    await callTool(b, 'memory_get', { notes: ['Acme'] })
    await svc.passport().bridge.pollOnce()
    await callTool(b, 'memory_search', { query: 'Acme' })
    // the next spool call sweeps what main answered
    await callTool(b, 'memory_link', { links: [{ from: 'Acme', to: 'Billing' }] })
    expect(fs.readdirSync(spool).filter((f) => f.endsWith(MEM_RPC.answerSuffix)).length).toBeLessThanOrEqual(1)
  })

  it('read grants refuse writes; legacy argument names still work', async () => {
    const r = server(grant('read'))
    const w = await callTool(r, 'memory_write', { note: 'X', facts: [{ text: 'abc def' }] })
    expect(w.isError).toBe(true)
    expect(text(w)).toMatch(/read-only/)
    const rw = server(grant())
    const legacy = await callTool(rw, 'memory_write', { entity: 'Legacy Thing', entity_type: 'concept', facts: [{ text: 'Old agents still say entity', kind: 'fact' }] })
    expect(legacy.isError, text(legacy)).toBeFalsy()
    expect(json(legacy)).toMatchObject({ note: '[[Legacy Thing]]', created: true })
    const got = json(await callTool(rw, 'memory_get', { names: ['Legacy Thing'] })) as { notes: { note: string }[] }
    expect(got.notes[0].note).toBe('[[Legacy Thing]]')
    const bad = await callTool(rw, 'memory_get', { notes: [] })
    expect(bad.isError).toBe(true)
    expect(text(bad)).toMatch(/Invalid arguments/)
  })
})

// ---------- engine side: write rules, harvest rules, tool lines, attach env ----------

describe('engine memory: Passport write rules and tool lines (§7.2, §7.4, §7.6)', () => {
  const vaultEnv = { ELECTRON_RUN_AS_NODE: '1', HIVE_MEM_INDEX: '/u/passport-index.db', HIVE_MEM_GRANT: 'mgr_1', HIVE_MEM_FP: '/u/fp.json', HIVE_MEM_SPOOL: '/u/mem-rpc/mgr_1', HIVE_COMPANY_ID: A, HIVE_VAULT: '/u/Passport' }
  const g = (toolNames: string[], env: Record<string, string> = vaultEnv): MemoryGrant => ({
    grantId: 'mgr_1',
    server: { name: 'hivemem', command: '/App/Hive', args: ['/App/mcp-memory.js'], env },
    toolNames,
    spawnDir: '/tmp/spawn',
    brief: 'B'
  })
  const RW = ['memory_search', 'memory_get', 'memory_write', 'memory_link', 'memory_invalidate', 'memory_taste']

  it('the rules stay under 900 characters and say what §7.4 says', () => {
    expect(MEMORY_WRITE_RULES.length).toBeLessThan(900)
    expect(PASSPORT_HARVEST_RULES.length).toBeLessThan(900)
    expect(MEMORY_WRITE_RULES).toMatch(/^<passport-write-rules>/)
    expect(MEMORY_WRITE_RULES).toMatch(/\[\[Exact Title\]\]/)
    expect(MEMORY_WRITE_RULES).toMatch(/memory_link/)
    expect(MEMORY_WRITE_RULES).toMatch(/Supersede by \^id/)
    expect(PASSPORT_HARVEST_RULES).toMatch(/<passport-notes>\n### \[\[Exact Note Title\]\]\n- \[fact\] /)
  })

  it('picks the Passport rules, the v1 rules or the harvest rules per grant', () => {
    expect(agentBrief(g(RW), true)).toBe(`B\n\n${MEMORY_WRITE_RULES}`)
    expect(agentBrief(g(['memory_search', 'memory_get', 'memory_write', 'memory_invalidate'], { HIVE_MEM_DB: '/u/memory.db', HIVE_MEM_GRANT: 'g' }), true)).toBe(`B\n\n${LEGACY_MEMORY_WRITE_RULES}`)
    // inject (no MCP) on a read-write vault grant: harvest rules, unless the spawn is never harvested
    expect(agentBrief(g(RW), false)).toBe(`B\n\n${PASSPORT_HARVEST_RULES}`)
    expect(agentBrief(g(RW), false, { harvest: false })).toBe('B')
    expect(agentBrief(g(['memory_search', 'memory_get']), false)).toBe('B')
    expect(agentBrief(g(['memory_search', 'memory_get']), true)).toBe('B')
  })

  it('tool lines name notes and learn memory_link', () => {
    expect(memoryToolLine('mcp__hivemem__memory_link', { links: [{ from: 'Stripe', to: '[[acme-web]]', type: 'uses' }] })).toBe('[memory] link Stripe → acme-web (uses)')
    expect(memoryToolLine('mcp__hivemem__memory_link', { links: [{ from: 'a', to: 'b' }] })).toBe('[memory] link a → b (relates_to)')
    expect(memoryToolLine('hivemem.memory_link', { links: [{}, {}] })).toBe('[memory] link 2 relations')
    expect(memoryToolLine('mcp__hivemem__memory_write', { note: '[[Stripe]]', facts: [{}], relations: [{}] })).toBe('[memory] write Stripe (1 fact, 1 relation)')
    expect(memoryToolLine('mcp__hivemem__memory_write', { entity: 'db', facts: [{}] })).toBe('[memory] write db (1 fact)')
    expect(memoryToolLine('mcp__hivemem__memory_get', { notes: ['[[Stripe]]', 'Ana'], depth: 2 })).toBe('[memory] get Stripe, Ana (depth 2)')
    expect(memoryToolLine('mcp__hivemem__memory_get', { names: ['a'] })).toBe('[memory] get a')
    expect(memoryToolLine('mcp__hivemem__memory_invalidate', { refs: ['[[S#^f-1]]', '^f-2'], reason: 'stale' })).toBe('[memory] invalidate 2 items: stale')
    expect(memoryToolLine('mcp__hivemem__memory_invalidate', { ids: ['mfa_1'] })).toBe('[memory] invalidate 1 item')
  })

  it('the attach helpers carry the vault env (spool, company) and pre-approve memory_link', () => {
    const grant = g(RW)
    const claude = claudeMcpAttach(grant)
    const cfg = JSON.parse(claude.files[0].content) as { mcpServers: Record<string, { env: Record<string, string> }> }
    expect(cfg.mcpServers.hivemem.env).toMatchObject({ HIVE_MEM_SPOOL: '/u/mem-rpc/mgr_1', HIVE_COMPANY_ID: A, HIVE_MEM_INDEX: '/u/passport-index.db' })
    expect(claude.args.join(' ')).toContain('mcp__hivemem__memory_link')
    const codex = codexMcpAttach(grant).args.join(' ')
    expect(codex).toContain(`mcp_servers.hivemem.env.HIVE_COMPANY_ID="${A}"`)
    expect(codex).toContain('mcp_servers.hivemem.env.HIVE_MEM_SPOOL="/u/mem-rpc/mgr_1"')
    expect(codex).toContain('"memory_link"')
  })
})
