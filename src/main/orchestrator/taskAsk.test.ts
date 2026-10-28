/**
 * CHAT-UI.md §8: a task filed from a conversation that stops for the founder comes back there as its filer's own
 * message (the whole question, once per ask), the founder answers in the conversation like any other message, and the
 * answer reaches the task: straight away when it clearly answers the one open question, else through the agent
 * (forum_reply answer_task). When the task is done, the agent says the result there too.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { OrchWorld, report, type Turn } from './__tests__/world'
import type { ForumMessage } from '../../shared/forum'

const worlds: OrchWorld[] = []
afterEach(() => {
  while (worlds.length) worlds.pop()!.dispose()
})

const BLOCKED = report({
  outcome: 'blocked',
  summary: 'The posts were made by the autopilot, but I could not see which workspace member turned it on',
  blockers: [{ needs: 'access', text: "Can't read production rows (social_post, vagent_autopilot_proposals) to see who created those posts" }]
})

function setup(opts: { reply?: (turn: Turn, w: OrchWorld, n: number) => Promise<string | null> } = {}) {
  const w = new OrchWorld()
  worlds.push(w)
  const co = w.company('Vibiz')
  const ops = w.department(co.id, 'Operations', 'ops')
  const owner = w.forum.store.owner(co.id)
  w.forum.onHumanPost = (m) => void w.responder.onHumanPost(m)
  let replies = 0
  let taskRuns = 0
  const taskAnswers: string[] = []
  const julia = w.seat(co.id, ops, 'Support Lead', 'claude', 'manual', async (turn, world) => {
    if (turn.kind === 'task') {
      taskRuns++
      if (taskRuns > 1) taskAnswers.push(turn.prompt)
      return { output: taskRuns === 1 ? BLOCKED : report({ outcome: 'review', summary: 'Checked the PostHog events: Ana created both posts from the Autopilot tab on 24 Oct' }) }
    }
    replies++
    const me = world.forum.store.memberForAgent(turn.agentId)!
    const caller = { companyId: co.id, memberId: me.id, runId: turn.run.id, stepId: turn.owner.stepId, taskId: null }
    if (replies === 1) {
      const ask = world.posts(co.id).find((m) => m.text.includes('who created'))!
      await world.forum.api.call(caller, 'forum_reply', { to: ask.ref, text: "I started {task}: Check who created the posts. I'll post the result here.", task: { title: 'Check who created the posts' } })
    } else if (opts.reply) {
      const out = await opts.reply(turn, world, replies)
      if (out) return { output: out }
    }
    return { output: report({ outcome: 'answered', summary: 'Replied' }) }
  })
  const jm = w.forum.store.memberForAgent(julia.id)!
  const conv = w.forum.store.createChannel(owner.id, { name: 'chat-posts-ab12', kind: 'private', memberIds: [jm.id] })
  // as handlers/forum.ts forum:post does (the desktop composer and the phone both post through it)
  const say = (text: string, threadId?: string): ForumMessage => {
    const msg = w.forum.store.post(owner.id, { channelId: conv.id, text, ...(threadId ? { threadId } : {}) })
    let answered = false
    if (msg.threadId) {
      const root = w.forum.store.message(msg.threadId)
      if (root.kind === 'ask' && root.ask?.status === 'open') {
        w.forum.answer(root.id, owner.id, text, msg.id)
        answered = true
      }
    }
    if (!answered) answered = !!w.forum.routeTaskReply(msg, owner.id)
    if (!answered) w.forum.humanPosted(msg)
    return msg
  }
  const inConv = (): ForumMessage[] => (w.db.prepare('SELECT seq FROM forum_messages WHERE channel_id=? ORDER BY seq').all(conv.id) as { seq: number }[]).map((r) => w.forum.store.message(r.seq))
  /** the task blocked on its first run, its question in the conversation */
  const stuck = async () => {
    say('can you check who created the social posts for maria@example.com?')
    await w.drain()
    const t = w.c.listTasks(co.id).find((x) => /who created/.test(x.title))!
    await w.runNow(t.id)
    await w.drain()
    w.forum.reconcileTaskCards(co.id, { post: true })
    return t
  }
  const questions = (taskId: string) => inConv().filter((m) => m.kind === 'ask' && m.ask?.taskId === taskId)
  return { w, co, owner, julia, jm, conv, say, inConv, stuck, questions, taskAnswers, replyTurns: () => w.turns.filter((t) => t.kind === 'reply').length }
}

