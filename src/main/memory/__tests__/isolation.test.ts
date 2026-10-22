// Strictly per company (PASSPORT.md §1.8, §7.1, §7.5, §8, §12; §14 P8.2): one index db and one main serve every company,
// so isolation rests on binding every query and op to the grant's company. Northwind (the fixture vault) and Globex share
// titles (Stripe, Ana Ruiz) and Globex holds marker words (zebra, Okapi). A Northwind grant must not read or write Globex
// through any tool argument, id, path, ref or env var; briefs and suggestions never carry the other company; a grant
// whose env names another company is served ask_user only.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MEM_RPC, type MemRpcRequest } from '../../../shared/memory'
import type { StepOutputEvent } from '../../../shared/engine'
import type { VaultOp } from '../../../shared/passport'
import { writePrivateJson } from '../../gateway/files'
import { buildPassportBrief, knownNotesLine } from '../brief'
import { graphOp, linksOp, noteOp } from '../passportIpc'
import { backlinks, globalGraph, localGraph, notesTree, unlinkedMentions, vaultGhosts, vaultNoteDetail, vaultSearch } from '../search'
import { SuggestionPipeline } from '../vault/suggest'
import { nativeOk } from '../vault/__tests__/vaultTestKit'
import { GX, GX_APP, makeHarness, NW, NW_WEB, PERSONAL, toolJson, toolText, type Harness } from './fixtures/vault/harness'

const d = nativeOk ? describe : describe.skip
/** Anything of Globex's that must never reach Northwind. */
const GLOBEX = /zebra|okapi|globex/i
/** Northwind-only names and lines that must never reach Globex (Globex's own text mentions "Ledger Sync" and "Dunning"). */
const NORTHWIND = /northwind-web|billing-worker|Helios|Mercury Bank|Northwind|payouts every Tuesday|integer cents|raw body parser/

let h: Harness
let gx: { zebra: string; zebraBlock: string; stripe: string; files: () => string }

/** Globex's vault: a B-only note, colliding titles (Stripe, Ana Ruiz), a relation, a ghost and plain mentions of Northwind titles. */
async function seedGlobex(): Promise<void> {
  h.rt.ensure(GX)
  const ops: VaultOp[] = [
    { op: 'createNote', title: 'Zebra Project', type: 'concept', summary: 'Globex zebra launch, codenamed Okapi.' },
    { op: 'observe', note: 'Zebra Project', category: 'decision', text: 'The zebra launch ships to Okapi customers first' },
    { op: 'createNote', title: 'Stripe', type: 'product' },
    { op: 'observe', note: 'Stripe', category: 'gotcha', text: 'Globex rotates its zebra Stripe keys every Friday' },
    { op: 'createNote', title: 'Ana Ruiz', type: 'person' },
    { op: 'observe', note: 'Ana Ruiz', category: 'role', text: 'Ana Ruiz at Globex leads zebra procurement' },
    { op: 'createNote', title: 'Globex Payments', type: 'product' },
    { op: 'relate', from: 'Globex Payments', rel: 'uses', to: 'Stripe' },
    { op: 'relate', from: 'Zebra Project', rel: 'depends_on', to: 'Okapi Rollout' },
    { op: 'observe', note: 'Globex Payments', category: 'fact', text: 'We looked at Ledger Sync and Dunning tools before building zebra billing' },
    { op: 'createNote', title: 'Refund policy', type: 'process' },
    { op: 'observe', note: 'Refund policy', category: 'convention', text: 'Refunds over 500 EUR need a second approver from finance' }
  ]
  const res = await h.rt.applyOps(GX, ops, { kind: 'user' })
  expect(res.results.map((r) => r.status)).toEqual(ops.map(() => 'ok'))
  const zebra = h.rt.index.resolve(GX, 'Zebra Project').toNote!
  const zebraText = h.read(GX, 'Concepts/Zebra Project.md')
  gx = {
    zebra,
    zebraBlock: /\^(f-[0-9a-z]{10})/.exec(zebraText)![1],
    stripe: h.rt.index.resolve(GX, 'Stripe').toNote!,
    files: () => h.files(GX).map((f) => `${f}\n${h.read(GX, f)}`).join('\n\u0000')
  }
}

