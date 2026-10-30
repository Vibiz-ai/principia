/**
 * AGENT-COLLAB.md: agents asking agents (routing, guards, visibility) and the team awareness tools.
 * In-memory db, the real ForumService + ForumResponder; runs are fake rows (the engine never starts).
 */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ForumService } from './service'
import { ForumResponder } from './responder'
import { ForumRefusal, type ForumCaller } from './agentApi'
import type { ForumDirectory } from './store'
import { collabSettings, DEFAULT_AGENT_COLLAB, type AgentCollabSettings } from '../../shared/collab'
import { estimateUsd, priceOf, costOf } from './pricing'
import { scrubSecrets, type TeamTask } from './teamTools'
import { parseForumArgs, parseForumBlocks } from './protocol'
import { parseCli } from './cli/main'

const CO = 'co_acme'
const CO2 = 'co_other'
let db: Database.Database
let clock: Date
let settings: Partial<AgentCollabSettings>
let quitting: boolean
let board: TeamTask[]
const departments = [
  { id: 'dep_mkt', key: 'marketing', name: 'Marketing', archivedAt: null },
  { id: 'dep_dev', key: 'development', name: 'Development', archivedAt: null },
  { id: 'dep_sales', key: 'sales', name: 'Sales', archivedAt: null },
  { id: 'dep_sup', key: 'support', name: 'Support', archivedAt: null }
]
const agents = [
  { id: 'agt_marcus', companyId: CO, departmentId: 'dep_mkt', name: 'Copywriter', archivedAt: null as string | null, personaName: 'Marcus' },
  { id: 'agt_livia', companyId: CO, departmentId: 'dep_dev', name: 'Bug fixer', archivedAt: null as string | null, personaName: 'Livia' },
  { id: 'agt_sergio', companyId: CO, departmentId: 'dep_sales', name: 'Closer', archivedAt: null as string | null, personaName: 'Sergio' },
  { id: 'agt_cato', companyId: CO, departmentId: 'dep_sup', name: 'Helper', archivedAt: null as string | null, personaName: 'Cato' },
  { id: 'agt_spy', companyId: CO2, departmentId: null, name: 'Spy', archivedAt: null as string | null, personaName: 'Brutus' }
]
const directory: ForumDirectory = {
  departments: (companyId) => (companyId === CO ? departments : []),
  agents: (companyId) => agents.filter((a) => a.companyId === companyId),
  ownerName: () => 'Lautaro',
  hasCompany: (id) => id === CO || id === CO2
}

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'prompt', title TEXT NOT NULL DEFAULT '', trigger TEXT NOT NULL DEFAULT 'manual', status TEXT NOT NULL DEFAULT 'running', reason TEXT, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, outcome TEXT, company_id TEXT, task_id TEXT, agent_id TEXT);
    CREATE TABLE run_steps (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL, status TEXT NOT NULL, output TEXT, error TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY, parent_id TEXT, run_id TEXT, provider TEXT NOT NULL, model TEXT, tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL, model_usage_json TEXT, started_at TEXT NOT NULL, company_id TEXT);
    CREATE TABLE company_tasks (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, company_id TEXT NOT NULL, data TEXT NOT NULL);`)
  clock = new Date('2026-10-21T10:00:00.000Z')
  n = 0
  settings = {}
  quitting = false
  board = []
  for (const a of agents) a.archivedAt = null
})
afterEach(() => db.close())

/** run ids go on across restarts (a second setup over the same db) */
let n = 0
interface Start { agentId: string; prompt: string; runId: string; reply: { messageId: string } }

/** The service with a responder that "starts" runs by inserting a run row (agent_id set, like wire.ts). */
function setup() {
  const starts: Start[] = []
  const s = new ForumService({
    db,
    directory,
    enabled: () => true,
    emit: () => undefined,
    now: () => clock,
    collabSettings: () => settings,
    quitting: () => quitting,
    board: () => board,
    company: {
      saveDepartment: () => ({ id: 'x', key: 'x', name: 'x' }),
      saveAgent: () => ({ id: 'x', name: 'x' }),
      departmentByKey: () => null,
      defaultProfile: () => null,
      profileExists: () => false,
      companyName: () => 'Acme',
      seatLabel: (agentId) => {
        const a = agents.find((x) => x.id === agentId)
        const d = departments.find((x) => x.id === a?.departmentId)
        return a ? `${a.name}${d ? `, ${d.name}` : ''}` : null
      }
    },
    seats: {
      departmentOf: (agentId) => agents.find((a) => a.id === agentId)?.departmentId ?? null,
      canAnswer: (agentId) => !agents.find((a) => a.id === agentId)?.archivedAt,
      leadOf: (companyId, depId) => agents.find((a) => a.companyId === companyId && a.departmentId === depId && !a.archivedAt)?.id ?? null
    }
  })
  const seats = (companyId: string, departmentId: string | null) => agents.filter((a) => a.companyId === companyId && !a.archivedAt && (!departmentId || a.departmentId === departmentId)).map((a) => a.id)
  const responder = new ForumResponder({
    store: () => s.store,
    enabled: () => true,
    seat: (agentId) => {
      const a = agents.find((x) => x.id === agentId)
      return a ? { id: a.id, companyId: a.companyId, departmentId: a.departmentId, name: a.name, instructions: 'Do your job.', profileId: 'prof_claude', repoId: null, active: !a.archivedAt } : null
    },
    departmentName: (id) => departments.find((d) => d.id === id)?.name ?? null,
    seats,
    start: (input) => {
      const runId = `r_wake${++n}`
      db.prepare('INSERT INTO runs (id, title, created_at, started_at, company_id, agent_id) VALUES (?,?,?,?,?,?)').run(runId, 'Forum reply', clock.toISOString(), clock.toISOString(), input.companyId, input.agentId)
      s.noteReplyRun(runId, input.reply)
      starts.push({ agentId: input.agentId, prompt: input.prompt, runId, reply: input.reply })
      return runId
    },
    journal: s.owed,
    askOf: (message, memberId) => s.askOf(message, memberId),
    onWakeStarted: (ids, runId) => s.collab.noteStarted(ids, runId),
    onWakeFailed: (ids, reason) => s.wakeFailed(ids, reason),
    onUnanswered: (messageId, memberId, reason) => s.noteUnanswered(messageId, memberId, reason),
    now: () => clock
  })
  s.onHumanPost = (m) => void responder.onHumanPost(m)
  s.collabWake = (req) => responder.wakeForAgent(req.target, req.message.companyId, req.message.id, { handle: req.asker.handle, label: null, depth: req.depth, maxHops: req.maxHops, why: req.why }, req.wakeId)
  s.store.sync(CO)
  s.store.sync(CO2)
  const caller = (agentId: string, runId: string | null = 'r_task1', over: Partial<ForumCaller> = {}): ForumCaller => ({ companyId: agents.find((a) => a.id === agentId)!.companyId, memberId: s.store.memberForAgent(agentId)!.id, runId, stepId: `st_${runId}_${agentId}`, taskId: null, ...over })
  const wakes = () => db.prepare('SELECT from_member, to_member, depth, status, refusal, via FROM forum_agent_wakes ORDER BY created_at, rowid').all() as { from_member: string; to_member: string; depth: number; status: string; refusal: string | null; via: string }[]
  const handle = (memberId: string) => s.store.member(memberId)?.handle
  return { s, responder, starts, caller, wakes, handle, member: (agentId: string) => s.store.memberForAgent(agentId)! }
}

const refusal = async (p: Promise<string>): Promise<string> => {
  try {
    await p
  } catch (e) {
    if (e instanceof ForumRefusal) return e.message
    throw e
  }
  throw new Error('expected a refusal')
}

describe('agents ask agents (forum_ask_agent)', () => {
  it('posts an ask in the target department room, wakes the target with an agent prompt, and the reply answers it', async () => {
    const { s, starts, caller, wakes, member, responder } = setup()
    const out = await s.api.call(caller('agt_marcus'), 'forum_ask_agent', { to: '@livia', question: 'Is the pricing page live?', why: 'launch email links to it', wait_s: 0 })
    expect(out).toMatch(/^open m[0-9a-z]+ #development · woke @livia \(hop 1\/3, run r_wake1\)/)
    expect(starts).toHaveLength(1)
    expect(starts[0].agentId).toBe('agt_livia')
    expect(starts[0].prompt).toMatch(/^Agent ask in #development/)
    expect(starts[0].prompt).toContain('@marcus')
    expect(starts[0].prompt).toContain('hop 1 of 3')
    expect(starts[0].prompt).toContain('Why they ask: launch email links to it')
    expect(starts[0].prompt).toContain('Never ask @marcus back')
    const ask = s.store.message(starts[0].reply.messageId)
    expect(ask).toMatchObject({ kind: 'ask', ask: { status: 'open', to: [member('agt_livia').id], taskId: null } })
    expect(wakes()).toEqual([{ from_member: member('agt_marcus').id, to_member: member('agt_livia').id, depth: 1, status: 'started', refusal: null, via: 'ask' }])
    // Livia's reply run answers with forum_reply: the ask is answered, the wake too
    const r = await s.api.call(caller('agt_livia', 'r_wake1'), 'forum_reply', { to: ask.ref, text: 'Yes, live since PRN-12 shipped.' })
    expect(r).toMatch(/answered the ask/)
    expect(s.store.message(ask.id).ask).toMatchObject({ status: 'answered', answer: 'Yes, live since PRN-12 shipped.' })
    expect(wakes()[0].status).toBe('answered')
    responder.onRunEnded('r_wake1')
  })

  it('the asker can wait for the answer inside its tool call', async () => {
    const { s, starts, caller } = setup()
    const pending = s.api.call(caller('agt_marcus'), 'forum_ask_agent', { to: 'development', question: 'Which API version do we ship?', wait_s: 5 })
    await new Promise((r) => setTimeout(r, 10))
    expect(starts).toHaveLength(1)
    const ask = s.store.message(starts[0].reply.messageId)
    await s.api.call(caller('agt_livia', starts[0].runId), 'forum_reply', { to: ask.ref, text: 'v2, behind the flag.' })
    expect(await pending).toBe(`answered ${ask.ref} by @livia: v2, behind the flag.`)
  })

  it('times out without an answer and says where it will arrive', async () => {
    const { s, caller } = setup()
    settings = { waitDefaultS: 0 }
    const out = await s.api.call(caller('agt_marcus'), 'forum_ask_agent', { to: '@livia', question: 'Status of PRN-3?', wait_s: 0 })
    expect(out).toMatch(/the answer will be in forum_read \{"thread":"m[0-9a-z]+"\} and your next brief/)
  })

  it('a woken agent that ends without replying still answers the ask with its final output', async () => {
    const { s, starts, caller } = setup()
    await s.api.call(caller('agt_marcus'), 'forum_ask_agent', { to: '@livia', question: 'Is staging up?', wait_s: 0 })
    const ask = s.store.message(starts[0].reply.messageId)
    await s.harvest({ runId: starts[0].runId, stepId: 'st_x', adapter: 'claude', status: 'passed', output: 'Staging is up; deploy at 09:00.', companyId: CO })
    expect(s.store.message(ask.id).ask).toMatchObject({ status: 'answered', answer: 'Staging is up; deploy at 09:00.' })
  })

  it('forum_ask to agents only takes the agent path (no task park, wakes them)', async () => {
    const { s, starts, caller } = setup()
    const out = await s.api.call(caller('agt_marcus', 'r_task1', { taskId: 'task_1' }), 'forum_ask', { question: 'Can you review the copy?', to: ['@sergio'] })
    expect(out).toMatch(/woke @sergio/)
    expect(out).not.toMatch(/parked/)
    expect(starts[0].agentId).toBe('agt_sergio')
  })

  it('refuses people, unknown targets and yourself, before posting anything', async () => {
    const { s, caller } = setup()
    const before = (db.prepare('SELECT COUNT(*) AS n FROM forum_messages').get() as { n: number }).n
    expect(await refusal(s.api.call(caller('agt_marcus'), 'forum_ask_agent', { to: '@lautaro', question: 'hello?' }))).toMatch(/is a person; ask people with forum_ask/)
    expect(await refusal(s.api.call(caller('agt_marcus'), 'forum_ask_agent', { to: '@nobody', question: 'hello?' }))).toMatch(/No agent or department @nobody/)
    expect(await refusal(s.api.call(caller('agt_marcus'), 'forum_ask_agent', { to: '@marcus', question: 'hello?' }))).toMatch(/cannot ask yourself/)
    expect(await refusal(s.api.call(caller('agt_marcus'), 'forum_ask_agent', { to: '@brutus', question: 'hello?' }))).toMatch(/No agent or department/)
    expect((db.prepare('SELECT COUNT(*) AS n FROM forum_messages').get() as { n: number }).n).toBe(before)
  })
})

describe('loop safety (guards)', () => {
  it('cycle: a woken agent cannot wake its asker back; depth grows along the chain; hops cap the chain', async () => {
    const { s, starts, caller, wakes } = setup()
    settings = { maxHops: 3, waitDefaultS: 0 }
    await s.api.call(caller('agt_marcus'), 'forum_ask_agent', { to: '@livia', question: 'q1?' })
    // Livia (r_wake1) asks Marcus back: cycle
    expect(await refusal(s.api.call(caller('agt_livia', 'r_wake1'), 'forum_ask_agent', { to: '@marcus', question: 'what for?' }))).toMatch(/already in this conversation/)
    // Livia asks Sergio: hop 2; Sergio asks Cato: hop 3
    expect(await s.api.call(caller('agt_livia', 'r_wake1'), 'forum_ask_agent', { to: '@sergio', question: 'q2?' })).toMatch(/hop 2\/3/)
    expect(await s.api.call(caller('agt_sergio', starts[1].runId), 'forum_ask_agent', { to: '@cato', question: 'q3?' })).toMatch(/hop 3\/3/)
    expect(starts[2].prompt).toContain('This conversation has no hops left')
    // Cato asks Livia: cycle (Livia is in the chain); a fresh agent would be hop 4: refused by hops
    expect(await refusal(s.api.call(caller('agt_cato', starts[2].runId), 'forum_ask_agent', { to: '@livia', question: 'q4?' }))).toMatch(/already in this conversation/)
    agents.push({ id: 'agt_nora', companyId: CO, departmentId: 'dep_mkt', name: 'Analyst', archivedAt: null, personaName: 'Nora' })
    s.store.sync(CO)
    expect(await refusal(s.api.call(caller('agt_cato', starts[2].runId), 'forum_ask_agent', { to: '@nora', question: 'q4?' }))).toMatch(/3 hops deep \(limit 3\)/)
    agents.pop()
    expect(wakes().map((w) => [w.depth, w.status, w.refusal])).toEqual([
      [1, 'started', null],
      [2, 'refused', 'cycle'],
      [2, 'started', null],
      [3, 'started', null],
      [4, 'refused', 'cycle'],
      [4, 'refused', 'hops']
    ])
    expect(starts).toHaveLength(3)
  })

  it('per-thread, per-target, per-asker and per-company caps; the hourly ones reset', async () => {
    const { s, caller, wakes, responder, starts } = setup()
    settings = { perAgentPerHour: 2, perAskerPerHour: 3, perCompanyPerDay: 5, waitDefaultS: 0 }
    const ask = (from: string, to: string, run = 'r_task1') => s.api.call(caller(from, run), 'forum_ask_agent', { to, question: 'status?' })
    // the target answers (an agent has at most 3 open asks) and its reply run ends
    const end = async () => {
      const st = starts[starts.length - 1]
      await s.api.call(caller(st.agentId, st.runId), 'forum_reply', { to: s.store.message(st.reply.messageId).ref, text: 'fine' })
      responder.onRunEnded(st.runId)
    }
    await ask('agt_marcus', '@livia')
    await end()
    await ask('agt_sergio', '@livia')
    await end()
    expect(await refusal(ask('agt_cato', '@livia'))).toMatch(/@livia was asked by agents 2 times in the last hour/)
    await ask('agt_marcus', '@sergio')
    await end()
    await ask('agt_marcus', '@cato')
    await end()
    expect(await refusal(ask('agt_marcus', '@sergio'))).toMatch(/you asked agents 3 times in the last hour/)
    clock = new Date(clock.getTime() + 3601_000)
    await ask('agt_marcus', '@livia')
    await end()
    // 5 wakes in 24 h: the company cap
    expect(await refusal(ask('agt_sergio', '@cato'))).toMatch(/used its 5 agent-to-agent wakes/)
    expect(wakes().filter((w) => w.status === 'refused').map((w) => w.refusal)).toEqual(['target_cap', 'asker_cap', 'company_cap'])
    const usage = s.collab.usage(CO)
    expect(usage).toMatchObject({ wakesToday: 5, refusedToday: 3, capPerDay: 5 })
  })

  it('per-thread cap counts mentions in one thread', async () => {
    const { s, caller, member, responder, starts } = setup()
    settings = { perThread: 2 }
    const g = s.store.channelByName(CO, 'general')!
    const root = s.store.post(member('agt_marcus').id, { channelId: g.id, text: 'Launch plan thread' })
    const reply = (from: string, text: string) => s.api.call(caller(from), 'forum_reply', { to: root.ref, text })
    expect(await reply('agt_marcus', '@livia can you check the deploy?')).toMatch(/woke @livia/)
    responder.onRunEnded(starts[0].runId)
    expect(await reply('agt_marcus', '@sergio pricing ok?')).toMatch(/woke @sergio/)
    expect(await reply('agt_marcus', '@cato any tickets?')).toMatch(/@cato not woken: this thread already woke agents 2 times/)
  })

  it('a mention of the asker in a reply is skipped silently; plain agent posts never wake anyone', async () => {
    const { s, caller, wakes, starts } = setup()
    await s.api.call(caller('agt_marcus'), 'forum_ask_agent', { to: '@livia', question: 'status?', wait_s: 0 })
    const ask = s.store.message(starts[0].reply.messageId)
    const r = await s.api.call(caller('agt_livia', 'r_wake1'), 'forum_reply', { to: ask.ref, text: '@marcus done, see PRN-4' })
    expect(r).toMatch(/@marcus is in this conversation \(not woken again\)/)
    expect(wakes()).toHaveLength(1)
    await s.api.call(caller('agt_sergio'), 'forum_post', { channel: '#general', text: 'Weekly numbers are in.' })
    expect(wakes()).toHaveLength(1)
    expect(starts).toHaveLength(1)
  })

  it('crediting an agent this run already asked does not wake it again (found in a live haiku run)', async () => {
    const { s, caller, wakes, starts } = setup()
    settings = { waitDefaultS: 0 }
    await s.api.call(caller('agt_marcus', 'r_reply_h'), 'forum_ask_agent', { to: '@livia', question: 'Which version ships PDF export?' })
    const g = s.store.channelByName(CO, 'marketing')!
    const root = s.store.post(s.store.owner(CO).id, { channelId: g.id, text: 'draft the blurb' })
    // a handle inside a sentence is a reference: no wake at all
    const r = await s.api.call(caller('agt_marcus', 'r_reply_h'), 'forum_reply', { to: root.ref, text: 'Blurb, based on Development (@livia): …' })
    expect(r).not.toMatch(/livia/)
    // addressed to her, but this run already asked her
    const r2 = await s.api.call(caller('agt_marcus', 'r_reply_h'), 'forum_reply', { to: root.ref, text: '@livia thanks, using your numbers.' })
    expect(r2).toMatch(/@livia already answered you in this run/)
    // a status report naming agents mid-sentence wakes no one (found in a live haiku run)
    await s.api.call(caller('agt_sergio', 'r_report'), 'forum_post', { channel: '#general', text: 'By agent: @livia 2 runs $0.02, @marcus 2 runs $0.01.' })
    expect(wakes()).toHaveLength(1)
    expect(starts).toHaveLength(1)
    // another run may still ask her
    expect(await s.api.call(caller('agt_marcus', 'r_other'), 'forum_post', { channel: '#general', text: '@livia one more question: is v2.3 stable?' })).toMatch(/woke @livia|queued/)
  })

  it('@department mention wakes its lead only; self mentions never wake', async () => {
    const { s, caller, starts } = setup()
    agents.push({ id: 'agt_quintus', companyId: CO, departmentId: 'dep_dev', name: 'Reviewer', archivedAt: null, personaName: 'Quintus' })
    s.store.sync(CO)
    const out = await s.api.call(caller('agt_marcus'), 'forum_post', { channel: '#general', text: '@development is the API stable? cc @marcus' })
    expect(out).toMatch(/woke @livia/)
    expect(out).not.toMatch(/quintus/)
    expect(starts.map((x) => x.agentId)).toEqual(['agt_livia'])
    agents.pop()
  })

  it('off: nothing an agent writes wakes another agent; asks are refused with the reason', async () => {
    const { s, caller, starts } = setup()
    settings = { enabled: false }
    expect(await refusal(s.api.call(caller('agt_marcus'), 'forum_ask_agent', { to: '@livia', question: 'status?' }))).toMatch(/agent-to-agent asks are off/)
    expect(await s.api.call(caller('agt_marcus'), 'forum_post', { channel: '#general', text: '@livia hi' })).not.toMatch(/woke/)
    expect(starts).toHaveLength(0)
  })

  it('a paused or archived target cannot be woken', async () => {
    const { s, caller } = setup()
    agents[1].archivedAt = '2026-10-20T00:00:00.000Z'
    expect(await refusal(s.api.call(caller('agt_marcus'), 'forum_ask_agent', { to: '@livia', question: 'status?' }))).toMatch(/cannot answer now|No agent/)
  })

  it('a busy target queues the ask and starts it when its current reply ends', async () => {
    const { s, caller, responder, starts, wakes, member } = setup()
    const owner = s.store.owner(CO)
    responder.onHumanPost(s.store.post(owner.id, { channelId: s.store.channelByName(CO, 'development')!.id, text: 'hi livia' }))
    expect(starts).toHaveLength(1)
    const out = await s.api.call(caller('agt_marcus'), 'forum_ask_agent', { to: '@livia', question: 'status?', wait_s: 0 })
    expect(out).toMatch(/@livia is answering something else; queued/)
    expect(wakes()[0].status).toBe('queued')
    responder.onRunEnded(starts[0].runId)
    expect(starts).toHaveLength(2)
    expect(starts[1].prompt).toMatch(/^Agent ask in/)
    expect(db.prepare('SELECT status, to_run FROM forum_agent_wakes').get()).toEqual({ status: 'started', to_run: starts[1].runId })
    expect(member('agt_livia')).toBeTruthy()
  })

  it('people still wake agents exactly as before', () => {
    const { s, starts } = setup()
    const owner = s.store.owner(CO)
    s.humanPosted(s.store.post(owner.id, { channelId: s.store.channelByName(CO, 'marketing')!.id, text: 'ciao' }))
    expect(starts.map((x) => x.agentId)).toEqual(['agt_marcus'])
    expect(starts[0].prompt).toMatch(/^Forum reply in #marketing/)
  })
})

describe('visibility (Agent talk panel, Run view)', () => {
  it('collab.state groups wakes by thread with who, why, depth and cost; forRun shows the conversation', async () => {
    const { s, caller, starts, member } = setup()
    settings = { waitDefaultS: 0 }
    await s.api.call(caller('agt_marcus', 'r_task1'), 'forum_ask_agent', { to: '@livia', question: 'Is the pricing page live?', why: 'launch email' })
    const ask = s.store.message(starts[0].reply.messageId)
    db.prepare("INSERT INTO run_steps VALUES ('st_w1','r_wake1',1,'passed','Yes',NULL)").run()
    await s.api.call(caller('agt_livia', 'r_wake1', { stepId: 'st_w1' }), 'forum_reply', { to: ask.ref, text: 'Yes.' })
    db.prepare("INSERT INTO agents VALUES ('ag1',NULL,'r_wake1','claude','claude-haiku-5-5',10000,2000,0.0123,NULL,?,?)").run(clock.toISOString(), CO)
    const st = s.collabState(CO)
    expect(st.settings).toEqual({ ...DEFAULT_AGENT_COLLAB, waitDefaultS: 0 })
    expect(st.threads).toHaveLength(1)
    expect(st.threads[0]).toMatchObject({ threadMessageId: ask.id, maxDepth: 1, costUsd: 0.0123, costEstimated: false })
    expect(st.threads[0].wakes[0]).toMatchObject({ fromMemberId: member('agt_marcus').id, toMemberId: member('agt_livia').id, why: 'launch email', status: 'answered', toRunId: 'r_wake1', fromRunId: 'r_task1' })
    const asked = s.runConversation('r_task1')
    expect(asked.asked).toHaveLength(1)
    expect(asked.messages.map((m) => m.text)).toEqual(['@livia Is the pricing page live?\n(why: launch email)', 'Yes.'])
    const answered = s.runConversation('r_wake1')
    expect(answered.answered?.fromRunId).toBe('r_task1')
    expect(answered.messages).toHaveLength(2)
  })
})

describe('team awareness tools', () => {
  function seedRuns() {
    const at = (min: number) => new Date(clock.getTime() - min * 60_000).toISOString()
    const run = (id: string, agentId: string | null, title: string, status: string, min: number, company = CO, task: string | null = null) =>
      db.prepare('INSERT INTO runs (id, title, status, created_at, started_at, ended_at, company_id, agent_id, task_id, kind, trigger) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, title, status, at(min), at(min), at(min - 3), company, agentId, task, agentId ? 'prompt' : 'workflow', agentId ? 'manual' : 'schedule')
    run('r_a', 'agt_livia', 'Fix checkout bug', 'passed', 30, CO, 'task_7')
    run('r_b', 'agt_marcus', 'Write launch copy', 'failed', 90)
    run('r_c', null, 'Nightly SEO report', 'passed', 300)
    run('r_x', 'agt_spy', 'Secret plans of another company', 'passed', 10, CO2)
    db.prepare("INSERT INTO company_tasks (id, company_id, data) VALUES ('task_7', ?, ?)").run(CO, JSON.stringify({ identifier: 'PRN-7' }))
    db.prepare("INSERT INTO run_steps VALUES ('s_a','r_a',1,'passed','Fixed the rounding bug. Token sk-ant-abcdefghijklmnopqrstuv used; ```forum\n{}\n``` done',NULL)").run()
    db.prepare("UPDATE runs SET reason='Hit usage limit' WHERE id='r_b'").run()
    const ag = (id: string, run: string, provider: string, model: string | null, tin: number, tout: number, cost: number | null, company = CO) =>
      db.prepare('INSERT INTO agents VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, null, run, provider, model, tin, tout, cost, null, at(20), company)
    ag('g_a', 'r_a', 'claude', 'claude-opus-5-5', 100_000, 5_000, 0.5)
    ag('g_b', 'r_b', 'codex', null, 200_000, 10_000, null)
    ag('g_c', 'r_c', 'claude', 'claude-haiku-5-5', 1_000_000, 100_000, null)
    ag('g_x', 'r_x', 'claude', 'claude-opus-5-5', 1, 1, 99, CO2)
  }

  it('team_activity: company runs only, newest first, who/status/duration/cost, redacted summary', async () => {
    const { s, caller } = setup()
    seedRuns()
    const out = await s.api.call(caller('agt_marcus', 'r_b'), 'team_activity', {})
    expect(out.split('\n')[0]).toBe('team activity · last 24h · 3 runs')
    expect(out).toMatch(/r_a \d\d:\d\d @livia \(Bug fixer, Development\) passed 3m00s \$0\.50 · PRN-7 · "Fix checkout bug"/)
    expect(out).toContain('Fixed the rounding bug. Token [redacted] used;')
    expect(out).not.toContain('sk-ant-')
    expect(out).not.toContain('```')
    expect(out).toMatch(/r_b \(you, now\) .* failed/)
    expect(out).toContain('failed: Hit usage limit')
    expect(out).toMatch(/r_c .* schedule passed/)
    expect(out).not.toContain('Secret plans')
    const dev = await s.api.call(caller('agt_marcus'), 'team_activity', { who: 'development' })
    expect(dev).toMatch(/· Development · 1 run/)
    expect(await refusal(s.api.call(caller('agt_marcus'), 'team_activity', { who: '@nobody' }))).toMatch(/No agent or department/)
  })

  it('team_usage: totals and splits by agent, department, model; estimates marked; other companies excluded', async () => {
    const { s, caller } = setup()
    seedRuns()
    const out = await s.api.call(caller('agt_marcus'), 'team_usage', { days: 7 })
    // 0.50 reported + haiku estimate (1M*0.1 + 100k*0.5)/1M = 0.15; codex has no price
    expect(out.split('\n')[0]).toBe('team usage · last 7 days · Acme · 3 runs 1.4M tok ~$0.65')
    expect(out).toMatch(/by agent: .*@livia \(Bug fixer, Development\) 1 run 105k tok \$0\.50/)
    expect(out).toMatch(/workflows and chats \(no seat\) 1 run 1\.1M tok ~\$0\.15/)
    expect(out).toMatch(/@marcus \(Copywriter, Marketing\) 1 run 210k tok \$\?/)
    expect(out).toMatch(/by department: Development 1 run 105k tok \$0\.50/)
    expect(out).toMatch(/by model: claude-opus-5-5 .* \$0\.50 · claude-haiku-5-5 .* ~\$0\.15 · codex \(model not reported\) 1 run 210k tok \$\?/)
    expect(out).toMatch(/agent conversations \(24h\): 0 of 40 wakes used/)
    expect(out).toContain('Anthropic API list prices')
    expect(out).not.toContain('99')
  })

  it('team_board: open tasks by default, sorted, with assignee and block reason', async () => {
    const { s, caller } = setup()
    board = [
      { identifier: 'PRN-1', title: 'Ship pricing', status: 'done', blockReason: null, agentId: 'agt_livia', departmentId: 'dep_dev', priority: 2, updatedAt: '2026-10-20T00:00:00Z' },
      { identifier: 'PRN-2', title: 'Launch email', status: 'blocked', blockReason: 'needs_input', agentId: 'agt_marcus', departmentId: 'dep_mkt', priority: 1, updatedAt: '2026-10-20T00:00:00Z' },
      { identifier: 'PRN-3', title: 'Fix login', status: 'in_progress', blockReason: null, agentId: 'agt_livia', departmentId: 'dep_dev', priority: 3, updatedAt: '2026-10-21T00:00:00Z' },
      { identifier: 'PRN-4', title: 'Triage tickets', status: 'todo', blockReason: null, agentId: null, departmentId: 'dep_sup', priority: 0, updatedAt: '2026-10-21T00:00:00Z' }
    ]
    const out = await s.api.call(caller('agt_marcus'), 'team_board', {})
    expect(out.split('\n')).toEqual([
      'team board · 3 tasks (1 in_progress, 1 blocked, 1 todo)',
      '- PRN-3 in_progress @livia (Bug fixer, Development) · "Fix login"',
      '- PRN-2 blocked(needs_input) @marcus (Copywriter, Marketing) · "Launch email"',
      '- PRN-4 todo Support (unassigned) · "Triage tickets"'
    ])
    expect(await s.api.call(caller('agt_marcus'), 'team_board', { who: '@livia', all: true })).toMatch(/2 tasks/)
  })

  it('team tools are reads: no rate limit on posts, no Forum write', async () => {
    const { s, caller } = setup()
    for (let i = 0; i < 15; i++) await s.api.call(caller('agt_marcus'), 'team_board', {})
    expect((db.prepare('SELECT COUNT(*) AS n FROM forum_messages').get() as { n: number }).n).toBe(0)
  })
})

