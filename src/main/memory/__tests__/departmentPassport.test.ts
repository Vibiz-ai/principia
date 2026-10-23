// DEPARTMENTS.md §7 / PASSPORT.md §3.1, §4: the department passport slot. The brief carries `## [[Marketing]]
// (department)` once, after the company card and within the caps, boosts notes linked to the department note, and
// falls back to contextFallback when there is no note (or nothing in it); a run with no department gets no slot. The
// department note (`Departments/<Name>.md`, `part_of [[Company]]`) is created idempotently, and only in vault mode.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CompanyPassport } from '../../../shared/company'
import type { PassportDepartment } from '../../../shared/passport'
import type { Repo } from '../../../shared/types'
import { parseNote } from '../../../shared/vault/parse'
import { makeKit, nativeOk, type Kit } from '../vault/__tests__/vaultTestKit'
import { seedDepartmentNote } from '../vault/seed'
import { buildPassportBrief, departmentCardLines, departmentNote, PASSPORT_BRIEF, renderCompanyCard } from '../brief'
import { MemoryService, type MemoryCompanies } from '../service'

const d = nativeOk ? describe : describe.skip
const A = 'co_acme'
const B = 'co_globex'
const count = (text: string, needle: string) => text.split(needle).length - 1
const heads = (text: string) => text.split('\n').filter((l) => l.startsWith('## '))

function dept(extra: Partial<PassportDepartment> = {}): PassportDepartment {
  return { id: 'dep_mkt0000001', companyId: A, name: 'Marketing', passportNote: null, contextFallback: 'Voice: plain words, no hype.', charter: { does: 'Launch posts and campaigns', doesNot: 'Write code' }, ...extra }
}
function fm(id: string, title: string, type: string, extra = ''): string {
  return `---\nid: ${id}\ntitle: ${title}\ntype: ${type}\n${extra}---\n# ${title}\n`
}

// ---------------------------------------------------------------------------------------------------------------------
// the brief (index level)
// ---------------------------------------------------------------------------------------------------------------------

const kits: Kit[] = []
afterEach(() => {
  while (kits.length) kits.pop()!.close()
})

function acme(withDeptNote = true): Kit {
  const k = makeKit({ companyId: A })
  kits.push(k)
  k.write('Acme.md', fm('n-acme000001', 'Acme', 'company') + 'Acme sells developer tools.\n\n## Observations\n- [mission] Make billing boring (user, 2026-10-01) ^f-mission001\n')
  if (withDeptNote) {
    k.write(
      'Departments/Marketing.md',
      fm('n-mkt0000001', 'Marketing', 'department', 'department_id: dep_mkt0000001\n') +
        'Launch posts and campaigns.\n\n## Observations\n- [convention] Every launch post links the changelog (user, 2026-10-02) ^f-mktconv001\n\n## Processes\n- [process] Draft, review with Ana, publish Tuesday (user, 2026-10-02) ^f-mktproc001\n\n## Relations\n- part_of [[Acme]] ^r-mktpart001\n- uses [[Zeta Checklist]] ^r-mktuses001\n'
    )
  }
  // two notes that match "launch webhook" equally; only the checklist is linked to the department
  k.write('Concepts/Zeta Checklist.md', fm('n-check00001', 'Zeta Checklist', 'concept') + 'Steps.\n\n## Observations\n- [fact] Launch webhook steps for the release (user, 2026-10-01) ^f-check00001\n')
  k.write('Concepts/Alpha Runbook.md', fm('n-runbk00001', 'Alpha Runbook', 'concept') + 'Steps.\n\n## Observations\n- [fact] Launch webhook steps for the release (user, 2026-10-01) ^f-runbk00001\n')
  // the runbook gets an inbound link of its own, so link degree alone does not decide the order
  k.write('Concepts/Ops Board.md', fm('n-opsbrd0001', 'Ops Board', 'concept') + 'Board.\n\n## Relations\n- uses [[Alpha Runbook]] ^r-opsuses001\n')
  k.index.rebuild(A)
  return k
}

