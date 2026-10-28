/**
 * DEPARTMENTS.md §13 D11 step 2: the company board end to end, over the real modules (hive.db, HookedCompanyStore,
 * Dispatcher, router, recurring boards, task-mode Slack triggers, TaskTools behind the AuthorBroker, the board IPC
 * actions) with a fake adapter: the engine's `runs.start` queues a turn, and each seat's script plays the agent,
 * calling the hivetask tools through the broker as its step would, then the run ends the way the engine ends it
 * (runs row, then runHooks: the company hook's syncRun, then the dispatcher).
 *
 * 1. The scenario: a Slack message creates a task, it routes to Support, Autopilot runs it, the agent asks, the human
 *    answers, it resumes, reports review, the human approves with a note, and a dependent Marketing task heals and
 *    runs. Replayed twice, the two transcripts are identical.
 * 2. An overnight soak over 5 companies with adversarial seats (askers, crashers, ping-pong handoffs, subtask spawners,
 *    silent seats) and a steady stream of Slack follow-ups and new work, no human: no task beyond its caps
 *    (automatic wakes per hour, maxInFlight, one task per agent, children, depth, filings per hour, handoffs), nothing
 *    reaches done, and once the stimuli stop the board goes quiet and stays quiet (no re-wake loop).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type DB } from '../db'
import { Store } from '../db/store'
import { AuthorBroker, type BrokerDeps } from '../author/broker'
import { AuthorDrafts } from '../author/drafts'
import { createSlackTriggers } from '../engine/slackTriggers'
import { MemStore } from '../engine/__tests__/fakes'
import { boardActions } from '../handlers/board'
import { Dispatcher, HookedCompanyStore, taskRunBridge } from './dispatcher'
import { recurringBoards } from './recurring'
import { TASK_CREATE_CAPS, TaskTools, type TaskCaller, type TaskTool } from './taskTools'
import { AGENT_MAX_PARALLEL, laneOf, MAX_HANDOFFS, needsYouReason, type BoardTask, type CompanyAgent, type CompanyTaskInput, type Department } from '../../shared/company'
import type { LiveOwner, SlackBridge, SlackTriggerState, StartRunOptions } from '../../shared/engine'
import { newId } from '../../shared/ids'
import type { SlackInboundMessage, SlackTrigger, SlackTriggerEvent } from '../../shared/slack'
import type { Run, RunTarget, Workflow } from '../../shared/types'

const HOUR = 3_600_000
const flush = () => new Promise(r => setTimeout(r, 0))
async function settle() { for (let i = 0; i < 8; i++) await flush() }

// ---------- the world: real board modules, fake adapter ----------

type ToolAnswer = { ok: boolean; result?: Record<string, unknown>; error?: string }
interface Turn {
  run: Run
  target: RunTarget
  opts: StartRunOptions
  owner: LiveOwner
  /** fake clock time the run started */
  at: number
  /** soak: steps until the run ends (drawn at its first step) */
  ticksLeft: number | null
}
interface TurnCtx {
  turn: Turn
  task: BoardTask
  agent: CompanyAgent
  prompt: string
  /** one tool call through the broker, as the step's hivemem server would send it */
  tool(name: TaskTool, args?: Record<string, unknown>): Promise<ToolAnswer>
}
type TurnEnd = { status: 'passed' | 'failed' | 'canceled'; agentSessionId?: string }
type Script = (ctx: TurnCtx) => Promise<TurnEnd>

class World {
  readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-board-e2e-'))
  readonly db: DB = openDatabase(path.join(this.dir, 'test.db'))
  readonly store = new Store(this.db)
  readonly c = new HookedCompanyStore(this.store, { companiesRoot: path.join(this.dir, 'companies') })
  clock = new Date('2026-10-20T18:00:00.000Z')
  readonly d: Dispatcher
  readonly tools: TaskTools
  readonly broker: AuthorBroker
  readonly board: ReturnType<typeof boardActions>
  readonly bridge: ReturnType<typeof taskRunBridge>
  /** every run the fake engine started, in order */
  readonly turns: Turn[] = []
  /** runs in flight (the fake adapter's processes) */
  readonly live: Turn[] = []
  readonly scripts = new Map<string, Script>()
  private seq = 0
  private callN = 0