describe('protocol, pricing, settings', () => {
  it('validates the new tools and parses the fenced ask_agent op and the CLI', () => {
    expect(() => parseForumArgs('forum_ask_agent', { to: '@x', question: 'hi?', extra: 1 })).toThrow(/Invalid arguments/)
    expect(() => parseForumArgs('team_usage', { days: 31 })).toThrow()
    expect(parseForumBlocks('```forum\n{"op":"ask_agent","to":"@livia","question":"status?"}\n```').ops).toEqual([{ tool: 'forum_ask_agent', args: { to: '@livia', question: 'status?' } }])
    expect(parseForumBlocks('```forum\n{"op":"team_usage"}\n```').errors).toEqual(['unknown forum op "team_usage"'])
    expect(parseCli(['ask-agent', '@livia', 'is', 'it', 'live?', '--wait', '30'])).toEqual(['forum_ask_agent', { to: '@livia', question: 'is it live?', wait_s: 30 }])
    expect(parseCli(['usage', 'development', '--days', '3'])).toEqual(['team_usage', { who: 'development', days: 3 }])
  })

  it('prices: longest prefix, reported cost wins, unknown models have no dollar figure', () => {
    expect(priceOf('claude-opus-5-5[1m]')).toEqual({ inPerM: 4, outPerM: 20 })
    expect(priceOf('claude-opus-5')).toEqual({ inPerM: 5, outPerM: 25 })
    expect(priceOf('gpt-5-codex')).toBeNull()
    expect(estimateUsd('claude-haiku-5-5', 1_000_000, 1_000_000)).toBeCloseTo(0.6)
    expect(costOf({ model: 'claude-opus-5-5', tokensIn: 1, tokensOut: 1, costUsd: 2 })).toEqual({ usd: 2, estimated: false })
    expect(costOf({ model: 'gpt-5', tokensIn: 10, tokensOut: 10, costUsd: null })).toEqual({ usd: null, estimated: false })
  })

  it('collabSettings clamps and fills defaults', () => {
    expect(collabSettings(undefined)).toEqual(DEFAULT_AGENT_COLLAB)
    expect(collabSettings({ maxHops: 99, perThread: 0, waitDefaultS: 500, waitMaxS: 100, enabled: false })).toMatchObject({ maxHops: 6, perThread: 1, waitDefaultS: 100, waitMaxS: 100, enabled: false })
  })

  it('scrubs secret shapes', () => {
    expect(scrubSecrets('key sk-ant-api03-abcdefghijklmnop and ghp_abcdefghijklmnopqrstuvwxyz123 and password=hunter2hunter2')).toBe('key [redacted] and [redacted] and [redacted]')
  })
})

