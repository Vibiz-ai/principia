import { describe, expect, it } from 'vitest'
import { autonomyPhrase, finishedLine, gerund, deskReply, findDuplicate, greeting, homeHeadline, paraphrase, routeAsk, statusSentence, taskOrigin, taskTitleFor, waitsOnOther, weekTiles, type DeskAgent } from './desk'

const NW: DeskAgent[] = [
  { id: 'marcus', name: 'Marcus', role: 'Brand Voice Writer', department: 'Marketing' },
  { id: 'pliny', name: 'Pliny', role: 'Ad Strategist', department: 'Marketing' },
  { id: 'cato', name: 'Cato', role: 'Support Responder', department: 'Customer Support' },
  { id: 'junia', name: 'Junia', role: 'Operations Planner', department: 'Operations' }
]

describe('autonomyPhrase: one phrase per agent, the same everywhere', () => {
  it('auto agents act on their own; others ask before what their role does', () => {
    expect(autonomyPhrase({ auto: true, role: 'Brand Voice Writer' })).toBe('Acts on its own')
    expect(autonomyPhrase({ auto: false, role: 'Brand Voice Writer' })).toBe('Asks before posting')
    expect(autonomyPhrase({ auto: false, role: 'Support Responder' })).toBe('Asks before replying')
    expect(autonomyPhrase({ auto: false, role: 'Ad Strategist' })).toBe('Asks before spending')
    expect(autonomyPhrase({ auto: false, role: 'Dev Builder' })).toBe('Asks before merging')
    expect(autonomyPhrase({ auto: false, role: 'Generalist', department: 'Operations' })).toBe('Asks before ordering')
    expect(autonomyPhrase({ auto: false, role: 'Chief of staff' })).toBe('Asks before acting')
  })
})

describe('routeAsk', () => {
  it('an @name wins, then the words, then the first active agent', () => {
    expect(routeAsk('@Cato draft a holiday post', NW)).toEqual({ agent: NW[2], by: 'mention' })
    expect(routeAsk('@pli check the competitor ads', NW)!.agent.id).toBe('pliny')
    expect(routeAsk('write a post about our new decaf', NW)).toEqual({ agent: NW[0], by: 'words' })
    expect(routeAsk('refund the Oct 12 order', NW)!.agent.id).toBe('cato')
    expect(routeAsk('what are competitors running as ads?', NW)!.agent.id).toBe('pliny')
    expect(routeAsk('make an October fulfilment checklist', NW)!.agent.id).toBe('junia')
    expect(routeAsk('something vague', NW)).toEqual({ agent: NW[0], by: 'default' })
    // a writer beats an SEO analyst listed first for a blog post (Harbor)
    const hd: DeskAgent[] = [{ id: 'pliny', name: 'Pliny', role: 'SEO Analyst', department: 'Marketing' }, { id: 'marcus', name: 'Marcus', role: 'Content Writer', department: 'Marketing' }]
    expect(routeAsk('write a blog post about teeth whitening', hd)!.agent.id).toBe('marcus')
    expect(routeAsk('which keywords should we rank for?', hd)!.agent.id).toBe('pliny')
  })
  it('a paused agent is skipped by the words and the default, never by an @name', () => {
    const paused = NW.map((a) => (a.id === 'marcus' ? { ...a, paused: true } : a))
    expect(routeAsk('something vague', paused)!.agent.id).toBe('pliny')
    expect(routeAsk('@marcus write a post', paused)!.agent.id).toBe('marcus')
  })
  it('no agents: nobody to route to', () => {
    expect(routeAsk('hello', [])).toBeNull()
  })
})

describe('paraphrase (D11): a full sentence, never a truncated quote', () => {
  it('restates the whole request in the agent’s voice', () => {
    expect(paraphrase('write a post about our new decaf')).toBe("I'll write a post about your new decaf")
    expect(paraphrase('@Marcus please draft next week’s Instagram, 3 posts, warm, about the Ethiopian single-origin. Thanks!')).toBe(
      "I'll draft next week’s Instagram, 3 posts, warm, about the Ethiopian single-origin"
    )
    expect(paraphrase('Can you send me the October numbers?')).toBe("I'll send you the October numbers")
    expect(paraphrase('Instagram posts for Thursday’s launch')).toBe("I'll work on Instagram posts for Thursday’s launch")
    expect(paraphrase('how are our ads doing?')).toBe("I'll find out how your ads are doing and answer you here")
  })
  it('keeps a long request whole', () => {
    const long = 'write ' + 'a very long brief about the holiday gift box and every detail of it '.repeat(6).trim()
    expect(paraphrase(long)).toBe(`I'll ${long}`)
    expect(paraphrase(long)).not.toContain('…')
  })
})

