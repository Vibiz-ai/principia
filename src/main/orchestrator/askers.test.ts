/**
 * ORCHESTRATOR.md §1.1, §2: an agent finds its teammates by name (the context lists them), and every way it can ask one
 * from a task run picks the task back up when the answer comes: a run report question, forum_ask_agent (Codex ends its
 * turn after asking; Claude may wait), and a question by @mention. The answer reaches the next turn once.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { OrchWorld, report, type Turn } from './__tests__/world'
import type { CompanyAgent } from '../../shared/company'

const worlds: OrchWorld[] = []
afterEach(() => {
  while (worlds.length) worlds.pop()!.dispose()
})

function setup(asker: 'auto' | 'manual' = 'manual') {
  const w = new OrchWorld()
  worlds.push(w)
  const co = w.company()
  const mkt = w.department(co.id, 'Marketing', 'marketing')
  const dev = w.department(co.id, 'Development', 'development')
  const marcus = w.seat(co.id, mkt, 'Brand Voice Writer', 'claude', 'manual', () => ({ output: 'Warm and plain, no exclamation marks.' }))
  const coder = w.seat(co.id, dev, 'Web Developer', 'codex', asker)
  return { w, co, mkt, dev, marcus, coder, name: w.forum.store.memberForAgent(marcus.id)!.name }
}
const caller = (w: OrchWorld, t: Turn, a: CompanyAgent) => ({ companyId: a.companyId, memberId: w.forum.store.memberForAgent(a.id)!.id, runId: t.run.id, stepId: t.owner.stepId, taskId: t.taskId })

describe('teammates by name', () => {
  it('the context lists every teammate as @handle (role, department); a report question to "Name, Role" reaches them', async () => {
    const { w, co, dev, marcus, coder, name } = setup()
    // another company has a seat with the same role: never reached from here
    const other = w.company('Other')
    const otherMkt = w.department(other.id, 'Marketing', 'marketing')
    w.seat(other.id, otherMkt, 'Brand Voice Writer', 'claude', 'manual', () => ({ output: 'WRONG COMPANY' }))
    let n = 0
    w.scripts.set(coder.id, (t) => {
      n++
      if (n === 1) {
        expect(t.context).toContain(`@${w.handle(marcus.id)}`)
        expect(t.context).toContain('(Brand Voice Writer, Marketing)')
        return { output: report({ outcome: 'blocked', summary: 'Waiting on the tone', questions: [{ to: `${name}, Brand Voice Writer`, question: 'Which tone for the hero line?', why: '', blocking: true }] }) }
      }
      return { output: report({ outcome: 'review', summary: 'Hero line done' }) }
    })
    const t = w.task({ companyId: co.id, title: 'Hero line', departmentId: dev.id, agentId: coder.id })
    await w.runNow(t.id)
    await w.drain()
    const q = w.orch(w.turns[0].run.id)!.actions.find((a) => a.kind === 'question')!
    expect(q.status).toBe('done')
    expect(q.detail).toContain(`@${w.handle(marcus.id)}`)
    expect(w.posts(co.id).some((m) => m.text.includes('WRONG COMPANY'))).toBe(false)
    expect(w.posts(other.id).filter((m) => m.kind !== 'system')).toHaveLength(0)
    expect(w.c.task(t.id).pendingWake?.reasons.join(' ')).toContain('Warm and plain')
  })

  it('a name nobody has is refused with the teammates to pick from', async () => {
    const { w, co, dev, coder, marcus } = setup()
    w.scripts.set(coder.id, () => ({ output: report({ outcome: 'review', summary: 'S', questions: [{ to: 'Cicero', question: 'Any thoughts?', why: '', blocking: false }] }) }))
    const t = w.task({ companyId: co.id, title: 'T', departmentId: dev.id, agentId: coder.id })
    await w.runNow(t.id)
    await w.drain()
    const q = w.orch(w.turns[0].run.id)!.actions.find((a) => a.kind === 'question')!
    expect(q.status).toBe('failed')
    expect(q.detail).toContain(`teammates: @${w.handle(marcus.id)}`)
  })
})

describe('a Forum-tool question from a task run picks the task back up', () => {
  it('forum_ask_agent, then the turn ends (Codex): the answer wakes the task, with an Activity line', async () => {
    const { w, co, dev, coder, name } = setup('manual')
    let n = 0
    w.scripts.set(coder.id, async (t, world) => {
      n++
      if (n === 1) {
        const out = await world.forum.api.call(caller(world, t, coder), 'forum_ask_agent', { to: name, question: 'Which tone for the hero line?', wait_s: 0 })
        expect(out).toMatch(/^open m/)
        return { output: report({ outcome: 'blocked', summary: 'Asked the writer about the tone' }) }
      }
      return { output: report({ outcome: 'review', summary: 'Hero line done' }) }
    })
    const t = w.task({ companyId: co.id, title: 'Hero line', departmentId: dev.id, agentId: coder.id })
    await w.runNow(t.id)
    await w.drain()
    const after = w.c.task(t.id)
    expect(after.status).toBe('todo')
    expect(after.pendingWake?.reasons.join(' ')).toContain('Warm and plain')
    const line = w.c.detail(t.id).activity.map((a) => a.message).find((l) => l.startsWith('Principia:') && l.includes('answered'))!
    expect(line).toContain('when you press Start')
    expect(line).not.toContain('Warm and plain')
    await w.runNow(t.id)
    await w.drain()
    expect(w.c.task(t.id).status).toBe('in_review')
    expect(w.turns.at(-1)!.prompt).toContain('Warm and plain')
  })

  it('forum_ask_agent plus a decision blocker in the report (Codex): the wait stays out of Needs you, the answer resumes', async () => {
    const { w, co, dev, coder, name } = setup('manual')
    let n = 0
    w.scripts.set(coder.id, async (t, world) => {
      n++
      if (n === 1) {
        await world.forum.api.call(caller(world, t, coder), 'forum_ask_agent', { to: name, question: 'Which flavour word for the tagline?', wait_s: 0 })
        return { output: report({ outcome: 'blocked', summary: 'Asked the writer', blockers: [{ needs: 'decision', text: `Awaiting ${name}'s flavour word` }] }) }
      }
      return { output: report({ outcome: 'review', summary: 'Tagline done' }) }
    })
    const t = w.task({ companyId: co.id, title: 'Tagline', departmentId: dev.id, agentId: coder.id })
    await w.runNow(t.id)
    await w.drain()
    const acts = w.orch(w.turns[0].run.id)!.actions
    expect(acts.find((a) => a.kind === 'blocker')!.status).toBe('skipped')
    expect(acts.find((a) => a.kind === 'blocker')!.detail).toContain(`@${name.toLowerCase()}`)
    const after = w.c.task(t.id)
    expect(after.ask?.answer ?? null).toBeNull()
    expect(after.ask).toBeFalsy()
    expect(after.status).toBe('todo')
    expect(after.pendingWake?.reasons.join(' ')).toContain('Warm and plain')
    const line = w.c.detail(t.id).activity.map((a) => a.message).find((l) => l.startsWith('Principia:') && l.includes('answered'))!
    expect(line).not.toContain('after you answer')
    await w.runNow(t.id)
    await w.drain()
    expect(w.c.task(t.id).status).toBe('in_review')
  })

  it('a decision blocker with no teammate asked still comes to the founder', async () => {
    const { w, co, dev, coder } = setup('manual')
    w.scripts.set(coder.id, () => ({ output: report({ outcome: 'blocked', summary: 'Need a call', blockers: [{ needs: 'decision', text: 'Pick the launch date' }] }) }))
    const t = w.task({ companyId: co.id, title: 'Launch', departmentId: dev.id, agentId: coder.id })
    await w.runNow(t.id)
    await w.drain()
    expect(w.c.task(t.id).ask?.prompt).toContain('Pick the launch date')
  })

  it('an automatic agent continues by itself', async () => {
    const { w, co, dev, coder, name } = setup('auto')
    let n = 0
    w.scripts.set(coder.id, async (t, world) => {
      n++
      if (n === 1) {
        await world.forum.api.call(caller(world, t, coder), 'forum_ask_agent', { to: `@${name.toLowerCase()}`, question: 'Which tone?', wait_s: 0 })
        return { output: report({ outcome: 'blocked', summary: 'Asked' }) }
      }
      expect(t.prompt).toContain('Warm and plain')
      return { output: report({ outcome: 'review', summary: 'Done' }) }
    })
    const t = w.task({ companyId: co.id, title: 'Hero line', departmentId: dev.id, agentId: coder.id })
    await w.runNow(t.id)
    await w.drain()
    expect(n).toBe(2)
    expect(w.c.task(t.id).status).toBe('in_review')
    expect(w.c.detail(t.id).activity.map((a) => a.message).some((l) => l.startsWith('Principia:') && l.includes('picks it up now'))).toBe(true)
  })

  it('an answer the tool was still waiting for (Claude waits) wakes nothing', async () => {
    const { w, co, dev, coder, marcus } = setup('auto')
    const me = w.forum.store.memberForAgent(marcus.id)!
    let n = 0
    w.scripts.set(coder.id, async (t, world) => {
      n++
      const asking = world.forum.api.call(caller(world, t, coder), 'forum_ask_agent', { to: `@${me.handle}`, question: 'Which tone?', wait_s: 30 })
      await new Promise((r) => setTimeout(r, 0))
      const ask = world.posts(co.id).find((m) => m.kind === 'ask')!
      world.forum.answer(ask.id, me.id, 'Warm.')
      expect(await asking).toMatch(/^answered/)
      return { output: report({ outcome: 'review', summary: 'Done with the answer' }) }
    })
    const t = w.task({ companyId: co.id, title: 'Hero line', departmentId: dev.id, agentId: coder.id })
    await w.runNow(t.id)
    await w.drain()
    expect(n).toBe(1)
    expect(w.c.task(t.id).status).toBe('in_review')
    expect(w.c.task(t.id).pendingWake).toBeFalsy()
  })

  it('a question by @mention: the reply in its thread wakes the task', async () => {
    const { w, co, dev, coder, marcus } = setup('manual')
    let n = 0
    w.scripts.set(coder.id, async (t, world) => {
      n++
      if (n === 1) {
        await world.forum.api.call(caller(world, t, coder), 'forum_post', { channel: '#marketing', text: `@${world.handle(marcus.id)} which tone for the hero line?` })
        return { output: report({ outcome: 'blocked', summary: 'Asked the writer' }) }
      }
      return { output: report({ outcome: 'review', summary: 'Done' }) }
    })
    const t = w.task({ companyId: co.id, title: 'Hero line', departmentId: dev.id, agentId: coder.id })
    await w.runNow(t.id)
    await w.drain()
    expect(w.c.task(t.id).status).toBe('todo')
    expect(w.c.task(t.id).pendingWake?.reasons.join(' ')).toContain('Warm and plain')
  })
})

describe('the update post', () => {
  it('is skipped when the only news is the wait', async () => {
    const { w, co, dev, coder, marcus } = setup('manual')
    w.scripts.set(coder.id, () => ({ output: report({ outcome: 'blocked', summary: 'Waiting on the tone', questions: [{ to: `@${w.handle(marcus.id)}`, question: 'Which tone?', why: '', blocking: true }], evidence: ['No headline drafted yet'] }) }))
    const t = w.task({ companyId: co.id, title: 'Hero line', departmentId: dev.id, agentId: coder.id })
    await w.runNow(t.id)
    await w.drain()
    const post = w.orch(w.turns[0].run.id)!.actions.find((a) => a.kind === 'post')!
    expect(post.status).toBe('skipped')
    expect(post.detail).toContain('only waits for the answer')
    expect(w.posts(co.id).filter((m) => m.via === 'principia' && m.kind !== 'ask')).toHaveLength(0)
  })
})

describe('follow-ups the run already filed', () => {
  it('task_create {agent} goes to that teammate, and the same follow-up in the report is not filed again', async () => {
    const { w, co, dev, coder, marcus, name } = setup('manual')
    w.scripts.set(coder.id, async (t, world) => {
      const out = (await world.broker.taskCall({ runId: t.run.id, stepId: t.owner.stepId }, 'task_create', { title: `${name}: Write matching holiday box ad body copy`, agent: name }, {})) as { task: { identifier: string } }
      const id = out.task.identifier
      return { output: report({ outcome: 'review', summary: 'Headline done', followUps: [{ title: `${id}: ${name}: Write matching holiday box ad body copy`, goal: '' }] }) }
    })
    const t = w.task({ companyId: co.id, title: 'Holiday headline', departmentId: dev.id, agentId: coder.id })
    await w.runNow(t.id)
    await w.drain()
    const made = w.c.listTasks(co.id).filter((x) => x.title.includes('holiday box ad body copy'))
    expect(made).toHaveLength(1)
    expect(made[0]!.agentId).toBe(marcus.id)
    const f = w.orch(w.turns[0].run.id)!.actions.find((a) => a.kind === 'follow_up')!
    expect(f.status).toBe('skipped')
    expect(f.detail).toContain(made[0]!.identifier)
  })

  it('task_create {agent} with a name from another company is refused with the teammates', async () => {
    const { w, co, dev, coder } = setup('manual')
    const other = w.company('Other')
    w.seat(other.id, w.department(other.id, 'Ads', 'ads'), 'Ads Analyst', 'claude', 'manual')
    const elsewhere = w.forum.store.roster(other.id)[0]!.name
    let err = ''
    w.scripts.set(coder.id, async (t, world) => {
      try {
        await world.broker.taskCall({ runId: t.run.id, stepId: t.owner.stepId }, 'task_create', { title: 'Ads check', agent: elsewhere }, {})
      } catch (e) {
        err = String(e)
      }
      return { output: report({ outcome: 'review', summary: 'S' }) }
    })
    const t = w.task({ companyId: co.id, title: 'T', departmentId: dev.id, agentId: coder.id })
    await w.runNow(t.id)
    await w.drain()
    expect(err).toContain('No teammate')
    expect(w.c.listTasks(other.id)).toHaveLength(0)
  })

  it('a report follow-up for a name not in the company says so, and never goes back to the asker', async () => {
    const { w, co, dev, coder } = setup('auto')
    w.scripts.set(coder.id, () => ({ output: report({ outcome: 'review', summary: 'S', followUps: [{ title: 'Check the ads', goal: '', agentHandle: 'Aurelia' }] }) }))
    const t = w.task({ companyId: co.id, title: 'T', departmentId: dev.id, agentId: coder.id })
    await w.runNow(t.id)
    await w.drain()
    const f = w.orch(w.turns[0].run.id)!.actions.find((a) => a.kind === 'follow_up')!
    expect(f.detail).toContain('no teammate "Aurelia" in this company')
    const filed = w.c.listTasks(co.id).find((x) => x.title === 'Check the ads')!
    expect(filed.agentId).not.toBe(coder.id)
  })
})
