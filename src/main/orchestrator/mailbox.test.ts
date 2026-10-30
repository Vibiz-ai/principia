/**
 * ORCHESTRATOR.md §2: questions in run reports reach teammates on any harness, under the collab guards, and a blocking
 * answer wakes the asker. Seats here run on a stub Codex: they never call a tool, only write their final answer.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { OrchWorld, report, type Script, type Turn } from './__tests__/world'

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
  return { w, co, dev, mkt }
}
const refOf = (t: Turn) => /(m[0-9a-z]+) from @/.exec(t.context ?? '')?.[1] ?? null

describe('mailbox: questions from run reports', () => {
  it('a teammate with no task answers in a reply run on its own harness; the blocking asker wakes with the answer', async () => {
    const { w, co, dev, mkt } = setup()
    const writer = w.seat(co.id, mkt, 'Copywriter', 'codex', 'auto', (t) => {
      expect(t.kind).toBe('reply')
      // the reply prompt carries the question (the responder's agent ask)
      expect(t.prompt).toContain('Which tone for the launch?')
      return { output: 'Friendly and short, no jargon.' }
    })
    let turn = 0
    const fixer = w.seat(co.id, dev, 'Bug fixer', 'codex', 'auto', (t) => {
      turn++
      if (turn === 1) return { output: report({ outcome: 'blocked', summary: 'Waiting on the tone', questions: [{ to: `@${w.handle(writer.id)}`, question: 'Which tone for the launch?', why: 'the banner copy', blocking: true }] }) }
      // the follow-up turn: the answer is in its wake, once (the context does not repeat it)
      expect(t.prompt).toContain('Friendly and short, no jargon.')
      expect(t.context).not.toContain('Friendly and short, no jargon.')
      return { output: report({ outcome: 'review', summary: 'Banner done in a friendly tone' }) }
    })
    const task = w.task({ companyId: co.id, title: 'Launch banner', departmentId: dev.id, agentId: fixer.id })
    await w.runNow(task.id)
    await w.drain()
    expect(turn).toBe(2)
    expect(w.turns.map((t) => [t.kind, t.agentId])).toEqual([['task', fixer.id], ['reply', writer.id], ['task', fixer.id]])
    const wake = w.db.prepare('SELECT via, status, from_run, to_run FROM forum_agent_wakes').get() as { via: string; status: string; from_run: string; to_run: string }
    expect(wake).toMatchObject({ via: 'report', status: 'answered', from_run: w.turns[0].run.id, to_run: w.turns[1].run.id })
    const ask = w.posts(co.id).find((m) => m.kind === 'ask')!
    expect(ask.via).toBe('principia')
    expect(ask.ask?.status).toBe('answered')
    expect(w.c.task(task.id).status).toBe('in_review')
    expect(w.c.task(task.id).report?.summary).toBe('Banner done in a friendly tone')
    expect((w.db.prepare('SELECT status, delivery FROM orch_mailbox').get())).toEqual({ status: 'answered', delivery: 'seat' })
  })

  it.each([
    ['failed', { status: 'failed' as const, output: '' }, 'the run failed'],
    ['canceled', { status: 'canceled' as const, output: '' }, 'its run was canceled'],
    ['empty', { output: '' }, 'it ended without an answer']
  ])('a %s reply run: the blocking asker wakes with why, and a late real answer still counts', async (_name, res, why) => {
    const { w, co, dev, mkt } = setup()
    const writer = w.seat(co.id, mkt, 'Copywriter', 'codex', 'auto', (t) => {
      if (t.kind === 'reply') return res
      return { output: report({ outcome: 'review', summary: 'Answered late', answers: [{ ref: w.posts(co.id).find((m) => m.kind === 'ask')!.ref, text: 'Warm and plain.' }] }) }
    })
    const prompts: string[] = []
    const fixer = w.seat(co.id, dev, 'Bug fixer', 'codex', 'auto', (t) => {
      prompts.push(t.prompt)
      if (prompts.length === 1) return { output: report({ outcome: 'blocked', summary: 'Waiting on the tone', questions: [{ to: `@${w.handle(writer.id)}`, question: 'Which tone?', why: '', blocking: true }] }) }
      return { output: report({ outcome: 'review', summary: `Turn ${prompts.length}` }) }
    })
    const task = w.task({ companyId: co.id, title: 'Launch banner', departmentId: dev.id, agentId: fixer.id })
    await w.runNow(task.id)
    await w.drain()
    // the asker did not wait forever: its next turn says who could not answer, and why
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('could not answer')
    expect(prompts[1]).toContain(why)
    expect(w.db.prepare('SELECT status, refusal FROM forum_agent_wakes').get()).toEqual({ status: 'refused', refusal: 'start_failed' })
    expect(w.posts(co.id).find((m) => m.kind === 'ask')!.ask).toMatchObject({ status: 'answered', noAnswer: true })
    // the teammate's real answer comes later, from a task's run report: it replaces the "could not answer"
    const late = w.task({ companyId: co.id, title: 'Tone guide', departmentId: mkt.id, agentId: writer.id })
    await w.runNow(late.id)
    await w.drain()
    const lateRun = w.turns.find((t) => t.taskId === late.id)!.run.id
    expect(w.orch(lateRun)!.actions.find((a) => a.kind === 'answer')).toMatchObject({ status: 'done' })
    const ask = w.posts(co.id).find((m) => m.kind === 'ask')!
    expect(ask.ask).toMatchObject({ status: 'answered', answer: 'Warm and plain.' })
    expect(ask.ask?.noAnswer).toBeFalsy()
    expect(w.db.prepare('SELECT status FROM forum_agent_wakes').get()).toEqual({ status: 'answered' })
    expect(w.db.prepare('SELECT answer FROM orch_mailbox').get()).toEqual({ answer: 'Warm and plain.' })
    expect(prompts.join('\n')).toContain('Warm and plain.')
  })

  it('a report that answers from the reply run itself is the answer, with no "could not answer" line', async () => {
    const { w, co, dev, mkt } = setup()
    const writer = w.seat(co.id, mkt, 'Copywriter', 'codex', 'auto', () => ({ output: report({ outcome: 'answered', summary: 'Answered', answers: [{ ref: w.posts(co.id).find((m) => m.kind === 'ask')!.ref, text: 'Warm and plain.' }] }).replace(/^Done\.\n\n/, '') }))
    const prompts: string[] = []
    const fixer = w.seat(co.id, dev, 'Bug fixer', 'codex', 'auto', (t) => {
      prompts.push(t.prompt)
      if (prompts.length === 1) return { output: report({ outcome: 'blocked', summary: 'Waiting on the tone', questions: [{ to: `@${w.handle(writer.id)}`, question: 'Which tone?', why: '', blocking: true }] }) }
      return { output: report({ outcome: 'review', summary: 'Done' }) }
    })
    const task = w.task({ companyId: co.id, title: 'Launch banner', departmentId: dev.id, agentId: fixer.id })
    await w.runNow(task.id)
    await w.drain()
    const ask = w.posts(co.id).find((m) => m.kind === 'ask')!
    expect(ask.ask).toMatchObject({ status: 'answered', answer: 'Warm and plain.' })
    expect(prompts[1]).toContain('Warm and plain.')
    expect(prompts[1]).not.toContain('could not answer')
    expect(w.forum.store.thread(ask.id).replies.filter((m) => m.kind === 'system')).toEqual([])
  })

  it('a late answer to a question that did not block its task reaches the next inbox, without a wake', async () => {
    const { w, co, dev, mkt } = setup()
    const writer = w.seat(co.id, mkt, 'Copywriter', 'codex', 'auto', () => ({ output: '' }))
    const fixer = w.seat(co.id, dev, 'Bug fixer', 'codex', 'manual', () => ({ output: report({ outcome: 'review', summary: 'Done', questions: [{ to: `@${w.handle(writer.id)}`, question: 'Which tone?', why: '', blocking: false }] }) }))
    const task = w.task({ companyId: co.id, title: 'Launch banner', departmentId: dev.id, agentId: fixer.id })
    await w.runNow(task.id)
    await w.drain()
    const card = w.posts(co.id).find((m) => m.kind === 'ask')!
    expect(card.ask?.noAnswer).toBe(true)
    expect(w.mailbox.inbox(fixer.id, 'r_seen', false).map((i) => i.kind)).toEqual(['answer'])
    w.forum.answer(card.id, w.forum.store.memberForAgent(writer.id)!.id, 'Warm and plain.', card.id)
    expect(w.c.task(task.id).pendingWake).toBeFalsy()
    expect(w.mailbox.inbox(fixer.id, 'r_next', false).map((i) => i.text).join()).toContain('Warm and plain.')
  })

  it('a teammate busy on a task gets the question in that task, answers in its report, and the asker wakes', async () => {
    const { w, co, dev, mkt } = setup()
    let wTurns = 0
    const writer = w.seat(co.id, mkt, 'Copywriter', 'codex', 'auto', (t) => {
      wTurns++
      const ref = refOf(t)
      if (!ref) return { output: report({ outcome: 'review', summary: 'Draft written' }) }
      return { output: report({ outcome: 'review', summary: 'Answered a teammate', answers: [{ ref, text: 'Blue, the brand colour.' }] }) }
    })
    let fTurns = 0
    const fixer = w.seat(co.id, dev, 'Bug fixer', 'codex', 'auto', (t) => {
      fTurns++
      if (fTurns === 1) return { output: report({ outcome: 'blocked', summary: 'Need the colour', questions: [{ to: '@marketing', question: 'Which colour for the button?', why: '', blocking: true }] }) }
      expect(t.prompt).toContain('Blue, the brand colour.')
      expect(t.context).not.toContain('Blue, the brand colour.')
      return { output: report({ outcome: 'review', summary: 'Button is blue' }) }
    })
    const wt = w.task({ companyId: co.id, title: 'Draft the launch post', departmentId: mkt.id, agentId: writer.id })
    const ft = w.task({ companyId: co.id, title: 'Button', departmentId: dev.id, agentId: fixer.id })
    await w.runNow(wt.id)
    await w.runNow(ft.id)
    // the fixer's turn ends first: the writer's task is still in flight, so the question goes into it
    await w.play(w.turns.find((t) => t.taskId === ft.id)!)
    expect(w.c.task(wt.id).pendingWake?.reasons.join(' ')).toContain('Which colour for the button?')
    expect((w.db.prepare('SELECT delivery FROM orch_mailbox').get() as { delivery: string }).delivery).toBe('task')
    await w.drain()
    expect(wTurns).toBe(2)
    expect(fTurns).toBe(2)
    expect(w.c.task(ft.id).report?.summary).toBe('Button is blue')
    const ask = w.posts(co.id).find((m) => m.kind === 'ask')!
    expect(ask.ask).toMatchObject({ status: 'answered', answer: 'Blue, the brand colour.' })
  })

  describe('a question delivered into a teammate\'s task', () => {
    /** The writer is on a task when the fixer's blocking question arrives; `script` plays the writer's task turns. */
    async function delivered(writerScript: (t: Turn, turn: number) => ReturnType<Script>, autonomy: 'auto' | 'manual' = 'auto') {
      const { w, co, dev, mkt } = setup()
      let wTurns = 0
      const writer = w.seat(co.id, mkt, 'Copywriter', 'codex', autonomy, (t) => writerScript(t, ++wTurns))
      const prompts: string[] = []
      const fixer = w.seat(co.id, dev, 'Bug fixer', 'codex', 'auto', (t) => {
        prompts.push(t.prompt)
        if (prompts.length === 1) return { output: report({ outcome: 'blocked', summary: 'Need the colour', questions: [{ to: `@${w.handle(writer.id)}`, question: 'Which colour?', why: '', blocking: true }] }) }
        return { output: report({ outcome: 'review', summary: `Turn ${prompts.length}` }) }
      })
      const wt = w.task({ companyId: co.id, title: 'Draft the launch post', departmentId: mkt.id, agentId: writer.id })
      const ft = w.task({ companyId: co.id, title: 'Button', departmentId: dev.id, agentId: fixer.id })
      await w.runNow(wt.id)
      await w.runNow(ft.id)
      await w.play(w.turns.find((t) => t.taskId === ft.id)!)
      expect((w.db.prepare('SELECT delivery FROM orch_mailbox').get() as { delivery: string }).delivery).toBe('task')
      expect(w.db.prepare('SELECT status, to_run FROM forum_agent_wakes').get()).toEqual({ status: 'started', to_run: w.c.task(wt.id).runId })
      const card = () => w.posts(co.id).find((m) => m.kind === 'ask')!
      return { w, co, mkt, writer, wt, ft, prompts, card }
    }

    it.each([
      ['failed', 'failed' as const, 'its task run failed'],
      ['canceled', 'canceled' as const, 'its task was stopped']
    ])('a %s task run: the asker wakes with why, and a later turn\'s answer still counts', async (_name, status, why) => {
      const { w, wt, prompts, card } = await delivered((t, turn) => {
        if (turn === 1) return { status, output: '' }
        expect(t.prompt).toContain('Which colour?')
        return { output: report({ outcome: 'review', summary: 'Answered', answers: [{ ref: /\((m[0-9a-z]+)\)/.exec(t.prompt)![1]!, text: 'Blue.' }] }) }
      })
      await w.drain()
      expect(w.c.task(wt.id).status).toBe('blocked')
      expect(prompts).toHaveLength(2)
      expect(prompts[1]).toContain('could not answer')
      expect(prompts[1]).toContain(why)
      expect(card().ask).toMatchObject({ status: 'answered', noAnswer: true })
      expect(w.db.prepare('SELECT status, refusal FROM forum_agent_wakes').get()).toEqual({ status: 'refused', refusal: 'start_failed' })
      // the question still waits in the task's wake: when the founder retries it, the real answer replaces the first
      expect(w.c.task(wt.id).pendingWake?.reasons.join(' ')).toContain('Which colour?')
      w.d.runNow(wt.id)
      await w.drain()
      expect(card().ask).toMatchObject({ status: 'answered', answer: 'Blue.' })
      expect(card().ask?.noAnswer).toBeFalsy()
      expect(w.db.prepare('SELECT status FROM forum_agent_wakes').get()).toEqual({ status: 'answered' })
      expect(prompts.join('\n')).toContain('Blue.')
    })

    it('the turn that follows up carries the question: the asker waits for that turn, not the one before', async () => {
      const seen: string[] = []
      const { w, wt, prompts, card } = await delivered((t) => {
        seen.push(t.run.id)
        return { output: report({ outcome: 'review', summary: `Turn ${seen.length}` }) }
      })
      await w.play(w.turns.find((t) => t.taskId === wt.id)!)
      // the first turn passed and its follow-up took the question: nobody gave up yet
      expect(w.c.task(wt.id).status).toBe('in_progress')
      expect(card().ask?.status).toBe('open')
      expect(w.db.prepare('SELECT status, to_run FROM forum_agent_wakes').get()).toEqual({ status: 'started', to_run: w.c.task(wt.id).runId })
      await w.drain()
      // the follow-up ended without answering either: now the asker stops waiting
      expect(seen).toHaveLength(2)
      expect(card().ask).toMatchObject({ status: 'answered', noAnswer: true, answer: expect.stringContaining('its task ended without an answer') })
      expect(prompts[1]).toContain('could not answer')
    })

    it('a seat with no follow-up turn (manual) releases the asker, and the question stays in the task', async () => {
      const { w, wt, prompts, card } = await delivered(() => ({ output: report({ outcome: 'review', summary: 'Draft written' }) }), 'manual')
      await w.drain()
      expect(w.c.task(wt.id).status).toBe('in_review')
      expect(card().ask).toMatchObject({ status: 'answered', noAnswer: true })
      expect(prompts[1]).toContain('could not answer')
      expect(w.c.task(wt.id).pendingWake?.reasons.join(' ')).toContain('Which colour?')
    })

    it('a task handed to someone else: its next turn cannot answer for the one asked, so the asker is released now', async () => {
      const { w, co, mkt, wt, card } = await delivered((t, turn) => {
        if (turn === 1) {
          const other = w.seat(co.id, mkt, 'Stand-in', 'codex', 'auto')
          w.db.prepare("UPDATE company_tasks SET agent_id=?, data=json_set(data, '$.agentId', ?) WHERE id=?").run(other.id, other.id, t.taskId)
        }
        return { output: report({ outcome: 'review', summary: 'Handed over' }) }
      })
      const first = w.c.task(wt.id).runId
      await w.play(w.turns.find((t) => t.taskId === wt.id)!)
      expect(w.c.task(wt.id).status).toBe('in_progress')
      expect(w.c.task(wt.id).runId).not.toBe(first)
      expect(card().ask).toMatchObject({ status: 'answered', noAnswer: true })
    })

    it('a quit leaves it for the boot pass, which releases the asker once', async () => {
      const { w, wt, prompts, card } = await delivered(() => ({ status: 'canceled', output: '' }))
      w.quitting = true
      await w.play(w.turns.find((t) => t.taskId === wt.id)!)
      expect(card().ask?.status).toBe('open')
      expect(w.db.prepare('SELECT status FROM forum_agent_wakes').get()).toEqual({ status: 'started' })
      w.quitting = false
      w.forum.settleDelivered()
      await w.drain()
      expect(card().ask).toMatchObject({ status: 'answered', noAnswer: true })
      expect(prompts[1]).toContain('could not answer')
      const answer = card().ask?.answeredAt
      w.forum.settleDelivered()
      expect(card().ask?.answeredAt).toBe(answer)
    })

    it('the boot pass leaves a turn that is still running alone', async () => {
      const { w, card } = await delivered(() => ({ output: report({ outcome: 'review', summary: 'Done' }) }))
      w.forum.settleDelivered()
      expect(card().ask?.status).toBe('open')
      expect(w.db.prepare('SELECT status FROM forum_agent_wakes').get()).toEqual({ status: 'started' })
    })

    it('a task held by an interactive session has no run that ends: the question goes to a reply run instead', async () => {
      const { w, co, dev, mkt } = setup()
      const writer = w.seat(co.id, mkt, 'Copywriter', 'codex', 'manual', (t) => {
        expect(t.kind).toBe('reply')
        return { output: 'Blue.' }
      })
      const fixer = w.seat(co.id, dev, 'Bug fixer', 'codex', 'manual', () => ({ output: report({ outcome: 'blocked', summary: 'Need the colour', questions: [{ to: `@${w.handle(writer.id)}`, question: 'Which colour?', why: '', blocking: true }] }) }))
      const wt = w.task({ companyId: co.id, title: 'Draft the launch post', departmentId: mkt.id, agentId: writer.id })
      w.db.prepare("UPDATE company_tasks SET status='in_progress', run_id='ses_live' WHERE id=?").run(wt.id)
      const ft = w.task({ companyId: co.id, title: 'Button', departmentId: dev.id, agentId: fixer.id })
      await w.runNow(ft.id)
      await w.drain()
      expect((w.db.prepare('SELECT delivery FROM orch_mailbox').get() as { delivery: string }).delivery).toBe('seat')
      expect(w.posts(co.id).find((m) => m.kind === 'ask')!.ask).toMatchObject({ status: 'answered', answer: 'Blue.' })
    })
  })

  it('the collab guards apply to report questions: self, unknown, cycle and the daily cap', async () => {
    const { w, co, dev, mkt } = setup()
    w.collab = { perCompanyPerDay: 2 }
    const writer = w.seat(co.id, mkt, 'Copywriter', 'codex', 'manual')
    const fixer = w.seat(co.id, dev, 'Bug fixer', 'codex', 'manual')
    // the writer's reply run asks the fixer back: a cycle (A asked B, B asks A)
    w.scripts.set(writer.id, () => ({ output: `Use blue.\n\n${report({ outcome: 'answered', summary: 'Answered', questions: [{ to: `@${w.handle(fixer.id)}`, question: 'Why do you ask?', why: '', blocking: false }] }).replace(/^Done\.\n\n/, '')}` }))
    w.scripts.set(fixer.id, () => ({
      output: report({ outcome: 'review', summary: 'S', questions: [{ to: `@${w.handle(fixer.id)}`, question: 'Me?', why: '', blocking: false }, { to: '@nobody', question: 'Hello?', why: '', blocking: false }, { to: `@${w.handle(writer.id)}`, question: 'Colour?', why: '', blocking: false }] })
    }))
    const task = w.task({ companyId: co.id, title: 'T', departmentId: dev.id, agentId: fixer.id })
    await w.runNow(task.id)
    await w.drain()
    const first = w.orch(w.turns[0].run.id)!.actions.filter((a) => a.kind === 'question')
    expect(first.map((a) => a.status)).toEqual(['failed', 'failed', 'done'])
    expect(first[0].detail).toMatch(/yourself|not woken/)
    expect(first[1].detail).toContain('no teammate @nobody')
    const reply = w.turns.find((t) => t.kind === 'reply')!
    const back = w.orch(reply.run.id)!.actions.find((a) => a.kind === 'question')!
    expect(back.status).toBe('failed')
    expect(back.detail).toMatch(/already in this conversation/)
    expect((w.db.prepare("SELECT refusal FROM forum_agent_wakes WHERE status='refused'").all() as { refusal: string }[]).map((r) => r.refusal)).toContain('cycle')
    // the cap: two live wakes per day; a third question from a new run is refused
    const t2 = w.task({ companyId: co.id, title: 'T2', departmentId: dev.id, agentId: fixer.id })
    w.scripts.set(fixer.id, () => ({ output: report({ outcome: 'review', summary: 'S', questions: [{ to: `@${w.handle(writer.id)}`, question: 'Again?', why: '', blocking: false }] }) }))
    w.scripts.set(writer.id, () => ({ output: 'Sure.' }))
    await w.runNow(t2.id)
    await w.drain()
    const third = w.orch(w.turns.find((t) => t.taskId === t2.id)!.run.id)!.actions.find((a) => a.kind === 'question')!
    w.clock = new Date(w.clock.getTime() + 1000)
    const t3 = w.task({ companyId: co.id, title: 'T3', departmentId: dev.id, agentId: fixer.id })
    await w.runNow(t3.id)
    await w.drain()
    const fourth = w.orch(w.turns.find((t) => t.taskId === t3.id)!.run.id)!.actions.find((a) => a.kind === 'question')!
    expect([third.status, fourth.status]).toEqual(['done', 'failed'])
    expect(fourth.detail).toMatch(/24 hours/)
  })

  it('the inbox shows a question once to a resumed turn and an answer once to the asker', () => {
    const { w, co, dev, mkt } = setup()
    const writer = w.seat(co.id, mkt, 'Copywriter', 'codex', 'manual')
    const fixer = w.seat(co.id, dev, 'Bug fixer', 'codex', 'manual')
    w.db.prepare("INSERT INTO runs(id,kind,title,target_json,trigger,status,created_at,artifacts_dir,company_id,agent_id) VALUES('r_a','prompt','x','{}','manual','passed','2026-10-20T18:00:00.000Z','/tmp',?,?)").run(co.id, fixer.id)
    const res = w.mailbox.send({ companyId: co.id, fromAgentId: fixer.id, fromRunId: 'r_a', fromTaskId: null, to: `@${w.handle(writer.id)}`, question: 'Q1?', why: '', blocking: false, opKey: 'k1' })
    expect(res.status).toBe('sent')
    expect(w.mailbox.inbox(writer.id, 'r_w1', true).map((i) => i.kind)).toEqual(['question'])
    expect(w.mailbox.inbox(writer.id, 'r_w2', true)).toEqual([])
    // a fresh (not resumed) turn sees open questions again
    expect(w.mailbox.inbox(writer.id, 'r_w3', false)).toHaveLength(1)
    const ask = w.posts(co.id).find((m) => m.kind === 'ask')!
    w.forum.answer(ask.id, w.forum.store.memberForAgent(writer.id)!.id, 'A1')
    expect(w.mailbox.inbox(fixer.id, 'r_f1', false).map((i) => i.text)).toEqual([expect.stringContaining('A1')])
    expect(w.mailbox.inbox(fixer.id, 'r_f2', false)).toEqual([])
    // a second question to the same teammate from the same run is not sent twice
    expect(w.mailbox.send({ companyId: co.id, fromAgentId: fixer.id, fromRunId: 'r_a', fromTaskId: null, to: `@${w.handle(writer.id)}`, question: 'Q1 again?', why: '', blocking: false, opKey: 'k2' }).status).toBe('skipped')
  })
})
