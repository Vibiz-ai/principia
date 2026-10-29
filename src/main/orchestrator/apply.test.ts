/** ORCHESTRATOR.md §1.3: Principia applies a run's report itself, once, without redoing what the agent did over MCP. */
import { afterEach, describe, expect, it } from 'vitest'
import { OrchWorld, report } from './__tests__/world'

const worlds: OrchWorld[] = []
afterEach(() => {
  while (worlds.length) worlds.pop()!.dispose()
})

function setup() {
  const w = new OrchWorld()
  worlds.push(w)
  const co = w.company()
  const dev = w.department(co.id, 'Development', 'development')
  const mkt = w.department(co.id, 'Marketing', 'marketing')
  const dev1 = w.seat(co.id, dev, 'Bug fixer', 'codex', 'manual')
  const writer = w.seat(co.id, mkt, 'Copywriter', 'claude', 'auto')
  return { w, co, dev, mkt, dev1, writer }
}

describe('apply: after a run', () => {
  it('posts the update once (via Principia), files follow-ups backlog-first and keeps the board outcome', async () => {
    const { w, co, dev, dev1, writer } = setup()
    w.scripts.set(dev1.id, () => ({
      output: report({ outcome: 'review', summary: 'Fixed the checkout bug', evidence: ['src/cart.ts'], followUps: [{ title: 'Add a test for the cart', goal: 'cover the bug' }, { title: 'Announce the fix', goal: 'tell customers', departmentKey: 'marketing' }] })
    }))
    const t = w.task({ companyId: co.id, title: 'Fix checkout', departmentId: dev.id, agentId: dev1.id })
    await w.runNow(t.id)
    const run = w.turns[0].run
    await w.play(w.turns[0])
    const after = w.c.task(t.id)
    expect(after.status).toBe('in_review')
    expect(after.report?.summary).toBe('Fixed the checkout bug')
    // one update post, from Principia, in the seat's department channel (the Forum's own automatic post stood down)
    const posts = w.posts(co.id).filter((m) => m.authorId === w.forum.store.memberForAgent(dev1.id)!.id)
    expect(posts).toHaveLength(1)
    expect(posts[0].via).toBe('principia')
    expect(posts[0].text).toContain(`${t.identifier}: Fixed the checkout bug`)
    // the bug fixer is manual: its follow-up waits in Backlog; the copywriter is auto and autopilot is on: To do
    const tasks = w.c.listTasks(co.id)
    const test = tasks.find((x) => x.title === 'Add a test for the cart')!
    const announce = tasks.find((x) => x.title === 'Announce the fix')!
    expect(test.status).toBe('backlog')
    expect(test.agentId).toBe(dev1.id)
    expect(test.parentId).toBe(t.id)
    expect(announce.agentId).toBe(writer.id)
    expect(['todo', 'in_progress']).toContain(announce.status)
    const o = w.orch(run.id)!
    expect(o.source).toBe('fence')
    expect(o.actions.map((a) => [a.kind, a.status])).toEqual([['post', 'done'], ['follow_up', 'done'], ['follow_up', 'done']])
  })

  it('does not repeat the task id the agent put in front of its summary', async () => {
    const { w, co, dev, dev1 } = setup()
    const t = w.task({ companyId: co.id, title: 'T', departmentId: dev.id, agentId: dev1.id })
    w.scripts.set(dev1.id, () => ({ output: report({ outcome: 'review', summary: `${t.identifier}: Fixed it` }) }))
    await w.runNow(t.id)
    await w.play(w.turns[0])
    expect(w.posts(co.id).find((m) => m.via === 'principia')?.text).toBe(`${t.identifier}: Fixed it`)
  })

  it('a reply run\'s founder questions and blockers become one ask card for the founder', async () => {
    const { w, co, dev1 } = setup()
    w.scripts.set(dev1.id, () => ({ output: report({ outcome: 'answered', summary: 'Told them', questions: [{ to: 'founder', question: 'Can you share last month\'s numbers?', why: '', blocking: false }], blockers: [{ text: 'No access to the shop\'s inbox', needs: 'connection', connectionId: 'notion' }] }) }))
    const owner = w.forum.store.owner(co.id)
    const general = w.forum.store.channels(co.id, owner.id).find((c) => c.system === 'general')!
    // a person writes to the seat: the responder starts a short reply run (no task)
    w.forum.onHumanPost = (m) => void w.responder.onHumanPost(m)
    w.forum.humanPosted(w.forum.store.post(owner.id, { channelId: general.id, text: `@${w.handle(dev1.id)} how are weekends?` }))
    await w.drain()
    const reply = w.turns.find((t) => t.kind === 'reply')!
    const a = w.orch(reply.run.id)!.actions.find((x) => x.kind === 'founder_question')!
    expect(a).toMatchObject({ status: 'done', link: 'principia://connect/notion' })
    const card = w.posts(co.id).find((m) => m.kind === 'ask' && m.ask?.to.includes(owner.id))!
    expect(card.via).toBe('principia')
    expect(card.text).toContain('last month')
    expect(card.text).toContain('principia://connect/notion')
  })

  it('is applied once per run, whatever calls it again', async () => {
    const { w, co, dev, dev1 } = setup()
    w.scripts.set(dev1.id, () => ({ output: report({ outcome: 'review', summary: 'S', followUps: [{ title: 'Once only', goal: '' }] }) }))
    const t = w.task({ companyId: co.id, title: 'T', departmentId: dev.id, agentId: dev1.id })
    await w.runNow(t.id)
    const run = w.turns[0].run
    await w.play(w.turns[0])
    await w.finish(run.id, 'passed')
    expect(w.applier.afterRun({ id: run.id, status: 'passed' })).toBeNull()
    expect(w.c.listTasks(co.id).filter((x) => x.title === 'Once only')).toHaveLength(1)
    expect(w.posts(co.id).filter((m) => m.via === 'principia')).toHaveLength(1)
  })

  it('skips what the agent already did over MCP: its own post, a task already on the board, a teammate it asked', async () => {
    const { w, co, dev, dev1, writer } = setup()
    w.task({ companyId: co.id, title: 'Write the release notes', status: 'backlog' })
    w.scripts.set(dev1.id, async (turn, world) => {
      const me = world.forum.store.memberForAgent(dev1.id)!
      const caller = { companyId: co.id, memberId: me.id, runId: turn.run.id, stepId: turn.owner.stepId, taskId: turn.taskId }
      await world.forum.api.call(caller, 'forum_post', { channel: '#development', text: 'Working on it, posted myself' })
      await world.forum.api.call(caller, 'forum_ask_agent', { to: `@${world.handle(writer.id)}`, question: 'Which tone?', wait_s: 0 })
      return { output: report({ outcome: 'review', summary: 'S', followUps: [{ title: 'write the release notes!', goal: '' }], questions: [{ to: `@${world.handle(writer.id)}`, question: 'Which tone?', why: '', blocking: false }] }) }
    })
    const t = w.task({ companyId: co.id, title: 'T', departmentId: dev.id, agentId: dev1.id })
    await w.runNow(t.id)
    const run = w.turns[0].run
    await w.play(w.turns[0])
    const o = w.orch(run.id)!
    expect(o.actions.map((a) => [a.kind, a.status])).toEqual([['post', 'skipped'], ['follow_up', 'skipped'], ['question', 'skipped']])
    expect(w.c.listTasks(co.id).filter((x) => /release notes/i.test(x.title))).toHaveLength(1)
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM forum_agent_wakes').get()).toEqual({ n: 1 })
  })

  it('facts become proposals for the founder, never written', async () => {
    const { w, co, dev, dev1 } = setup()
    w.scripts.set(dev1.id, () => ({ output: report({ outcome: 'review', summary: 'S', facts: [{ text: 'We ship on Tuesdays', topic: 'Release process' }] }) }))
    const t = w.task({ companyId: co.id, title: 'T', departmentId: dev.id, agentId: dev1.id })
    await w.runNow(t.id)
    await w.play(w.turns[0])
    expect(w.facts).toEqual([{ companyId: co.id, facts: [{ text: 'We ship on Tuesdays', topic: 'Release process' }] }])
    const fact = w.orch(w.turns[0].run.id)!.actions.find((a) => a.kind === 'fact')!
    expect(fact.status).toBe('proposed')
    expect(fact.detail).toMatch(/for review/)
  })

  it('founder questions and blockers park the task in Needs you, with a connect link', async () => {
    const { w, co, dev, dev1 } = setup()
    w.scripts.set(dev1.id, () => ({
      output: report({ outcome: 'blocked', summary: 'Need payments', questions: [{ to: 'founder', question: 'Monthly or yearly plans?', why: 'pricing page', blocking: true }], blockers: [{ text: 'Payments are not connected', needs: 'connection', connectionId: 'stripe' }] })
    }))
    const t = w.task({ companyId: co.id, title: 'Pricing page', departmentId: dev.id, agentId: dev1.id })
    await w.runNow(t.id)
    await w.play(w.turns[0])
    const after = w.c.task(t.id)
    expect(after.status).toBe('blocked')
    expect(after.blockReason).toBe('needs_input')
    expect(after.ask?.prompt).toContain('Monthly or yearly plans?')
    expect(after.ask?.prompt).toContain('principia://connect/stripe')
    const a = w.orch(w.turns[0].run.id)!.actions.find((x) => x.kind === 'founder_question')!
    expect(a).toMatchObject({ status: 'done', link: 'principia://connect/stripe' })
  })

  it('hands the task on through the existing handoff path', async () => {
    const { w, co, dev, dev1, writer } = setup()
    w.scripts.set(dev1.id, () => ({ output: report({ outcome: 'review', summary: 'Code is done; copy is next', handoff: { departmentKey: 'marketing', why: 'needs the launch copy' } }) }))
    const t = w.task({ companyId: co.id, title: 'Launch page', departmentId: dev.id, agentId: dev1.id })
    await w.runNow(t.id)
    await w.play(w.turns[0])
    const after = w.c.task(t.id)
    expect(after.agentId).toBe(writer.id)
    expect(after.handoffs).toBe(1)
    expect(w.c.detail(t.id).activity.some((x) => x.kind === 'handoff')).toBe(true)
    expect(w.orch(w.turns[0].run.id)!.actions[0]).toMatchObject({ kind: 'handoff', status: 'done' })
  })

  it('a follow-up that blocks the current task leaves it waiting for that follow-up', async () => {
    const { w, co, dev, dev1 } = setup()
    w.scripts.set(dev1.id, () => ({ output: report({ outcome: 'review', summary: 'Half done', followUps: [{ title: 'Get the API key', goal: '', blocksCurrent: true }] }) }))
    const t = w.task({ companyId: co.id, title: 'Integrate', departmentId: dev.id, agentId: dev1.id })
    await w.runNow(t.id)
    await w.play(w.turns[0])
    const dep = w.c.listTasks(co.id).find((x) => x.title === 'Get the API key')!
    const after = w.c.task(t.id)
    expect(after.dependencyIds).toEqual([dep.id])
    expect(after.status).toBe('blocked')
    expect(after.blockReason).toBe('deps')
  })

  it('a blocker that only waits on another open task waits for it instead of landing in Needs you (PR-47)', async () => {
    const { w, co, dev, dev1 } = setup()
    const other = w.task({ companyId: co.id, title: 'Ship the installer fix', departmentId: dev.id, agentId: dev1.id })
    const t = w.task({ companyId: co.id, title: 'Remove the install note', departmentId: dev.id, agentId: dev1.id })
    w.scripts.set(dev1.id, () => ({ output: report({ outcome: 'blocked', summary: `Waiting on ${other.identifier}`, blockers: [{ text: `Waiting on ${other.identifier} to merge before removing the lines.`, needs: 'decision' }] }) }))
    await w.runNow(t.id)
    await w.play(w.turns[0])
    const after = w.c.task(t.id)
    expect(after.dependencyIds).toEqual([other.id])
    expect(after).toMatchObject({ status: 'blocked', blockReason: 'deps', ask: null })
    expect(w.orch(w.turns[0].run.id)!.actions.find((a) => a.kind === 'blocker')).toMatchObject({ status: 'skipped' })
  })

  it('a blocked summary that only waits on another open task waits for it too (no blockers list)', async () => {
    const { w, co, dev, dev1 } = setup()
    const other = w.task({ companyId: co.id, title: 'Ship the fix', departmentId: dev.id, agentId: dev1.id })
    const t = w.task({ companyId: co.id, title: 'Tidy the copy', departmentId: dev.id, agentId: dev1.id })
    w.scripts.set(dev1.id, () => ({ output: report({ outcome: 'blocked', summary: `Nothing changed yet: waiting on ${other.identifier} to merge.` }) }))
    await w.runNow(t.id)
    await w.play(w.turns[0])
    expect(w.c.task(t.id)).toMatchObject({ status: 'blocked', blockReason: 'deps', dependencyIds: [other.id] })
  })

  it('a blocker naming a task but needing a person still comes to you', async () => {
    const { w, co, dev, dev1 } = setup()
    const other = w.task({ companyId: co.id, title: 'Other', departmentId: dev.id, agentId: dev1.id })
    const t = w.task({ companyId: co.id, title: 'Connect it', departmentId: dev.id, agentId: dev1.id })
    w.scripts.set(dev1.id, () => ({ output: report({ outcome: 'blocked', summary: 'Need Stripe', blockers: [{ text: `Waiting on ${other.identifier}: Stripe is not connected`, needs: 'connection', connectionId: 'stripe' }] }) }))
    await w.runNow(t.id)
    await w.play(w.turns[0])
    expect(w.c.task(t.id)).toMatchObject({ status: 'blocked', blockReason: 'needs_input', dependencyIds: [] })
  })

  it('reads the report file when there is no fenced block (redacted like any output)', async () => {
    const { w, co, dev, dev1 } = setup()
    w.scripts.set(dev1.id, () => ({ output: 'All done, see the file.', file: { v: 1, outcome: 'review', summary: 'From the file, key sk-test-abc123' } }))
    const t = w.task({ companyId: co.id, title: 'T', departmentId: dev.id, agentId: dev1.id })
    await w.runNow(t.id)
    await w.play(w.turns[0])
    const o = w.orch(w.turns[0].run.id)!
    expect(o.source).toBe('file')
    // the board reads it like the fenced block: in review with its summary, not flagged "no report"
    expect(w.c.task(t.id)).toMatchObject({ status: 'in_review', report: { outcome: 'review' } })
    expect(w.c.task(t.id).report?.summary).toContain('From the file')
    const post = w.posts(co.id).find((m) => m.via === 'principia')!.text
    expect(post).toContain('From the file')
    expect(post).not.toContain('sk-test-abc123')
  })

  it('shadow mode records what it would do and does nothing (the Forum posts as before)', async () => {
    const { w, co, dev, dev1 } = setup()
    w.settings = { mode: 'shadow' }
    w.scripts.set(dev1.id, () => ({
      output: report({ outcome: 'review', summary: 'Shadowed', followUps: [{ title: 'Should not exist', goal: '' }], questions: [{ to: 'founder', question: 'Q?', why: '', blocking: false }], facts: [{ text: 'f' }], handoff: { departmentKey: 'marketing', why: 'x' } })
    }))
    const t = w.task({ companyId: co.id, title: 'T', departmentId: dev.id, agentId: dev1.id })
    const before = w.c.listTasks(co.id).length
    await w.runNow(t.id)
    await w.play(w.turns[0])
    expect(w.c.listTasks(co.id)).toHaveLength(before)
    const after = w.c.task(t.id)
    expect(after.status).toBe('in_review')
    expect(after.agentId).toBe(dev1.id)
    expect(after.ask).toBeNull()
    expect(w.facts).toEqual([])
    expect(w.posts(co.id).filter((m) => m.via === 'principia')).toHaveLength(0)
    // the Forum's own automatic post still happened
    expect(w.posts(co.id).some((m) => m.origin === `agent:${w.turns[0].owner.stepId}`)).toBe(true)
    const o = w.orch(w.turns[0].run.id)!
    expect(o.mode).toBe('shadow')
    expect(o.actions.length).toBeGreaterThan(0)
    // nothing done, proposed or failed: only what it would do (and what it would skip)
    expect(o.actions.filter((a) => a.status !== 'shadow' && a.status !== 'skipped')).toEqual([])
    expect(o.actions.find((a) => a.kind === 'post')?.status).toBe('shadow')
  })

  it('mode off: nothing is recorded or changed', async () => {
    const { w, co, dev, dev1 } = setup()
    w.settings = { mode: 'off' }
    w.scripts.set(dev1.id, () => ({ output: report({ outcome: 'review', summary: 'S', followUps: [{ title: 'Nope', goal: '' }] }) }))
    const t = w.task({ companyId: co.id, title: 'T', departmentId: dev.id, agentId: dev1.id })
    await w.runNow(t.id)
    await w.play(w.turns[0])
    expect(w.orch(w.turns[0].run.id)).toBeNull()
    expect(w.c.listTasks(co.id).some((x) => x.title === 'Nope')).toBe(false)
  })

  it('an extracted report only proposes: backlog follow-ups, no asks, no post', async () => {
    const { w, co, mkt, writer } = setup()
    w.settings = { mode: 'on', extractFallback: true, callsPerDay: 1 }
    let calls = 0
    w.extract = async () => {
      calls++
      return { v: 1, outcome: 'review', summary: 'Extracted', evidence: [], followUps: [{ title: 'Extracted idea', goal: '' }], questions: [{ to: '@nobody', question: 'Hm?', why: '', blocking: true }], facts: [], blockers: [], suggestions: [], answers: [] }
    }
    // the copywriter is auto with autopilot on: an extracted follow-up still waits in Backlog
    w.scripts.set(writer.id, () => ({ output: 'I wrote the copy. No report block here.' }))
    const t = w.task({ companyId: co.id, title: 'Copy', departmentId: mkt.id, agentId: writer.id })
    await w.runNow(t.id)
    await w.play(w.turns[0])
    const o = w.orch(w.turns[0].run.id)!
    expect(o.source).toBe('extracted')
    expect(w.c.listTasks(co.id).find((x) => x.title === 'Extracted idea')?.status).toBe('backlog')
    expect(o.actions.find((a) => a.kind === 'question')?.status).toBe('proposed')
    expect(o.actions.find((a) => a.kind === 'post')?.status).toBe('skipped')
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM orch_mailbox').get()).toEqual({ n: 0 })
    // the daily budget (1 call) is used: the next run without a report is not extracted
    const t2 = w.task({ companyId: co.id, title: 'Copy 2', departmentId: mkt.id, agentId: writer.id })
    await w.runNow(t2.id)
    await w.drain()
    expect(calls).toBe(1)
    expect(w.orch(w.turns.at(-1)!.run.id)?.source).not.toBe('extracted')
  })

  it('a failed run is not acted on', async () => {
    const { w, co, dev, dev1 } = setup()
    w.scripts.set(dev1.id, () => ({ output: report({ outcome: 'review', summary: 'S', followUps: [{ title: 'From a failed run', goal: '' }] }), status: 'failed' }))
    const t = w.task({ companyId: co.id, title: 'T', departmentId: dev.id, agentId: dev1.id })
    await w.runNow(t.id)
    await w.play(w.turns[0])
    expect(w.c.listTasks(co.id).some((x) => x.title === 'From a failed run')).toBe(false)
    expect(w.orch(w.turns[0].run.id)?.actions).toEqual([])
  })
})
