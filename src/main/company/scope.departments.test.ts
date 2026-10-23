// DEPARTMENTS.md §7 on scope.ts: passportContextFor(companyId, {departmentId}) adds the department slot after the
// company card (contextFallback before the vault), a run with no department gets none, the renderer receives the
// department, and a run or session finds its department through its task.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../db'
import { Store } from '../db/store'
import { CompanyStore } from './index'
import { DepartmentStore } from './departments'
import { staticPassportRenderer } from './scope'
import { DEPARTMENT_SLOT_CHARS, departmentFallbackLines } from '../memory/departmentSlot'
import type { CompanyPassport, Department } from '../../shared/company'
import type { PassportDepartment } from '../../shared/passport'

let db: DB; let store: Store; let c: CompanyStore; let d: DepartmentStore; let dir: string
let acme: CompanyPassport; let beta: CompanyPassport; let marketing: Department
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-dept-scope-'))
  db = openDatabase(path.join(dir, 'test.db')); store = new Store(db); c = new CompanyStore(store); d = new DepartmentStore(store, c)
  acme = c.create({ name: 'Acme', mission: 'Make billing boring' }); beta = c.create({ name: 'Beta', mission: 'Bake bread' })
  marketing = d.save({ companyId: acme.id, name: 'Marketing', data: { charter: { does: 'Launch posts and campaigns', doesNot: 'Write code' }, contextFallback: 'Voice: plain words.\nNever promise dates.' } })
})
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const count = (text: string, needle: string) => text.split(needle).length - 1

describe('department slot (DEPARTMENTS.md §7)', () => {
  it('a Marketing run gets the slot once, after the company card, with contextFallback before the vault', () => {
    const text = c.scope.passportContextFor(acme.id, { departmentId: marketing.id })!
    expect(count(text, '## [[Marketing]] (department)')).toBe(1)
    expect(text.indexOf('Make billing boring')).toBeLessThan(text.indexOf('## [[Marketing]] (department)'))
    expect(text).toContain('Voice: plain words.\nNever promise dates.')
    expect(text).toContain('Does: Launch posts and campaigns')
    const slot = text.slice(text.indexOf('## [[Marketing]]'))
    expect(slot.length).toBeLessThanOrEqual(DEPARTMENT_SLOT_CHARS)
  })

  it('a run with no department, an unknown one or another company\'s gets no slot', () => {
    const plain = c.scope.passportContextFor(acme.id)!
    expect(plain).not.toContain('(department)')
    expect(c.scope.passportContextFor(acme.id, { departmentId: null })).toBe(plain)
    expect(c.scope.passportContextFor(acme.id, { departmentId: 'dep_nope' })).toBe(plain)
    const sales = d.save({ companyId: beta.id, name: 'Sales', data: { contextFallback: 'Beta secret pipeline' } })
    const leaked = c.scope.passportContextFor(acme.id, { departmentId: sales.id })!
    expect(leaked).not.toContain('Beta secret pipeline')
    expect(leaked).not.toContain('(department)')
  })

  it('passes the department to a registered renderer and falls back with the slot when it throws', () => {
    const seen: (PassportDepartment | null | undefined)[] = []
    c.scope.setPassportRenderer((co, dep) => { seen.push(dep); return `card:${co.slug}${dep ? `+${dep.name}` : ''}` })
    expect(c.scope.passportContextFor(acme.id, { departmentId: marketing.id })).toBe('card:acme+Marketing')
    expect(c.scope.passportContextFor(acme.id)).toBe('card:acme')
    expect(seen[0]).toMatchObject({ id: marketing.id, companyId: acme.id, name: 'Marketing', contextFallback: 'Voice: plain words.\nNever promise dates.' })
    expect(seen[1]).toBeNull()
    c.scope.setPassportRenderer(() => { throw new Error('vault down') })
    const fallback = c.scope.passportContextFor(acme.id, { departmentId: marketing.id })!
    expect(fallback).toContain('Make billing boring')
    expect(count(fallback, '## [[Marketing]] (department)')).toBe(1)
  })

  it('an empty department says nothing; an empty Personal profile still carries its department slot', () => {
    const empty = d.save({ companyId: acme.id, name: 'Ops' })
    expect(c.scope.passportContextFor(acme.id, { departmentId: empty.id })).not.toContain('(department)')
    const personal = c.scope.personal()
    expect(staticPassportRenderer(personal)).toBeNull()
    const dep: PassportDepartment = { id: 'dep_x', companyId: personal.id, name: 'Home', passportNote: null, contextFallback: 'Groceries on Sunday', charter: { does: '', doesNot: '' } }
    expect(staticPassportRenderer(personal, dep)).toBe('## [[Home]] (department)\nGroceries on Sunday')
  })

  it('keeps the slot within ~600 chars and titles it after the passport note once it has one', () => {
    const dep: PassportDepartment = { id: 'dep_x', companyId: acme.id, name: 'Growth', passportNote: 'Growth Team', contextFallback: 'x'.repeat(590), charter: { does: 'y'.repeat(300), doesNot: '' } }
    const lines = departmentFallbackLines(dep)
    expect(lines[0]).toBe('## [[Growth Team]] (department)')
    expect(lines.join('\n').length).toBeLessThanOrEqual(DEPARTMENT_SLOT_CHARS)
    expect(lines[1].endsWith('…')).toBe(true)
  })

  it('finds the department of a run or session through its task', () => {
    // the task row as the board writes it (the JSON is the source of truth for departmentId)
    const t = { id: 'task_dept0001' }
    db.prepare('INSERT INTO company_tasks(id, company_id, data) VALUES(?,?,?)').run(t.id, acme.id, JSON.stringify({ id: t.id, title: 'Launch post', companyId: acme.id, departmentId: marketing.id }))
    db.prepare(`INSERT INTO runs(id,kind,title,target_json,trigger,status,created_at,artifacts_dir,company_id,task_id) VALUES('run_dept0001','prompt','R','{}','manual','running',?,?,?,?)`).run(new Date().toISOString(), dir, acme.id, t.id)
    expect(c.scope.departmentOf({ runId: 'run_dept0001' })).toMatchObject({ id: marketing.id, name: 'Marketing' })
    db.prepare(`INSERT INTO sessions(id,title,profile_id,adapter,cwd,status,cols,rows,started_at,artifacts_dir,log_path,company_id,task_id) VALUES('ses_dept0001','S','prof_x','claude',?,'running',80,24,?,?,?,?,?)`).run(dir, new Date().toISOString(), dir, dir, acme.id, t.id)
    expect(c.scope.departmentOf({ sessionId: 'ses_dept0001' })?.id).toBe(marketing.id)
    expect(c.scope.departmentOf({ runId: 'run_missing' })).toBeNull()
    expect(c.scope.departmentOf({})).toBeNull()
    expect(c.scope.passportDepartments(acme.id).map((x) => x.name)).toEqual(['Marketing'])
    expect(c.scope.passportDepartments(beta.id)).toEqual([])
  })
})
