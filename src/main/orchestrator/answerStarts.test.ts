/**
 * CHAT-UI.md §8: the founder's answer, or their "go ahead", is their go-ahead. VO-16 sat waiting after the founder
 * answered Julia ("main app bro and lets make it a new one") with autopilot off, and their next message ("are u
 * working on it? or what?") was taken for the answer to VO-16's question. Here: an answer resumes the task at once
 * (autopilot off, a manual seat), a task that cannot start says why instead of "back on", a status question goes to
 * the agent with the task's live state, an option said back routes without a model call, a failed classifier leaves it
 * to the agent, and the agent starts a filed task when the founder says go.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { OrchWorld, report, type Turn } from './__tests__/world'
import type { ForumMessage } from '../../shared/forum'
import type { ModelCall, ModelCallRequest } from '../company/router'
import { boardActions } from '../handlers/board'

const worlds: OrchWorld[] = []
afterEach(() => {
  while (worlds.length) worlds.pop()!.dispose()
})

const BLOCKED = report({ outcome: 'blocked', summary: 'Drafted two options', blockers: [{ needs: 'decision', text: 'Which app: the main app or a new one?' }] })

function setup(opts: { reply?: (turn: Turn, w: OrchWorld, n: number) => Promise<string | null>; autopilot?: boolean; fileFirst?: boolean } = {}) {
  const w = new OrchWorld()
  worlds.push(w)
  const co = w.company('Vibiz')
  if (!opts.autopilot) w.c.setAutopilot(co.id, false)
  const ops = w.department(co.id, 'Product', 'product')
  const owner = w.forum.store.owner(co.id)
  w.forum.onHumanPost = (m) => void w.responder.onHumanPost(m)
  let replies = 0
  let taskRuns = 0
  const prompts: string[] = []
  const julia = w.seat(co.id, ops, 'Product Lead', 'claude', 'manual', async (turn, world) => {
    if (turn.kind === 'task') {
      taskRuns++
      prompts.push(turn.prompt)
      return { output: taskRuns === 1 ? BLOCKED : report({ outcome: 'review', summary: 'Built the landing page in the main app' }) }
    }
    replies++
    prompts.push(turn.prompt)
    const me = world.forum.store.memberForAgent(turn.agentId)!
    const caller = { companyId: co.id, memberId: me.id, runId: turn.run.id, stepId: turn.owner.stepId, taskId: null }
    if (replies === 1 && opts.fileFirst !== false) {
      const req = world.posts(co.id).find((m) => m.text.includes('landing page'))!
      await world.forum.api.call(caller, 'forum_reply', { to: req.ref, text: "I started {task}: Landing page. I'll post the result here.", task: { title: 'Landing page' } })
    } else if (opts.reply) {
      const out = await opts.reply(turn, world, replies)
      if (out) return { output: out }
    }
    return { output: report({ outcome: 'answered', summary: 'Replied' }) }
  })
  const jm = w.forum.store.memberForAgent(julia.id)!
  const conv = w.forum.store.createChannel(owner.id, { name: 'chat-landing-ab12', kind: 'private', memberIds: [jm.id] })
  const calls: ModelCallRequest[] = []
  let kind: string | (() => Promise<string>) = '{"kind":"answer"}'
  const model: ModelCall = async (req) => {
    calls.push(req)
    return typeof kind === 'function' ? kind() : kind
  }
  w.replyKind = model
  // as handlers/forum.ts forum:post does
  const say = async (text: string): Promise<ForumMessage> => {
    const msg = w.forum.store.post(owner.id, { channelId: conv.id, text })
    await w.forum.routeHumanPost(msg, owner.id)
    return msg
  }
  const inConv = (): ForumMessage[] => (w.db.prepare('SELECT seq FROM forum_messages WHERE channel_id=? ORDER BY seq').all(conv.id) as { seq: number }[]).map((r) => w.forum.store.message(r.seq))
  const fromJulia = () => inConv().filter((m) => m.authorId === jm.id && m.kind !== 'system')
  /** VO-1 filed from the request, started, and stopped on its question */
  const stuck = async () => {
    await say('build me a landing page')
    await w.drain()
    const t = w.c.listTasks(co.id).find((x) => x.title === 'Landing page')!
    w.forum.reconcileTaskCards(co.id, { post: true })
    expect(w.c.task(t.id)).toMatchObject({ status: 'blocked', blockReason: 'needs_input' })
    return t
  }
  const setKind = (k: typeof kind) => {
    kind = k
  }
  return { w, co, owner, julia, jm, conv, say, inConv, fromJulia, stuck, calls, setKind, prompts, replyTurns: () => w.turns.filter((t) => t.kind === 'reply').length }
}

/** Gives the agent three other tasks in flight. */
function fill(w: OrchWorld, companyId: string, agentId: string): string[] {
  return [1, 2, 3].map((i) => {
    const t = w.task({ companyId, agentId, title: `Other ${i}` })
    w.db.prepare("UPDATE company_tasks SET status='in_progress', data=json_set(data,'$.status','in_progress') WHERE id=?").run(t.id)
    return t.id
  })
}

