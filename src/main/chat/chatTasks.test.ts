/**
 * CHAT-UI.md §8 for chat sessions: a task a chat files with company_file_task (for another department) or task_create
 * (the chat's own work) shows in that chat as the live card (its tool call), feeds the "Working on it" strip, is filed
 * once per request, and its result comes back into the chat as a notice.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../db'
import { Store } from '../db/store'
import { HookedCompanyStore } from '../company/dispatcher'
import { TaskTools } from '../company/taskTools'
import type { BoardTool } from '../company/taskToolDefs'
import type { LiveOwner } from '../../shared/engine'
import { chatTaskCard, chatTaskCards, workingStrip } from '../../shared/taskCard'
import { ChatTaskNotes, sessionOfTask } from './taskNotes'

let db: DB
let store: Store
let c: HookedCompanyStore
let dir: string
let tools: TaskTools
let notes: { sid: string; text: string }[]
let open: Set<string>

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-chattasks-'))
  db = openDatabase(path.join(dir, 'test.db'))
  store = new Store(db)
  c = new HookedCompanyStore(store)
  tools = new TaskTools({ company: () => c, enabled: () => true })
  notes = []
  open = new Set()
  const n = new ChatTaskNotes({ isSession: (id) => !!db.prepare('SELECT 1 FROM sessions WHERE id=?').get(id), note: (sid, text) => (open.has(sid) ? (notes.push({ sid, text }), true) : false) })
  c.onTaskWrite((t) => void n.onTaskWrite(t))
})
afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function world() {
  const co = c.create({ name: 'Pinecone' })
  const marketing = c.departments.save({ companyId: co.id, name: 'Marketing', data: { charter: { does: 'Campaigns and landing copy', doesNot: 'Code' } } })
  const profile = store.createProfile({ name: 'Agent', adapter: 'claude', permissionMode: 'default', secretNames: [], useApiKeyAuth: false })
  const writer = c.departments.saveAgent({ companyId: co.id, departmentId: marketing.id, kind: 'profile', refId: profile.id, name: 'Copywriter', data: { autonomy: 'manual' } })
  const chat = (id: string) => {
    db.prepare(`INSERT INTO sessions(id,title,profile_id,adapter,repo_id,cwd,status,cols,rows,started_at,artifacts_dir,log_path,company_id) VALUES(?,?,?,?,?,?,'running',80,24,?,?,?,?)`).run(id, 'Chat · Claude', profile.id, 'claude', null, dir, new Date().toISOString(), dir, dir, co.id)
    open.add(id)
    return { sessionId: id } as LiveOwner
  }
  return { co, marketing, writer, chat, profile }
}
const call = (owner: LiveOwner, tool: BoardTool, args: Record<string, unknown>, callId: string) => tools.call(tools.resolveCaller(owner), tool, args, { callId })
/** The chat's tool item as the transcript holds it: the MCP result is the tool's JSON as text. */
const toolItem = (name: string, result: unknown, at = Date.parse('2026-10-27T10:00:00.000Z')) => ({ kind: 'tool', name, status: 'ok', resultText: JSON.stringify([{ type: 'text', text: JSON.stringify(result) }]), startedAt: at })