d('the department slot in the brief (DEPARTMENTS.md §7)', () => {
  it('indexes Departments/<Name>.md as type department, part_of the company', () => {
    const k = acme()
    const n = departmentNote(k.db, A, dept())!
    expect(n).toMatchObject({ id: 'n-mkt0000001', path: 'Departments/Marketing.md', type: 'department' })
    // found by department_id after a rename, and by title for a hand-written note without one
    expect(departmentNote(k.db, A, dept({ name: 'Growth' }))?.id).toBe('n-mkt0000001')
    expect(departmentNote(k.db, A, dept({ id: 'dep_other00001' }))).toBeNull()
  })

  it('a Marketing run gets the block exactly once, right after the company card, within the caps', () => {
    const k = acme()
    const { text, noteIds } = buildPassportBrief(k.db, { companyId: A, companyName: 'Acme', query: 'launch webhook', transport: 'mcp', department: dept() })
    expect(count(text, '## [[Marketing]] (department)')).toBe(1)
    expect(heads(text).slice(0, 2)).toEqual(['## [[Acme]] (company)', '## [[Marketing]] (department)'])
    // the slot is the Open Passport L1 render: charter, taste, processes and facts as `key: value` lines
    expect(text).toContain('\nconvention: Every launch post links the changelog')
    expect(text).toContain('\nprocess: Draft, review with Ana, publish Tuesday')
    expect(text).toContain('\ndoes: Launch posts and campaigns')
    expect(text).not.toContain('part_of') // the card already says which company
    // the department note never repeats in Relevant / Nearby / Pinned (Known notes still lists the exact title)
    expect(text).not.toMatch(/^- \[\[Marketing\]\]/m)
    expect(noteIds).toContain('n-mkt0000001')
    expect(text.length).toBeLessThanOrEqual(PASSPORT_BRIEF.totalChars)
    const slot = departmentCardLines(k.db, A, dept(), 'n-acme000001')
    expect(slot.join('\n').length).toBeLessThanOrEqual(PASSPORT_BRIEF.departmentChars)
  })

  it('a run with no department gets no slot', () => {
    const k = acme()
    const { text } = buildPassportBrief(k.db, { companyId: A, companyName: 'Acme', query: 'launch webhook', transport: 'mcp' })
    expect(heads(text).filter((h) => h.endsWith('(department)'))).toEqual([])
    // the note itself is ordinary company knowledge: every agent reads the whole company passport
    expect(text).toMatch(/^- \[\[Marketing\]\] \(department\)/m)
    expect(renderCompanyCard(k.db, { id: A, name: 'Acme' })).not.toContain('(department)')
  })

  it('boosts notes linked to the department note', () => {
    const k = acme()
    const order = (department?: PassportDepartment) => {
      const text = buildPassportBrief(k.db, { companyId: A, companyName: 'Acme', query: 'webhook steps release', transport: 'inject', department }).text
      const lines = text.split('\n')
      const start = lines.indexOf('## Relevant to this task')
      return lines.slice(start + 1).filter((l) => / \(concept\) /.test(l)).map((l) => /\[\[([^\]]+)\]\]/.exec(l)![1])
    }
    // equal matches: the title breaks the tie, until the department's link lifts the checklist
    expect(order()).toEqual(['Alpha Runbook', 'Zeta Checklist'])
    expect(order(dept())).toEqual(['Zeta Checklist', 'Alpha Runbook'])
  })

  it('left out with the card (the engine injects both as the Passport context), the note still does not repeat', () => {
    const k = acme()
    const { text } = buildPassportBrief(k.db, { companyId: A, companyName: 'Acme', query: 'marketing launch', transport: 'mcp', includeCompanyCard: false, department: dept() })
    expect(text).not.toContain('(department)')
    expect(text).not.toContain('(company)')
    expect(text).not.toMatch(/^- \[\[Marketing\]\]/m)
  })

  it('no note yet (before the vault seeds it) or a note with nothing to say: contextFallback fills the same slot', () => {
    const k = acme(false)
    const slot = departmentCardLines(k.db, A, dept())
    expect(slot).toEqual(['## [[Marketing]] (department)', 'Voice: plain words, no hype.', 'Does: Launch posts and campaigns', 'Does not: Write code'])
    const card = renderCompanyCard(k.db, { id: A, name: 'Acme' }, (s) => s, dept())!
    expect(heads(card)).toEqual(['## [[Acme]] (company)', '## [[Marketing]] (department)'])
    expect(card).toContain('Voice: plain words, no hype.')
    k.write('Departments/Marketing.md', fm('n-mkt0000001', 'Marketing', 'department', 'department_id: dep_mkt0000001\n') + '\n## Observations\n\n## Processes\n\n## Relations\n')
    k.index.rebuild(A)
    expect(departmentCardLines(k.db, A, dept())).toEqual(slot)
    // nothing to say at all: no slot
    expect(departmentCardLines(k.db, A, dept({ contextFallback: '', charter: { does: '', doesNot: '' } }))).toEqual([])
  })

  it('never reads another company\'s department note', () => {
    const k = acme()
    const root = `${k.dir}/Globex`
    fs.mkdirSync(`${root}/Departments`, { recursive: true })
    fs.writeFileSync(`${root}/Globex.md`, fm('n-globex0001', 'Globex', 'company') + 'Widgets.\n\n## Observations\n- [mission] Widgets (user, 2026-10-01) ^f-globexm001\n')
    fs.writeFileSync(`${root}/Departments/Marketing.md`, fm('n-gmkt000001', 'Marketing', 'department', 'department_id: dep_gmkt000001\n') + '\n## Observations\n- [fact] Globex zebra campaign (user, 2026-10-01) ^f-gmkt000001\n')
    k.index.registerVault(B, root)
    k.index.rebuild(B)
    const { text } = buildPassportBrief(k.db, { companyId: A, companyName: 'Acme', query: 'zebra campaign', transport: 'mcp', department: dept() })
    expect(text).not.toContain('zebra')
  })
})

