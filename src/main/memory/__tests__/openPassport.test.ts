// Open Passport in Principia (PASSPORT.md "Open Passport"): taste capture (stated writes, inferred proposals,
// reinforcement, memory_taste over the spool RPC), the export (a valid passport with department charters, agents and
// L0/L1 renders), import as a new company, and the three-way merge of a copy that comes back (conflicts to the Inbox).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CompanyPassport } from '../../../shared/company'
import type { PassportDepartment } from '../../../shared/passport'
import { nativeOk } from '../vault/__tests__/vaultTestKit'
import { MemoryService, type MemoryCompanies } from '../service'
import { readIncoming, type ExportDepartment } from '../openPassportIo'
import { reviewSignal } from '../taste'
import { readZip, writeFiles } from '../../openPassport/fs'
import { validate } from '../../openPassport'

const d = nativeOk ? describe : describe.skip
const A = 'co_acme'
const B = 'co_globex'
const MKT: PassportDepartment = { id: 'dep_mkt0000001', companyId: A, name: 'Marketing', passportNote: null, contextFallback: '', charter: { does: 'Launch emails and the website', doesNot: 'Paid ads' } }
const EXPORT_DEPS: ExportDepartment[] = [{ id: MKT.id, key: 'marketing', name: 'Marketing', charter: MKT.charter, agents: [{ name: 'Copywriter', capabilities: 'drafts launch emails' }] }]

function passport(id: string, name: string): CompanyPassport {
  return {
    id, name, slug: name.toLowerCase(), color: '#888', sortOrder: 0, mission: '', brandVoice: '', audience: '', products: '', goals: '', context: '', constraints: '',
    repoIds: [], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', system: null, vaultPath: null
  }
}

let dir: string
let svc: MemoryService
let departments: PassportDepartment[]
let renderer: ((c: CompanyPassport, dep?: PassportDepartment | null) => string | null) | null
function companies(): MemoryCompanies {
  const list = [passport(A, 'Acme'), passport(B, 'Globex'), { ...passport('co_personal', 'Personal'), system: 'personal' as const }]
  const get = (id: string) => list.find((x) => x.id === id) ?? (() => { throw new Error('Company not found') })()
  return {
    store: { getSettings: () => ({ experimental: { vault: true } }) },
    listPassports: () => list,
    passport: get,
    resolveCompany: () => ({ company: get(A), repo: null }),
    companyForRepo: () => get('co_personal'),
    vaultPathFor: (id: string) => path.join(dir, 'companies', get(id).slug, 'Passport'),
    setPassportRenderer: (fn: typeof renderer) => {
      renderer = fn
    },
    setMemoryCounter: () => {},
    update: (id: string) => get(id),
    scope: {
      passportDepartment: (companyId: string, id: string) => departments.find((x) => x.id === id && x.companyId === companyId) ?? null,
      passportDepartments: (companyId: string) => departments.filter((x) => x.companyId === companyId),
      departmentOf: (ref: { runId?: string | null }) => (ref.runId === 'run_mkt0000001' ? departments[0] ?? null : null)
    }
  } as unknown as MemoryCompanies
}