  constructor() {
    this.d = new Dispatcher({
      company: this.c, startRun: (t, o) => this.startRun(t, o), cancelRun: async id => this.finish(id, { status: 'canceled' }),
      enabled: () => true, now: () => this.clock
    })
    this.c.hooks = this.d.hooks()
    this.tools = new TaskTools({ company: () => this.c, enabled: () => true, now: () => this.clock, pump: id => void this.d.pump(id) })
    // as wire.ts does: a pending handoff is applied right before every syncRun
    const sync = this.c.syncRun.bind(this.c)
    this.c.syncRun = run => { this.tools.beforeSyncRun(run); return sync(run) }
    const deps = { drafts: new AuthorDrafts(this.db), tasks: { resolve: (o: LiveOwner) => this.tools.resolveCaller(o), call: (caller: unknown, tool: TaskTool, args: Record<string, unknown>, hints: { companyId: string | null; taskId: string | null; callId: string | null }) => this.tools.call(caller as TaskCaller, tool, args, hints) } }
    this.broker = new AuthorBroker({ ...deps, now: () => this.clock.getTime() } as unknown as BrokerDeps)
    // the board IPC actions (handlers/board.ts) with the dispatcher pump as their onChange, as registerBoardHandlers wires them
    this.board = boardActions({ company: this.c, settings: () => ({ experimental: { companies: true, departments: true } }), engine: { runs: { cancel: async id => this.finish(id, { status: 'canceled' }) } }, dispatcher: this.d }, id => void this.d.pump(id))
    this.bridge = taskRunBridge({ company: () => this.c, dispatcher: () => this.d, toolset: () => req => this.tools.toolset(req) })
  }
  dispose() {
    this.d.dispose()
    this.db.close()
    fs.rmSync(this.dir, { recursive: true, force: true })
  }

  /** The fake engine's runs.start: a run row linked to its task, and a turn queued for the seat's script. */
  private startRun(target: RunTarget, opts: StartRunOptions): Run {
    const id = `r_e2e${++this.seq}`
    const now = this.clock.toISOString()
    this.db.prepare(`INSERT INTO runs(id,kind,title,target_json,trigger,status,created_at,artifacts_dir,company_id) VALUES(?,'prompt','Task',?,'manual','running',?,?,?)`).run(id, JSON.stringify(target), now, this.dir, opts.companyId ?? null)
    const run: Run = { id, kind: 'prompt', title: 'Task', target, workflowId: null, scheduleId: null, parentRunId: null, trigger: 'task' as Run['trigger'], status: 'running', reason: null, createdAt: now, startedAt: now, endedAt: null, artifactsDir: this.dir, artifactCount: 0, companyId: opts.companyId ?? undefined }
    const turn: Turn = { run, target, opts, owner: { runId: id, stepId: `st_e2e${this.seq}` }, at: this.clock.getTime(), ticksLeft: null }
    this.turns.push(turn)
    this.live.push(turn)
    return run
  }
  /** Ends a run as the engine does: the row, then runHooks in Hive's order (company syncRun, then the dispatcher). */
  private finish(runId: string, end: TurnEnd) {
    const i = this.live.findIndex(t => t.run.id === runId)
    if (i < 0) return
    const [turn] = this.live.splice(i, 1)
    this.db.prepare('UPDATE runs SET status=?, ended_at=? WHERE id=?').run(end.status, this.clock.toISOString(), runId)
    const run: Run = { ...turn.run, status: end.status, endedAt: this.clock.toISOString() }
    this.c.syncRun(run)
    this.d.onRunUpdated(run)
  }
  /** Plays one turn: the seat's script (tool calls through the broker), then the run end. */
  async play(turn: Turn): Promise<void> {
    if (!this.live.includes(turn)) return
    const task = this.c.task(turn.opts.taskId!)
    const agent = this.c.departments.agent(turn.opts.agentId!)
    const script: Script = this.scripts.get(agent.id) ?? (async () => ({ status: 'passed' }))
    const prompt = turn.target.kind === 'prompt' ? turn.target.prompt : ''
    const end = await script({ turn, task, agent, prompt, tool: (name, args = {}) => this.call(turn.owner, name, args) })
    // the executor reports the provider conversation id while the step runs
    if (end.agentSessionId) this.bridge.sessionCaptured!({ runId: turn.run.id, taskId: task.id, adapter: 'claude', agentSessionId: end.agentSessionId })
    this.finish(turn.run.id, end)
    await settle()
  }
  /** Plays every queued turn (and the turns they cause) until the fake engine is idle. */
  async drain(max = 50): Promise<void> {
    for (let i = 0; this.live.length; i++) {
      if (i >= max) throw new Error(`still ${this.live.length} runs after ${max} turns: a loop`)
      await this.play(this.live[0])
    }
  }
  call(owner: LiveOwner, tool: TaskTool, args: Record<string, unknown>): Promise<ToolAnswer> {
    return new Promise(resolve => this.broker.handleCall(owner, { hive: 'author_call', call_id: `hac_${String(++this.callN).padStart(10, '0')}`, tool, args }, (_id, p) => resolve(p as ToolAnswer)))
  }