describe('gerund', () => {
  it('spells the -ing form', () => {
    expect(finishedLine('Write a post about our new decaf')).toBe('I finished writing a post about your new decaf. It’s ready for your OK.')
    expect(finishedLine('Instagram week plan')).toBe('I finished Instagram week plan. It’s ready for your OK.')
    expect(['write', 'draft', 'plan', 'tidy', 'fix', 'audit', 'make', 'set'].map(gerund)).toEqual(['writing', 'drafting', 'planning', 'tidying', 'fixing', 'auditing', 'making', 'setting'])
  })
})

describe('taskTitleFor', () => {
  it('sentence case, first sentence, cut at a word past 120 characters', () => {
    expect(taskTitleFor('@Marcus please write a post about our new decaf. Make it warm.')).toBe('Write a post about our new decaf')
    const t = taskTitleFor('draft ' + 'word '.repeat(60))
    expect(t.length).toBeLessThanOrEqual(121)
    expect(t.endsWith('…')).toBe(true)
  })
})

describe('findDuplicate + deskReply: a repeat is merged and said so', () => {
  const tasks = [
    { id: 't1', title: 'Instagram week plan (Oct 27 – Nov 2)', status: 'todo' as const, description: 'Three Instagram posts for next week' },
    { id: 't2', title: 'Draft Northwind brand voice guide', status: 'in_progress' as const },
    { id: 't3', title: 'Holiday gift-box landing copy', status: 'done' as const }
  ]
  it('matches open work on shared words, never done work or a vague overlap', () => {
    expect(findDuplicate('add Thursday’s launch to the Instagram week posts', tasks)?.id).toBe('t1')
    expect(findDuplicate('update the brand voice guide with emoji rules', tasks)?.id).toBe('t2')
    expect(findDuplicate('rewrite the holiday gift-box landing copy', tasks)).toBeNull()
    expect(findDuplicate('write a post about our new decaf', tasks)).toBeNull()
    expect(findDuplicate('instagram', tasks)).toBeNull()
  })
  it('the merged reply names the work and where it came from', () => {
    expect(deskReply({ request: 'Also mention the holiday gift box in the decaf post', autonomy: 'Asks before posting', merged: { title: 'Write a post about our new decaf', origin: 'you', status: 'in_progress' } })).toBe(
      "Got it. I'm already writing a post about your new decaf (you asked earlier); I'll add this: mention the holiday gift box in the decaf post."
    )
    const r = deskReply({ request: 'add Thursday’s launch to the Instagram week posts', autonomy: 'Asks before posting', merged: { title: 'The Instagram week plan', origin: 'setup', status: 'in_progress' } })
    expect(r).toBe("Got it. I'm already on the Instagram week plan (from setup); I'll add this: add Thursday’s launch to the Instagram week posts.")
  })
  it('a fresh request: On it, the paraphrase, and what happens next in the agent’s autonomy words', () => {
    expect(deskReply({ request: 'write a post about our new decaf', autonomy: 'Asks before posting' })).toBe(
      "On it. I'll write a post about your new decaf. I ask before posting, so it comes to Needs you for your OK first."
    )
    expect(deskReply({ request: 'write a post about our new decaf', autonomy: 'Acts on its own' })).toContain("I'll tell you in Needs you when it's done.")
    // behind the current task: it says truthfully whether it starts by itself or waits for your Start
    expect(deskReply({ request: 'write a post', autonomy: 'Acts on its own', busyWith: 'Draft brand voice guide', startsNext: true })).toContain("I'm still drafting brand voice guide. I start this right after, on my own.")
    expect(deskReply({ request: 'write a post', autonomy: 'Asks before posting', busyWith: 'Draft brand voice guide' })).toContain('This waits in my Queue: press Start when you want me on it.')
    expect(deskReply({ request: 'write a post', autonomy: 'Asks before posting', busyWith: 'Draft brand voice guide' })).not.toContain('next in my queue')
    expect(deskReply({ request: 'write a post', autonomy: 'Acts on its own', pausedCompany: 'Harbor Dental Group' })).toBe("Got it. I'll write a post. Harbor Dental Group is paused, so it waits in my queue until you resume.")
  })
  it('origin words', () => {
    const co = '2026-10-25T01:30:00.000Z'
    expect(taskOrigin({ source: 'manual', externalId: null, createdAt: '2026-10-25T01:30:30.229Z' }, co)).toBe('setup')
    expect(taskOrigin({ source: 'manual', externalId: 'desk:a:1', createdAt: '2026-10-25T01:30:30.229Z' }, co)).toBe('you')
    expect(taskOrigin({ source: 'manual', externalId: null, createdAt: '2026-10-27T01:30:30.229Z' }, co)).toBe('board')
    expect(taskOrigin({ source: 'linear', externalId: 'x', createdAt: co }, co)).toBe('linear')
  })
})