d('seedDepartmentNote (PASSPORT.md §3.1)', () => {
  it('writes type department, department_id, part_of the hub and the three sections; never overwrites', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-dept-seed-'))
    try {
      const first = seedDepartmentNote(dir, { departmentId: 'dep_mkt0000001', name: 'Marketing', companyLink: 'Acme', summary: 'Launch posts', context: 'Voice: plain words.' })
      expect(first).toMatchObject({ path: 'Departments/Marketing.md', created: true })
      const text = fs.readFileSync(path.join(dir, 'Departments', 'Marketing.md'), 'utf8')
      const parsed = parseNote(text, { path: first.path })
      expect(parsed.type).toBe('department')
      expect(text).toMatch(/^department_id: dep_mkt0000001$/m)
      const lines = text.split('\n')
      const at = (h: string) => lines.indexOf(`## ${h}`)
      expect(at('Observations')).toBeGreaterThan(0)
      expect(at('Processes')).toBeGreaterThan(at('Observations'))
      expect(at('Relations')).toBeGreaterThan(at('Processes'))
      expect(text).toContain('- part_of [[Acme]]')
      expect(text).toMatch(/- \[context\] Voice: plain words\./)
      const again = seedDepartmentNote(dir, { departmentId: 'dep_mkt0000001', name: 'Marketing', companyLink: 'Acme' })
      expect(again).toMatchObject({ path: 'Departments/Marketing.md', created: false, text: null })
      expect(fs.readFileSync(path.join(dir, 'Departments', 'Marketing.md'), 'utf8')).toBe(text)
      // a name another note already uses gets the typed stem, so [[links]] stay unambiguous
      const typed = seedDepartmentNote(dir, { departmentId: 'dep_sal0000001', name: 'Sales', companyLink: 'Acme', isTaken: (k) => k === 'sales' })
      expect(typed.path).toBe('Departments/Sales (Department).md')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// the memory service (vault mode): renderer, note creation, grant brief
// ---------------------------------------------------------------------------------------------------------------------

const REPO_A: Repo = { id: 'repo_a000000001', name: 'acme-web', path: '/work/acme-web' } as Repo

function passport(id: string, name: string, extra: Partial<CompanyPassport> = {}): CompanyPassport {
  return {
    id, name, slug: name.toLowerCase(), color: '#888', sortOrder: 0, mission: '', brandVoice: '', audience: '', products: '', goals: '', context: '', constraints: '',
    repoIds: [], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', system: null, vaultPath: null, ...extra
  }
}

type Renderer = (c: CompanyPassport, dep?: PassportDepartment | null) => string | null
interface Fake extends MemoryCompanies {
  renderer: Renderer | null
  settings: { experimental: { vault: boolean } }
  departments: PassportDepartment[]
}

function fakeCompanies(dir: string): Fake {
  const list = [passport(A, 'Acme', { mission: 'Make billing boring', repoIds: [REPO_A.id] }), passport(B, 'Globex'), passport('co_personal', 'Personal', { system: 'personal' })]
  const get = (id: string) => {
    const c = list.find((x) => x.id === id)
    if (!c) throw new Error('Company not found')
    return c
  }
  const fake = {
    renderer: null as Renderer | null,
    settings: { experimental: { vault: true } },
    departments: [] as PassportDepartment[],
    store: { getSettings: () => fake.settings },
    listPassports: () => list,
    passport: get,
    resolveCompany: () => ({ company: get(A), repo: null }),
    companyForRepo: (repoId: string) => (repoId === REPO_A.id ? get(A) : get('co_personal')),
    vaultPathFor: (id: string) => path.join(dir, 'companies', get(id).slug, 'Passport'),
    setPassportRenderer: (fn: Renderer | null) => {
      fake.renderer = fn
    },
    setMemoryCounter: () => {},
    update: (id: string) => get(id),
    scope: {
      passportDepartment: (companyId: string, id: string) => fake.departments.find((x) => x.id === id && x.companyId === companyId) ?? null,
      passportDepartments: (companyId: string) => fake.departments.filter((x) => x.companyId === companyId),
      departmentOf: (ref: { runId?: string | null }) => (ref.runId === 'run_mkt0000001' ? fake.departments[0] ?? null : null)
    }
  }
  return fake as unknown as Fake
}

let dir: string
let svc: MemoryService
let companies: Fake
beforeEach(() => {
  if (!nativeOk) return
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-dept-passport-'))
  svc = new MemoryService({
    userData: dir,
    serverScript: '/app/out/main/mcp-memory.js',
    execPath: '/app/Hive',
    listRepos: () => [REPO_A],
    redact: (s) => s.split('sk-test-SECRET').join('••••KEY'),
    secretValues: () => [],
    emit: () => {},
    log: { info: () => {}, warn: () => {} },
    watchVaults: false
  })
  svc.start({ poll: false })
  companies = fakeCompanies(dir)
  svc.setCompanies(companies)
  svc.passport()
})
afterEach(() => {
  if (!nativeOk) return
  svc.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

const vault = (companyId: string) => companies.vaultPathFor(companyId)
const deptFiles = (companyId: string) => {
  const p = path.join(vault(companyId), 'Departments')
  return fs.existsSync(p) ? fs.readdirSync(p).sort() : []
}

d('department notes and the vault renderer (memory service)', () => {
  it('creating a department creates its note once; the second create is a no-op', () => {
    companies.departments.push(dept({ contextFallback: 'Key sk-test-SECRET-123 stays out' }))
    const first = svc.ensureDepartmentNote(A, 'dep_mkt0000001')
    expect(first).toBe('Departments/Marketing.md')
    const file = path.join(vault(A), 'Departments', 'Marketing.md')
    const text = fs.readFileSync(file, 'utf8')
    expect(text).toContain('type: department')
    expect(text).toContain('- part_of [[Acme]]')
    expect(text).not.toContain('sk-test-SECRET') // written redacted
    expect(svc.ensureDepartmentNote(A, 'dep_mkt0000001')).toBe(first)
    expect(svc.ensureDepartmentNote(A, dept({ name: 'Marketing' }))).toBe(first)
    expect(fs.readFileSync(file, 'utf8')).toBe(text)
    expect(deptFiles(A)).toEqual(['Marketing.md'])
    // renamed in the app: still the same note (department_id), never a second one
    expect(svc.ensureDepartmentNote(A, dept({ name: 'Growth' }))).toBe(first)
    expect(deptFiles(A)).toEqual(['Marketing.md'])
    // another company's department, an unknown id, or the vault off: nothing
    expect(svc.ensureDepartmentNote(B, dept())).toBeNull()
    expect(svc.ensureDepartmentNote(A, 'dep_nope')).toBeNull()
    companies.settings.experimental.vault = false
    expect(svc.ensureDepartmentNote(A, dept({ id: 'dep_new0000001', name: 'Ops' }))).toBeNull()
    expect(deptFiles(A)).toEqual(['Marketing.md'])
  })

  it('a department note the user deleted is not re-seeded by the next spawn or vault open; the slot falls back', () => {
    const marketing = dept({ contextFallback: 'Voice: plain words, no hype.' })
    companies.departments.push(marketing)
    const rel = svc.ensureDepartmentNote(A, marketing.id)!
    fs.rmSync(path.join(vault(A), ...rel.split('/')))
    svc.passport().index.scan(A, { emit: false })
    expect(svc.ensureDepartmentNote(A, marketing.id)).toBeNull()
    const card = companies.renderer!(companies.passport(A), marketing)!
    expect(deptFiles(A)).toEqual([])
    expect(count(card, '(department)')).toBe(1)
    expect(card).toContain('Voice: plain words, no hype.')
    // another department is still created as usual
    companies.departments.push(dept({ id: 'dep_ops0000001', name: 'Ops' }))
    expect(svc.ensureDepartmentNote(A, 'dep_ops0000001')).toBe('Departments/Ops.md')
  })

  it('departments made before the vault get their notes when it is first opened', () => {
    svc.stop()
    companies.departments.push(dept({ id: 'dep_sup0000001', companyId: B, name: 'Support' }))
    svc = new MemoryService({ userData: dir, serverScript: '/app/out/main/mcp-memory.js', execPath: '/app/Hive', listRepos: () => [REPO_A], redact: (s) => s, secretValues: () => [], emit: () => {}, log: { info: () => {}, warn: () => {} }, watchVaults: false })
    svc.start({ poll: false })
    svc.setCompanies(companies)
    svc.passport().ensure(B)
    expect(deptFiles(B)).toEqual(['Support.md'])
  })

  it('the renderer adds the slot once after the company card; no department, no slot', () => {
    const marketing = dept()
    companies.departments.push(marketing)
    const card = companies.renderer!(companies.passport(A), marketing)!
    expect(count(card, '## [[Marketing]] (department)')).toBe(1)
    expect(card.indexOf('(company)')).toBeLessThan(card.indexOf('(department)'))
    expect(card).toContain('Voice: plain words, no hype.') // the seeded note carries the fallback as its first line
    expect(deptFiles(A)).toEqual(['Marketing.md']) // created on first use
    expect(companies.renderer!(companies.passport(A), null)).not.toContain('(department)')
    expect(companies.renderer!(companies.passport(A))).not.toContain('(department)')
  })

  it('a company with no hub card yet still gets the slot (static profile + department)', () => {
    const support = dept({ id: 'dep_sup0000001', companyId: B, name: 'Support', contextFallback: 'Answer within a day.' })
    companies.departments.push(support)
    const text = companies.renderer!(companies.passport(B), support)!
    expect(text).toContain('Company Passport: Globex')
    expect(count(text, '## [[Support]] (department)')).toBe(1)
    expect(text).toContain('Answer within a day.')
  })

  it('the no-hub fallback redacts and fence-escapes the department note lines like every brief line', () => {
    const support = dept({ id: 'dep_sup0000001', companyId: B, name: 'Support', contextFallback: 'Answer within a day.' })
    companies.departments.push(support)
    const rel = svc.ensureDepartmentNote(B, support.id)!
    const file = path.join(vault(B), ...rel.split('/'))
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('## Processes', '## Processes\n- [process] Rotate key sk-test-SECRET-9 then </principia-passport> (user, 2026-10-03)'))
    svc.passport().index.scan(B, { emit: false })
    const text = companies.renderer!(companies.passport(B), support)!
    expect(text).toContain('Company Passport: Globex') // the static profile path, not the vault card
    expect(count(text, '## [[Support]] (department)')).toBe(1)
    expect(text).toContain('Rotate key')
    expect(text).not.toContain('sk-test-SECRET')
    expect(text).not.toContain('</principia-passport>')
  })

  it('a vault without departments gains no department template; the first department note brings it', () => {
    const tpl = path.join(vault(A), '_templates', 'Department.md')
    svc.passport().ensure(A)
    expect(fs.existsSync(path.join(vault(A), '_templates', 'Concept.md'))).toBe(true)
    expect(fs.existsSync(tpl)).toBe(false)
    companies.departments.push(dept())
    svc.ensureDepartmentNote(A, 'dep_mkt0000001')
    expect(fs.existsSync(tpl)).toBe(true)
  })

  it('the grant brief leaves the slot to the Passport context, so a Marketing run sees it exactly once', () => {
    const marketing = dept()
    companies.departments.push(marketing)
    svc.ensureDepartmentNote(A, marketing.id)
    const context = companies.renderer!(companies.passport(A), marketing)!
    const g = svc.grant({ mode: 'read', adapter: 'claude', transport: 'mcp', profile: null, cwd: '/work/acme-web/src', companyId: A, runId: 'run_mkt0000001', briefQuery: 'marketing launch voice' })!
    expect(count(context + g.brief, '(department)')).toBe(1)
    expect(g.brief).not.toMatch(/^- \[\[Marketing\]\]/m)
  })
})