describe('a task the founder asked for starts on their word', () => {
  it('filed from the request, it starts right away with autopilot off and a manual seat', async () => {
    const { w, co, say } = setup()
    await say('build me a landing page')
    await w.drain()
    const t = w.c.listTasks(co.id).find((x) => x.title === 'Landing page')!
    expect(['in_progress', 'blocked']).toContain(w.c.task(t.id).status)
    expect(w.turns.filter((x) => x.kind === 'task' && x.taskId === t.id)).toHaveLength(1)
  })

  it('the answer resumes the same agent at once, autopilot off; "back on" because it really is', async () => {
    const { w, say, stuck, fromJulia, prompts, calls } = setup()
    const t = await stuck()
    await say('main app bro and lets make it a new one')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.input).toContain('Which app: the main app or a new one?')
    expect(calls[0]!.input).toContain('main app bro and lets make it a new one')
    expect(w.c.task(t.id).status).toBe('in_progress')
    expect(fromJulia().filter((m) => m.text === `Got it, back on ${t.identifier}.`)).toHaveLength(1)
    await w.drain()
    expect(prompts.join('\n')).toContain('Answer: main app bro and lets make it a new one')
    expect(w.c.task(t.id).status).toBe('in_review')
  })

  it('the drawer and the phone (tasks:answer) resume it too, autopilot off', async () => {
    const { w, co, stuck, fromJulia } = setup()
    const t = await stuck()
    const board = boardActions({ company: w.c, settings: () => ({ experimental: { companies: true, departments: true } }), engine: { runs: { cancel: async () => undefined } }, dispatcher: w.d })
    board.answer({ id: t.id, answer: 'The main app' })
    expect(w.c.task(t.id).status).toBe('in_progress')
    w.forum.reconcileTaskCards(co.id, { post: true })
    expect(fromJulia().filter((m) => m.text === `Got your answer. Back on ${t.identifier}.`)).toHaveLength(1)
  })

  it('PR-69: a busy agent never holds an answer: it resumes beside the other work', async () => {
    const { w, co, julia, say, stuck, fromJulia } = setup()
    const t = await stuck()
    fill(w, co.id, julia.id)
    await say('the main app')
    expect(w.c.task(t.id).status).toBe('in_progress')
    expect(fromJulia().filter((m) => m.text === `Got it, back on ${t.identifier}.`)).toHaveLength(1)
  })

  it('the company’s in-flight limit does not hold an answered task (the founder said go); the seat’s cap does', async () => {
    const { w, co, say, stuck } = setup()
    const t = await stuck()
    w.c.setAutopilot(co.id, false, 1)
    const other = w.task({ companyId: co.id, title: 'Someone else’s work' })
    w.db.prepare("UPDATE company_tasks SET status='in_progress', run_id='r_other', data=json_set(data,'$.status','in_progress','$.runId','r_other') WHERE id=?").run(other.id)
    await say('the main app')
    expect(w.c.task(t.id).status).toBe('in_progress')
  })

  it('a paused agent: says so', async () => {
    const { w, julia, say, stuck, fromJulia } = setup()
    const t = await stuck()
    w.c.departments.pauseAgent(julia.id)
    await say('the main app')
    expect(w.c.task(t.id).status).toBe('todo')
    expect(fromJulia().filter((m) => m.text.startsWith('Got it')).map((m) => m.text)).toEqual([`Got it. Product Lead is paused; ${t.identifier} starts when you resume Product Lead.`])
  })
})

describe('only an answer is routed to the question', () => {
  it('"are u working on it? or what?" goes to the agent, who gets the task’s live state; no model call, nothing passed on', async () => {
    let prompt = ''
    const { w, say, stuck, calls, replyTurns, fromJulia } = setup({
      reply: async (turn) => {
        prompt = turn.prompt
        return null
      }
    })
    const t = await stuck()
    const before = replyTurns()
    await say('are u working on it? or what?')
    expect(calls).toHaveLength(0)
    expect(w.c.task(t.id)).toMatchObject({ status: 'blocked', blockReason: 'needs_input' })
    expect(w.c.detail(t.id).activity.some((a) => a.kind === 'answered')).toBe(false)
    expect(fromJulia().some((m) => /back on/i.test(m.text))).toBe(false)
    await w.drain()
    expect(replyTurns()).toBe(before + 1)
    expect(prompt).toContain('Tasks filed in this conversation, live now:')
    expect(prompt).toContain(`- ${t.identifier} “Landing page”: waiting for the person's answer: “`)
    expect(prompt).toContain('A status question is never an answer')
  })

  it('the classifier says status_question: the agent answers it', async () => {
    const { w, say, stuck, setKind, calls, replyTurns } = setup()
    const t = await stuck()
    setKind('{"kind":"status_question"}')
    const before = replyTurns()
    await say('so where do we stand with the page')
    expect(calls).toHaveLength(1)
    expect(w.c.task(t.id).status).toBe('blocked')
    await w.drain()
    expect(replyTurns()).toBe(before + 1)
  })

  it('an option said back routes without a model call', async () => {
    const { w, conv, say, stuck, calls } = setup()
    const t = await stuck()
    const q = w.forum.openTaskAsks(conv.id)[0]!
    w.forum.store.patchPayload(q.id, { ask: { ...q.ask!, options: ['Main app', 'New app'] } })
    await say('main app.')
    expect(calls).toHaveLength(0)
    expect(w.c.task(t.id).status).toBe('in_progress')
  })

  it('the classifier fails or times out: the agent handles it, nothing is auto-routed', async () => {
    const { w, say, stuck, setKind, replyTurns } = setup()
    const t = await stuck()
    setKind(async () => {
      throw new Error('the route call failed')
    })
    const before = replyTurns()
    await say('main app')
    expect(w.c.task(t.id).status).toBe('blocked')
    await w.drain()
    expect(replyTurns()).toBe(before + 1)
    // no model at all (no Claude CLI): the same
    w.replyKind = null
    await say('the main one')
    expect(w.c.task(t.id).status).toBe('blocked')
  })
})

