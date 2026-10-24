/** DEPARTMENTS.md §9: where a company or department chat runs, which folders it reaches, and what its brief says. */
import { describe, expect, it } from 'vitest'
import { AGENT_DATA_DEFAULTS, DEPARTMENT_DATA_DEFAULTS, type BoardTask, type CompanyAgent, type Department } from '../../shared/company'
import { CHAT_CAPS, chatBrief, chatPlacement, routingRules, type ChatContextInput } from './chatContext'

const T = '2026-10-20T10:00:00.000Z'
const dep = (id: string, key: string, name: string, does = ''): Department => ({
  id, companyId: 'co_a', key, name, color: null, icon: null, sortOrder: 0, archivedAt: null, createdAt: T, updatedAt: T,
  data: { ...DEPARTMENT_DATA_DEFAULTS, charter: { does, doesNot: '' } }
})
const agent = (id: string, departmentId: string | null, name: string, over: Partial<CompanyAgent['data']> = {}): CompanyAgent => ({
  id, companyId: 'co_a', departmentId, kind: 'profile', refId: 'p', name, archivedAt: null, pausedAt: null, createdAt: T, updatedAt: T, data: { ...AGENT_DATA_DEFAULTS, ...over }
})
const task = (n: number, departmentId: string | null, over: Partial<BoardTask> = {}): BoardTask =>
  ({ id: `task_${n}`, identifier: `PRN-${n}`, title: `Task ${n}`, status: 'todo', priority: 0, departmentId, agentId: null, updatedAt: T, companyId: 'co_a', ...over }) as BoardTask

const repos = [
  { id: 'repo_web', name: 'acme-web', path: '/Users/me/acme-web', exists: true },
  { id: 'repo_api', name: 'acme-api', path: '/Users/me/acme-api', exists: true },
  { id: 'repo_gone', name: 'old', path: '/Users/me/old', exists: false }
]
const mkt = dep('dep_m', 'marketing', 'Marketing', 'Launch posts and campaigns')
const dev = dep('dep_d', 'development', 'Development', 'Ships the app')
const base = (over: Partial<ChatContextInput> = {}): ChatContextInput => ({
  company: { id: 'co_a', name: 'Acme' },
  repos,
  departments: [mkt, dev],
  agents: [agent('agt_w', 'dep_m', 'Copywriter', { persona: { key: 'k', name: 'Ovid', personality: '', bio: '', look: { material: 'marble', hair: 'short', beard: 'none', laurel: false, drape: 'none' } } as never }), agent('agt_f', 'dep_d', 'Bug fixer', { defaultRepoId: 'repo_api' })],
  tasks: [],
  departmentId: null,
  fileTool: true,
  ...over
})

describe('chatPlacement: cwd and folders', () => {
  it('company chat: the workspace with several repos, the only repo with one; every other existing repo is an --add-dir', () => {
    const p = chatPlacement(base())
    expect(p.cwd).toBeNull()
    expect(p.addDirs).toEqual(['/Users/me/acme-web', '/Users/me/acme-api'])
    expect(p.department).toBeNull()
    const one = chatPlacement(base({ repos: [repos[0]!, repos[2]!] }))
    expect(one.cwd).toBe('/Users/me/acme-web')
    expect(one.addDirs).toEqual([])
  })

  it("department chat: the one repo its agents default to, else the company's only repo, else the workspace", () => {
    expect(chatPlacement(base({ departmentId: 'dep_d' }))).toMatchObject({ cwd: '/Users/me/acme-api', addDirs: ['/Users/me/acme-web'], department: { id: 'dep_d', key: 'development', name: 'Development' } })
    expect(chatPlacement(base({ departmentId: 'dep_m' })).cwd).toBeNull()
    const two = base({ departmentId: 'dep_d', agents: [agent('a1', 'dep_d', 'A', { defaultRepoId: 'repo_web' }), agent('a2', 'dep_d', 'B', { defaultRepoId: 'repo_api' })] })
    expect(chatPlacement(two).cwd).toBeNull()
    expect(chatPlacement({ ...two, repos: [repos[0]!] }).cwd).toBe('/Users/me/acme-web')
  })

  it("a department of another company is no department", () => {
    const foreign = { ...dep('dep_x', 'sales', 'Sales'), companyId: 'co_b' }
    expect(chatPlacement(base({ departments: [mkt, foreign], departmentId: 'dep_x' })).department).toBeNull()
  })
})

describe('chatBrief', () => {
  it('company chat: repos with paths, departments with their charter line, and the routing rules', () => {
    const b = chatBrief(base())
    expect(b).toContain('## This chat: Acme')
    expect(b).toContain("You run in Acme's workspace folder.")
    expect(b).toContain('- acme-web: /Users/me/acme-web')
    expect(b).not.toContain('/Users/me/old')
    expect(b).toContain('- Marketing (marketing): Launch posts and campaigns')
    expect(b).toContain('Do the work the founder asks for here')
    expect(b).toContain('company_file_task')
    // PROACTIVE.md §2: routing is the chat's own initiative now, deduplicated; new departments still need a yes
    expect(b).toContain('file it there yourself with company_file_task')
    expect(b).toContain('never twice')
    expect(b).toContain('No need to ask first')
    expect(b).toContain('company_create_department only after the founder says yes')
    expect(b).not.toContain('Never file or route work on your own initiative')
  })

  it('with "Agents use Principia on their own" off it keeps the passive rules', () => {
    const b = chatBrief(base({ proactive: false }))
    expect(b).toContain('Answer and do the work here in the chat by default')
    expect(b).toContain('only after the user says yes')
    expect(b).toContain('Never file or route work on your own initiative')
  })

  it("department chat: its agents (persona and role), its open tasks capped, the other departments", () => {
    const tasks = [
      task(1, 'dep_m', { status: 'in_progress', agentId: 'agt_w', title: 'Launch post' }),
      task(2, 'dep_m', { status: 'done' }),
      task(3, 'dep_d'),
      ...Array.from({ length: CHAT_CAPS.tasks + 3 }, (_, i) => task(10 + i, 'dep_m'))
    ]
    const b = chatBrief(base({ departmentId: 'dep_m', tasks }))
    expect(b).toContain('## This chat: the Marketing department of Acme')
    expect(b).toContain('### Agents in Marketing')
    expect(b).toContain('- Ovid (Copywriter)')
    expect(b).toContain(`### Open tasks in Marketing (${CHAT_CAPS.tasks + 4})`)
    expect(b.indexOf('PRN-1 Launch post · in progress · Ovid (Copywriter)')).toBeGreaterThan(0)
    expect(b).not.toContain('PRN-2 ')
    expect(b).not.toContain('PRN-3 ')
    expect(b).toContain('- and 4 more on the Board')
    expect(b).toContain('### Other departments of Acme')
    expect(b).toContain('- Development (development)')
    expect(b).toContain("another department's charter")
  })

  it('without the file tool (codex, gemini) it asks the user to file it on the Board', () => {
    expect(routingRules(false, null).join('\n')).toContain('suggest filing it on the Board')
    expect(routingRules(false, null, false).join('\n')).toContain('file it on the Board')
    expect(chatBrief(base({ fileTool: false }))).not.toContain('company_file_task')
  })
})
