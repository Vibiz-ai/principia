/** docs/DEMO.md: the demo seed produces a user-data folder the app's own stores load. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../db'
import { Store } from '../db/store'
import { CompanyStore } from '../company'
import { ForumStore } from '../forum/store'
import { usageSummary } from '../usage/summary'
import { laneOf } from '../../shared/company'
import { parseNote } from '../../shared/vault/parse'
import { seedDemo, type DemoSeedResult } from './seedDemo'

let dir: string
let res: DemoSeedResult
let db: DB
let store: Store
let c: CompanyStore

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-demo-'))
  res = seedDemo(path.join(dir, 'ud'), { now: new Date('2026-10-28T12:00:00') })
  db = openDatabase(path.join(res.userData, 'hive.db'))
  store = new Store(db)
  c = new CompanyStore(store, { companiesRoot: path.join(res.userData, 'companies') })
})
afterAll(() => {
  db?.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('demo seed', () => {
  it('three businesses (the agency with two clients), departments on, nothing running', () => {
    const names = c.listPassports().map((p) => p.name)
    expect(names).toEqual(expect.arrayContaining(['Pinecone Coffee', 'Ledgerline', 'Brightline Studio', 'Juniper Yoga', 'Harlow Bikes']))
    expect(c.listPassports().filter((p) => p.client).map((p) => p.name).sort()).toEqual(['Harlow Bikes', 'Juniper Yoga'])
    const s = store.getSettings()
    expect(s.experimental).toMatchObject({ companies: true, vault: true, departments: true })
    expect(s.onboardingDone).toBe(true)
    for (const co of res.companies) expect(c.boardSettings(co.id).autopilot).toBe(false)
  })
  it('agents on both harnesses, and tasks across the board’s columns', () => {
    const coffee = res.companies.find((x) => x.name === 'Pinecone Coffee')!.id
    const adapters = new Set(c.departments.listAgents().map((a) => store.getProfile(a.refId)?.adapter))
    expect([...adapters].sort()).toEqual(['claude', 'codex'])
    const tasks = c.listTasks(coffee)
    expect(new Set(tasks.map((t) => t.status))).toEqual(new Set(['todo', 'in_review', 'done', 'blocked']))
    expect(tasks.some((t) => t.blockReason === 'needs_input' && t.ask)).toBe(true)
    expect(tasks.some((t) => t.blockReason === 'deps')).toBe(true)
    expect(tasks.every((t) => !!laneOf(t))).toBe(true)
    // the agent that needed Instagram hands out its connect link (Home turns it into a suggestion)
    expect(tasks.some((t) => t.report?.summary.includes(`principia://connect/instagram?company=${coffee}`))).toBe(true)
    expect(res.tasks).toBe(c.listTasks().length)
  })
  it('the SaaS has a real fixture repository inside the folder, and its routine is on', () => {
    const saas = c.listPassports().find((p) => p.name === 'Ledgerline')!
    expect(saas.repoIds).toHaveLength(1)
    const repo = store.getRepo(saas.repoIds[0]!)!
    expect(repo.path.startsWith(res.userData)).toBe(true)
    expect(fs.existsSync(path.join(repo.path, '.git'))).toBe(true)
    const sched = store.listSchedules(saas.id)
    expect(sched.map((s) => [s.name, s.enabled])).toEqual([['Open pull requests digest', true]])
    expect(store.getSettings().routines?.[saas.id]?.['repo-health']?.scheduleId).toBe(sched[0]!.id)
    // the same task-mode schedule Turn on makes: the developer's standing card, not a plain run
    expect(sched[0]!.target).toMatchObject({ mode: 'task', agentId: expect.stringMatching(/^agt_/) })
    // the fixture's tests pass on main (no broken test waiting for the first coding task)
    expect(fs.readFileSync(path.join(repo.path, 'src', 'money.js'), 'utf8')).toContain('Math.round(lines.reduce')
  })
  it('each agency company has an agent asking for a tool, and review tasks carry the drafts themselves', () => {
    const studio = c.listPassports().find((p) => p.name === 'Brightline Studio')!
    const asks = c.listTasks(studio.id).filter((t) => (t.report?.summary ?? '').includes('principia://connect/notion?company=' + studio.id))
    expect(asks).toHaveLength(1)
    const pinecone = c.listPassports().find((p) => p.name === 'Pinecone Coffee')!
    const ig = c.listTasks(pinecone.id).find((t) => t.title.startsWith('Draft three Instagram posts'))!
    expect(ig.report?.summary).toMatch(/1\. Monday: "/)
    expect(ig.report?.summary).not.toContain('{{connect:')
  })
  it('Knowledge notes parse as Passport notes', () => {
    const coffee = c.listPassports().find((p) => p.name === 'Pinecone Coffee')!
    const file = path.join(c.vaultPathFor(coffee.id), 'Products', 'Weekly Beans.md')
    const note = parseNote(fs.readFileSync(file, 'utf8'))
    expect(note).toMatchObject({ title: 'Weekly Beans', type: 'product', status: 'active' })
    expect(note.id).toMatch(/^n-/)
    expect(res.notes).toBeGreaterThanOrEqual(10)
  })
  it('agents talk on the Forum, in a thread', () => {
    const forum = new ForumStore(db, { directory: { departments: () => [], agents: () => [], ownerName: () => 'You', hasCompany: () => true } })
    const coffee = res.companies.find((x) => x.name === 'Pinecone Coffee')!.id
    const owner = forum.owner(coffee)
    const general = forum.channelByName(coffee, 'general')!
    const msgs = forum.messages(general.id, { limit: 50 })
    expect(msgs.length).toBeGreaterThanOrEqual(1)
    expect(forum.thread(msgs[0]!.id).replies.length).toBeGreaterThanOrEqual(2)
    expect(owner.name).toBe('You')
    expect(res.forumPosts).toBe(9)
  })
  it('spend rows show up in the Spend summary', () => {
    const names = (id: string) => c.listPassports().find((p) => p.id === id)?.name ?? id
    const s = usageSummary({ db, companyName: names, now: () => new Date('2026-10-28T12:00:00') }, { range: '30d' })
    expect(s.total.usd ?? 0).toBeGreaterThan(0)
    expect(s.byCompany.map((r) => r.label)).toEqual(expect.arrayContaining(['Pinecone Coffee', 'Ledgerline', 'Brightline Studio']))
  })
  it('synthetic only: no home paths or real-looking secrets in what it wrote', () => {
    const dump = JSON.stringify(c.listTasks()) + JSON.stringify(c.listPassports())
    expect(dump).not.toMatch(/\/Users\/|sk-[A-Za-z0-9]{10}|@gmail\.com/)
  })
  it('refuses a folder that already has a database', () => {
    expect(() => seedDemo(res.userData)).toThrow(/already exists/)
  })
})