  profile(name = 'Claude') {
    return this.store.createProfile({ name, adapter: 'claude', permissionMode: 'default', secretNames: [], useApiKeyAuth: false })
  }
  seat(companyId: string, dep: Department, name: string, profileId: string, script?: Script): CompanyAgent {
    const a = this.c.departments.saveAgent({ companyId, departmentId: dep.id, kind: 'profile', refId: profileId, name, data: { autonomy: 'auto' } })
    if (script) this.scripts.set(a.id, script)
    return a
  }
  task(over: Partial<CompanyTaskInput> & { companyId: string }): BoardTask {
    return this.c.createTask({ title: 'Task', description: '', repoId: null, status: 'todo', priority: 3, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], ...over })
  }
  kinds(taskId: string) { return this.c.detail(taskId).activity.map(a => a.kind) }
}

/** `want` appears in `list` in this order (other entries may sit between). */
function inOrder(list: string[], want: string[]): boolean {
  let i = 0
  for (const x of list) if (x === want[i]) i++
  return i === want.length
}

// ---------- task-mode Slack triggers over the world (engine/slackTriggers.ts, as recurringTasks.test.ts drives it) ----------

class SlackStore extends MemStore {
  triggers: SlackTrigger[] = []
  stateRows = new Map<string, SlackTriggerState>()
  trigEvents: SlackTriggerEvent[] = []
  listSlackTriggers(): SlackTrigger[] { return this.triggers.map(t => ({ ...t })) }
  getSlackTriggerState(triggerId: string, channelId: string, threadKey: string): SlackTriggerState | null { return this.stateRows.get(`${triggerId}|${channelId}|${threadKey}`) ?? null }
  putSlackTriggerState(s: SlackTriggerState): void { this.stateRows.set(`${s.triggerId}|${s.channelId}|${s.threadKey}`, { ...s }) }
  listSlackTriggerStates(): SlackTriggerState[] { return [...this.stateRows.values()] }
  insertSlackTriggerEvent(e: Omit<SlackTriggerEvent, 'id' | 'createdAt'>): SlackTriggerEvent {
    const ev = { ...e, id: newId('slackTriggerEvent'), createdAt: new Date().toISOString() }
    this.trigEvents.push(ev)
    return ev
  }
}
let tsSeq = 1_760_200_000
function slackMsg(x: Partial<SlackInboundMessage> = {}): SlackInboundMessage {
  const nowMs = Date.now()
  return { teamId: 'T1', channelId: 'C1', channelKind: 'channel', channelName: 'support', ts: x.ts ?? `${++tsSeq}.000100`, threadTs: null, userId: 'U1', userName: 'Dana Lee', botId: null, subtype: null,
    plain: '@hive my order arrived broken', isMention: true, isDmToBot: false, isOwn: false, fromBot: false, eventTime: Math.floor(nowMs / 1000), receivedAt: nowMs, source: 'event', catchup: false, ...x } as SlackInboundMessage
}
/** A task-mode trigger on #support with no department of its own: the channel routes it (§2 step 3). */
function slackInbox(w: World, companyId: string) {
  const st = new SlackStore()
  const cbs = new Set<(m: SlackInboundMessage) => void>()
  const runStarts: RunTarget[] = []
  const slack = {
    connected: () => true,
    onMessage: (cb: (m: SlackInboundMessage) => void) => { cbs.add(cb); return () => void cbs.delete(cb) },
    threadTranscript: () => '',
    permalink: async (ch: string, ts: string) => `https://acme.slack.com/archives/${ch}/p${ts.replace('.', '')}`,
    resolveUserName: (id: string) => id,
    reply: async () => ({ status: 'drafted' }),
    repliesForRun: () => 0,
    toolServer: () => null,
    message: () => null,
    alert: () => undefined
  } as unknown as SlackBridge
  const wf = { id: 'wf_inbox', name: 'Support inbox', nodes: [], inputs: [], companyId } as unknown as Workflow
  st.triggers = [{
    id: 'strg_inbox', name: 'Support inbox', workflowId: wf.id, enabled: true,
    match: { on: ['mention', 'thread'], channels: ['C1'], keywords: [], regex: null, fromUsers: [] },
    reply: { mode: 'none', autoChannels: [], replyNode: null }, limits: { debounceSec: 0, maxRunsPerThreadPerHour: 4 }, inputs: {},
    access: { fullPermissions: false, secretNames: [] }, action: 'task', departmentId: null, origin: null,
    createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z', sentence: '', lastFiredAt: null, lastRunId: null, lastRunStatus: null
  } as unknown as SlackTrigger]
  const triggers = createSlackTriggers({
    store: st, slack, getWorkflow: () => wf, getSettings: () => ({ schedulesPaused: false, slackTriggerCatchupMin: 10 }) as never,
    startRun: (t) => { runStarts.push(t); return { id: newId('run'), status: 'running', trigger: 'slack' } as Run },
    getRun: () => null, activeRuns: () => [], emit: () => {}, log: { info: () => {}, warn: () => {}, error: () => {} }, now: () => new Date(),
    board: recurringBoards({ company: () => w.c, dispatcher: () => w.d, enabled: () => true }).slack
  })
  triggers.start()
  return { st, runStarts, emit: (m: SlackInboundMessage) => cbs.forEach(cb => cb(m)), stop: () => triggers.stop() }
}

