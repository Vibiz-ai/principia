import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForumMessage } from '../../shared/forum'
import type { ModelCall, ModelCallRequest } from '../company/router'
import { ForumService } from './service'
import type { ForumDirectory } from './store'
import { ConversationPilot, PICKING_LINE, choosePick, cleanTitle, modelHandoff, parsePick, pickSystem, titleInput, type PilotSeat } from './conversationPilot'
import { buildReplyPrompt } from './responder'

const CO = 'co_acme'
let db: Database.Database
let deps: { departments: { id: string; key: string; name: string; archivedAt: string | null }[]; agents: { id: string; companyId: string; departmentId: string | null; name: string; archivedAt: string | null; personaName: string | null }[] }

const directory: ForumDirectory = {
  departments: (companyId) => (companyId === CO ? deps.departments : []),
  agents: (companyId) => deps.agents.filter((a) => a.companyId === companyId),
  ownerName: () => 'Lautaro',
  hasCompany: (id) => id === CO
}

beforeEach(() => {
  db = new Database(':memory:')
  deps = {
    departments: [
      { id: 'dep_dev', key: 'development', name: 'Development', archivedAt: null },
      { id: 'dep_mkt', key: 'marketing', name: 'Marketing', archivedAt: null }
    ],
    agents: [
      { id: 'agt_julia', companyId: CO, departmentId: 'dep_dev', name: 'Repo auditor', archivedAt: null, personaName: 'Julia' },
      { id: 'agt_marcus', companyId: CO, departmentId: 'dep_mkt', name: 'Content writer', archivedAt: null, personaName: 'Marcus' }
    ]
  }
})
afterEach(() => db.close())

const SEATS: PilotSeat[] = [
  { agentId: 'agt_julia', name: 'Julia', role: 'Repo auditor', departmentKey: 'development', department: 'Development', does: 'Code, bugs and releases', capabilities: 'Checks the repo for leaks and broken builds', instructions: 'Audit the repository weekly.' },
  { agentId: 'agt_marcus', name: 'Marcus', role: 'Content writer', departmentKey: 'marketing', department: 'Marketing', does: 'Posts, newsletter and brand', capabilities: 'Writes posts and captions', instructions: 'Write in the brand voice.' }
]
const DEPS = [
  { key: 'development', name: 'Development', does: 'Code, bugs and releases' },
  { key: 'marketing', name: 'Marketing', does: 'Posts, newsletter and brand' }
]

/** A fake cheap-tier call: answers by what the system prompt asks for (a title, or a pick). No model runs. */
function fakeModel(answers: { title?: string | (() => Promise<string>); pick?: string }): ModelCall & { calls: ModelCallRequest[] } {
  const calls: ModelCallRequest[] = []
  const fn = (async (req: ModelCallRequest) => {
    calls.push(req)
    if (/name a conversation/.test(req.system)) {
      const t = answers.title
      if (t === undefined) throw new Error('no title model')
      return typeof t === 'string' ? t : t()
    }
    if (answers.pick === undefined) throw new Error('no pick model')
    return answers.pick
  }) as ModelCall & { calls: ModelCallRequest[] }
  fn.calls = calls
  return fn
}