describe('statusSentence', () => {
  const t = (id: string, title: string) => ({ identifier: id, title, blockReason: null })
  const seat = (x: Partial<Parameters<typeof statusSentence>[0]['seat']>) => ({ current: null, queue: [], review: [], parked: [], kind: 'idle', ...x })
  it('reads every state in words, with its glyph; non-code companies never see task codes (C7)', () => {
    expect(statusSentence({ seat: seat({ current: t('NW-7', 'Instagram week plan'), kind: 'working' }), agentPaused: false, code: false, since: '2m' })).toEqual({ kind: 'working', glyph: '●', text: 'Working on Instagram week plan · 2m' })
    expect(statusSentence({ seat: seat({ current: t('LA-7', 'Rounding bug'), kind: 'working' }), agentPaused: false, code: true, activity: 'Running the tests' }).text).toBe('Working on LA-7 Rounding bug: running the tests')
    expect(statusSentence({ seat: seat({ current: t('NW-8', 'Refund #1042'), kind: 'needs' }), agentPaused: false, code: false }).text).toBe('Asking you about Refund #1042')
    expect(statusSentence({ seat: seat({ review: [t('NW-7', 'Instagram week')] }), agentPaused: false, code: false })).toMatchObject({ kind: 'needs', text: 'Waiting for your OK on Instagram week' })
    expect(statusSentence({ seat: seat({ queue: [t('NW-11', 'Holiday gift-box landing copy'), t('NW-12', 'x')] }), agentPaused: false, code: false })).toMatchObject({ kind: 'ready', text: 'Ready: Holiday gift-box landing copy (+1 more)' })
    expect(statusSentence({ seat: seat({}), agentPaused: false, code: false })).toMatchObject({ kind: 'idle', text: 'Nothing assigned' })
    expect(statusSentence({ seat: seat({}), agentPaused: true, code: false })).toMatchObject({ kind: 'paused', glyph: '‖', text: 'Paused by you' })
    expect(statusSentence({ seat: seat({ current: t('HD-1', 'SEO audit') }), agentPaused: true, companyPaused: 'Harbor Dental Group', code: false }).text).toBe('Paused with Harbor Dental Group: SEO audit is saved')
  })
})

describe('Home words', () => {
  it('the headline answers the 5-second question', () => {
    expect(homeHeadline({ company: 'Northwind Coffee', needs: 3, working: 1, paused: false, agents: 4 })).toBe('Northwind Coffee · 3 things need you, 1 agent is working.')
    expect(homeHeadline({ company: 'Northwind Coffee', needs: 1, working: 0, paused: false, agents: 4 })).toBe('Northwind Coffee · 1 thing needs you, no agent is working.')
    expect(homeHeadline({ company: 'Harbor', needs: 0, working: 0, paused: true, agents: 4 })).toBe('Harbor · paused, nothing needs you.')
  })
  it('greeting uses the user’s own first name when known', () => {
    expect(greeting(new Date(2026, 9, 26, 9), 'Maya Smith')).toBe('Good morning, Maya')
    expect(greeting(new Date(2026, 9, 26, 15), null)).toBe('Good afternoon')
  })
  it('This week: three tiles, and no fake plan number (C10, PM risk)', () => {
    const now = new Date(2026, 9, 28, 12) // Wednesday
    const recent = new Date(2026, 9, 27).toISOString()
    const old = new Date(2026, 9, 20).toISOString()
    const tasks = [
      { status: 'done' as const, updatedAt: recent, report: { outcome: 'review' as const, summary: '', evidence: [], at: recent } },
      { status: 'done' as const, updatedAt: recent, report: null },
      { status: 'done' as const, updatedAt: recent, report: null, doneNote: 'Approved: the decaf post' },
      { status: 'done' as const, updatedAt: old, report: { outcome: 'review' as const, summary: '', evidence: [], at: old } }
    ]
    const tiles = weekTiles(tasks, { now, code: false, waitingReview: 3, paused: false })
    expect(tiles.map((t) => [t.label, t.value])).toEqual([['Tasks done', '3'], ['Drafts approved', '2'], ['Claude plan', '—']])
    expect(tiles[1]!.detail).toBe('3 waiting for you')
    expect(tiles[2]!.detail).toContain("Claude doesn't report plan limits yet")
    expect(weekTiles(tasks, { now, code: true, waitingReview: 0, paused: false })[1]!.label).toBe('Pull requests')
    expect(weekTiles([], { now, code: false, waitingReview: 0, paused: false, planPercent: 31 })[2]!.value).toBe('31%')
  })
})