/** Globex's derived and operational rows, to prove nothing of Northwind's activity touched them. */
const globexRows = () =>
  JSON.stringify(
    ['mem_note', 'mem_fact', 'mem_link', 'mem_alias', 'mem_proposal', 'mem_conflict'].map((t) => h.rt.db.prepare(`SELECT * FROM ${t} WHERE company_id = ? ORDER BY rowid`).all(GX))
  )

beforeEach(async () => {
  if (!nativeOk) return
  h = makeHarness()
  await seedGlobex()
})
afterEach(() => {
  if (nativeOk) h.close()
})

d('a Northwind grant reads Northwind only (§7.1, §7.2)', () => {
  it('no query, title, note id, block ref, path or filter reaches Globex', async () => {
    const b = h.server(h.grant(NW))
    expect(b.handlers.instructions()).not.toMatch(GLOBEX)
    for (const query of ['zebra', 'Okapi', 'Zebra Project', 'Globex Payments', 'Globex', 'zebra Stripe keys Friday', 'Ana Ruiz procurement']) {
      const r = await h.call(b, 'memory_search', { query, limit: 20 })
      expect(r.isError, toolText(r)).toBeFalsy()
      expect(toolText(r), query).not.toMatch(GLOBEX)
    }
    expect(toolText(await h.call(b, 'memory_search', { query: 'zebra', types: ['concept', 'product'], tags: ['company'] }))).not.toMatch(GLOBEX)

    const probes = [
      'Zebra Project',
      gx.zebra,
      `[[Zebra Project#^${gx.zebraBlock}]]`,
      `^${gx.zebraBlock}`,
      'Globex',
      'Okapi Rollout',
      'Concepts/Zebra Project',
      '../../globex/Passport/Concepts/Zebra Project.md',
      path.join(h.root(GX), 'Concepts', 'Zebra Project.md'),
      'Globex Payments'
    ]
    const got = await h.call(b, 'memory_get', { notes: probes, depth: 2, include_history: true })
    expect(got.isError, toolText(got)).toBeFalsy()
    const gj = toolJson<{ notes: unknown[]; not_found: { not_found: string; did_you_mean: string[]; ghost_referenced_by?: string[] }[] }>(got)
    expect(gj.notes).toEqual([])
    // each probe comes back as not found (echoing only what was asked), with no hint drawn from Globex
    expect(gj.not_found.map((n) => n.not_found)).toEqual(probes)
    expect(JSON.stringify(gj.not_found.map(({ not_found: _asked, ...rest }) => rest))).not.toMatch(GLOBEX)

    // shared titles resolve to Northwind's own notes, with Northwind's lines and neighbours only
    const shared = await h.call(b, 'memory_get', { notes: ['Stripe', 'Ana Ruiz'], depth: 2, include_history: true })
    const sj = toolJson<{ notes: { note: string }[] }>(shared)
    expect(sj.notes.map((n) => n.note)).toEqual(['[[Stripe]]', '[[Ana Ruiz]]'])
    expect(toolText(shared)).not.toMatch(GLOBEX)
    expect(toolText(shared)).toContain('payouts every Tuesday')
  })

  it('a company can never be named in tool arguments', async () => {
    const b = h.server(h.grant(NW))
    for (const [name, args] of [
      ['memory_search', { query: 'zebra', company_id: GX }],
      ['memory_search', { query: 'zebra', companyId: GX }],
      ['memory_get', { notes: ['Zebra Project'], company: GX }],
      ['memory_write', { note: 'Zebra Project', company_id: GX, facts: [{ text: 'cross company write' }] }],
      ['memory_link', { links: [{ from: 'Stripe', to: 'Zebra Project', company_id: GX }] }],
      ['memory_invalidate', { refs: [`^${gx.zebraBlock}`], reason: 'cross company', companyId: GX }]
    ] as const) {
      const r = await h.call(b, name, args)
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true)
      expect(toolText(r)).toMatch(/Invalid arguments/)
    }
  })

  it('the vault queries behind the tools and IPC are bound to one company', () => {
    const db = h.rt.db
    expect(vaultSearch(db, { companyId: NW }, 'zebra okapi globex')).toEqual([])
    expect(vaultNoteDetail(db, NW, gx.zebra)).toBeNull()
    expect(backlinks(db, NW, gx.stripe)).toEqual([])
    expect(localGraph(db, NW, gx.zebra, 3).nodes).toEqual([])
    expect(unlinkedMentions(db, NW, gx.zebra, { root: h.root(NW) })).toEqual([])
    expect(JSON.stringify(globalGraph(db, NW, { includeArchived: true, includeTags: true }))).not.toMatch(GLOBEX)
    expect(JSON.stringify(vaultGhosts(db, NW, 1000))).not.toMatch(GLOBEX)
    expect(JSON.stringify(notesTree(db, NW, { includeArchived: true }))).not.toMatch(GLOBEX)
    expect(knownNotesLine(db, NW, 100_000)).not.toMatch(GLOBEX)
    // and the other way round
    expect(JSON.stringify(globalGraph(db, GX, { includeArchived: true }))).not.toMatch(NORTHWIND)
    expect(vaultSearch(db, { companyId: GX }, 'Ledger Sync dunning invoices')).toEqual([expect.objectContaining({ note: expect.objectContaining({ title: 'Globex Payments' }) })])
  })
})