beforeEach(() => {
  if (!nativeOk) return
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-open-passport-'))
  departments = [MKT]
  renderer = null
  svc = new MemoryService({ userData: dir, serverScript: '/x.js', execPath: '/x', listRepos: () => [], redact: (s) => s.split('sk-test-SECRET').join('••••KEY'), secretValues: () => [], emit: () => {}, log: { info: () => {}, warn: () => {} }, watchVaults: false })
  svc.start({ poll: false })
  svc.setCompanies(companies())
  svc.passport().ensure(A)
})
afterEach(() => {
  if (!nativeOk) return
  svc.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

const vault = (id: string) => path.join(dir, 'companies', id === A ? 'acme' : 'globex', 'Passport')
const read = (id: string, rel: string) => fs.readFileSync(path.join(vault(id), ...rel.split('/')), 'utf8')
const user = { kind: 'user' as const }
const pending = (kind: string) => svc.passport().listProposals(A).items.filter((p) => p.kind === kind)

d('taste capture', () => {
  it('a stated taste is written to Taste.md; the same statement again reinforces it; the card leads with it', async () => {
    const rt = svc.passport()
    const r1 = await rt.taste(A, { scope: 'company', polarity: 'dislikes', text: 'Exclamation marks in subject lines', example: 'drop the !!' }, { stated: true, source: user, proposalSource: 'agent' })
    expect(r1).toMatchObject({ status: 'written', reinforced: false, note: '[[Taste]]' })
    expect(read(A, 'Taste.md')).toMatch(/type: taste/)
    expect(read(A, 'Taste.md')).toMatch(/- \[dislikes\] Exclamation marks in subject lines \(example: "drop the !!"\) \(user, \d{4}-\d{2}-\d{2}\) \^f-[0-9a-z]{10}/)
    const r2 = await rt.taste(A, { scope: 'company', polarity: 'dislikes', text: 'exclamation marks in subject lines.', example: '[[Launch email v1]]' }, { stated: true, source: user, proposalSource: 'agent' })
    expect(r2.reinforced).toBe(true)
    expect(read(A, 'Taste.md').match(/\[dislikes\]/g)).toHaveLength(1)
    expect(read(A, 'Taste.md')).toContain('Exclamation marks in subject lines (x2; example: "drop the !!"; [[Launch email v1]])')
    const card = renderer!(passport(A, 'Acme'))!
    expect(card).toContain('dislikes: Exclamation marks in subject lines (x2)')
    expect(card).not.toContain('example:')
  })

  it('a review note is a taste proposal for the task department; accepting writes it, the same signal is not filed twice', async () => {
    expect(reviewSignal('approved', 'ok', 'T')).toBeNull()
    const r = await svc.reviewTaste({ companyId: A, departmentId: MKT.id, title: 'Launch email for reminders' }, 'sent_back', 'Too long, keep it under 100 words')
    expect(r).toMatchObject({ status: 'proposed', note: '[[Marketing]]' })
    const [p] = pending('taste')
    expect(p).toMatchObject({ source: 'board', title: 'Taste: dislikes "Too long, keep it under 100 words"' })
    expect(read(A, 'Departments/Marketing.md')).not.toContain('[dislikes]')
    await svc.passport().acceptProposals(A, [p.id])
    expect(read(A, 'Departments/Marketing.md')).toMatch(/- \[dislikes\] Too long, keep it under 100 words \(example: "Launch email for reminders"\) \(user via suggestion sg-/)
    const again = await svc.reviewTaste({ companyId: A, departmentId: MKT.id, title: 'Launch email for reminders' }, 'sent_back', 'Too long, keep it under 100 words')
    // the line exists now: the same signal proposes a reinforcement, once
    expect(again).toMatchObject({ status: 'proposed', reinforced: true })
    expect((await svc.reviewTaste({ companyId: A, departmentId: MKT.id, title: 'Launch email for reminders' }, 'sent_back', 'Too long, keep it under 100 words'))?.status).toBe('known')
    const slot = renderer!(passport(A, 'Acme'), MKT)!
    expect(slot).toContain('dislikes: Too long, keep it under 100 words')
  })

  it('memory_taste over the spool: the run department, proposals unless stated, secrets refused', async () => {
    const rt = svc.passport()
    const grant = rt.grants.create({ companyId: A, vaultPath: vault(A), spoolDir: null, mode: 'read-write', adapter: 'claude', transport: 'mcp', runId: 'run_mkt0000001' })
    const res = (await rt.handleRpc(grant, { v: 1, grantId: grant.id, companyId: A, method: 'taste', args: { scope: 'department', polarity: 'prefers', text: 'One call to action per email', example: '[[Launch email v2]]' } })) as { status: string }
    expect(res.status).toBe('proposed')
    expect(pending('taste')[0].source).toBe('agent')
    const stated = (await rt.handleRpc(grant, { v: 1, grantId: grant.id, companyId: A, method: 'taste', args: { scope: 'company', polarity: 'avoid', text: 'Promising ship dates', example: 'never again', stated_by_user: true } })) as { status: string }
    expect(stated.status).toBe('written')
    expect(read(A, 'Taste.md')).toMatch(/\[avoid\] Promising ship dates \(example: "never again"\) \(claude/)
    await expect(rt.handleRpc(grant, { v: 1, grantId: grant.id, companyId: A, method: 'taste', args: { scope: 'company', polarity: 'likes', text: 'key sk-ant-abcdefghijklmnopqrstuvwxyz0123', example: 'x' } })).rejects.toThrow(/secret|credential|Refused/)
    await expect(rt.handleRpc(grant, { v: 1, grantId: grant.id, companyId: A, method: 'taste', args: { scope: 'department:sales', polarity: 'likes', text: 'Calls', example: 'x' } })).rejects.toThrow(/Unknown department/)
  })
})

d('Open Passport export, import and merge', () => {
  async function seed(): Promise<void> {
    const rt = svc.passport()
    await rt.applyOps(A, [
      { op: 'observe', note: 'Acme', category: 'mission', text: 'Make getting paid boring' },
      { op: 'createNote', title: 'Ana Ruiz', type: 'person', summary: 'Runs marketing.' },
      { op: 'observe', note: 'Ana Ruiz', category: 'role', text: 'Head of marketing' },
      { op: 'relate', from: 'Ana Ruiz', rel: 'part_of', to: 'Marketing' },
      { op: 'observe', note: 'Marketing', category: 'convention', text: 'Subject lines under 6 words' }
    ])
    await rt.taste(A, { scope: 'company', polarity: 'likes', text: 'Plain, short copy', example: 'cut it in half' }, { stated: true, source: user, proposalSource: 'agent' })
  }

  it('exports a valid passport: notes, department slug, charter and agents, manifest and budgeted renders', async () => {
    await seed()
    const r = svc.passport().exportOpenPassport(A, EXPORT_DEPS)
    const files = readZip(r.zip)
    const report = validate(files)
    expect(report.errors).toEqual([])
    expect(r.manifest).toMatchObject({ open_passport: '0.1.0', name: 'Acme', revision: 1, card: 'Acme.md', taste: 'Taste.md' })
    expect(r.manifest.departments).toEqual([expect.objectContaining({ slug: 'marketing', path: 'Departments/Marketing.md' })])
    expect([...files.keys()].some((p) => p.startsWith('.principia') || p.startsWith('_templates') || p.startsWith('.obsidian'))).toBe(false)
    const l0 = files.get('renders/l0.md') as string
    expect(l0).toContain('mission: Make getting paid boring')
    expect(l0).toContain('likes: Plain, short copy')
    const l1 = files.get('renders/departments/marketing.l1.md') as string
    expect(l1).toContain('does: Launch emails and the website')
    expect(l1).toContain('people: Ana Ruiz')
    expect(l1).toContain('agents: Copywriter: drafts launch emails')
    // the vault itself is untouched by the export's additions
    expect(read(A, 'Departments/Marketing.md')).not.toContain('[agent]')
    // same content, same revision; a change bumps it with the parent recorded
    expect(svc.passport().exportOpenPassport(A, EXPORT_DEPS).manifest.revision).toBe(1)
    await svc.passport().applyOps(A, [{ op: 'observe', note: 'Ana Ruiz', category: 'fact', text: 'Lives in Lisbon' }])
    const next = svc.passport().exportOpenPassport(A, EXPORT_DEPS).manifest
    expect(next.revision).toBe(2)
    expect(next.parent).toEqual({ revision: 1, digest: r.manifest.digest })
  })

  it('imports a passport into a new company vault: notes in their folders, taste, departments, provenance kept parseable', async () => {
    await seed()
    const zip = path.join(dir, 'acme.passport.zip')
    fs.writeFileSync(zip, svc.passport().exportOpenPassport(A, EXPORT_DEPS).zip)
    const inc = readIncoming(zip)
    expect(inc.errors).toEqual([])
    departments.push({ ...MKT, id: 'dep_gmk0000001', companyId: B })
    const n = svc.passport().importOpenPassport(B, inc, new Map([['marketing', 'dep_gmk0000001']]))
    expect(n).toBeGreaterThan(3)
    expect(read(B, 'People/Ana Ruiz.md')).toContain('[role] Head of marketing')
    expect(read(B, 'Taste.md')).toContain('[likes] Plain, short copy')
    expect(read(B, 'Departments/Marketing.md')).toMatch(/^department_id: dep_gmk0000001$/m)
    expect(fs.existsSync(path.join(vault(B), 'Departments', 'Marketing (2).md'))).toBe(false)
    const card = renderer!(passport(B, 'Globex'))!
    expect(card).toContain('likes: Plain, short copy')
  })

  it('merges a copy improved elsewhere: three-way against our export, conflicts kept as ours and filed for review', async () => {
    await seed()
    const out = path.join(dir, 'theirs')
    writeFiles(out, readZip(svc.passport().exportOpenPassport(A, EXPORT_DEPS).zip))
    // elsewhere: a new fact, a new note, a reinforced taste, and an edit to the role line
    const ana = path.join(out, 'People', 'Ana Ruiz.md')
    fs.writeFileSync(ana, fs.readFileSync(ana, 'utf8').replace('Head of marketing', 'Head of growth').replace('## Relations', '- [fact] Speaks Portuguese (hermes, 2026-10-21) ^f-anaport001\n\n## Relations'))
    fs.mkdirSync(path.join(out, 'Customers'), { recursive: true })
    fs.writeFileSync(path.join(out, 'Customers', 'Mercury Studio.md'), '---\nid: n-mercury001\ntitle: Mercury Studio\ntype: customer\n---\n# Mercury Studio\nFirst paying customer.\n')
    const taste = path.join(out, 'Taste.md')
    fs.writeFileSync(taste, fs.readFileSync(taste, 'utf8').replace('Plain, short copy (example:', 'Plain, short copy (x3; example:'))
    // here, meanwhile: the same role line changed differently
    const ref = /\[role\] Head of marketing \(user, [0-9-]+\) \^(f-[0-9a-z]{10})/.exec(read(A, 'People/Ana Ruiz.md'))![1]
    await svc.passport().applyOps(A, [{ op: 'supersede', blockId: ref, text: 'Head of brand' }])
    const r = await svc.passport().mergeOpenPassport(A, readIncoming(out), new Map([['marketing', MKT.id]]))
    expect(r.based).toBe(true)
    expect(r.created).toBe(1)
    const anaNow = read(A, 'People/Ana Ruiz.md')
    expect(anaNow).toContain('Head of brand')
    expect(anaNow).toMatch(/- \[fact\] Speaks Portuguese \(migration, 2026-10-21\) \^f-anaport001/)
    expect(read(A, 'Customers/Mercury Studio.md')).toContain('First paying customer.')
    expect(read(A, 'Taste.md')).toContain('Plain, short copy (x3;')
    // ours superseded the role line while theirs edited it: kept ours, one conflict in the Inbox
    expect(r.conflicts).toBe(1)
    const [c] = pending('import_conflict')
    expect(c).toMatchObject({ needsDecision: true, source: 'import' })
    expect(c.evidence.map((e) => e.quote).join('\n')).toContain('Head of growth')
  })
})

d('publish / sync with an Open Passport host (mocked, no network)', () => {
  /** A fake host: one passport, revisions stored as given (a real host merges; this one only has to serve them). */
  function fakeHost(initial: Uint8Array) {
    const revs: Uint8Array[] = [initial]
    const calls: string[] = []
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      const u = new URL(url)
      const auth = (init.headers as Record<string, string>).authorization
      calls.push(`${init.method ?? 'GET'} ${u.pathname}${(init.headers as Record<string, string>)['x-base-revision'] ? ` base=${(init.headers as Record<string, string>)['x-base-revision']}` : ''}`)
      if (auth !== 'Bearer opk_test') return new Response(JSON.stringify({ error: 'unknown or revoked token' }), { status: 401, headers: { 'content-type': 'application/json' } })
      if (u.pathname.endsWith('/revisions') && init.method === 'POST') {
        revs.push(new Uint8Array(init.body as ArrayBuffer))
        return Response.json({ status: 'applied', revision: revs.length, conflicts: [] })
      }
      if (u.pathname.endsWith('/revisions')) return Response.json({ head: revs.length, revisions: revs.map((_, i) => ({ revision: i + 1 })) })
      if (u.pathname.endsWith('/bundle')) return new Response(revs[revs.length - 1] as unknown as BodyInit, { headers: { 'content-type': 'application/zip' } })
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
    return { fetchImpl, calls, revs }
  }

  it('is off until configured; a sync pulls the host head (merged into the vault), then pushes the vault on that base', async () => {
    const { PassportSync } = await import('../openPassportSync')
    const { rememberBundle } = await import('../openPassportIo')
    const rt = svc.passport()
    await rt.applyOps(A, [{ op: 'createNote', title: 'Ana Ruiz', type: 'person' }, { op: 'observe', note: 'Ana Ruiz', category: 'role', text: 'Head of marketing' }])
    // the host holds our passport plus a line a cloud runner added there
    const out = path.join(dir, 'cloud')
    writeFiles(out, readZip(rt.exportOpenPassport(A, EXPORT_DEPS).zip))
    const ana = path.join(out, 'People', 'Ana Ruiz.md')
    fs.writeFileSync(ana, fs.readFileSync(ana, 'utf8').replace(/\n*$/, '\n- [fact] Prefers async updates (codex, 2026-10-21) ^f-anaasync01\n'))
    const { writeZip } = await import('../../openPassport/fs')
    const { readFolder } = await import('../../openPassport/fs')
    const host = fakeHost(writeZip(readFolder(out)))
    const sync = new PassportSync({
      userData: dir,
      fetch: host.fetchImpl,
      exportZip: (id) => rt.exportOpenPassport(id, EXPORT_DEPS),
      merge: (id, inc, baseDigest) => rt.mergeOpenPassport(id, inc, new Map([['marketing', MKT.id]]), { baseDigest }),
      remember: (id, inc) => rememberBundle(rt.ensure(id), inc)
    })
    expect(sync.view(A)).toBeNull()
    await expect(sync.sync(A)).rejects.toThrow(/not connected/)
    expect(() => sync.configure(A, { url: 'http://passport.example.com', passportId: 'acme', token: 'opk_test' })).toThrow(/https/)
    const view = sync.configure(A, { url: 'https://passport.example.com/ignored/path', passportId: 'acme', token: 'opk_test' })
    expect(view).toMatchObject({ url: 'https://passport.example.com', passportId: 'acme', hasToken: true, base: null })
    expect(JSON.stringify(view)).not.toContain('opk_test')
    expect(fs.statSync(path.join(dir, 'open-passport-sync.json')).mode & 0o777).toBe(0o600)
    const r = await sync.sync(A)
    expect(r.pulled).toMatchObject({ from: null, to: 1, conflicts: 0 })
    expect(read(A, 'People/Ana Ruiz.md')).toContain('Prefers async updates (codex, 2026-10-21) ^f-anaasync01')
    expect(r.pushed).toEqual({ revision: 2, conflicts: 0 })
    expect(host.calls).toEqual(['GET /v1/passports/acme/revisions', 'GET /v1/passports/acme/bundle', 'POST /v1/passports/acme/revisions base=1'])
    expect(sync.view(A)?.base).toBe(2)
    // nothing new on either side: one cheap revisions call, no bundle, no push
    host.calls.length = 0
    const again = await sync.sync(A)
    expect(again).toMatchObject({ pulled: null, pushed: null, revision: 2 })
    expect(host.calls).toEqual(['GET /v1/passports/acme/revisions'])
    // a revoked token says so
    sync.configure(A, { url: 'https://passport.example.com', passportId: 'acme', token: 'opk_revoked' })
    await expect(sync.sync(A)).rejects.toThrow(/refused the token/)
  })
})