describe('an agent is never left waiting by a quit (AGENT-COLLAB.md)', () => {
  const ask = async (a: ReturnType<typeof setup>) => {
    await a.s.api.call(a.caller('agt_marcus'), 'forum_ask_agent', { to: '@livia', question: 'Is the pricing page live?', wait_s: 0 })
    return a.s.store.openAsks(CO)[0]!
  }

  it('a quit cuts off the reply: the next boot asks again, and the ask keeps its asker and hop', async () => {
    const before = setup()
    const card = await ask(before)
    const after = setup()
    after.responder.recover()
    expect(after.starts.map((x) => x.reply.messageId)).toEqual([card.id])
    expect(after.starts[0]!.prompt).toMatch(/^Agent ask in #development/)
    expect(after.starts[0]!.prompt).toContain('hop 1 of 3')
    expect(after.wakes()[0]!.status).toBe('started')
    await after.s.api.call(after.caller('agt_livia', after.starts[0]!.runId), 'forum_reply', { to: card.ref, text: 'Yes, it is live.' })
    expect(after.s.store.message(card.id).ask).toMatchObject({ status: 'answered', answer: 'Yes, it is live.' })
  })

  it('a second quit: the ask closes with why, so the asker stops waiting and its open-ask slot frees up', async () => {
    const first = setup()
    const card = await ask(first)
    setup().responder.recover()
    const third = setup()
    third.responder.recover()
    expect(third.starts).toEqual([])
    expect(third.s.store.message(card.id).ask).toMatchObject({ status: 'answered', answer: expect.stringContaining('could not answer') })
    expect(third.s.store.openAsks(CO)).toEqual([])
    expect(third.wakes()[0]).toMatchObject({ status: 'refused', refusal: 'start_failed' })
    expect(third.s.owed.all()).toEqual([])
  })

  it('an ask older than a day is not answered late: it closes with why', async () => {
    const first = setup()
    const card = await ask(first)
    clock = new Date(clock.getTime() + 25 * 3600_000)
    const after = setup()
    after.responder.recover()
    expect(after.starts).toEqual([])
    expect(after.s.store.message(card.id).ask?.status).toBe('answered')
  })

  it('an ask answered before the quit is not asked again', async () => {
    const first = setup()
    const card = await ask(first)
    await first.s.api.call(first.caller('agt_livia', 'r_wake1'), 'forum_reply', { to: card.ref, text: 'Yes.' })
    const after = setup()
    after.responder.recover()
    expect(after.starts).toEqual([])
    expect(after.s.owed.all()).toEqual([])
  })

  it('an ask still queued behind a reply comes back too', async () => {
    const before = setup()
    const owner = before.s.store.owner(CO)
    const room = before.s.store.channelByName(CO, 'development')!
    before.responder.onHumanPost(before.s.store.post(owner.id, { channelId: room.id, text: 'hello', threadId: null }))
    const card = await ask(before)
    expect(before.wakes()[0]!.status).toBe('queued')
    const after = setup()
    after.responder.recover()
    expect(after.starts).toHaveLength(1)
    after.responder.onRunEnded(after.starts[0]!.runId)
    expect(after.starts.map((x) => x.reply.messageId)).toContain(card.id)
  })

  it('an ask to two agents stays open while the other can still answer', async () => {
    const a = setup()
    await a.s.api.call(a.caller('agt_marcus'), 'forum_ask', { to: ['@livia', '@cato'], question: 'Anyone there?' })
    const card = a.s.store.openAsks(CO)[0]!
    const ids = (db.prepare('SELECT id FROM forum_agent_wakes ORDER BY rowid').all() as { id: string }[]).map((r) => r.id)
    expect(ids).toHaveLength(2)
    a.s.wakeFailed(ids.slice(0, 1), 'it could not start')
    expect(a.s.store.message(card.id).ask?.status).toBe('open')
    a.s.wakeFailed(ids.slice(1), 'it could not start')
    expect(a.s.store.message(card.id).ask?.status).toBe('answered')
  })
})

describe('a reply run to an agent that ends without an answer', () => {
  const asked = async () => {
    const a = setup()
    await a.s.api.call(a.caller('agt_marcus'), 'forum_ask_agent', { to: '@livia', question: 'Is staging up?', wait_s: 0 })
    const card = a.s.store.openAsks(CO)[0]!
    return { ...a, card, runId: a.starts[0]!.runId }
  }

  it.each([
    ['failed', 'Timed out after 15 min', 'Timed out after 15 min'],
    ['canceled', 'Canceled', 'its run was canceled'],
    ['passed', null, 'it ended without an answer']
  ])('%s: the ask closes with why, and the wake stops waiting', async (status, reason, why) => {
    const a = await asked()
    await a.s.harvest({ runId: a.runId, stepId: 'st_x', adapter: 'claude', status, output: '', companyId: CO })
    a.s.settleReply(a.runId, status, reason)
    expect(a.s.store.message(a.card.id).ask).toMatchObject({ status: 'answered', noAnswer: true, answer: expect.stringContaining(why) })
    expect(a.wakes()[0]).toMatchObject({ status: 'refused', refusal: 'start_failed' })
    // run hooks fire more than once for one run
    a.s.settleReply(a.runId, status, reason)
    expect(a.s.store.message(a.card.id).ask?.answer).toContain(why)
  })

  it('a woken agent that only posted elsewhere did not answer: its asker stops waiting too', async () => {
    const a = await asked()
    const output = 'Looked.\n```forum\n{"op":"post","channel":"#general","text":"Looking at staging."}\n```'
    expect(await a.s.harvest({ runId: a.runId, stepId: 'st_x', adapter: 'claude', status: 'passed', output, companyId: CO })).toBe(1)
    a.s.settleReply(a.runId, 'passed', null)
    expect(a.s.store.message(a.card.id).ask).toMatchObject({ status: 'answered', noAnswer: true })
  })

  it('the final answer of a reply run is never deferred: the run report path cannot lose it to the close', async () => {
    const a = await asked()
    a.s.deferAutoPost = () => true
    await a.s.harvest({ runId: a.runId, stepId: 'st_x', adapter: 'claude', status: 'passed', output: 'Staging is up.', companyId: CO })
    a.s.settleReply(a.runId, 'passed', null)
    const ask = a.s.store.message(a.card.id).ask
    expect(ask).toMatchObject({ status: 'answered', answer: 'Staging is up.' })
    expect(ask?.noAnswer).toBeFalsy()
    expect(a.wakes()[0]!.status).toBe('answered')
  })

  it('a quit keeps it open: the next boot asks again', async () => {
    quitting = true
    const a = await asked()
    a.s.settleReply(a.runId, 'canceled', 'Canceled')
    expect(a.s.store.message(a.card.id).ask?.status).toBe('open')
    expect(a.wakes()[0]!.status).toBe('started')
  })

  it('a late reply replaces the close, once; an answer after that is refused as before', async () => {
    const a = await asked()
    a.s.settleReply(a.runId, 'failed', 'Timed out')
    const out = await a.s.api.call(a.caller('agt_livia', 'r_later'), 'forum_reply', { to: a.card.ref, text: 'Staging is up after all.' })
    expect(out).toMatch(/answered the ask/)
    const ask = a.s.store.message(a.card.id).ask
    expect(ask).toMatchObject({ status: 'answered', answer: 'Staging is up after all.', answeredBy: a.member('agt_livia').id })
    expect(ask?.noAnswer).toBeFalsy()
    expect(a.wakes()[0]!.status).toBe('answered')
    expect(() => a.s.answer(a.card.id, a.member('agt_livia').id, 'Again.')).toThrow(/already answered/)
  })

  it('a person can still answer it, and the wake of the run that ended stays as it was', async () => {
    const a = await asked()
    a.s.settleReply(a.runId, 'failed', 'Timed out')
    const owner = a.s.store.owner(CO)
    a.s.answer(a.card.id, owner.id, 'Yes, I checked.')
    expect(a.s.store.message(a.card.id).ask).toMatchObject({ answer: 'Yes, I checked.', answeredBy: owner.id })
    expect(a.wakes()[0]!.status).toBe('refused')
  })

  it('a late harvest of the same run still answers', async () => {
    const a = await asked()
    a.s.settleReply(a.runId, 'passed', null)
    await a.s.harvest({ runId: a.runId, stepId: 'st_x', adapter: 'claude', status: 'passed', output: 'Staging is up.', companyId: CO })
    expect(a.s.store.message(a.card.id).ask).toMatchObject({ answer: 'Staging is up.' })
  })

  it('a question by @mention reaches the asker with why, then with the late reply', async () => {
    const a = setup()
    const room = a.s.store.channelByName(CO, 'development')!
    const replied: string[] = []
    a.s.collab.onReplied = (e) => void replied.push(e.text)
    await a.s.api.call(a.caller('agt_marcus'), 'forum_post', { channel: `#${room.name}`, text: '@livia is staging up?' })
    const runId = a.starts[0]!.runId
    a.s.settleReply(runId, 'failed', 'Timed out')
    expect(replied).toEqual([expect.stringContaining('could not answer')])
    await a.s.api.call(a.caller('agt_livia', 'r_later'), 'forum_reply', { to: a.s.store.message(a.starts[0]!.reply.messageId).ref, text: 'Yes, it is up.' })
    expect(replied[1]).toBe('Yes, it is up.')
    expect(a.wakes()[0]!.status).toBe('answered')
  })

  it('a wake refused at the start is not revived by a later reply in the thread', async () => {
    const a = await asked()
    db.prepare("UPDATE forum_agent_wakes SET status='refused', refusal='start_failed', to_run=NULL").run()
    a.s.collab.noteReplied(a.member('agt_livia').id, a.card.seq, 'hello')
    expect(a.wakes()[0]!.status).toBe('refused')
  })
})

describe('a queue that mixes people and agents', () => {
  const busy = async () => {
    const a = setup()
    const owner = a.s.store.owner(CO)
    const room = a.s.store.channelByName(CO, 'development')!
    const say = (text: string) => a.s.store.post(owner.id, { channelId: room.id, text, threadId: null })
    a.responder.onHumanPost(say('first'))
    const person = say('second')
    a.responder.onHumanPost(person)
    await a.s.api.call(a.caller('agt_marcus'), 'forum_ask_agent', { to: '@livia', question: 'Is the pricing page live?', wait_s: 0 })
    const card = a.s.store.openAsks(CO)[0]!
    return { ...a, person, card, room }
  }

  it('a person and an agent each get their own run, with their own rules and thread', async () => {
    const a = await busy()
    a.responder.onRunEnded('r_wake1')
    expect(a.starts).toHaveLength(2)
    expect(a.starts[1]!.prompt).toMatch(/^Forum reply in #development/)
    expect(a.starts[1]!.reply.messageId).toBe(a.person.id)
    a.responder.onRunEnded('r_wake2')
    expect(a.starts).toHaveLength(3)
    expect(a.starts[2]!.prompt).toMatch(/^Agent ask in #development/)
    expect(a.starts[2]!.reply.messageId).toBe(a.card.id)
  })

  it('two asks queued: each gets its own run, so neither is left without an answer', async () => {
    const a = setup()
    const owner = a.s.store.owner(CO)
    const room = a.s.store.channelByName(CO, 'development')!
    a.responder.onHumanPost(a.s.store.post(owner.id, { channelId: room.id, text: 'first', threadId: null }))
    await a.s.api.call(a.caller('agt_marcus'), 'forum_ask_agent', { to: '@livia', question: 'One?', wait_s: 0 })
    await a.s.api.call(a.caller('agt_marcus', 'r_task2'), 'forum_ask_agent', { to: '@livia', question: 'Two?', wait_s: 0 })
    a.responder.onRunEnded('r_wake1')
    a.responder.onRunEnded('r_wake2')
    expect(a.starts.slice(1).map((x) => x.prompt.includes('One?') ? 'one' : 'two')).toEqual(['one', 'two'])
    expect(a.starts[1]!.prompt).not.toContain('Two?')
  })

  it('it cannot start: the person gets a line and the agent stops waiting', async () => {
    const a = await busy()
    agents.find((x) => x.id === 'agt_livia')!.archivedAt = '2026-10-21T10:00:00.000Z'
    a.responder.onRunEnded('r_wake1')
    expect(a.starts).toHaveLength(1)
    const lines = a.s.store.thread(a.person.id).replies.filter((m) => m.kind === 'system').map((m) => m.text)
    expect(lines).toEqual([expect.stringContaining('could not answer this')])
    expect(a.s.store.message(a.card.id).ask).toMatchObject({ status: 'answered', answer: expect.stringContaining('could not answer') })
    expect(a.wakes().find((w) => w.via === 'ask')).toMatchObject({ status: 'refused', refusal: 'start_failed' })
  })
})