// ---------- 1. the scenario ----------

let worlds: World[] = []
beforeEach(() => { worlds = [] })
afterEach(() => {
  vi.useRealTimers()
  for (const w of worlds) w.dispose()
})
const world = () => { const w = new World(); worlds.push(w); return w }

/**
 * Runs the scenario and returns its transcript with ids normalized: what started, every task's statuses and activity
 * kinds. Asserts each step on the way.
 */
async function scenario(): Promise<string> {
  const w = world()
  const co = w.c.create({ name: 'Acme' })
  const support = w.c.departments.save({ companyId: co.id, name: 'Support', key: 'support', data: { slackChannels: ['C1'], charter: { does: 'Answers customers', doesNot: 'Writes marketing copy' } } })
  const marketing = w.c.departments.save({ companyId: co.id, name: 'Marketing', key: 'marketing' })
  const profile = w.profile()
  const inbox = slackInbox(w, co.id)
  let askedOnce = false
  const supportAgent = w.seat(co.id, support, 'Support agent', profile.id, async ({ prompt, tool }) => {
    if (!askedOnce) {
      askedOnce = true
      // turn 1: read the task (the Slack text is wrapped as untrusted data), note progress, ask the human
      const got = await tool('task_get')
      expect(got.ok).toBe(true)
      expect(String((got.result!.task as { description: string }).description)).toContain('<slack-message untrusted="true"')
      expect((await tool('task_comment', { text: 'Checking the order history' })).ok).toBe(true)
      // the customer writes again while the run is working: one comment and a coalesced wake
      inbox.emit(slackMsg({ threadTs: root.ts, plain: 'order number is 4417' }))
      await settle()
      expect((await tool('task_ask', { kind: 'choice', prompt: 'Refund or replacement for order 4417?', options: ['Refund', 'Replacement'] })).ok).toBe(true)
      return { status: 'passed', agentSessionId: 'conv-support' }
    }
    // turn 2 (resumed conversation): the wake carries the follow-up and the answer
    expect(prompt).toContain('Answer: Replacement')
    expect(prompt).toContain('order number is 4417')
    const rep = await tool('task_report', { outcome: 'review', summary: 'Replacement for order 4417 shipped', evidence: ['shipment SHP-88'] })
    expect(rep.ok).toBe(true)
    return { status: 'passed', agentSessionId: 'conv-support' }
  })
  const copywriter = w.seat(co.id, marketing, 'Copywriter', profile.id, async ({ prompt, tool }) => {
    expect(prompt).toContain('Unblocked: every dependency is done.')
    // the dependency's done note reaches the dependent task's prompt
    expect(prompt).toContain('Customer confirmed the replacement arrived')
    expect((await tool('task_report', { outcome: 'review', summary: 'Status page note drafted', evidence: ['status.md'] })).ok).toBe(true)
    return { status: 'passed' }
  })
  w.c.setAutopilot(co.id, true)

  // a Slack message creates the task; the channel routes it to Support's only agent; Autopilot starts it
  const root = slackMsg({ plain: '@hive my order arrived broken' })
  inbox.emit(root)
  await settle()
  const t1 = w.c.listTasks(co.id).find(t => t.source === 'slack')!
  expect(t1).toMatchObject({ status: 'in_progress', departmentId: support.id, agentId: supportAgent.id, routing: { departmentId: support.id, agentId: supportAgent.id, by: 'rule' } })
  expect(inbox.runStarts).toEqual([])
  expect(w.turns.map(t => [t.opts.trigger, t.opts.taskId, t.opts.agentId])).toEqual([['task', t1.id, supportAgent.id]])

  // the human files the Marketing follow-up, which waits on the Support task (dependency lock, Queued)
  const t2 = w.task({ companyId: co.id, title: 'Note the broken-shipment fix on the status page', departmentId: marketing.id, agentId: copywriter.id, dependencyIds: [t1.id] })
  expect(w.c.task(t2.id)).toMatchObject({ status: 'blocked', blockReason: 'deps' })
  expect(laneOf(w.c.task(t2.id))).toBe('queued')

  // turn 1: the agent asks; the run ends; no follow-up turn although a wake arrived during the run
  await w.drain()
  expect(w.c.task(t1.id)).toMatchObject({ status: 'blocked', blockReason: 'needs_input', ask: { kind: 'choice', options: ['Refund', 'Replacement'] }, agentSessionId: 'conv-support' })
  expect(w.c.task(t1.id).pendingWake?.count).toBe(1)
  expect(laneOf(w.c.task(t1.id))).toBe('needs_you')
  expect(needsYouReason(w.c.task(t1.id))).toBe('needs_input')
  expect(w.turns).toHaveLength(1)
  for (let i = 0; i < 5; i++) await w.d.tick()
  expect(w.turns).toHaveLength(1)

  // the human answers (tasks:answer): back to todo, the same agent resumes its conversation
  w.board.answer({ id: t1.id, answer: 'Replacement' })
  await settle()
  expect(w.turns).toHaveLength(2)
  expect(w.turns[1].opts).toMatchObject({ trigger: 'task', taskId: t1.id, agentId: supportAgent.id, resumeSessionId: 'conv-support' })
  await w.drain()
  expect(w.c.task(t1.id)).toMatchObject({ status: 'in_review', report: { outcome: 'review', summary: 'Replacement for order 4417 shipped', evidence: ['shipment SHP-88'] }, pendingWake: null })
  expect(laneOf(w.c.task(t1.id))).toBe('needs_you')
  for (let i = 0; i < 5; i++) await w.d.tick()
  expect(w.turns).toHaveLength(2)
  expect(w.c.task(t2.id).status).toBe('blocked')

  // the human approves with a note (tasks:approve): done; the Marketing task heals and runs at once
  expect(() => w.board.approve({ id: t1.id, doneNote: '  ' })).toThrow()
  w.board.approve({ id: t1.id, doneNote: 'Customer confirmed the replacement arrived' })
  await settle()
  expect(w.c.task(t1.id)).toMatchObject({ status: 'done', doneNote: 'Customer confirmed the replacement arrived' })
  expect(w.turns).toHaveLength(3)
  expect(w.turns[2].opts).toMatchObject({ trigger: 'task', taskId: t2.id, agentId: copywriter.id, resumeSessionId: null })
  await w.drain()
  expect(w.c.task(t2.id)).toMatchObject({ status: 'in_review', report: { summary: 'Status page note drafted' } })
  w.board.approve({ id: t2.id, doneNote: 'Published' })
  await settle()
  for (let i = 0; i < 5; i++) await w.d.tick()
  expect(w.turns).toHaveLength(3)
  expect(w.c.listTasks(co.id).map(t => t.status)).toEqual(['done', 'done'])

  const k1 = w.kinds(t1.id), k2 = w.kinds(t2.id)
  expect(inOrder(k1, ['created', 'routed', 'woke', 'started', 'comment', 'comment', 'coalesced', 'asked', 'answered', 'woke', 'started', 'report', 'approved'])).toBe(true)
  expect(inOrder(k2, ['created', 'parked', 'healed', 'woke', 'started', 'report', 'approved'])).toBe(true)
  // agent writes are attributed to the agent; the approval to the human
  const act1 = w.c.detail(t1.id).activity
  expect(act1.find(a => a.message === 'Checking the order history')?.by).toBe('agent')
  expect(act1.find(a => a.kind === 'approved')?.by).toBe('human')
  inbox.stop()

  const ids = new Map<string, string>([[co.id, 'CO'], [support.id, 'SUP'], [marketing.id, 'MKT'], [supportAgent.id, 'AGT1'], [copywriter.id, 'AGT2'], [t1.id, 'T1'], [t2.id, 'T2']])
  const norm = (s: string | null | undefined) => s ? ids.get(s) ?? s : s
  return JSON.stringify({
    turns: w.turns.map(t => [t.opts.trigger, norm(t.opts.taskId), norm(t.opts.agentId), t.opts.resumeSessionId ?? null]),
    tasks: [t1, t2].map(t => ({ k: w.kinds(t.id), by: w.c.detail(t.id).activity.map(a => a.by), status: w.c.task(t.id).status }))
  })
}

