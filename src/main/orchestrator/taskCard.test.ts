/**
 * CHAT-UI.md §8: a task started from a conversation shows as a live card there, the agent says plainly that it
 * started it, a second agent never files the same request again, and the result comes back into the conversation.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { OrchWorld, report, type Turn } from './__tests__/world'
import type { ForumMessage } from '../../shared/forum'

const worlds: OrchWorld[] = []
afterEach(() => {
  while (worlds.length) worlds.pop()!.dispose()
})

function setup(opts: { taskOutput?: string } = {}) {
  const w = new OrchWorld()
  worlds.push(w)
  const co = w.company()
  const mkt = w.department(co.id, 'Marketing', 'marketing')
  const owner = w.forum.store.owner(co.id)
  w.forum.onHumanPost = (m) => void w.responder.onHumanPost(m)
  const results: Record<string, string> = {}
  const script = () => async (turn: Turn, world: OrchWorld) => {
    if (turn.kind === 'task') return { output: opts.taskOutput ?? report({ outcome: 'review', summary: 'Rewrote the UGC landing hero; the PostHog funnel shows where people drop' }) }
    const me = world.forum.store.memberForAgent(turn.agentId)!
    const ask = world.posts(co.id).find((m) => m.text.includes('conversion'))!
    const caller = { companyId: co.id, memberId: me.id, runId: turn.run.id, stepId: turn.owner.stepId, taskId: null }
    results[me.name] = String(await world.forum.api.call(caller, 'forum_reply', { to: ask.ref, text: "I started {task}: Lift UGC conversion. I'll post the result here.", task: { title: 'Lift UGC conversion' } }))
    return { output: report({ outcome: 'answered', summary: 'Replied' }) }
  }
  const julia = w.seat(co.id, mkt, 'Growth Analyst', 'claude', 'manual', script())
  const junia = w.seat(co.id, mkt, 'Copywriter', 'claude', 'manual', script())
  const jm = w.forum.store.memberForAgent(julia.id)!
  const um = w.forum.store.memberForAgent(junia.id)!
  const conv = w.forum.store.createChannel(owner.id, { name: 'chat-ugc-conversion-ab12', kind: 'private', memberIds: [jm.id, um.id] })
  const say = (text: string) => w.forum.humanPosted(w.forum.store.post(owner.id, { channelId: conv.id, text }))
  const inConv = (): ForumMessage[] => (w.db.prepare('SELECT seq FROM forum_messages WHERE channel_id=? ORDER BY seq').all(conv.id) as { seq: number }[]).map((r) => w.forum.store.message(r.seq))
  return { w, co, mkt, owner, julia, junia, jm, um, conv, say, inConv, results }
}

describe('a task started from a conversation', () => {
  it('is said plainly, carded under the reply, and filed once even when two agents answer', async () => {
    const { w, co, jm, um, say, inConv, results } = setup()
    say('we need to get more conversion in vibiz ugc… check posthog')
    await w.drain()
    const tasks = w.c.listTasks(co.id).filter((t) => /UGC conversion/.test(t.title))
    expect(tasks).toHaveLength(1)
    const t = tasks[0]!
    // one card, a system line with the task payload, right under the filer's reply (no grey "made … from this message")
    const msgs = inConv()
    const cards = msgs.filter((m) => m.task)
    expect(cards).toHaveLength(1)
    const filer = cards[0]!.task!.filedBy === jm.id ? jm : um
    const other = filer === jm ? um : jm
    const said = msgs.find((m) => m.authorId === filer.id && m.kind === 'text')!
    expect(said.text).toBe(`I started ${t.identifier}: Lift UGC conversion. I'll post the result here.`)
    expect(cards[0]!.seq).toBeGreaterThan(said.seq)
    expect(cards[0]!.text).toBe(`${filer.name} started ${t.identifier}: Lift UGC conversion`)
    expect(cards[0]!.task).toMatchObject({ taskId: t.id, identifier: t.identifier, agentId: filer.agentId, state: 'queued' })
    // the second agent hears who is on it and files nothing
    expect(results[other.name]).toMatch(new RegExp(`already filed as ${t.identifier} by ${filer.name}: not filed again`))
    // and its reply does not claim the work
    const second = msgs.find((m) => m.authorId === other.id && m.kind === 'text')!
    expect(second.text).toBe(`${filer.name} already started ${t.identifier}: Lift UGC conversion. ${filer.name} will post the result here.`)
    expect(msgs.some((m) => /from this message/.test(m.text))).toBe(false)
    expect(w.forum.conversationOfTask(t.id)).toBe(cards[0]!.channelId)
  })

  it('posts the result back into the conversation, not the department channel, and the card updates in place', async () => {
    const { w, co, mkt, owner, say, inConv } = setup()
    say('we need to get more conversion in vibiz ugc… check posthog')
    await w.drain()
    const t = w.c.listTasks(co.id).find((x) => /UGC conversion/.test(x.title))!
    const card = inConv().find((m) => m.task)!
    await w.runNow(t.id)
    // working: the stored card follows the task
    w.forum.reconcileTaskCards(co.id)
    expect(w.forum.store.message(card.seq).task).toMatchObject({ state: 'working', runId: w.c.task(t.id).runId })
    await w.drain()
    expect(w.c.task(t.id).status).toBe('in_review')
    const runId = w.c.task(t.id).runId!
    const back = inConv().filter((m) => m.kind !== 'system' && m.origin === `principia:${runId}`)
    expect(back).toHaveLength(1)
    expect(back[0]!.text).toContain('Rewrote the UGC landing hero')
    const room = w.forum.store.channels(co.id, owner.id).find((c) => c.departmentId === mkt.id)!
    expect((w.db.prepare('SELECT COUNT(*) n FROM forum_messages WHERE channel_id=? AND origin=?').get(room.id, `principia:${runId}`) as { n: number }).n).toBe(0)
    // the card: same message, now In review with the one-line result; no second result post
    const before = inConv().length
    w.forum.reconcileTaskCards(co.id, { post: true })
    w.forum.reconcileTaskCards(co.id, { post: true })
    expect(inConv()).toHaveLength(before)
    const now = w.forum.store.message(card.seq)
    expect(now.id).toBe(card.id)
    expect(now.task).toMatchObject({ state: 'in_review', result: 'Rewrote the UGC landing hero; the PostHog funnel shows where people drop', resultFor: runId })
    expect(now.task!.finishedAt).toBeTruthy()
    // approved: Done, and main stops following it
    w.c.approve(t.id, 'Shipped')
    w.forum.reconcileTaskCards(co.id, { post: true })
    expect(w.forum.store.message(card.seq).task).toMatchObject({ state: 'done', final: true })
    expect(w.forum.store.taskCards(co.id, { open: true })).toHaveLength(0)
  })

  it('without Principia’s report the agent’s own answer still lands in the conversation, once', async () => {
    const { w, co, say, inConv } = setup({ taskOutput: 'Rewrote the hero and checked the funnel.' })
    w.settings = { mode: 'off', extractFallback: false }
    say('we need to get more conversion in vibiz ugc… check posthog')
    await w.drain()
    const t = w.c.listTasks(co.id).find((x) => /UGC conversion/.test(x.title))!
    await w.runNow(t.id)
    await w.drain()
    const runId = w.c.task(t.id).runId!
    w.forum.reconcileTaskCards(co.id, { post: true })
    const back = inConv().filter((m) => m.kind !== 'system' && m.createdAt && m.text.includes('Rewrote the hero'))
    expect(back).toHaveLength(1)
    expect(back[0]!.text).toContain(t.identifier)
    expect(w.forum.resultPosted(t.id, runId)).toBe(true)
  })
})