d('a Northwind grant writes Northwind only (§7.1, §7.3)', () => {
  it('writes, links, invalidations and supersedes naming Globex things never touch Globex', async () => {
    const files = gx.files()
    const rows = globexRows()
    const g = h.grant(NW)
    const b = h.server(g)
    const w = toolJson<{ path: string; created: boolean }>(await h.call(b, 'memory_write', { note: 'Zebra Project', facts: [{ text: 'Northwind has its own zebra-striped dashboard theme' }] }))
    expect(w.created).toBe(true)
    expect(fs.existsSync(path.join(h.root(NW), ...w.path.split('/')))).toBe(true)
    await h.call(b, 'memory_write', { note: gx.zebra, facts: [{ text: 'Named by a raw note id of another company' }] })
    await h.call(b, 'memory_link', { links: [{ from: 'Stripe', type: 'relates_to', to: 'Globex Payments' }, { from: 'Ana Ruiz', type: 'relates_to', to: 'Okapi Rollout' }] })
    const inv = toolJson<{ items: { result: string }[] }>(await h.call(b, 'memory_invalidate', { refs: [`^${gx.zebraBlock}`, `[[Zebra Project#^${gx.zebraBlock}]]`], reason: 'cross company' }))
    expect(inv.items.map((i) => i.result)).toEqual(['not_found', 'not_found'])
    await h.call(b, 'memory_write', { note: 'Stripe', facts: [{ text: 'Keys rotate monthly', supersedes: `^${gx.zebraBlock}` }] })
    // the env is no lever either: HIVE_VAULT is for messages only, writes follow the grant
    const tampered = h.server(g, { HIVE_VAULT: h.root(GX) })
    const t = toolJson<{ path: string }>(await h.call(tampered, 'memory_write', { note: 'Env tamper probe', facts: [{ text: 'Written with HIVE_VAULT pointing at Globex' }] }))
    expect(fs.existsSync(path.join(h.root(NW), ...t.path.split('/')))).toBe(true)

    expect(gx.files()).toBe(files)
    expect(globexRows()).toBe(rows)
    expect(h.read(NW, 'Products/Stripe.md')).toContain('- relates_to [[Globex Payments]]')
    expect(h.rt.db.prepare(`SELECT to_note FROM mem_link WHERE company_id = ? AND to_norm = 'globex payments'`).all(NW)).toEqual([{ to_note: null }])
  })

  it('the spool bridge refuses a request naming another company or another grant', async () => {
    const files = gx.files()
    const g = h.grant(NW)
    const other = h.grant(GX)
    const spool = h.rt.grants.get(g.grantId)!.spool_dir!
    const ask = async (req: Omit<MemRpcRequest, 'v'>, id: string) => {
      writePrivateJson(path.join(spool, `${id}${MEM_RPC.requestSuffix}`), { v: 1, ...req })
      const answer = path.join(spool, `${id}${MEM_RPC.answerSuffix}`)
      for (let i = 0; i < 200 && !fs.existsSync(answer); i++) {
        await h.rt.bridge.pollOnce()
        if (!fs.existsSync(answer)) await new Promise((r) => setTimeout(r, 5))
      }
      return JSON.parse(fs.readFileSync(answer, 'utf8')) as { ok: boolean; code?: string }
    }
    expect(await ask({ grantId: g.grantId, companyId: GX, method: 'write', args: { note: 'Leak', facts: [{ text: 'into Globex' }] } }, 'req00000001')).toMatchObject({ ok: false, code: 'company' })
    expect(await ask({ grantId: other.grantId, companyId: GX, method: 'write', args: { note: 'Leak', facts: [{ text: 'borrowed grant' }] } }, 'req00000002')).toMatchObject({ ok: false })
    expect(gx.files()).toBe(files)
  })
})

