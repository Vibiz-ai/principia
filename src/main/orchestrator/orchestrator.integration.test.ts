/**
 * ORCHESTRATOR.md §9: end to end over the real board, Forum and Principia's layer (see __tests__/world.ts), with a stub
 * Codex harness that never calls a tool. One Codex step ends with a run report; Principia alone turns it into the team
 * update, a follow-up that an automatic teammate then picks up, and a question that wakes another teammate. Replayed
 * twice, the transcripts are identical; nothing loops.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { OrchWorld, report } from './__tests__/world'

const worlds: OrchWorld[] = []
afterEach(() => {
  while (worlds.length) worlds.pop()!.dispose()
})

async function scenario(): Promise<string> {
  const w = new OrchWorld()
  worlds.push(w)
  const co = w.company('Northwind')
  const dev = w.department(co.id, 'Development', 'development')
  const mkt = w.department(co.id, 'Marketing', 'marketing')
  const sup = w.department(co.id, 'Support', 'support')
  w.seat(co.id, sup, 'Helper', 'codex', 'manual', (t) => {
    expect(t.kind).toBe('reply')
    return { output: 'Three customers reported it this week.' }
  })
  const writer = w.seat(co.id, mkt, 'Copywriter', 'codex', 'auto', () => ({ output: report({ outcome: 'review', summary: 'Release note drafted' }) }))
  const fixer = w.seat(co.id, dev, 'Bug fixer', 'codex', 'manual', (t) => {
    // a plain Codex step: it only sees its prompt with Principia's block, and writes its answer
    expect(t.context).toContain('principia-run-report')
    return {
      output: report({
        outcome: 'review',
        summary: 'Fixed the double charge at checkout',
        evidence: ['src/checkout.ts', 'npm test: 212 passed'],
        followUps: [{ title: 'Write a release note about the checkout fix', goal: 'customers saw double charges', departmentKey: 'marketing' }],
        questions: [{ to: '@support', question: 'How many customers reported the double charge?', why: 'for the release note', blocking: false }]
      })
    }
  })
  const task = w.task({ companyId: co.id, title: 'Customers are charged twice', departmentId: dev.id, agentId: fixer.id })
  await w.runNow(task.id)
  await w.drain()

  // the post: one update from the Codex seat, via Principia, in #development
  const fixerMember = w.forum.store.memberForAgent(fixer.id)!
  const updates = w.posts(co.id).filter((m) => m.authorId === fixerMember.id && m.kind === 'text')
  expect(updates).toHaveLength(1)
  expect(updates[0].via).toBe('principia')
  expect(w.forum.store.channel(updates[0].channelId).name).toBe('development')
  // the follow-up: filed for the automatic copywriter (To do), which the dispatcher then ran
  const note = w.c.listTasks(co.id).find((t) => t.title.startsWith('Write a release note'))!
  expect(note.agentId).toBe(writer.id)
  expect(note.status).toBe('in_review')
  // the wake: the question reached Support's helper in a reply run on its own (Codex) harness, which answered it
  const ask = w.posts(co.id).find((m) => m.kind === 'ask')!
  expect(ask.ask?.status).toBe('answered')
  expect(ask.ask?.answer).toBe('Three customers reported it this week.')
  expect(w.turns.map((t) => `${t.kind}:${w.c.departments.getAgent(t.agentId)!.name}`)).toEqual(['task:Bug fixer', 'reply:Helper', 'task:Copywriter'])
  expect(w.c.task(task.id).status).toBe('in_review')
  const o = w.orch(w.turns[0].run.id)!
  expect(o.actions.map((a) => `${a.kind}:${a.status}`)).toEqual(['post:done', 'follow_up:done', 'question:done'])

  // the transcript, ids normalised
  const ids = new Map<string, string>()
  const norm = (s: string) => s.replace(/\b(r_orch\d+|st_r_orch\d+|task_[0-9a-f]+|agt_[0-9a-f]+|fmsg_[0-9a-z]+|m[0-9a-z]{1,4}\b)/g, (x) => {
    if (!ids.has(x)) ids.set(x, `<${ids.size}>`)
    return ids.get(x)!
  })
  return norm(JSON.stringify({
    turns: w.turns.map((t) => [t.kind, w.c.departments.getAgent(t.agentId)!.name]),
    tasks: w.c.listTasks(co.id).map((t) => [t.title, t.status, t.blockReason]),
    actions: w.turns.map((t) => w.orch(t.run.id)?.actions.map((a) => [a.kind, a.status, a.detail]) ?? null),
    posts: w.posts(co.id).map((m) => [m.kind, m.via ?? 'agent', m.text])
  }))
}

describe('orchestrator end to end (stub Codex)', () => {
  it('a report becomes a post, a follow-up and a wake, the same way every time', async () => {
    const a = await scenario()
    const b = await scenario()
    expect(a).toBe(b)
  })
})
