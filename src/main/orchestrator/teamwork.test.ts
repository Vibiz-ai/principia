/**
 * ORCHESTRATOR.md §1.3 and §2, the loop between teammates: a decision the agent waits for from a teammate stays the
 * teammate's (never a stale question for the founder), the answer picks the task back up (a manual agent's waits in To
 * do), a teammate who cannot be asked sends it to the founder, the same question is never asked again across woken
 * turns, secrets in reports never reach the Forum or teammates' prompts, reply runs never spend an extraction, and a
 * follow-up can name the teammate who should do it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { blockerLine } from './apply'
import { connectionName } from './coordinatorRules'
import { OrchWorld, report } from './__tests__/world'

const worlds: OrchWorld[] = []
afterEach(() => {
  while (worlds.length) worlds.pop()!.dispose()
})

function setup(askerAutonomy: 'auto' | 'manual' = 'manual') {
  const w = new OrchWorld()
  worlds.push(w)
  const co = w.company()
  const mkt = w.department(co.id, 'Marketing', 'marketing')
  const ads = w.department(co.id, 'Ads', 'ads')
  const pliny = w.seat(co.id, ads, 'Ad strategist', 'codex', 'manual', () => ({ output: 'Playful, with one pun at most.' }))
  let turns = 0
  const marcus = w.seat(co.id, mkt, 'Brand writer', 'claude', askerAutonomy, () => {
    turns++
    return turns === 1
      ? {
          output: report({
            outcome: 'blocked',
            summary: 'Waiting on the tone',
            questions: [{ to: `@${w.handle(pliny.id)}`, question: 'Playful or premium for the holiday box?', why: 'the subject line', blocking: true }],
            blockers: [{ text: "The subject line can't be written until Pliny chooses playful or premium", needs: 'decision' }]
          })
        }
      : { output: report({ outcome: 'review', summary: 'Subject line written in a playful tone' }) }
  })
  return { w, co, mkt, ads, pliny, marcus, turns: () => turns }
}

describe('teamwork: a blocking question to a teammate', () => {
  it('a decision waiting on a teammate never becomes a founder question; the answer puts a manual agent\'s task back in To do', async () => {
    const { w, co, mkt, marcus } = setup('manual')
    const t = w.task({ companyId: co.id, title: 'Email subject line', departmentId: mkt.id, agentId: marcus.id })
    await w.runNow(t.id)
    await w.drain()
    const after = w.c.task(t.id)
    // no stale "Needs your decision" for the founder: the teammate answered it
    expect(after.ask).toBeFalsy()
    expect(after.status).toBe('todo')
    expect(after.pendingWake?.reasons.join(' ')).toContain('Playful, with one pun at most.')
    const acts = w.orch(w.turns[0].run.id)!.actions
    expect(acts.find((a) => a.kind === 'blocker')).toMatchObject({ status: 'skipped' })
    expect(acts.find((a) => a.kind === 'blocker')!.detail).toContain('not for you')
    // the founder sees why it moved, and what happens next
    const lines = w.c.detail(t.id).activity.map((a) => a.message)
    expect(lines.some((l) => /answered m[0-9a-z]+/.test(l) && l.includes('when you press Start'))).toBe(true)
    expect(lines.some((l) => l.startsWith('Principia after this run:') && l.includes('Asked'))).toBe(true)
    // Start: the next turn has the answer
    await w.runNow(t.id)
    await w.drain()
    expect(w.c.task(t.id).status).toBe('in_review')
    // the answer reaches the next turn once: in its wake, not again in the context or the Activity line
    expect(w.turns.at(-1)!.prompt.split('Playful, with one pun at most.').length - 1).toBe(1)
    expect(w.turns.at(-1)!.context).not.toContain('Playful, with one pun at most.')
  })

  it('an automatic asker with Autopilot on continues by itself', async () => {
    const { w, co, mkt, marcus, turns } = setup('auto')
    const t = w.task({ companyId: co.id, title: 'Email subject line', departmentId: mkt.id, agentId: marcus.id })
    await w.runNow(t.id)
    await w.drain()
    expect(turns()).toBe(2)
    expect(w.c.task(t.id).status).toBe('in_review')
    expect(w.c.task(t.id).ask).toBeFalsy()
  })

  it('a teammate who cannot be asked sends the held decision to the founder', async () => {
    const { w, co, mkt, marcus, pliny } = setup('manual')
    // the teammate is paused: the mailbox refuses the question
    w.c.departments.pauseAgent(pliny.id)
    const t = w.task({ companyId: co.id, title: 'Email subject line', departmentId: mkt.id, agentId: marcus.id })
    await w.runNow(t.id)
    await w.drain()
    const acts = w.orch(w.turns[0].run.id)!.actions
    const esc = acts.find((a) => a.kind === 'blocker' && a.status === 'done')!
    expect(esc.detail).toContain('Asked you instead')
    // the decision is the task's own ask (Needs you), so the founder's answer resumes the task the usual way
    const parked = w.c.task(t.id)
    expect(parked).toMatchObject({ status: 'blocked', blockReason: 'needs_input' })
    expect(parked.ask!.prompt).toContain('Needs your decision')
    expect(parked.ask!.prompt).toContain('so this comes to you')
    w.c.answer(t.id, 'Go playful')
    expect(w.c.task(t.id).status).toBe('todo')
    await w.runNow(t.id)
    await w.drain()
    expect(w.turns.at(-1)!.prompt).toContain('Go playful')
    expect(w.c.task(t.id).status).toBe('in_review')
  })
})

describe('teamwork: no loops across woken turns', () => {
  it('the same question to the same teammate is asked once per task, and a task asks one teammate at most twice in 6 hours', async () => {
    const w = new OrchWorld()
    worlds.push(w)
    const co = w.company()
    const mkt = w.department(co.id, 'Marketing', 'marketing')
    const fin = w.department(co.id, 'Finance', 'finance')
    w.seat(co.id, fin, 'Analyst', 'codex', 'auto', () => ({ output: 'Revenue is up 4%.' }))
    let n = 0
    const asker = w.seat(co.id, mkt, 'Writer', 'claude', 'auto', () => {
      n++
      return { output: report({ outcome: 'blocked', summary: `Turn ${n}`, questions: [{ to: '@finance', question: n <= 2 ? 'Numbers please' : `Another number ${n}?`, why: '', blocking: true }] }) }
    })
    const t = w.task({ companyId: co.id, title: 'Weekly note', departmentId: mkt.id, agentId: asker.id })
    await w.runNow(t.id)
    await w.drain()
    // turn 1 asks, its answer wakes turn 2, which repeats the question: skipped, so no new answer and no new turn
    expect(n).toBe(2)
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM orch_mailbox').get()).toEqual({ n: 1 })
    const q2 = w.orch(w.turns.filter((x) => x.kind === 'task')[1].run.id)!.actions.find((a) => a.kind === 'question')!
    expect(q2).toMatchObject({ status: 'skipped' })
    expect(q2.detail).toContain('they answered: Revenue is up 4%.')
  })
})

describe('teamwork: secrets, reply runs, follow-ups, wording', () => {
  it('a key pasted into a report never reaches the Forum, the board or a teammate\'s prompt; a fact holding one is not kept', async () => {
    const w = new OrchWorld()
    worlds.push(w)
    const co = w.company()
    const mkt = w.department(co.id, 'Marketing', 'marketing')
    // built at runtime so the public-release credential screen never sees a key-shaped literal
    const key = ['sk', 'ant', 'api03-AAAAAAAAAAAAAAAAAAAAAAAA'].join('-')
    const gh = 'ghp' + '_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'
    const a = w.seat(co.id, mkt, 'Writer', 'claude', 'manual', () => ({ output: report({ outcome: 'review', summary: `Used ${key} and ${gh} to post`, facts: [{ text: `The admin token: ${key}` }, { text: 'Orders ship on Mondays' }] }) }))
    const b = w.seat(co.id, mkt, 'Editor', 'claude', 'manual')
    const t1 = w.task({ companyId: co.id, title: 'Post', departmentId: mkt.id, agentId: a.id })
    await w.runNow(t1.id)
    await w.drain()
    const all = JSON.stringify([w.posts(co.id).map((m) => m.text), w.c.task(t1.id).report, w.db.prepare('SELECT report_json FROM orch_run_reports').all()])
    expect(all).not.toContain(key)
    expect(all).not.toContain(gh)
    expect(w.facts.flatMap((f) => f.facts.map((x) => x.text))).toEqual(['Orders ship on Mondays'])
    expect(w.orch(w.turns[0].run.id)!.actions.find((x) => x.kind === 'fact' && x.status === 'skipped')!.detail).toContain('password or key')
    const t2 = w.task({ companyId: co.id, title: 'Edit', departmentId: mkt.id, agentId: b.id })
    await w.runNow(t2.id)
    expect(w.turns.at(-1)!.context).toContain('Used [redacted]')
    expect(w.turns.at(-1)!.context).not.toContain(key)
  })

  it('a reply run without a report never spends an extraction', async () => {
    const w = new OrchWorld()
    worlds.push(w)
    w.settings = { mode: 'on', extractFallback: true, callsPerDay: 5 }
    let calls = 0
    w.extract = async () => {
      calls++
      return null
    }
    const co = w.company()
    const mkt = w.department(co.id, 'Marketing', 'marketing')
    const a = w.seat(co.id, mkt, 'Writer', 'codex', 'manual', () => ({ output: 'Weekends are busy, mostly brunch.' }))
    const owner = w.forum.store.owner(co.id)
    const general = w.forum.store.channels(co.id, owner.id).find((c) => c.system === 'general')!
    w.forum.onHumanPost = (m) => void w.responder.onHumanPost(m)
    w.forum.humanPosted(w.forum.store.post(owner.id, { channelId: general.id, text: `@${w.handle(a.id)} how are weekends?` }))
    await w.drain()
    expect(w.turns.some((t) => t.kind === 'reply')).toBe(true)
    expect(calls).toBe(0)
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM orch_budget').get()).toEqual({ n: 0 })
  })

  it('a follow-up names the teammate who should do it; a summary that names the task is posted as it is', async () => {
    const w = new OrchWorld()
    worlds.push(w)
    const co = w.company()
    const mkt = w.department(co.id, 'Marketing', 'marketing')
    const ads = w.department(co.id, 'Ads', 'ads')
    const pliny = w.seat(co.id, ads, 'Ad strategist', 'codex', 'manual')
    const marcus = w.seat(co.id, mkt, 'Brand writer', 'claude', 'manual')
    const t = w.task({ companyId: co.id, title: 'Tagline', departmentId: mkt.id, agentId: marcus.id })
    w.scripts.set(marcus.id, () => ({ output: report({ outcome: 'review', summary: `Wrote the ${t.identifier} tagline`, followUps: [{ title: 'Ad concepts from the tagline', goal: '', agentHandle: `@${w.handle(pliny.id)}` }] }) }))
    await w.runNow(t.id)
    await w.drain()
    const f = w.c.listTasks(co.id).find((x) => x.title === 'Ad concepts from the tagline')!
    expect(f).toMatchObject({ agentId: pliny.id, departmentId: ads.id, status: 'backlog' })
    expect(w.posts(co.id).find((m) => m.via === 'principia')!.text).toBe(`Wrote the ${t.identifier} tagline`)
  })

  it('a connection blocker reads as two sentences; a connection id reads as a name', () => {
    expect(blockerLine({ text: 'I need read access to Shopify sales', needs: 'connection', connectionId: 'shopify' })).toBe('Needs a connection: I need read access to Shopify sales. Set it up: principia://connect/shopify')
    expect(connectionName('shopify')).toBe('Shopify')
    expect(connectionName('google-drive')).toBe('Google Drive')
  })
})