d('the Passport page IPC is bound to the request company (§10, §11)', () => {
  it('Northwind requests cannot read, save, create, rename, archive or link into Globex by id, path or folder', async () => {
    const files = gx.files()
    const rows = globexRows()
    const nwFiles = h.files(NW)
    const zebraRel = 'Concepts/Zebra Project.md'
    const zebraAbs = path.join(h.root(GX), 'Concepts', 'Zebra Project.md')
    const traversal = path.relative(h.root(NW), zebraAbs).split(path.sep).join('/')
    const redact = (s: string) => s
    const attempt = async <T>(p: Promise<T> | T): Promise<T | Error> => {
      try {
        return await p
      } catch (e) {
        return e as Error
      }
    }
    // reads: a Globex id or a Globex-relative path is not a Northwind note
    for (const ref of [{ id: gx.zebra }, { path: zebraRel }, { path: traversal }, { path: zebraAbs }]) {
      const r = await attempt(noteOp(h.rt, { op: 'get', companyId: NW, ...ref }, redact))
      // a refusal may echo what was asked, nothing more
      const asked = ('id' in ref ? ref.id : ref.path) as string
      expect(r instanceof Error ? r.message.split(asked).join('') : JSON.stringify(r), JSON.stringify(ref)).not.toMatch(GLOBEX)
    }
    for (const op of ['backlinks', 'unlinked', 'outgoing'] as const) {
      const r = await attempt(linksOp(h.rt, { op, companyId: NW, noteId: gx.zebra } as never, redact))
      expect(JSON.stringify(r instanceof Error ? r.message : r)).not.toMatch(GLOBEX)
    }
    expect(JSON.stringify(graphOp(h.rt, { op: 'local', companyId: NW, noteId: gx.zebra, depth: 2 } as never))).not.toMatch(GLOBEX)
    // writes: an editor save, a create in a traversal folder, rename/archive by Globex id, and ops naming Globex things
    const text = fs.readFileSync(zebraAbs, 'utf8')
    const hash = h.rt.db.prepare('SELECT hash FROM mem_note WHERE company_id = ? AND id = ?').get(GX, gx.zebra) as { hash: string }
    for (const p of [traversal, zebraAbs]) await attempt(noteOp(h.rt, { op: 'save', companyId: NW, path: p, baseHash: hash.hash, text: `${text}- [fact] hijacked by Northwind\n` }, redact))
    await attempt(noteOp(h.rt, { op: 'create', companyId: NW, title: 'Escapee', folder: path.relative(h.root(NW), path.join(h.root(GX), 'Concepts')) }, redact))
    await attempt(noteOp(h.rt, { op: 'create', companyId: NW, title: '../../globex/Passport/Concepts/Escapee two' }, redact))
    await attempt(noteOp(h.rt, { op: 'rename', companyId: NW, id: gx.zebra, newTitle: 'Renamed by Northwind' }, redact))
    await attempt(noteOp(h.rt, { op: 'archive', companyId: NW, id: gx.zebra }, redact))
    await attempt(
      noteOp(h.rt, {
        op: 'ops',
        companyId: NW,
        ops: [
          { op: 'invalidate', blockId: gx.zebraBlock, reason: 'cross company' },
          { op: 'archive', note: gx.zebra },
          { op: 'merge', from: gx.stripe, into: 'Stripe' },
          { op: 'observe', note: gx.zebra, category: 'fact', text: 'hijacked through a raw id' }
        ]
      }, redact)
    )
    expect(gx.files()).toBe(files)
    expect(globexRows()).toBe(rows)
    // whatever Northwind created landed inside Northwind's own vault
    for (const f of h.files(NW).filter((x) => !nwFiles.includes(x))) expect(path.join(h.root(NW), f).startsWith(h.root(NW) + path.sep)).toBe(true)
    expect(fs.readdirSync(path.join(h.root(GX), 'Concepts')).filter((f) => /Escapee/.test(f))).toEqual([])
  })
})