describe('a task that stops for the founder asks in its conversation', () => {
  it('posts the whole question once, as the agent who filed it, with what it found so far', async () => {
    const { w, co, jm, stuck, questions, inConv } = setup()
    const t = await stuck()
    expect(w.c.task(t.id)).toMatchObject({ status: 'blocked', blockReason: 'needs_input' })
    const qs = questions(t.id)
    expect(qs).toHaveLength(1)
    const q = qs[0]!
    expect(q.authorId).toBe(jm.id)
    expect(q.ask).toMatchObject({ status: 'open', taskId: t.id })
    expect(q.text).toBe(
      `${t.identifier} is stuck and needs you.\n` +
        'So far: The posts were made by the autopilot, but I could not see which workspace member turned it on\n' +
        "I need access: Can't read production rows (social_post, vagent_autopilot_proposals) to see who created those posts\n" +
        `Reply here and I'll pass it on to ${t.identifier}.`
    )
    // no separate "VO-1: <summary>" update before it: the question says it
    const runId = w.c.task(t.id).runId!
    expect(inConv().filter((m) => m.origin === `principia:${runId}` && m.kind !== 'system')).toHaveLength(0)
    expect(w.orch(runId)!.actions.some((a) => a.kind === 'post' && a.status === 'skipped' && /question goes to the conversation/.test(a.detail))).toBe(true)
    // the card points at it; reconciling again never asks twice
    const card = inConv().find((m) => m.task)!
    expect(card.task).toMatchObject({ state: 'needs_you', askMessageId: q.id })
    w.forum.reconcileTaskCards(co.id, { post: true })
    w.forum.reconcileTaskCards(co.id, { post: true })
    expect(questions(t.id)).toHaveLength(1)
    // the Forum's ask badge does not count it again (the task is in Needs you already)
    expect(w.forum.state(co.id).openAsks).toBe(0)
  })

  it('routes the founder’s next message to the task, confirms, and the result comes back as the agent', async () => {
    const { w, co, jm, say, stuck, questions, inConv, taskAnswers, replyTurns } = setup()
    const t = await stuck()
    const before = replyTurns()
    say('Use the PostHog events instead')
    // straight to the task: no reply run for the agent, one confirmation line from it
    expect(replyTurns()).toBe(before)
    expect(w.c.task(t.id)).toMatchObject({ status: 'todo', ask: { answer: 'Use the PostHog events instead' } })
    expect(questions(t.id)[0]!.ask).toMatchObject({ status: 'answered', answer: 'Use the PostHog events instead' })
    const acks = inConv().filter((m) => m.authorId === jm.id && m.text === `Got it, back on ${t.identifier}.`)
    expect(acks).toHaveLength(1)
    // the same agent resumes with the answer
    await w.runNow(t.id)
    await w.drain()
    expect(taskAnswers.join('\n')).toContain('Use the PostHog events instead')
    expect(w.c.task(t.id).status).toBe('in_review')
    w.forum.reconcileTaskCards(co.id, { post: true })
    const runId = w.c.task(t.id).runId!
    const back = inConv().filter((m) => m.origin === `principia:${runId}` && m.kind !== 'system')
    expect(back).toHaveLength(1)
    expect(back[0]!.authorId).toBe(jm.id)
    expect(back[0]!.text).toBe(`${t.identifier} is ready for your review. Checked the PostHog events: Ana created both posts from the Autopilot tab on 24 Oct`)
    // nothing asked again, nothing confirmed twice
    expect(questions(t.id)).toHaveLength(1)
    expect(inConv().filter((m) => m.text.startsWith('Got'))).toHaveLength(1)
  })

  it('a reply in the question’s thread (the card’s Answer) answers it too', async () => {
    const { w, say, stuck, questions } = setup()
    const t = await stuck()
    say('Paste: ana@example.com made both', questions(t.id)[0]!.id)
    expect(w.c.task(t.id).ask?.answer).toBe('Paste: ana@example.com made both')
  })

  it('something else goes to the agent, who passes the answer on with forum_reply answer_task', async () => {
    let prompt = ''
    const { w, co, jm, say, stuck, questions, inConv, replyTurns } = setup({
      reply: async (turn, world) => {
        prompt = turn.prompt
        const me = world.forum.store.memberForAgent(turn.agentId)!
        const last = world.posts(co.id).filter((m) => m.authorId !== me.id).pop()!
        const t = world.c.listTasks(co.id)[0]!
        await world.forum.api.call({ companyId: co.id, memberId: me.id, runId: turn.run.id, stepId: turn.owner.stepId, taskId: null }, 'forum_reply', {
          to: last.ref,
          text: `Sure, I'll look at the funnel after. Got it, back on ${t.identifier}.`,
          answer_task: { task: t.identifier, answer: 'Check the PostHog events instead' }
        })
        return null
      }
    })
    const t = await stuck()
    const before = replyTurns()
    say('also, can you check the signup funnel? and for the posts just check the PostHog events instead')
    // not clearly an answer: the agent gets it, told about the open question
    expect(w.c.task(t.id).ask?.answer).toBeUndefined()
    await w.drain()
    expect(replyTurns()).toBe(before + 1)
    expect(prompt).toContain(`Still waiting for the person in this conversation: ${t.identifier}`)
    expect(prompt).toContain('"answer_task":{"task":')
    expect(w.c.task(t.id)).toMatchObject({ status: 'todo', ask: { answer: 'Check the PostHog events instead' } })
    expect(questions(t.id)[0]!.ask?.status).toBe('answered')
    // the agent's own reply is the confirmation: no second line from Principia
    expect(inConv().filter((m) => m.authorId === jm.id && /back on/.test(m.text))).toHaveLength(1)
  })

  it('two open questions: nothing is guessed, the agent decides', async () => {
    const { w, co, say, stuck, questions } = setup()
    const t = await stuck()
    // a second task of the same conversation waiting too
    const q1 = questions(t.id)[0]!
    w.forum.store.post(q1.authorId, { channelId: q1.channelId, text: 'Second question', kind: 'ask', ask: { status: 'open', to: [w.forum.store.owner(co.id).id], taskId: t.id } })
    expect(w.forum.routeTaskReply(say('Use PostHog'), w.forum.store.owner(co.id).id)).toBeNull()
    expect(w.c.task(t.id).ask?.answer).toBeUndefined()
  })

  it('answered elsewhere (the drawer, the phone’s Needs you): the question closes and the agent says so once', async () => {
    const { w, co, jm, stuck, questions, inConv } = setup()
    const t = await stuck()
    w.c.answer(t.id, 'Read-only access is fine, ask Ana for it')
    w.forum.reconcileTaskCards(co.id, { post: true })
    w.forum.reconcileTaskCards(co.id, { post: true })
    expect(questions(t.id)[0]!.ask).toMatchObject({ status: 'answered', answer: 'Read-only access is fine, ask Ana for it' })
    expect(inConv().filter((m) => m.authorId === jm.id && m.text === `Got your answer. Back on ${t.identifier}.`)).toHaveLength(1)
  })
})