describe('D11 QA corpus: common phrasings read as a sentence that listened (step 3 QA)', () => {
  const reply = (request: string) => deskReply({ request, autonomy: 'Asks before posting' })
  it('persons swap by role: subject "you" is "I", object "you" is "me"; my/our become your', () => {
    expect(paraphrase('look into why our orders dropped and tell me what you think')).toBe("I'll look into why your orders dropped and tell you what I think")
    expect(paraphrase("make sure you don't post anything without asking me first")).toBe("I'll make sure I don't post anything without asking you first")
    expect(paraphrase('tell me what you think about the new logo')).toBe("I'll tell you what I think about the new logo")
    expect(paraphrase('Can you send me the October numbers?')).toBe("I'll send you the October numbers")
  })
  it('"Can someone…" and "can you also…" are requests, not questions; no "?." anywhere', () => {
    expect(reply('Can someone write instagram posts for our cold brew launch on Thursday')).toBe("On it. I'll write instagram posts for your cold brew launch on Thursday. I ask before posting, so it comes to Needs you for your OK first.")
    expect(reply('Can someone do a competitor ad review?')).toBe("On it. I'll do a competitor ad review. I ask before posting, so it comes to Needs you for your OK first.")
    expect(reply('can you also do the homepage copy, mention the holiday blend launch on Thursday')).toBe("On it. I'll do the homepage copy, and mention the holiday blend launch on Thursday. I ask before posting, so it comes to Needs you for your OK first.")
    for (const q of ['how did last week’s ads do?', 'Can someone do a competitor ad review?', 'is the shop ready?', 'what?', 'Thanks!']) expect(reply(q)).not.toMatch(/\?\.|\.\./)
    expect(taskTitleFor('Can someone write instagram posts for our cold brew launch on Thursday')).toBe('Write instagram posts for our cold brew launch on Thursday')
    expect(taskTitleFor('Can you get posts ready?')).toBe('Get posts ready')
  })
  it('context around the ask is kept as a note; the title is the ask', () => {
    expect(paraphrase('Thursday we launch the holiday blend. Can you get posts ready?')).toBe("I'll get posts ready. Noted: Thursday you launch the holiday blend")
    expect(taskTitleFor('Thursday we launch the holiday blend. Can you get posts ready?')).toBe('Get posts ready')
  })
  it('questions come back as indirect questions, without the approval line', () => {
    expect(reply("how did last week's ads do?")).toBe("On it. I'll find out how last week's ads did and answer you here.")
    expect(paraphrase('why did our orders drop last week?')).toBe("I'll find out why your orders dropped last week and answer you here")
    expect(paraphrase('which keywords should we rank for?')).toBe("I'll find out which keywords you should rank for and answer you here")
    expect(paraphrase('is the shop ready for Black Friday?')).toBe("I'll find out whether the shop is ready for Black Friday and answer you here")
    expect(paraphrase('does the newsletter go out on Monday?')).toBe("I'll find out whether the newsletter goes out on Monday and answer you here")
    expect(paraphrase('Can we post on Sunday?')).toBe("I'll find out whether you can post on Sunday and answer you here")
    expect(paraphrase('what are competitors running as ads?')).toBe("I'll find out what competitors are running as ads and answer you here")
  })
  it('a merge says where the work stands ("already drafting" only while it is drafted) and only what the request adds', () => {
    const req = 'can you also do the homepage copy, mention the holiday blend launch on Thursday'
    expect(findDuplicate(req, [{ id: 'h', title: 'Draft homepage copy', status: 'todo' }])?.id).toBe('h')
    expect(deskReply({ request: req, autonomy: 'Asks before posting', merged: { title: 'Draft homepage copy', origin: 'setup', status: 'todo' } })).toBe(
      "Got it. Drafting homepage copy is already in my queue (from setup), not started yet. I've added this to it: mention the holiday blend launch on Thursday. Press Start when you want me on it."
    )
    expect(deskReply({ request: req, autonomy: 'Asks before posting', merged: { title: 'Draft homepage copy', origin: 'setup', status: 'blocked', waitingOnOther: true } })).toContain('waiting on another task first')
    expect(deskReply({ request: req, autonomy: 'Asks before posting', merged: { title: 'Draft homepage copy', origin: 'setup', status: 'in_progress' } })).toBe(
      "Got it. I'm already drafting homepage copy (from setup); I'll add this: mention the holiday blend launch on Thursday."
    )
  })
  it('new specific work is not merged into a loosely similar task (Harbor: teeth whitening ≠ the monthly blog post)', () => {
    const open = [{ id: 'b', title: 'First monthly blog post draft', status: 'todo' as const }]
    expect(findDuplicate('Write a blog post about teeth whitening for the La Jolla clinic', open)).toBeNull()
    expect(findDuplicate('add a section on whitening to the monthly blog post', open)?.id).toBe('b')
  })
})

