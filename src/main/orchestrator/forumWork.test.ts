/**
 * Step 2 of the PM's list: when a person asks an agent in the Forum to do something or put it on the board, the agent
 * files the task itself (forum_reply's task field), or Principia files it from the reply run's report when the
 * agent has no Forum tools. Nobody tells the founder to press Make task.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { buildReplyPrompt } from '../forum/responder'
import { OrchWorld, report } from './__tests__/world'

const worlds: OrchWorld[] = []
afterEach(() => {
  while (worlds.length) worlds.pop()!.dispose()
})

function setup() {
  const w = new OrchWorld()
  worlds.push(w)
  const co = w.company()
  const mkt = w.department(co.id, 'Marketing', 'marketing')
  const owner = w.forum.store.owner(co.id)
  w.forum.onHumanPost = (m) => void w.responder.onHumanPost(m)
  const room = w.forum.store.channels(co.id, owner.id).find((c) => c.departmentId === mkt.id)!
  const say = (text: string) => w.forum.humanPosted(w.forum.store.post(owner.id, { channelId: room.id, text }))
  return { w, co, mkt, owner, room, say }
}

describe('the Forum reply rules', () => {
  it('tell the agent to put asked-for work on the Board itself, never to send the person to Make task', () => {
    const p = buildReplyPrompt({ seat: { name: 'Brand Voice Writer', instructions: '' }, department: 'Marketing', me: 'marcus', channel: '#marketing', messages: [{ ref: 'm1', author: 'you', text: 'put a post about the sale on the board' }], thread: [], replyTo: 'm1' })
    expect(p).toContain('put it on the Board yourself, now')
    expect(p).toContain('"task":{"title":"…"}')
    expect(p).toContain('Never ask them to press Make task')
    expect(p).toContain('"followUps"')
    expect(p).not.toMatch(/suggest (the )?Make task/i)
  })
})

describe('a person asks an agent for work in the Forum', () => {
  it('an agent without Forum tools: Principia files its report follow-up for that agent, in To do, once', async () => {
    const { w, co, mkt, room, say } = setup()
    const marcus = w.seat(co.id, mkt, 'Brand Voice Writer', 'codex', 'manual', () => ({
      output: `On it: a post about the autumn sale is on the Board.\n\n${report({ outcome: 'answered', summary: 'Said I will write it', followUps: [{ title: 'Write a post about the autumn sale', goal: 'One Instagram post, warm and plain' }] }).replace(/^Done\.\n\n/, '')}`
    }))
    say(`@${w.handle(marcus.id)} put a post about the autumn sale on the board`)
    await w.drain()
    const t = w.c.listTasks(co.id).find((x) => x.title === 'Write a post about the autumn sale')!
    expect(t).toMatchObject({ agentId: marcus.id, status: 'todo' })
    expect(t.description).toContain('a request in the Forum')
    expect(t.description).toContain('autumn sale on the board')
    const lines = (w.db.prepare('SELECT text FROM forum_messages WHERE channel_id=?').all(room.id) as { text: string }[]).map((m) => m.text)
    expect(lines.some((l) => l.includes(`started ${t.identifier}: ${t.title}`))).toBe(true)
    // the reply never sends the founder to Make task
    expect(lines.join(' ')).not.toMatch(/Make task/)
  })

  it('an agent that filed it with forum_reply: the same request in its report is not filed twice', async () => {
    const { w, co, mkt, say } = setup()
    const marcus = w.seat(co.id, mkt, 'Brand Voice Writer', 'claude', 'manual', async (turn, world) => {
      const me = world.forum.store.memberForAgent(turn.agentId)!
      const ask = world.posts(co.id).find((m) => m.text.includes('autumn sale'))!
      await world.forum.api.call({ companyId: co.id, memberId: me.id, runId: turn.run.id, stepId: turn.owner.stepId, taskId: null }, 'forum_reply', { to: ask.ref, text: 'On the Board.', task: { title: 'Autumn sale post' } })
      return { output: report({ outcome: 'answered', summary: 'Filed it', followUps: [{ title: 'Write the autumn sale post', goal: '' }] }) }
    })
    say(`@${w.handle(marcus.id)} put a post about the autumn sale on the board`)
    await w.drain()
    const filed = w.c.listTasks(co.id).filter((x) => /autumn sale/i.test(x.title))
    expect(filed.map((x) => x.title)).toEqual(['Autumn sale post'])
    const reply = w.turns.find((t) => t.kind === 'reply')!
    expect(w.orch(reply.run.id)!.actions.find((a) => a.kind === 'follow_up')).toMatchObject({ status: 'skipped' })
  })
})