describe('the agent starts a filed task when the founder says go', () => {
  const goAhead = (said: { prompt: string; result: string }, task: () => string, from: 'owner' | 'agent' = 'owner') => async (turn: Turn, world: OrchWorld) => {
    said.prompt = turn.prompt
    const me = world.forum.store.memberForAgent(turn.agentId)!
    const owner = world.forum.store.owner(me.companyId)
    const last = world.posts(me.companyId).filter((m) => m.authorId === (from === 'owner' ? owner.id : me.id)).pop()!
    const caller = { companyId: me.companyId, memberId: me.id, runId: turn.run.id, stepId: turn.owner.stepId, taskId: null }
    said.result = await world.forum.api.call(caller, 'forum_reply', { to: last.ref, text: `Starting ${task()} now.`, start_task: task() })
    return null
  }

  it('forum_reply start_task on "go ahead" starts the task (autopilot off, manual seat)', async () => {
    const said = { prompt: '', result: '' }
    let id = ''
    const { w, owner, julia, conv, say, fromJulia } = setup({ fileFirst: false, reply: goAhead(said, () => id) })
    // the founder made it a task themselves (Make task): it waits for their word
    const req = w.forum.store.post(owner.id, { channelId: conv.id, text: 'Pricing page for the new plan' })
    const t = w.forum.toTask(req.id, owner.id, julia.id)
    id = t.identifier
    await w.drain()
    expect(w.c.task(t.id).status).toBe('todo')
    await say('go ahead, start it')
    await w.drain()
    expect(said.prompt).toContain('Tasks filed in this conversation, live now:')
    expect(said.prompt).toContain(`- ${t.identifier} “Pricing page for the new plan”: not started yet: Autopilot is off in Vibiz`)
    expect(said.prompt).toContain(`"start_task":"${t.identifier}"`)
    expect(said.result).toContain(`${t.identifier} started`)
    expect(w.turns.some((x) => x.kind === 'task' && x.taskId === t.id)).toBe(true)
    expect(fromJulia().some((m) => m.text === `Starting ${t.identifier} now.`)).toBe(true)
  })

  it('cannot start: the reply says what holds it instead of "Starting"', async () => {
    const said = { prompt: '', result: '' }
    let id = ''
    const { w, owner, julia, conv, say, fromJulia } = setup({ fileFirst: false, reply: goAhead(said, () => id) })
    const req = w.forum.store.post(owner.id, { channelId: conv.id, text: 'Pricing page for the new plan' })
    const t = w.forum.toTask(req.id, owner.id, julia.id)
    id = t.identifier
    const dep = w.task({ companyId: t.companyId, agentId: julia.id, title: 'First this' })
    w.c.updateTask(t.id, { dependencyIds: [dep.id] })
    await say('go ahead')
    await w.drain()
    expect(said.result).toContain('did not start')
    expect(fromJulia().map((m) => m.text)).toContain(`${t.identifier} starts as soon as its dependencies are done.`)
    expect(fromJulia().some((m) => m.text.startsWith('Starting'))).toBe(false)
  })

  it('only on a person’s message, and only a task of this conversation', async () => {
    const said = { prompt: '', result: '' }
    let id = 'VO-99'
    const { w, co, julia, say } = setup({ fileFirst: false, reply: goAhead(said, () => id) })
    // a task of another conversation (or none): refused
    const elsewhere = w.task({ companyId: co.id, agentId: julia.id, title: 'Elsewhere' })
    id = elsewhere.identifier
    await say('go ahead')
    await w.drain()
    expect(said.result).toContain('was not filed in this conversation: not started')
    expect(w.c.task(elsewhere.id).status).toBe('todo')
  })
})