describe('routing by score (step 3 QA)', () => {
  const HD: DeskAgent[] = [
    { id: 'pliny', name: 'Pliny', role: 'SEO Analyst', department: 'Marketing' },
    { id: 'marcus', name: 'Marcus', role: 'Content Writer', department: 'Marketing' },
    { id: 'junia', name: 'Junia', role: 'Report Builder', department: 'Operations' },
    { id: 'cato', name: 'Cato', role: 'Office Liaison', department: 'Front Office' }
  ]
  it('a word of the role beats a rule shared by many: reports to the Report Builder, office work to the Office Liaison', () => {
    expect(routeAsk('build the monthly performance report', HD)!.agent.id).toBe('junia')
    expect(routeAsk('draft the monthly client report', HD)!.agent.id).toBe('junia')
    expect(routeAsk('write the approval packet for the office manager', HD)!.agent.id).toBe('cato')
    expect(routeAsk('write a blog post about teeth whitening', HD)!.agent.id).toBe('marcus')
    expect(routeAsk('which keywords should we rank for?', HD)!.agent.id).toBe('pliny')
  })
  it('an @name nobody here has is said, not silently dropped', () => {
    const r = routeAsk('@Livia fix the booking page', HD)!
    expect(r.unknown).toBe('Livia')
    expect(r.by).not.toBe('mention')
  })
  it('a Report Builder is not a developer (C7: no "merging" outside code)', () => {
    expect(autonomyPhrase({ auto: false, role: 'Report Builder', department: 'Operations' })).toBe('Asks before sending anything out')
    expect(autonomyPhrase({ auto: false, role: 'Dev Builder', department: 'Development' })).toBe('Asks before merging')
  })
})

describe('Ready only for work that can start (step 3 QA)', () => {
  const t = (id: string, title: string, waiting = false) => ({ identifier: id, title, waiting })
  it('a task waiting on another one is never "Ready"', () => {
    const seat = { current: null, review: [], parked: [], kind: 'idle', queue: [t('HD-4', 'Office manager approval packet', true)] }
    expect(statusSentence({ seat, agentPaused: false, code: false })).toEqual({ kind: 'idle', glyph: '○', text: 'Waiting on another task before Office manager approval packet' })
    const both = { ...seat, queue: [t('HD-5', 'Patient FAQ'), t('HD-4', 'Office manager approval packet', true)] }
    expect(statusSentence({ seat: both, agentPaused: false, code: false }).text).toBe('Ready: Patient FAQ (+1 more)')
  })
  it('waitsOnOther reads the dependencies', () => {
    const all = [{ id: 'a', status: 'todo' as const }, { id: 'b', status: 'done' as const }]
    expect(waitsOnOther({ status: 'todo', blockReason: null, dependencyIds: ['a'] }, all)).toBe(true)
    expect(waitsOnOther({ status: 'todo', blockReason: null, dependencyIds: ['b'] }, all)).toBe(false)
    expect(waitsOnOther({ status: 'blocked', blockReason: 'deps', dependencyIds: [] }, all)).toBe(true)
  })
  it('your own chats are not agents in the headline', () => {
    expect(homeHeadline({ company: 'Ledgerly App', needs: 0, working: 0, chats: 1, paused: false, agents: 4 })).toBe('Ledgerly App · nothing needs you, no agent is working; one of your chats is running.')
  })
})