d('an env/grant company mismatch refuses to serve (§7.1 binding)', () => {
  it('lists ask_user only and refuses memory calls, in both directions and after release', async () => {
    const live = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-p8-live-'))
    try {
      const gNw = h.grant(NW)
      const gGx = h.grant(GX)
      for (const [g, env] of [
        [gNw, { HIVE_COMPANY_ID: GX }],
        [gGx, { HIVE_COMPANY_ID: NW }],
        [gNw, { HIVE_COMPANY_ID: PERSONAL }]
      ] as const) {
        const b = h.server(g, { ...env, HIVE_LIVE_DIR: live })
        expect(b.handlers.listTools().map((t) => t.name)).toEqual(['ask_user'])
        const r = await h.call(b, 'memory_search', { query: 'zebra' })
        expect(r.isError).toBe(true)
        expect(toolText(r)).not.toMatch(/Okapi|procurement/)
      }
      // a grant row of Globex presented with Northwind's grant id swapped in the env
      const swapped = h.server(gNw, { HIVE_MEM_GRANT: gGx.grantId })
      expect(swapped.handlers.listTools()).toEqual([])
      // a released grant writes nothing
      const b = h.server(gNw)
      h.svc.release(gNw.grantId)
      const before = h.files(NW)
      const r = await h.call(b, 'memory_write', { note: 'After release', facts: [{ text: 'should not land anywhere' }] })
      expect(r.isError).toBe(true)
      expect(h.files(NW)).toEqual(before)
    } finally {
      fs.rmSync(live, { recursive: true, force: true })
    }
  })
})

d('briefs never include another company (§8.3)', () => {
  it("a Northwind brief, card and known notes hold nothing of Globex, even when the prompt asks for it", () => {
    const g = h.grant(NW, { briefQuery: 'zebra Okapi Globex Payments: rotate the Stripe keys like Ana Ruiz does for procurement' })
    expect(g.brief).toContain('<principia-passport company="Northwind"')
    expect(g.brief).not.toMatch(GLOBEX)
    expect(g.brief).toMatch(/\[\[Stripe\]\]/) // its own Stripe note is relevant
    const card = h.companies.renderer!(h.companies.passport(NW))
    expect(card ?? '').not.toMatch(GLOBEX)
    const direct = buildPassportBrief(h.rt.db, { companyId: NW, companyName: 'Northwind', query: 'zebra okapi', transport: 'inject' })
    expect(direct.text).not.toMatch(GLOBEX)
    expect(direct.noteIds.every((id) => h.rt.index.noteById(NW, id))).toBe(true)
  })

  it("the spawn's company wins over its cwd: a Globex grant inside Northwind's repo gets no repo and no Northwind rows", () => {
    const g = h.grant(GX, { cwd: `${NW_WEB.path}/src/billing`, briefQuery: 'stripe webhooks raw body dunning invoices northwind-web' })
    const row = h.rt.grants.get(g.grantId)!
    expect(row).toMatchObject({ company_id: GX, repo_id: null })
    expect(g.server.env.HIVE_COMPANY_ID).toBe(GX)
    expect(g.brief).not.toMatch(NORTHWIND)
    expect(g.brief).not.toContain('here=')
    // and a Personal grant sees neither
    const p = h.grant(PERSONAL, { cwd: '/tmp/scratch', briefQuery: 'zebra stripe dunning ledger sync' })
    expect(p.brief).not.toMatch(GLOBEX)
    expect(p.brief).not.toMatch(NORTHWIND)
    // the cwd's company is the fallback only when the spawn names none
    const fallback = h.grant(GX, { companyId: null, cwd: GX_APP.path })
    expect(h.rt.grants.get(fallback.grantId)).toMatchObject({ company_id: GX, repo_id: GX_APP.id })
  })
})