function setup(model: ModelCall | null) {
  const woken: { memberId: string; message: ForumMessage }[] = []
  const posted: ForumMessage[] = []
  const hired: string[] = []
  const svc = new ForumService({
    db,
    directory,
    enabled: () => true,
    emit: () => undefined,
    company: {
      saveDepartment: () => {
        throw new Error('not used')
      },
      saveAgent: (input) => {
        const a = { id: `agt_${input.role.replace(/\W/g, '').toLowerCase()}`, companyId: input.companyId, departmentId: input.departmentId, name: input.role, archivedAt: null, personaName: 'Livia' }
        deps.agents.push(a)
        hired.push(`${input.role}|${input.departmentId}|${input.profileId}|${input.instructions}`)
        return { id: a.id, name: a.name }
      },
      departmentByKey: (_c, key) => deps.departments.find((d) => d.key === key) ?? null,
      defaultProfile: () => ({ id: 'prof_claude' }),
      profileExists: (id) => id === 'prof_claude',
      companyName: () => 'Acme',
      seatLabel: (id) => deps.agents.find((a) => a.id === id)?.name ?? null
    }
  })
  svc.store.sync(CO)
  svc.wakeOne = (memberId, message) => woken.push({ memberId, message })
  const pilot = new ConversationPilot({
    store: () => svc.store,
    call: () => model,
    seats: () => SEATS.filter((s) => deps.agents.some((a) => a.id === s.agentId)),
    departments: () => DEPS,
    defaultAdapter: () => 'claude',
    humanPosted: (m) => posted.push(m)
  })
  svc.pilot = pilot
  return { svc, pilot, woken, posted, hired, owner: svc.store.owner(CO) }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('conversation titles (CHAT-UI.md §7.1)', () => {
  it('cleans the model answer into a short title, or refuses it', () => {
    expect(cleanTitle('"Unscheduled posts on Acme workspace."')).toBe('Unscheduled posts on Acme workspace')
    expect(cleanTitle('Title: onboarding flow fixes')).toBe('Onboarding flow fixes')
    expect(cleanTitle('Vibiz UGC conversion\nBecause the founder asked…')).toBe('Vibiz UGC conversion')
    expect(cleanTitle('One two three four five six seven eight')).toBe('One two three four five six')
    expect(cleanTitle("I'm sorry, I can't help with that")).toBeNull()
    expect(cleanTitle('{"title":"x"}')).toBeNull()
    expect(cleanTitle('Hi')).toBeNull()
    expect(cleanTitle('')).toBeNull()
  })

  it('frames the conversation as data and redacts it', () => {
    const t = titleInput('Check hola@example.com sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 now', 'On it', (s) => s.replace('hola@example.com', '[email]'))
    expect(t).toMatch(/^Founder: Check \[email\]/)
    expect(t).not.toMatch(/sk-ant-api03-abcdefghij/)
    expect(t).toMatch(/\nFirst answer: On it$/)
  })

  it('names a new conversation, then refines it once after the first agent answer', async () => {
    let n = 0
    const model = fakeModel({ title: async () => (++n === 1 ? 'Unscheduled posts' : 'Unscheduled posts on Acme workspace') })
    const { svc, pilot, owner } = setup(model)
    const { channel, message } = pilot.start({ companyId: CO, text: 'Bro now lets also check whats the deal with the unscheduled posts on acme', title: 'Bro now lets also check whats…', name: 'chat-bro-ab12', purpose: 'You asked for Marcus.', agentIds: ['agt_marcus'] })
    expect(channel).toMatchObject({ topic: 'Bro now lets also check whats…', titleBy: 'first' })
    await flush()
    await flush()
    expect(svc.store.channel(channel.id, owner.id)).toMatchObject({ topic: 'Unscheduled posts', titleBy: 'ai' })
    // the agent answers in the message's thread: one refinement with the answer in view
    const marcus = svc.store.memberForAgent('agt_marcus')!
    svc.store.post(marcus.id, { channelId: channel.id, threadId: message.id, text: 'Three posts on Acme have no slot.' })
    await new Promise((r) => setTimeout(r, 10))
    expect(svc.store.channel(channel.id, owner.id).topic).toBe('Unscheduled posts on Acme workspace')
    expect(model.calls.at(-1)!.input).toMatch(/First answer: Three posts/)
    // never again
    svc.store.post(marcus.id, { channelId: channel.id, threadId: message.id, text: 'Fixed.' })
    await new Promise((r) => setTimeout(r, 10))
    expect(model.calls.filter((c) => /name a conversation/.test(c.system))).toHaveLength(2)
  })

  it('keeps the first-message title when the model fails or there is none', async () => {
    const { svc, pilot, owner } = setup(fakeModel({ title: async () => Promise.reject(new Error('rate limited')) }))
    const a = pilot.start({ companyId: CO, text: 'Check the onboarding flow', title: 'Check the onboarding flow', name: 'chat-onb-ab12', purpose: 'p', agentIds: ['agt_marcus'] })
    await flush()
    await flush()
    expect(svc.store.channel(a.channel.id, owner.id)).toMatchObject({ topic: 'Check the onboarding flow', titleBy: 'first' })
    const off = setup(null)
    const b = off.pilot.start({ companyId: CO, text: 'Hello team', title: 'Hello team', name: 'chat-hello-cd34', purpose: 'p', agentIds: ['agt_marcus'] })
    expect(await off.pilot.title(b.channel.id)).toBe(false)
    expect(off.svc.store.channel(b.channel.id, off.owner.id).topic).toBe('Hello team')
  })

  it('a rename wins, even one made while the model was thinking, and is never overwritten', async () => {
    let release: (v: string) => void = () => undefined
    const model = fakeModel({ title: () => new Promise<string>((r) => (release = r)) })
    const { svc, pilot, owner } = setup(model)
    const { channel, message } = pilot.start({ companyId: CO, text: 'Vibiz UGC numbers please', title: 'Vibiz UGC numbers please', name: 'chat-ugc-ab12', purpose: 'p', agentIds: ['agt_marcus'] })
    await flush()
    svc.store.updateChannel(owner.id, channel.id, { topic: 'My UGC thread' })
    release('Vibiz UGC conversion')
    await flush()
    await flush()
    expect(svc.store.channel(channel.id, owner.id)).toMatchObject({ topic: 'My UGC thread', titleBy: 'you' })
    // the first answer does not trigger a rename either
    svc.store.post(svc.store.memberForAgent('agt_marcus')!.id, { channelId: channel.id, threadId: message.id, text: 'UGC converts at 3%.' })
    await new Promise((r) => setTimeout(r, 10))
    expect(await pilot.title(channel.id)).toBe(false)
    expect(svc.store.channel(channel.id, owner.id).topic).toBe('My UGC thread')
    expect(svc.store.autoTitle(channel.id, 'Anything')).toBe(false)
  })

  it('backfills older conversations once, and keeps one a person renamed', async () => {
    const { svc, pilot, owner } = setup(fakeModel({ title: 'Social posts schedule' }))
    const mk = (name: string, topic: string, renamed: boolean) => {
      const ch = svc.store.createChannel(owner.id, { name, kind: 'private', purpose: 'p', memberIds: [svc.store.memberForAgent('agt_marcus')!.id] })
      svc.store.updateChannel(owner.id, ch.id, { topic })
      if (renamed) svc.store.updateChannel(owner.id, ch.id, { topic: `${topic} (mine)` })
      svc.store.post(owner.id, { channelId: ch.id, text: `${topic} please` })
      // older builds kept no title owner
      db.prepare("UPDATE forum_channels SET data='{}' WHERE id=?").run(ch.id)
      return ch.id
    }
    const plain = mk('chat-old-aa11', 'Check whats the', false)
    const mine = mk('chat-old-bb22', 'Launch plan', true)
    pilot.backfill(CO)
    pilot.backfill(CO)
    await new Promise((r) => setTimeout(r, 10))
    expect(svc.store.channel(plain, owner.id)).toMatchObject({ topic: 'Social posts schedule', titleBy: 'ai' })
    expect(svc.store.channel(mine, owner.id)).toMatchObject({ topic: 'Launch plan (mine)', titleBy: 'you' })
  })
})

describe('who answers: Principia picks (CHAT-UI.md §7.2)', () => {
  it('a pick cut short by a quit never leaves the conversation waiting', () => {
    const { svc, owner } = setup(null)
    const ch = svc.store.createChannel(owner.id, { name: 'chat-cut-ab12', kind: 'private', purpose: PICKING_LINE, data: { titleBy: 'first', picking: true } })
    const fresh = new ConversationPilot({ store: () => svc.store, call: () => null, seats: () => SEATS, departments: () => DEPS, humanPosted: () => undefined })
    fresh.backfill(CO)
    expect(svc.store.channel(ch.id, owner.id)).toMatchObject({ purpose: expect.stringMatching(/interrupted/) })
    expect(svc.store.channel(ch.id, owner.id).picking).toBeUndefined()
  })

  it('the prompt carries roles, departments, capabilities and instructions as short keys', () => {
    const sys = pickSystem(SEATS, DEPS)
    expect(sys).toMatch(/- s1: Julia, Repo auditor; department Development \(Code, bugs and releases\); does: Checks the repo/)
    expect(sys).toMatch(/- s2: Marcus, Content writer; department Marketing/)
    expect(sys).toMatch(/Never pick someone because one word happens to match/)
    expect(sys).toMatch(/- marketing \(Marketing\): Posts, newsletter and brand/)
  })

  it('picks by meaning: the model names the writer for a posts question that says "check"', () => {
    const parsed = parsePick('```json\n{"agents":["s2"],"fit":"good","reason":"Marcus runs the posts"}\n```', SEATS, DEPS)
    expect(choosePick(parsed, SEATS, ['agt_julia'])).toEqual({ kind: 'agents', agentIds: ['agt_marcus'], by: 'model', reason: 'Marcus runs the posts' })
  })

  it('drops hallucinated people and departments; no usable answer falls back to the rules', () => {
    const parsed = parsePick('{"agents":["s9","agt_x","s1"],"fit":"none","need":"ad buying","propose":{"role":"Ads buyer","department":"growth","instructions":"Run ads.","capabilities":"Meta ads"}}', SEATS, DEPS)
    expect(parsed).toMatchObject({ agentIds: ['agt_julia'], fit: 'none', propose: { role: 'Ads buyer', departmentKey: null } })
    expect(parsePick('not json', SEATS, DEPS)).toBeNull()
    expect(choosePick(null, SEATS, ['agt_marcus', 'agt_gone'])).toEqual({ kind: 'agents', agentIds: ['agt_marcus'], by: 'rules', reason: '' })
    expect(choosePick(null, SEATS, [])).toMatchObject({ kind: 'agents', agentIds: ['agt_julia'], by: 'rules' })
  })

  it('nobody fits: a new specialist, with the closest person offered instead; an existing role is brought in', () => {
    const parsed = parsePick('{"agents":["s2"],"fit":"none","reason":"Nobody schedules social posts","need":"social media scheduling","propose":{"role":"Social scheduler","department":"marketing","instructions":"You own the posting calendar.","capabilities":"Schedules posts"}}', SEATS, DEPS)
    expect(choosePick(parsed, SEATS, ['agt_julia'])).toEqual({
      kind: 'propose',
      draft: { role: 'Social scheduler', departmentKey: 'marketing', instructions: 'You own the posting calendar.', capabilities: 'Schedules posts' },
      insteadAgentId: 'agt_marcus',
      need: 'social media scheduling',
      reason: 'Nobody schedules social posts'
    })
    const same = parsePick('{"agents":[],"fit":"none","propose":{"role":"Content writer"}}', SEATS, DEPS)
    expect(choosePick(same, SEATS, [])).toMatchObject({ kind: 'agents', agentIds: ['agt_marcus'] })
  })

  it('the handoff line says who and why', () => {
    expect(modelHandoff([SEATS[1]!], 'They run the posts.')).toBe('Principia brought in Marcus (Content writer): they run the posts.')
    expect(modelHandoff([SEATS[0]!, SEATS[1]!], '')).toBe('Principia brought in Julia (Repo auditor) and Marcus (Content writer).')
  })

  it('start: shows Principia picking, then brings in the pick and wakes them on the message', async () => {
    const model = fakeModel({ pick: '{"agents":["s2"],"fit":"good","reason":"Marcus runs the posts"}' })
    const { svc, pilot, posted, owner } = setup(model)
    const r = pilot.start({ companyId: CO, text: 'check whats the status of the unscheduled posts', title: 'Check whats the status', name: 'chat-check-ab12', purpose: 'Principia brought in Julia (Repo auditor): the request mentions “check”.', pick: { agentIds: ['agt_julia'], handoff: 'Principia brought in Julia (Repo auditor): the request mentions “check”.' } })
    expect(r.channel).toMatchObject({ picking: true, purpose: PICKING_LINE })
    expect(r.channel.memberIds).toEqual([owner.id])
    expect(posted).toHaveLength(0)
    await r.routing
    const ch = svc.store.channel(r.channel.id, owner.id)
    expect(ch.memberIds).toEqual([owner.id, svc.store.memberForAgent('agt_marcus')!.id])
    expect(ch.picking).toBeUndefined()
    expect(ch.purpose).toBe('Principia brought in Marcus (Content writer): marcus runs the posts.')
    expect(posted.map((m) => m.id)).toEqual([r.message.id])
    // quiet: no "Lautaro added Marcus" line
    expect(svc.store.messages(ch.id).some((m) => /added/.test(m.text))).toBe(false)
    expect(model.calls.find((c) => /pick who on the team/.test(c.system))!.input).toBe('check whats the status of the unscheduled posts')
  })

  it('start without a model: the deterministic route and its handoff line', async () => {
    const { svc, pilot, posted, owner } = setup(null)
    const r = pilot.start({ companyId: CO, text: 'write a post', title: 'Write a post', name: 'chat-post-ab12', purpose: 'x', pick: { agentIds: ['agt_marcus'], handoff: 'Principia brought in Marcus (Content writer): the request mentions “post”.' } })
    await r.routing
    const ch = svc.store.channel(r.channel.id, owner.id)
    expect(ch.purpose).toBe('Principia brought in Marcus (Content writer): the request mentions “post”.')
    expect(ch.memberIds).toContain(svc.store.memberForAgent('agt_marcus')!.id)
    expect(posted).toHaveLength(1)
  })
})

describe('propose a new specialist → create (CHAT-UI.md §7.2)', () => {
  const PROPOSE = '{"agents":["s2"],"fit":"none","reason":"Nobody on the team schedules social posts","need":"social media scheduling","propose":{"role":"Social scheduler","department":"marketing","instructions":"You own the posting calendar.","capabilities":"Schedules posts"}}'

  it('nobody fits: a card in the conversation, nobody answers, nothing is created until the founder clicks', async () => {
    const { svc, pilot, posted, hired, owner } = setup(fakeModel({ pick: PROPOSE }))
    const r = pilot.start({ companyId: CO, text: 'schedule our instagram posts for next week', title: 'Schedule our instagram posts', name: 'chat-ig-ab12', purpose: 'x', pick: { agentIds: ['agt_julia'], handoff: 'x' } })
    await r.routing
    const card = svc.store.messages(r.channel.id).find((m) => m.kind === 'proposal')!
    expect(card).toMatchObject({ via: 'principia', text: 'No one on the team handles social media scheduling yet. Create “Social scheduler” in Marketing?' })
    expect(card.proposal).toMatchObject({ kind: 'agent', status: 'open', forMessageId: r.message.id, insteadAgentId: 'agt_marcus', need: 'social media scheduling', agent: { role: 'Social scheduler', departmentKey: 'marketing', adapter: 'claude' } })
    expect(svc.store.channel(r.channel.id, owner.id).memberIds).toEqual([owner.id])
    expect(posted).toHaveLength(0)
    expect(hired).toEqual([])
  })

  it('Create & bring in: hires through the Departments path, joins the conversation and answers the message', async () => {
    const { svc, pilot, woken, hired, owner } = setup(fakeModel({ pick: PROPOSE }))
    const r = pilot.start({ companyId: CO, text: 'schedule our instagram posts for next week', title: 't', name: 'chat-ig-cd34', purpose: 'x', pick: { agentIds: [], handoff: 'x' } })
    await r.routing
    const card = svc.store.messages(r.channel.id).find((m) => m.kind === 'proposal')!
    const out = svc.decide({ messageId: card.id, decision: 'approve', edits: { profileId: 'prof_claude' } }, owner.id)
    expect(out.proposal).toMatchObject({ status: 'approved', result: { agentId: 'agt_socialscheduler' } })
    expect(hired).toEqual(['Social scheduler|dep_mkt|prof_claude|You own the posting calendar.'])
    const livia = svc.store.memberForAgent('agt_socialscheduler')!
    const ch = svc.store.channel(r.channel.id, owner.id)
    expect(ch.memberIds).toContain(livia.id)
    expect(ch.purpose).toBe('Principia brought in Livia (Social scheduler), new on the team.')
    expect(woken).toEqual([{ memberId: livia.id, message: expect.objectContaining({ id: r.message.id }) }])
  })

  it('Use Marcus instead: no hire, Marcus joins and answers', async () => {
    const { svc, pilot, woken, hired, owner } = setup(fakeModel({ pick: PROPOSE }))
    const r = pilot.start({ companyId: CO, text: 'schedule our posts', title: 't', name: 'chat-ig-ef56', purpose: 'x', pick: { agentIds: [], handoff: 'x' } })
    await r.routing
    const card = svc.store.messages(r.channel.id).find((m) => m.kind === 'proposal')!
    const out = svc.decide({ messageId: card.id, decision: 'reject', useAgentId: 'agt_marcus' }, owner.id)
    expect(out.proposal).toMatchObject({ status: 'rejected', usedAgentId: 'agt_marcus' })
    expect(hired).toEqual([])
    const marcus = svc.store.memberForAgent('agt_marcus')!
    expect(svc.store.channel(r.channel.id, owner.id).memberIds).toContain(marcus.id)
    expect(woken.map((w) => [w.memberId, w.message.id])).toEqual([[marcus.id, r.message.id]])
    expect(svc.store.thread(card.id).replies.map((m) => m.text)).toEqual(['Lautaro brought in Marcus instead of a new specialist.'])
  })

  it('an agent proposes mid-conversation with forum_reply; the hire answers the person’s message', async () => {
    const { svc, pilot, woken, owner } = setup(null)
    const r = pilot.start({ companyId: CO, text: 'Can someone run our TikTok ads?', title: 't', name: 'chat-tt-ab12', purpose: 'x', agentIds: ['agt_marcus'] })
    const marcus = svc.store.memberForAgent('agt_marcus')!
    const caller = { companyId: CO, memberId: marcus.id, runId: 'r_1', stepId: 'st_1', taskId: null }
    const out = await svc.api.call(caller, 'forum_reply', { to: r.message.ref, text: 'Ads are not my job: want a specialist?', proposal: { kind: 'agent', role: 'Ads buyer', department: 'marketing', instructions: 'Run paid social.', capabilities: 'TikTok and Meta ads', reason: 'Nobody runs paid ads' } })
    expect(out).toMatch(/^ok m[0-9a-z]+ ↳m[0-9a-z]+ · proposal open/)
    const card = svc.store.thread(r.message.id).replies.find((m) => m.kind === 'proposal')!
    expect(card.proposal).toMatchObject({ forMessageId: r.message.id, agent: { role: 'Ads buyer' } })
    svc.decide({ messageId: card.id, decision: 'approve' }, owner.id)
    const hire = svc.store.memberForAgent('agt_adsbuyer')!
    expect(svc.store.channel(r.channel.id, owner.id).memberIds).toEqual(expect.arrayContaining([marcus.id, hire.id]))
    expect(woken.map((w) => [w.memberId, w.message.id])).toEqual([[hire.id, r.message.id]])
  })

  it('the conversation reply prompt tells agents how to propose (and only in a conversation)', () => {
    const base = { seat: { name: 'Content writer', instructions: '' }, department: 'Marketing', me: 'marcus', channel: '“Ads”', messages: [{ ref: 'm1', author: 'founder', text: 'ads?' }], thread: [], replyTo: 'm1' }
    expect(buildReplyPrompt({ ...base, conversation: true })).toMatch(/"proposal":\{"kind":"agent"/)
    expect(buildReplyPrompt(base)).not.toMatch(/"proposal"/)
  })

  it('never hires on its own: routing never decides, and an agent cannot approve', async () => {
    const { svc, pilot, owner } = setup(fakeModel({ pick: PROPOSE }))
    const save = vi.spyOn(svc as unknown as { decide: (...a: unknown[]) => unknown }, 'decide')
    const r = pilot.start({ companyId: CO, text: 'schedule posts', title: 't', name: 'chat-ig-gh78', purpose: 'x', pick: { agentIds: [], handoff: 'x' } })
    await r.routing
    expect(save).not.toHaveBeenCalled()
    const card = svc.store.messages(r.channel.id).find((m) => m.kind === 'proposal')!
    expect(() => svc.decide({ messageId: card.id, decision: 'approve' }, svc.store.memberForAgent('agt_marcus')!.id)).toThrow(/owner and admins/)
    expect(svc.store.channel(r.channel.id, owner.id).memberIds).toEqual([owner.id])
  })
})