describe('DEPARTMENTS.md D11: Slack to Support to review to a healed Marketing task (fake adapter)', () => {
  it('runs the whole scenario', async () => {
    await scenario()
  })
  it('is deterministic: two replays give the same transcript', async () => {
    const a = await scenario()
    const b = await scenario()
    expect(b).toBe(a)
  })
})

// ---------- 2. the overnight soak ----------

/** mulberry32: a seeded PRNG, so the soak replays exactly. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
type Persona = 'reporter' | 'asker' | 'silent' | 'crasher' | 'spawner' | 'pinger' | 'blocker' | 'chatter'
/** Four seats per company over two departments (Ops: seats 0-1, Growth: seats 2-3). */
const CREWS: Persona[][] = [
  ['pinger', 'reporter', 'pinger', 'spawner'],
  ['asker', 'silent', 'chatter', 'reporter'],
  ['crasher', 'spawner', 'blocker', 'pinger'],
  ['spawner', 'chatter', 'spawner', 'reporter'],
  ['reporter', 'pinger', 'silent', 'pinger']
]

describe('DEPARTMENTS.md D11: an overnight soak over 5 companies', () => {
  it('no task goes beyond its caps, nothing reaches done, and the board goes quiet without a re-wake loop', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const w = world()
    vi.setSystemTime(w.clock)
    const rand = rng(20261020)
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]
    const profile = w.profile()
    const refusals: Record<string, number> = {}
    const refused = (msg: string) => {
      const key = /limit 4/.test(msg) ? 'children_per_task' : /limit 10/.test(msg) ? 'filings_per_hour' : /one level deep/.test(msg) ? 'depth' : /already yours/.test(msg) ? 'self_handoff' : 'other'
      refusals[key] = (refusals[key] ?? 0) + 1
    }
    /** agent filings (time, company) for the per-hour cap */
    const filings: { at: number; companyId: string }[] = []
    const companies: { id: string; max: number; ops: Department; growth: Department; seats: CompanyAgent[] }[] = []

    const scriptFor = (persona: Persona, cid: string): Script => async ({ task, tool }) => {
      switch (persona) {
        case 'reporter':
          await tool('task_report', { outcome: 'review', summary: `Done: ${task.title}`, evidence: [] })
          return { status: 'passed' }
        case 'asker':
          await tool('task_ask', { kind: 'question', prompt: `Which option for ${task.title}?` })
          return { status: 'passed' }
        case 'silent':
          return { status: 'passed' }
        case 'crasher':
          return { status: 'failed' }
        case 'blocker':
          await tool('task_report', { outcome: 'blocked', summary: 'No access to the billing system', evidence: [] })
          return { status: 'passed' }
        case 'chatter':
          // agent comments never wake anyone, however many
          for (let i = 0; i < 6; i++) await tool('task_comment', { text: `progress ${i}` })
          await tool('task_report', { outcome: 'review', summary: 'Chatty but done', evidence: [] })
          return { status: 'passed' }
        case 'spawner': {
          for (let i = 0; i < 6; i++) {
            const r = await tool('task_create', { title: `Follow-up ${i} of ${task.identifier}`, departmentKey: i % 2 ? 'growth' : 'ops' })
            if (r.ok) filings.push({ at: w.clock.getTime(), companyId: cid })
            else refused(r.error ?? '')
          }
          await tool('task_report', { outcome: 'review', summary: 'Filed follow-ups', evidence: [] })
          return { status: 'passed' }
        }
        case 'pinger': {
          // hands off to the other department every time: ping-pong between two pingers until the handoff cap
          const here = companies.find(c => c.id === cid)!
          const to = task.departmentId === here.ops.id ? 'growth' : 'ops'
          const r = await tool('task_handoff', { departmentKey: to, reason: `Better for ${to}` })
          if (!r.ok) refused(r.error ?? '')
          return { status: 'passed' }
        }
      }
    }

    // rows created in the same millisecond tie on created_at and fall back to their random ids (seat order in a pump,
    // the router's oldest-agent tie break): one millisecond apart, the soak replays exactly
    const tick1ms = <T,>(make: () => T): T => { const out = make(); w.clock = new Date(w.clock.getTime() + 1); vi.setSystemTime(w.clock); return out }
    for (let n = 0; n < 5; n++) {
      const max = [1, 2, 3, 2, 1][n]
      const co = tick1ms(() => w.c.create({ name: `Company ${n}` }))
      const ops = tick1ms(() => w.c.departments.save({ companyId: co.id, name: 'Ops', key: 'ops' }))
      const growth = tick1ms(() => w.c.departments.save({ companyId: co.id, name: 'Growth', key: 'growth' }))
      const seats = CREWS[n].map((p, i) => tick1ms(() => w.seat(co.id, i < 2 ? ops : growth, `${p} ${n}.${i}`, profile.id)))
      companies.push({ id: co.id, max, ops, growth, seats })
      seats.forEach((s, i) => w.scripts.set(s.id, scriptFor(CREWS[n][i], co.id)))
      // the initial backlog: two tasks per seat, the second one depending on the first for half the seats
      for (const [i, s] of seats.entries()) {
        const first = w.task({ companyId: co.id, title: `Job ${n}.${i}.a`, departmentId: s.departmentId, agentId: s.id, priority: (1 + (i % 4)) as 1 | 2 | 3 | 4 })
        w.task({ companyId: co.id, title: `Job ${n}.${i}.b`, departmentId: s.departmentId, agentId: s.id, dependencyIds: i % 2 ? [first.id] : [] })
      }
      w.c.setAutopilot(co.id, true, max)
    }
    // a sixth company keeps Autopilot off (the default) with auto seats, assigned todo work and the same stream of
    // wakes (on a fixed beat, so the seeded stream of the five stays as it was): nothing of it may ever start
    const off = tick1ms(() => w.c.create({ name: 'Company off' }))
    const offDep = tick1ms(() => w.c.departments.save({ companyId: off.id, name: 'Ops', key: 'ops' }))
    const offSeats = ['reporter', 'pinger'].map((p, i) => tick1ms(() => w.seat(off.id, offDep, `${p} off.${i}`, profile.id, scriptFor(p as Persona, off.id))))
    const offTasks = offSeats.map(s => w.task({ companyId: off.id, title: `Off job ${s.name}`, departmentId: offDep.id, agentId: s.id }))
    expect(w.c.boardSettings(off.id).autopilot).toBe(false)

    /** automatic starts per task, fake clock times */
    const startsOf = new Map<string, number[]>()
    let counted = 0
    let saturated = 0
    const violations: string[] = []
    const check = (phase: string) => {
      for (const t of w.turns.slice(counted)) {
        const xs = startsOf.get(t.opts.taskId!) ?? []
        xs.push(t.at)
        startsOf.set(t.opts.taskId!, xs)
      }
      counted = w.turns.length
      const all = w.c.listTasks()
      for (const co of companies) {
        const inFlight = all.filter(t => t.companyId === co.id && t.status === 'in_progress')
        if (inFlight.length > co.max) violations.push(`${phase}: ${co.id} has ${inFlight.length} in flight (max ${co.max})`)
        if (inFlight.length === co.max) saturated++
      }
      const perAgent = new Map<string, number>()
      for (const t of all) {
        if (t.status === 'in_progress' && t.agentId) perAgent.set(t.agentId, (perAgent.get(t.agentId) ?? 0) + 1)
        if (t.status === 'done') violations.push(`${phase}: ${t.identifier} reached done without a human`)
        if (t.autoWakes.n > 4) violations.push(`${phase}: ${t.identifier} autoWakes ${t.autoWakes.n}`)
        if (t.handoffs > MAX_HANDOFFS) violations.push(`${phase}: ${t.identifier} handoffs ${t.handoffs}`)
        if (t.parentId) {
          const parent = all.find(p => p.id === t.parentId)!
          if (parent.parentId) violations.push(`${phase}: ${t.identifier} is two levels deep`)
          if (parent.companyId !== t.companyId) violations.push(`${phase}: ${t.identifier} has a parent in another company`)
        }
        // a task in flight is held by a live run of the fake engine, never an orphan
        if (t.status === 'in_progress' && !w.live.some(l => l.run.id === t.runId)) violations.push(`${phase}: ${t.identifier} in flight without a live run`)
      }
      for (const [agentId, n] of perAgent) if (n > AGENT_MAX_PARALLEL) violations.push(`${phase}: agent ${agentId} holds ${n} tasks (max ${AGENT_MAX_PARALLEL})`)
      const kids = new Map<string, number>()
      for (const t of all) if (t.parentId) kids.set(t.parentId, (kids.get(t.parentId) ?? 0) + 1)
      for (const [id, n] of kids) if (n > TASK_CREATE_CAPS.perTask) violations.push(`${phase}: ${id} has ${n} children`)
    }

    const tickMs = 5 * 60_000
    const advance = (ms: number) => { w.clock = new Date(w.clock.getTime() + ms); vi.setSystemTime(w.clock) }
    /** one 5-minute step: stimuli, runs that finish, the dispatcher tick */
    let stepN = 0
    const step = async (stimuli: boolean, phase: string) => {
      advance(tickMs)
      stepN++
      if (stimuli) {
        for (const co of companies) {
          const open = w.c.listTasks(co.id).filter(t => t.status !== 'done' && t.status !== 'canceled')
          // Slack follow-ups and schedule fires on existing work (coalesced while in flight)
          if (open.length && rand() < 0.5) w.d.wake(pick(open).id, `Slack follow-up at ${w.clock.toISOString()}`, 'system')
          // new work arrives unassigned in a department: the router picks a seat
          if (rand() < 0.08) w.task({ companyId: co.id, title: `Inbound ${w.clock.toISOString()}`, status: 'triage', departmentId: pick([co.ops, co.growth]).id, agentId: null })
        }
        w.d.wake(offTasks[stepN % offTasks.length].id, `Slack follow-up at ${w.clock.toISOString()}`, 'system')
        if (stepN % 12 === 0) w.task({ companyId: off.id, title: `Inbound ${w.clock.toISOString()}`, status: 'triage', departmentId: offDep.id, agentId: null })
        await settle()
      }
      // fake processes: each run takes 1-3 ticks
      for (const t of [...w.live]) {
        t.ticksLeft ??= 1 + Math.floor(rand() * 3)
        if (--t.ticksLeft <= 0) await w.play(t)
      }
      await w.d.tick()
      await settle()
      check(phase)
    }

    await w.d.pump()
    await settle()
    check('boot')
    // the night: 10 hours of 5-minute steps
    for (let i = 0; i < 120; i++) await step(true, `night ${i}`)
    // the stimuli stop: the board drains within a bounded number of steps. The backlog is finite (queued work behind a
    // maxInFlight of 1, follow-ups filed by spawners, each ping-ponged to its handoff cap), so this is a slow drain;
    // a re-wake loop would never end
    const DRAIN_MAX = 400
    let drainSteps = 0
    while (w.live.length || w.c.listTasks().some(t => t.status === 'todo' && t.agentId && t.companyId !== off.id)) {
      if (++drainSteps > DRAIN_MAX) break
      await step(false, `drain ${drainSteps}`)
    }
    expect(violations).toEqual([])
    expect(drainSteps).toBeLessThanOrEqual(DRAIN_MAX)
    expect(w.live).toHaveLength(0)
    // and then stays quiet: a day of hourly ticks starts nothing (a todo whose seat never runs it is only a manual seat)
    const quiet = w.turns.length
    for (let i = 0; i < 24; i++) {
      advance(HOUR)
      await w.d.tick()
      await settle()
      check(`quiet ${i}`)
    }
    expect(w.turns.length).toBe(quiet)
    expect(violations).toEqual([])

    // §0.7: at most 4 automatic wakes per task per hour (the guard's window opens at the first wake of the hour)
    for (const [taskId, xs] of startsOf) {
      let windowStart = -Infinity, n = 0
      for (const at of xs.sort((a, b) => a - b)) {
        if (at - windowStart >= HOUR) { windowStart = at; n = 0 }
        n++
        if (n > 4) violations.push(`${w.c.task(taskId).identifier}: ${n} automatic starts within the hour from ${new Date(windowStart).toISOString()}`)
      }
      // and so never more than 8 in any rolling hour
      for (const at of xs) if (xs.filter(x => x >= at && x < at + HOUR).length > 8) violations.push(`${taskId}: more than 8 starts in a rolling hour`)
    }
    // §6: at most 10 agent filings per company per rolling hour
    for (const f of filings) {
      const n = filings.filter(x => x.companyId === f.companyId && x.at >= f.at && x.at < f.at + HOUR).length
      if (n > TASK_CREATE_CAPS.perCompanyPerHour) violations.push(`${f.companyId}: ${n} filings within an hour of ${new Date(f.at).toISOString()}`)
    }
    expect(violations).toEqual([])
    // Autopilot off: wakes queued, routed, never started
    expect(w.turns.filter(t => t.opts.companyId === off.id)).toEqual([])
    expect(w.c.listTasks(off.id).every(t => t.status !== 'in_progress' && !t.runId)).toBe(true)
    expect(offTasks.every(t => (w.c.task(t.id).pendingWake?.count ?? 0) > 0)).toBe(true)

    // the soak really pressed on every cap (otherwise it proves nothing)
    const all = w.c.listTasks()
    const parked = (r: string) => all.filter(t => t.status === 'blocked' && t.blockReason === r).length
    expect(saturated).toBeGreaterThan(0)
    expect(parked('limit')).toBeGreaterThan(0)
    expect(parked('handoff_cap')).toBeGreaterThan(0)
    expect(parked('needs_input')).toBeGreaterThan(0)
    expect(parked('run_failed')).toBeGreaterThan(0)
    expect(parked('agent')).toBeGreaterThan(0)
    expect(refusals.children_per_task ?? 0).toBeGreaterThan(0)
    expect(refusals.depth ?? 0).toBeGreaterThan(0)
    expect(refusals.filings_per_hour ?? 0).toBeGreaterThan(0)
    // wakes during runs were coalesced, and some became follow-up turns
    expect(all.some(t => w.kinds(t.id).includes('coalesced'))).toBe(true)
    expect(all.some(t => w.c.detail(t.id).activity.some(a => a.kind === 'woke' && a.message.startsWith('Follow-up turn')))).toBe(true)
    expect(all.some(t => t.handoffs === MAX_HANDOFFS)).toBe(true)
    expect(w.turns.length).toBeGreaterThan(100)
    // no human acted overnight: every task is waiting for one (Needs you), queued behind a lock, or still in the Inbox
    for (const t of all) expect(['needs_you', 'queued', 'inbox']).toContain(laneOf(t))
  }, 120_000)
})