d('suggestions never include another company (§12)', () => {
  const step = (companyId: string, output: string): StepOutputEvent => ({
    runId: 'run_p8harv0001',
    stepId: 'step_p8harv001',
    nodeId: 'write',
    adapter: 'codex',
    companyId,
    memory: 'read-write',
    transport: 'inject',
    status: 'passed',
    output
  })

  it('stages 0 and 1 and the harvester only ever propose ops between one company’s notes', async () => {
    // Northwind text mentions Globex-only titles; Globex text mentions Northwind-only titles; both have a "Refund policy"
    await h.rt.applyOps(NW, [
      { op: 'observe', note: 'Churn', category: 'context', text: 'Compare with Zebra Project and Globex Payments before the board meeting' },
      { op: 'createNote', title: 'Refund policy', type: 'process' },
      { op: 'observe', note: 'Refund policy', category: 'convention', text: 'Refunds over 500 EUR need a second approver from finance' }
    ])
    const pipe = new SuggestionPipeline({ runtime: () => h.rt, redact: (s) => s, log: { info: () => {}, warn: () => {} }, timers: false })
    await pipe.suggest(NW)
    await pipe.suggest(GX)
    pipe.harvest(step(NW, 'Done.\n<passport-notes>\n### [[Zebra Project]]\n- [fact] Northwind borrows the zebra layout\n- uses [[Globex Payments]]\n</passport-notes>'))

    const rowsOf = (companyId: string) => h.rt.db.prepare('SELECT id, kind, payload_json, evidence_json FROM mem_proposal WHERE company_id = ?').all(companyId) as { id: string; kind: string; payload_json: string; evidence_json: string }[]
    const nw = rowsOf(NW)
    const gxRows = rowsOf(GX)
    expect(nw.length).toBeGreaterThan(0)
    expect(gxRows.length).toBeGreaterThan(0)
    const gxIds = (h.rt.db.prepare('SELECT id FROM mem_note WHERE company_id = ?').all(GX) as { id: string }[]).map((r) => r.id)
    const nwIds = (h.rt.db.prepare('SELECT id FROM mem_note WHERE company_id = ?').all(NW) as { id: string }[]).map((r) => r.id)
    const gxRoot = h.root(GX)
    for (const r of nw) {
      const blob = r.payload_json + r.evidence_json
      for (const id of gxIds) expect(blob, `${r.kind} names Globex note ${id}`).not.toContain(id)
      expect(blob).not.toContain(gxRoot)
      expect(blob).not.toMatch(/Okapi|procurement|rotates its zebra/) // Globex's text never quoted as evidence
      const ops = JSON.parse(r.payload_json) as VaultOp[]
      for (const op of Array.isArray(ops) ? ops : []) {
        if (op.op === 'linkMention') expect(['Zebra Project', 'Globex Payments']).not.toContain(op.target)
        if (op.op === 'merge') expect([op.from, op.into]).not.toContain(gxIds[0])
      }
    }
    for (const r of gxRows) {
      const blob = r.payload_json + r.evidence_json
      for (const id of nwIds) expect(blob, `${r.kind} names Northwind note ${id}`).not.toContain(id)
      expect(blob).not.toMatch(/payouts every Tuesday|Fly\.io|integer cents/)
      for (const op of JSON.parse(r.payload_json) as VaultOp[]) if (op.op === 'linkMention') expect(['Ledger Sync', 'Dunning']).not.toContain(op.target)
    }
    // the identical "Refund policy" notes are never a cross-company merge or similarity pair
    expect(nw.filter((r) => r.kind === 'merge' || r.kind === 'relation').every((r) => !gxIds.some((id) => r.payload_json.includes(id)))).toBe(true)
  })

  it("a company cannot accept, reject or edit another company's suggestion", async () => {
    const pipe = new SuggestionPipeline({ runtime: () => h.rt, redact: (s) => s, log: { info: () => {}, warn: () => {} }, timers: false })
    await pipe.suggest(GX)
    const theirs = h.rt.listProposals(GX).items
    expect(theirs.length).toBeGreaterThan(0)
    const files = gx.files()
    const ids = theirs.map((p) => p.id)
    const acc = await h.rt.acceptProposals(NW, ids)
    expect(acc.accepted).toBe(0)
    await h.rt.rejectProposals(NW, ids).catch(() => null)
    await expect(h.rt.editProposal(NW, ids[0], [{ op: 'observe', note: 'Stripe', category: 'fact', text: 'hijacked' }], true)).rejects.toThrow()
    expect(h.rt.listProposals(GX).items.map((p) => [p.id, p.status])).toEqual(theirs.map((p) => [p.id, p.status]))
    expect(gx.files()).toBe(files)
    expect(h.read(NW, 'Products/Stripe.md')).not.toContain('hijacked')
  })
})