describe('company_file_task from a chat', () => {
  it('draws the live card and the strip in that chat', () => {
    const w = world()
    const r = call(w.chat('s_ana'), 'company_file_task', { departmentKey: 'marketing', title: 'Lift UGC conversion', description: 'Check PostHog', reason: 'conversion is copy work', agent: 'Copywriter' }, 'tu_1')
    const card = chatTaskCard(toolItem('mcp__hive__company_file_task', r))!
    const t = c.listTasks(w.co.id)[0]!
    expect(card).toMatchObject({ taskId: t.id, identifier: t.identifier, title: 'Lift UGC conversion', agentId: w.writer.id, state: 'queued' })
    const strip = workingStrip(chatTaskCards([toolItem('mcp__hive__company_file_task', r)]).map((x) => ({ ...x, who: 'Julia' })), Date.parse('2026-10-27T10:02:00.000Z'))
    expect(strip!.line).toBe(`${t.identifier} is queued for Julia · 2m`)
  })

  it('files a request once: the same chat asking again, and another chat, get the first task back', () => {
    const w = world()
    const args = { departmentKey: 'marketing', title: 'Lift UGC conversion', description: 'x', reason: 'copy', agent: 'Copywriter' }
    const first = call(w.chat('s_ana'), 'company_file_task', args, 'tu_1') as { task: { identifier: string } }
    const again = call({ sessionId: 's_ana' } as LiveOwner, 'company_file_task', { ...args, title: 'Lift UGC conversion!' }, 'tu_2') as { already?: boolean; task: { identifier: string }; detail: string }
    const other = call(w.chat('s_ben'), 'company_file_task', { ...args, title: 'lift ugc conversion from posthog' }, 'tu_9') as { already?: boolean; task: { identifier: string }; detail: string }
    expect(c.listTasks(w.co.id)).toHaveLength(1)
    for (const r of [again, other]) {
      expect(r.already).toBe(true)
      expect(r.task.identifier).toBe(first.task.identifier)
      expect(r.detail).toMatch(/not filed again\. Say who is on it/)
    }
    // the repeat is not a second card
    expect(chatTaskCard(toolItem('company_file_task', again))).toBeNull()
    expect(chatTaskCards([toolItem('company_file_task', first), toolItem('company_file_task', again)])).toHaveLength(1)
    // a different request still files
    call({ sessionId: 's_ana' } as LiveOwner, 'company_file_task', { ...args, title: 'Write the autumn newsletter' }, 'tu_3')
    expect(c.listTasks(w.co.id)).toHaveLength(2)
  })

  it('posts the result back into the chat that filed it, once', () => {
    const w = world()
    const r = call(w.chat('s_ana'), 'company_file_task', { departmentKey: 'marketing', title: 'Lift UGC conversion', description: 'x', reason: 'copy', agent: 'Copywriter' }, 'tu_1') as { task: { id: string; identifier: string } }
    const t = c.task(r.task.id)
    expect(sessionOfTask(t)).toBe('s_ana')
    expect(notes).toEqual([])
    // its run: started, a report, passed (the board moves it to in review)
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO runs(id,kind,title,target_json,trigger,status,created_at,started_at,artifacts_dir,company_id,agent_id,task_id) VALUES('r_1','prompt','Run','{}','manual','running',?,?,?,?,?,?)`).run(now, now, dir, w.co.id, w.writer.id, t.id)
    c.startTask(t.id, w.profile.id, () => ({ id: 'r_1', status: 'running', companyId: w.co.id }) as never)
    expect(notes).toEqual([])
    c.patchInFlight(t.id, { report: { outcome: 'review', summary: 'Rewrote the hero; signup drop is at the upload step', evidence: [], at: now } })
    db.prepare("UPDATE runs SET status='passed' WHERE id='r_1'").run()
    c.syncRun({ id: 'r_1', status: 'passed' } as never)
    expect(c.task(t.id).status).toBe('in_review')
    expect(notes).toEqual([{ sid: 's_ana', text: `${t.identifier} is ready for your review: Rewrote the hero; signup drop is at the upload step` }])
    // approving it is the same result: no second line
    c.approve(t.id, 'Shipped')
    c.updateTask(t.id, { priority: 2 })
    expect(notes).toHaveLength(1)
  })
})

describe('task_create from a chat (the chat tracks its own work)', () => {
  it('draws the card, files a request once, and reports back when the chat moves it to review', () => {
    const w = world()
    const owner = w.chat('s_ana')
    const r = call(owner, 'task_create', { title: 'Rewrite the UGC landing hero', description: 'x' }, 'tu_1') as { task: { id: string; identifier: string } }
    expect(chatTaskCard(toolItem('mcp__hive__task_create', r))).toMatchObject({ taskId: r.task.id, identifier: r.task.identifier })
    const again = call(owner, 'task_create', { title: 'Rewrite the UGC landing hero', description: 'y' }, 'tu_2') as { already?: boolean; task: { id: string } }
    expect(again).toMatchObject({ already: true, task: { id: r.task.id } })
    expect(c.listTasks(w.co.id)).toHaveLength(1)
    expect(sessionOfTask(c.task(r.task.id))).toBe('s_ana')
    call(owner, 'task_update', { id: r.task.identifier, status: 'in_progress' }, 'tu_3')
    expect(notes).toEqual([])
    call(owner, 'task_update', { id: r.task.identifier, status: 'in_review', note: 'Built and checked' }, 'tu_4')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ sid: 's_ana', text: expect.stringMatching(new RegExp(`^${r.task.identifier} is ready for your review`)) })
  })

  it('a closed chat gets no notice (its card shows the result when it opens); a run is never a chat', () => {
    const w = world()
    const r = call(w.chat('s_ana'), 'task_create', { title: 'Rewrite the hero', description: 'x' }, 'tu_1') as { task: { id: string; identifier: string } }
    open.delete('s_ana')
    call({ sessionId: 's_ana' } as LiveOwner, 'task_update', { id: r.task.identifier, status: 'in_progress' }, 'tu_2')
    call({ sessionId: 's_ana' } as LiveOwner, 'task_update', { id: r.task.identifier, status: 'in_review' }, 'tu_3')
    expect(notes).toEqual([])
    expect(sessionOfTask({ source: 'agent', externalId: 'r_run1:tu_1' })).toBe('r_run1')
    const n = new ChatTaskNotes({ isSession: () => false, note: () => true })
    expect(n.onTaskWrite({ id: 't', identifier: 'X-1', status: 'done', source: 'agent', externalId: 'r_run1:tu_1' })).toBeNull()
    expect(sessionOfTask({ source: 'manual', externalId: 's_ana:tu' })).toBeNull()
  })
})

describe("a chat-filed task's question (CHAT-UI.md §8)", () => {
  it('is said in that chat once per ask, in full', () => {
    const said: string[] = []
    const n = new ChatTaskNotes({ isSession: () => true, note: (_sid, text) => (said.push(text), true) })
    const t = { id: 't1', identifier: 'VO-15', status: 'blocked', blockReason: 'needs_input', source: 'agent', externalId: 's_ana:tu_1', runId: 'r1', ask: { prompt: "Needs access: Can't read production rows (social_post)" } }
    expect(n.onTaskWrite(t)).toBe("VO-15 is stuck and needs you.\nI need access: Can't read production rows (social_post)\nAnswer it with Answer on the VO-15 card.")
    expect(n.onTaskWrite({ ...t, status: 'todo' })).toBeNull()
    // answered: no question; a new ask on the next run is said again
    expect(n.onTaskWrite({ ...t, status: 'todo', ask: { ...t.ask, answer: 'Use PostHog' } })).toBeNull()
    expect(n.onTaskWrite({ ...t, runId: 'r2', ask: { prompt: 'Which workspace?' } })).toContain('Which workspace?')
    expect(said).toHaveLength(2)
  })
})
