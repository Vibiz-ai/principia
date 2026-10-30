import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FORUM_LIMITS, messageRef, type ForumEvent } from '../../shared/forum'
import { ForumStore, newInviteCode, normalizeInviteCode, type ForumDirectory } from './store'
import * as policy from './policy'
import { parseText } from './refs'
import { FORUM_ARGS, FORUM_TOOL_DEFS, FORUM_TOOLS, forumSchema, parseForumArgs, parseForumBlocks } from './protocol'
import { ForumRefusal, type ForumCaller } from './agentApi'
import { ForumService, type ForumServiceDeps, type ForumTaskView } from './service'
import { attachForum } from './attach'
import { forumMcpHandlers, parseCli } from './cli/main'
import { formatBrief, messageLine } from './format'
import { ForumResponder, pickResponders, RESPONDER_LIMITS, type ResponderDeps } from './responder'

const CO = 'co_acme'
const CO2 = 'co_other'
let db: Database.Database
let deps: { departments: { id: string; key: string; name: string; archivedAt: string | null }[]; agents: { id: string; departmentId: string | null; name: string; archivedAt: string | null; personaName: string | null; companyId: string }[] }
let events: ForumEvent[]
let clock: Date

const directory: ForumDirectory = {
  departments: (companyId) => (companyId === CO ? deps.departments : []),
  agents: (companyId) => deps.agents.filter((a) => a.companyId === companyId),
  ownerName: () => 'Lautaro',
  hasCompany: (id) => id === CO || id === CO2
}

beforeEach(() => {
  db = new Database(':memory:')
  clock = new Date('2026-10-21T10:00:00.000Z')
  events = []
  deps = {
    departments: [{ id: 'dep_mkt', key: 'marketing', name: 'Marketing', archivedAt: null }, { id: 'dep_dev', key: 'development', name: 'Development', archivedAt: null }],
    agents: [
      { id: 'agt_marcus', companyId: CO, departmentId: 'dep_mkt', name: 'Copywriter', archivedAt: null, personaName: 'Marcus' },
      { id: 'agt_livia', companyId: CO, departmentId: 'dep_dev', name: 'Bug fixer', archivedAt: null, personaName: 'Livia' },
      { id: 'agt_other', companyId: CO2, departmentId: null, name: 'Spy', archivedAt: null, personaName: 'Cato' }
    ]
  }
})
afterEach(() => db.close())

function store(): ForumStore {
  return new ForumStore(db, { directory, now: () => clock, onEvent: (e) => events.push(e) })
}

describe('ForumStore: auto-membership (§1.2)', () => {
  it('creates the owner, #general, #proposals, department channels and agent members, idempotently', () => {
    const s = store()
    s.sync(CO)
    s.sync(CO)
    const owner = s.owner(CO)
    expect(owner).toMatchObject({ role: 'owner', handle: 'lautaro', kind: 'human' })
    const names = s.channels(CO, owner.id).map((c) => c.name)
    expect(names).toEqual(expect.arrayContaining(['general', 'proposals', 'marketing', 'development']))
    expect(names).toHaveLength(4)
    const marcus = s.memberForAgent('agt_marcus')!
    expect(marcus).toMatchObject({ handle: 'marcus', name: 'Marcus', kind: 'agent' })
    const mkt = s.channelByName(CO, 'marketing')!
    expect(mkt.memberIds).toContain(marcus.id)
    expect(s.channelByName(CO, 'development')!.memberIds).not.toContain(marcus.id)
    expect(s.channelByName(CO, 'general')!.memberIds).toEqual(expect.arrayContaining([owner.id, marcus.id]))
  })

  it('archives the channel of an archived department and removes archived seats', () => {
    const s = store()
    s.sync(CO)
    deps.departments[0].archivedAt = '2026-10-21T11:00:00.000Z'
    deps.agents[0].archivedAt = '2026-10-21T11:00:00.000Z'
    s.sync(CO)
    expect(s.channelByName(CO, 'marketing')!.archivedAt).toBeTruthy()
    expect(s.memberForAgent('agt_marcus')!.status).toBe('removed')
  })

  it('follows a persona rename (handle only when free) and keeps companies apart', () => {
    const s = store()
    s.sync(CO)
    s.sync(CO2)
    deps.agents[0].personaName = 'Marcus Aurelius'
    s.sync(CO)
    expect(s.memberForAgent('agt_marcus')).toMatchObject({ name: 'Marcus Aurelius', handle: 'marcusaurelius' })
    expect(s.memberByHandle(CO, 'cato')).toBeNull()
    expect(s.memberByHandle(CO2, 'cato')).not.toBeNull()
  })
})

describe('ForumStore: messages, mentions, threads, read state', () => {
  it('posts with mentions, department mentions, refs, unread and mention counts', () => {
    const s = store()
    s.sync(CO)
    const owner = s.owner(CO)
    const marcus = s.memberForAgent('agt_marcus')!
    const livia = s.memberForAgent('agt_livia')!
    const general = s.channelByName(CO, 'general')!
    const m = s.post(owner.id, { channelId: general.id, text: 'Hi @marcus and @development, see PRN-12 and [[Stripe]] https://x.dev/a.' })
    expect(m.mentions).toEqual(expect.arrayContaining([marcus.id, livia.id]))
    expect(m.mentionDepartments).toEqual(['dep_dev'])
    expect(m.refs.map((r) => r.kind)).toEqual(['url', 'task', 'note'])
    expect(m.ref).toBe(messageRef(m.seq))
    const forMarcus = s.channel(general.id, marcus.id)
    expect(forMarcus).toMatchObject({ unread: 1, mentions: 1 })
    expect(s.channel(general.id, owner.id).unread).toBe(0)
    s.markRead(marcus.id, general.id)
    expect(s.channel(general.id, marcus.id)).toMatchObject({ unread: 0, mentions: 0 })
    expect(events.some((e) => e.kind === 'message')).toBe(true)
  })

  it('threads are one level deep and count replies and repliers', () => {
    const s = store()
    s.sync(CO)
    const owner = s.owner(CO)
    const marcus = s.memberForAgent('agt_marcus')!
    const ch = s.channelByName(CO, 'marketing')!
    const root = s.post(owner.id, { channelId: ch.id, text: 'Launch copy?' })
    const r1 = s.post(marcus.id, { channelId: ch.id, threadId: root.id, text: 'On it' })
    const r2 = s.post(owner.id, { channelId: ch.id, threadId: r1.id, text: 'Thanks' })
    expect(r2.threadId).toBe(root.id)
    const t = s.thread(root.id)
    expect(t.root).toMatchObject({ replyCount: 2, repliers: [marcus.id, owner.id] })
    expect(t.replies.map((x) => x.text)).toEqual(['On it', 'Thanks'])
    // replies do not show as top-level messages or unread channel messages
    expect(s.messages(ch.id).map((x) => x.id)).toEqual([root.id])
    expect(s.threadActivity(marcus.id, ch.id, 0).map((x) => x.text)).toEqual(['Thanks'])
  })

  it('reactions toggle, edits and deletes are author-only, search respects filters and visibility', () => {
    const s = store()
    s.sync(CO)
    const owner = s.owner(CO)
    const marcus = s.memberForAgent('agt_marcus')!
    const ch = s.channelByName(CO, 'marketing')!
    const m = s.post(marcus.id, { channelId: ch.id, text: 'Draft hero copy ready' })
    expect(s.react(owner.id, m.id, '👍').reactions).toEqual({ '👍': [owner.id] })
    expect(s.react(owner.id, m.id, '👍').reactions).toEqual({})
    expect(() => s.edit(owner.id, m.id, 'hacked')).toThrow(/own messages/)
    expect(s.edit(marcus.id, m.id, 'Draft hero copy v2').editedAt).toBeTruthy()
    expect(s.search(CO, owner.id, 'hero from:@marcus').map((x) => x.id)).toEqual([m.id])
    expect(s.search(CO, owner.id, 'hero in:#general')).toEqual([])
    const priv = s.createChannel(owner.id, { name: 'secret-plan', kind: 'private', purpose: 'Board only' })
    s.post(owner.id, { channelId: priv.id, text: 'hero acquisition' })
    expect(s.search(CO, marcus.id, 'acquisition')).toEqual([])
    expect(s.edit(owner.id, m.id, null).deletedAt).toBeTruthy()
  })

  it('opens DMs once per member set and refuses cross-company members', () => {
    const s = store()
    s.sync(CO)
    s.sync(CO2)
    const owner = s.owner(CO)
    const marcus = s.memberForAgent('agt_marcus')!
    const a = s.openDm(owner.id, [marcus.id])
    expect(s.openDm(marcus.id, [owner.id]).id).toBe(a.id)
    expect(a.kind).toBe('dm')
    expect(() => s.openDm(owner.id, [s.memberForAgent('agt_other')!.id])).toThrow(/not in your company/)
    expect(() => s.post(owner.id, { channelId: s.channelByName(CO2, 'general')!.id, text: 'hi' })).toThrow()
  })
})

describe('policy (§2)', () => {
  const m = (role: string, kind = 'human', companyId = CO) => ({ id: `fmb_${role}`, companyId, kind: kind as 'human', role: role as 'owner', status: 'active' as const })
  const ch = (kind: string, extra: object = {}) => ({ id: 'fch_1', companyId: CO, kind: kind as 'public', system: null, archivedAt: null, createdBy: null, ...extra })
  it('read and post', () => {
    expect(policy.canRead(m('member'), ch('public'), false).ok).toBe(true)
    expect(policy.canRead(m('guest', 'guest'), ch('public'), false).ok).toBe(false)
    expect(policy.canRead(m('guest', 'guest'), ch('public'), true).ok).toBe(true)
    expect(policy.canRead(m('owner'), ch('private'), false).ok).toBe(false)
    expect(policy.canRead(m('member', 'human', CO2), ch('public'), true).ok).toBe(false)
    expect(policy.canPost(m('owner'), ch('public', { archivedAt: 'x' }), true).ok).toBe(false)
  })
  it('channels, invites, DMs, proposals', () => {
    expect(policy.canCreateChannel(m('agent', 'agent'), 'private').ok).toBe(false)
    expect(policy.canCreateChannel(m('agent', 'agent'), 'public').ok).toBe(true)
    expect(policy.canCreateChannel(m('guest', 'guest'), 'public').ok).toBe(false)
    expect(policy.canInvite(m('agent', 'agent'), 'member').ok).toBe(false)
    expect(policy.canInvite(m('member'), 'guest').ok).toBe(false)
    expect(policy.canInvite(m('admin'), 'admin').ok).toBe(false)
    expect(policy.canInvite(m('admin'), 'guest').ok).toBe(true)
    expect(policy.canInvite(m('owner'), 'admin').ok).toBe(true)
    expect(policy.canDm(m('agent', 'agent'), m('guest', 'guest'), true).ok).toBe(false)
    expect(policy.canDm(m('guest', 'guest'), m('member'), false).ok).toBe(false)
    expect(policy.canDecide(m('agent', 'agent'), { status: 'open' }).ok).toBe(false)
    expect(policy.canDecide(m('admin'), { status: 'approved' }).ok).toBe(false)
    expect(policy.canManageChannel(m('owner'), ch('public', { system: 'general' }), 'archive').ok).toBe(false)
    expect(policy.canBroadcast(m('agent', 'agent'))).toBe(false)
  })
})

describe('invites (§2.2)', () => {
  it('stores only a hash, redeems once, honours expiry, revocation and guest scope', () => {
    const s = store()
    s.sync(CO)
    const owner = s.owner(CO)
    const inv = s.createInvite(owner.id, { role: 'member', label: 'Ana' })
    expect(inv.code).toMatch(/^PF-[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    expect(JSON.stringify(db.prepare('SELECT * FROM forum_invites').all())).not.toContain(inv.code!)
    const ana = s.acceptInvite({ code: inv.code!.toLowerCase(), name: 'Ana Ruiz' })
    expect(ana).toMatchObject({ role: 'member', handle: 'anaruiz', kind: 'human' })
    expect(() => s.acceptInvite({ code: inv.code!, name: 'Eve' })).toThrow(/used/)
    const mkt = s.channelByName(CO, 'marketing')!
    const g = s.createInvite(owner.id, { role: 'guest', channelIds: [mkt.id], expiresInDays: 1 })
    clock = new Date('2026-10-23T10:00:00.000Z')
    expect(() => s.acceptInvite({ code: g.code!, name: 'Late' })).toThrow(/expired/)
    clock = new Date('2026-10-21T10:00:00.000Z')
    const g2 = s.createInvite(owner.id, { role: 'guest', channelIds: [mkt.id] })
    const guest = s.acceptInvite({ code: `principia://forum/join/${g2.code}`, name: 'Gus' })
    expect(s.channels(CO, guest.id).map((c) => c.name)).toEqual(['marketing'])
    const r = s.createInvite(owner.id, { role: 'member' })
    s.revokeInvite(owner.id, r.id)
    expect(() => s.acceptInvite({ code: r.code!, name: 'Rex' })).toThrow(/revoked/)
    expect(() => s.createInvite(s.memberForAgent('agt_marcus')!.id, { role: 'member' })).toThrow(/Agents cannot invite/)
    expect(() => s.createInvite(ana.id, { role: 'guest', channelIds: [mkt.id] })).toThrow(/owner and admins/)
  })
  it('codes normalize Crockford aliases', () => {
    const c = newInviteCode()
    expect(normalizeInviteCode(c.replace(/0/g, 'o').toLowerCase())).toBe(c)
  })
})

describe('protocol (§4)', () => {
  it('ten tools (six Forum, forum_ask_agent, three team reads), strict schemas, a compact schema document', () => {
    expect(FORUM_TOOLS).toHaveLength(10)
    for (const t of FORUM_TOOLS) expect(FORUM_TOOL_DEFS[t].inputSchema.additionalProperties).toBe(false)
    expect(() => parseForumArgs('forum_post', { channel: '#a', text: 'x', extra: 1 })).toThrow(/Invalid arguments/)
    expect(() => parseForumArgs('forum_create_channel', { name: 'Bad Name', purpose: 'long enough purpose' })).toThrow()
    expect(() => parseForumArgs('forum_ask', { question: 'ok?', wait_s: 601 })).toThrow()
    expect(FORUM_ARGS.forum_read.parse({})).toEqual({})
    // budget: the tool list an agent pays for stays small (forum_reply carries task, a hire proposal and answer_task)
    expect(JSON.stringify(forumSchema().tools).length).toBeLessThan(8100)
  })
  it('parses fenced blocks: ops object, arrays, single ops, junk and caps', () => {
    const out = [
      'Done.',
      '```forum',
      '{"ops":[{"op":"post","channel":"#marketing","text":"hi"},{"op":"nope"}]}',
      '```',
      '```forum',
      '[{"op":"reply","to":"m3","text":"x"}]',
      '```',
      '```forum',
      'not json',
      '```'
    ].join('\n')
    const r = parseForumBlocks(out)
    expect(r.ops.map((o) => o.tool)).toEqual(['forum_post', 'forum_reply'])
    expect(r.errors).toHaveLength(2)
    const many = '```forum\n' + JSON.stringify({ ops: Array.from({ length: 9 }, () => ({ op: 'post', channel: '#a', text: 'x' })) }) + '\n```'
    expect(parseForumBlocks(many).ops).toHaveLength(FORUM_LIMITS.fencedOps)
  })
  it('text parsing finds handles, broadcast and refs but not words', () => {
    const p = parseText('ping @Marcus @here re m3fk and me, email a@b.co, PRN-7')
    expect(p.handles).toEqual(['marcus'])
    expect(p.broadcast).toBe(true)
    expect(p.messageRefs).toEqual(['m3fk'])
    expect(p.refs.map((r) => r.id)).toEqual(['PRN-7'])
  })
})

// ---------- service + agent API ----------

interface FakeTask extends ForumTaskView { answered?: string }
let tasks: Map<string, FakeTask>
let created: { department: string[]; agent: string[]; tasks: string[] }

function service(extra: Partial<ForumServiceDeps> = {}): ForumService {
  tasks = new Map()
  created = { department: [], agent: [], tasks: [] }
  return new ForumService({
    db,
    directory,
    enabled: () => true,
    emit: (e) => events.push(e),
    now: () => clock,
    tasks: {
      get: (id) => tasks.get(id) ?? null,
      setAsk: (id, ask) => {
        const t = tasks.get(id)!
        t.ask = ask ? { prompt: ask.prompt } : null
      },
      answer: (id, answer) => {
        const t = tasks.get(id)!
        if (t.status !== 'blocked') throw new Error('not waiting')
        t.answered = answer
        t.status = 'todo'
        t.ask = { ...t.ask!, answer }
      },
      create: (input) => {
        created.tasks.push(input.title)
        return { id: 'task_1', identifier: 'PRN-1' }
      }
    },
    company: {
      saveDepartment: (input) => {
        if (deps.departments.some((d) => d.name === input.name)) throw new Error('That department exists')
        const d = { id: `dep_${input.name.toLowerCase()}`, key: input.key ?? input.name.toLowerCase(), name: input.name, archivedAt: null }
        deps.departments.push(d)
        created.department.push(d.name)
        return d
      },
      saveAgent: (input) => {
        const a = { id: `agt_${input.role.replace(/\W/g, '').toLowerCase()}`, companyId: input.companyId, departmentId: input.departmentId, name: input.role, archivedAt: null, personaName: 'Junia' }
        deps.agents.push(a)
        created.agent.push(input.role)
        return { id: a.id, name: a.name }
      },
      departmentByKey: (_c, key) => deps.departments.find((d) => d.key === key) ?? null,
      defaultProfile: () => ({ id: 'prof_claude' }),
      profileExists: (id) => id === 'prof_claude',
      companyName: () => 'Acme',
      seatLabel: (id) => (id === 'agt_marcus' ? 'Copywriter, Marketing' : null)
    },
    ...extra
  })
}

function callerFor(s: ForumService, agentId: string, over: Partial<ForumCaller> = {}): ForumCaller {
  s.store.sync(CO)
  return { companyId: CO, memberId: s.store.memberForAgent(agentId)!.id, runId: 'r_run1', stepId: 'st_1', taskId: null, ...over }
}

describe('agent API (§4)', () => {
  it('forum_read digest: mentions first, compact lines, cursor, marks what it showed', async () => {
    const s = service()
    const c = callerFor(s, 'agt_marcus')
    const owner = s.store.owner(CO)
    const mkt = s.store.channelByName(CO, 'marketing')!
    s.store.post(owner.id, { channelId: mkt.id, text: 'Launch copy due Fri. @marcus can you draft?' })
    s.store.post(owner.id, { channelId: s.store.channelByName(CO, 'general')!.id, text: 'Welcome all' })
    const text = await s.api.call(c, 'forum_read', {})
    expect(text.split('\n')[0]).toBe('forum v1 · @marcus (Copywriter, Marketing) · Acme')
    expect(text).toMatch(/^mentions \(1\)$/m)
    expect(text).toMatch(/#marketing \d\d:\d\d @lautaro: Launch copy due Fri\. @marcus can you draft\?/)
    expect(text).toMatch(/^#general \(1 new\)$/m)
    expect(text).toMatch(/^cursor c[0-9a-z]+$/m)
    expect(await s.api.call(c, 'forum_read', {})).toMatch(/nothing new/)
  })

  it('forum_read respects the budget and leaves the rest unread', async () => {
    const s = service()
    const c = callerFor(s, 'agt_marcus')
    const owner = s.store.owner(CO)
    const g = s.store.channelByName(CO, 'general')!
    for (let i = 0; i < 40; i++) s.store.post(owner.id, { channelId: g.id, text: `update ${i} ${'x'.repeat(80)}` })
    const text = await s.api.call(c, 'forum_read', { budget: 1000 })
    expect(text.length).toBeLessThanOrEqual(1100)
    expect(text).toMatch(/… more: \d+ in #general/)
    expect(s.store.channel(g.id, c.memberId).unread).toBeGreaterThan(0)
  })

  it('post, reply, mention and channel reads; refusals are one line', async () => {
    const s = service()
    const c = callerFor(s, 'agt_marcus')
    expect(await s.api.call(c, 'forum_post', { channel: '#marketing', text: 'Draft is in PRN-42', refs: ['[[Brand]]'] })).toMatch(/^ok m[0-9a-z]+ #marketing$/)
    const root = s.store.messages(s.store.channelByName(CO, 'marketing')!.id).at(-1)!
    expect(root.refs.map((r) => r.label)).toEqual(['PRN-42', '[[Brand]]'])
    expect(await s.api.call(c, 'forum_reply', { to: root.ref, text: 'v2 attached' })).toBe(`ok ${messageRef(root.seq + 1)} ↳${root.ref}`)
    expect(await s.api.call(c, 'forum_mention', { who: ['@livia'], text: 'need the hero size' })).toMatch(/^ok m[0-9a-z]+ @livia$/)
    expect(await s.api.call(c, 'forum_mention', { who: ['development'], text: 'build is red' })).toMatch(/#development$/)
    const read = await s.api.call(c, 'forum_read', { channel: '#marketing' })
    expect(read).toMatch(/Draft is in PRN-42 ↳1/)
    await expect(s.api.call(c, 'forum_post', { channel: '#nope', text: 'x' })).rejects.toThrow(/No channel #nope\. Known:/)
    await expect(s.api.call(c, 'forum_post', { channel: '#marketing', text: 'x', bogus: 1 })).rejects.toBeInstanceOf(ForumRefusal)
    await expect(s.api.call(c, 'forum_post', { channel: '#general', text: '@here everyone' })).rejects.toThrow(/@here/)
  })

  it('rate limits: posts per step', async () => {
    const s = service()
    const c = callerFor(s, 'agt_marcus')
    for (let i = 0; i < FORUM_LIMITS.postsPerStep; i++) await s.api.call(c, 'forum_post', { channel: '#marketing', text: `n${i}` })
    await expect(s.api.call(c, 'forum_post', { channel: '#marketing', text: 'one more' })).rejects.toThrow(/in this step/)
  })

  it('cannot read another company, private channels or post as someone else', async () => {
    const s = service()
    s.store.sync(CO2)
    const c = callerFor(s, 'agt_marcus')
    const owner = s.store.owner(CO)
    const priv = s.store.createChannel(owner.id, { name: 'board-room', kind: 'private' })
    s.store.post(owner.id, { channelId: priv.id, text: 'secret' })
    await expect(s.api.call(c, 'forum_read', { channel: '#board-room' })).rejects.toThrow(/private/)
    const other = s.store.channelByName(CO2, 'general')!
    const msg = s.store.post(s.store.owner(CO2).id, { channelId: other.id, text: 'other co' })
    await expect(s.api.call(c, 'forum_read', { thread: msg.ref })).rejects.toThrow(/No message/)
    await expect(s.api.call({ ...c, memberId: s.store.memberForAgent('agt_other')!.id }, 'forum_read', {})).rejects.toThrow(/stale/)
  })

  it('forum_ask waits for a human answer and clears the task ask', async () => {
    const s = service()
    const c = callerFor(s, 'agt_marcus', { taskId: 'task_9' })
    tasks.set('task_9', { id: 'task_9', companyId: CO, identifier: 'PRN-9', status: 'in_progress', blockReason: null, runId: 'r_run1', ask: null, report: null })
    const p = s.api.call(c, 'forum_ask', { question: 'Which tone?', options: ['playful', 'plain'], wait_s: 30 })
    await new Promise((r) => setTimeout(r, 5))
    const ask = s.store.openAsks(CO)[0]
    expect(ask.ask).toMatchObject({ status: 'open', options: ['playful', 'plain'], taskId: 'task_9' })
    expect(tasks.get('task_9')!.ask?.prompt).toMatch(/Which tone\? \(asked in the Forum, #marketing m/)
    s.answer(ask.id, s.store.owner(CO).id, 'playful')
    expect(await p).toBe(`answered ${ask.ref} by @lautaro: playful`)
    expect(tasks.get('task_9')!.ask).toBeNull()
    expect(s.store.thread(ask.id).replies.map((r) => r.text)).toEqual(['playful'])
  })

  it('forum_ask parks the task; the answer wakes it once parked (held while running)', async () => {
    const s = service()
    const c = callerFor(s, 'agt_marcus', { taskId: 'task_9' })
    tasks.set('task_9', { id: 'task_9', companyId: CO, identifier: 'PRN-9', status: 'in_progress', blockReason: null, runId: 'r_run1', ask: null, report: null })
    expect(await s.api.call(c, 'forum_ask', { question: 'Budget for ads?' })).toMatch(/^open m[0-9a-z]+ #marketing · parked/)
    const ask = s.store.openAsks(CO)[0]
    // answered while the run still runs: held
    expect(s.answer(ask.id, s.store.owner(CO).id, '$500').ask).toMatchObject({ status: 'answered', pendingTaskAnswer: true })
    expect(tasks.get('task_9')!.answered).toBeUndefined()
    // the run ends and parks it: reconcile applies the answer (tasks:answer wakes the agent)
    Object.assign(tasks.get('task_9')!, { status: 'blocked', blockReason: 'needs_input' })
    s.reconcileAsks(CO)
    expect(tasks.get('task_9')!.answered).toBe('$500')
    expect(s.store.message(ask.id).ask?.pendingTaskAnswer).toBe(false)
  })

  it('an ask answered on the board shows its answer in the Forum', async () => {
    const s = service()
    const c = callerFor(s, 'agt_marcus', { taskId: 'task_9' })
    tasks.set('task_9', { id: 'task_9', companyId: CO, identifier: 'PRN-9', status: 'in_progress', blockReason: null, runId: 'r_run1', ask: null, report: null })
    await s.api.call(c, 'forum_ask', { question: 'Ship Friday?' })
    const ask = s.store.openAsks(CO)[0]
    tasks.get('task_9')!.ask = { prompt: tasks.get('task_9')!.ask!.prompt, answer: 'yes' }
    s.reconcileAsks(CO)
    expect(s.store.message(ask.id).ask).toMatchObject({ status: 'answered', answer: 'yes' })
  })

  it('a reported task never parks on a Forum ask; open asks are capped', async () => {
    const s = service()
    const c = callerFor(s, 'agt_marcus', { taskId: 'task_9' })
    tasks.set('task_9', { id: 'task_9', companyId: CO, identifier: 'PRN-9', status: 'in_progress', blockReason: null, runId: 'r_run1', ask: null, report: { outcome: 'review' } })
    expect(await s.api.call(c, 'forum_ask', { question: 'FYI ok?' })).toMatch(/next forum_read/)
    await s.api.call(c, 'forum_ask', { question: 'q two?' })
    await s.api.call(c, 'forum_ask', { question: 'q three?' })
    await expect(s.api.call(c, 'forum_ask', { question: 'q four?' })).rejects.toThrow(/open asks/)
  })

  it('create_channel with a department proposal; approve creates the department and its channel', async () => {
    const s = service()
    const c = callerFor(s, 'agt_marcus')
    const out = await s.api.call(c, 'forum_create_channel', { name: 'growth-dept', purpose: 'Discuss a growth department', proposal: { kind: 'department', name: 'Growth', does: 'Experiments', doesNot: 'Brand', reason: 'Nobody owns funnels' } })
    expect(out).toMatch(/^ok #growth-dept · proposal m[0-9a-z]+ open$/)
    const p = s.store.openProposals(CO)[0]
    expect(s.store.messages(s.store.channelByName(CO, 'proposals')!.id).at(-1)!.text).toMatch(/Marcus proposed a new department, "Growth"/)
    await expect(s.api.call(c, 'forum_post', { channel: '#general', text: 'again', proposal: { kind: 'department', name: 'Growth2', reason: 'more' } })).rejects.toThrow(/still open/)
    const approved = s.decide({ messageId: p.id, decision: 'approve' }, s.store.owner(CO).id)
    expect(approved.proposal).toMatchObject({ status: 'approved', result: { departmentId: 'dep_growth' } })
    expect(created.department).toEqual(['Growth'])
    expect(s.store.channelByName(CO, 'growth')).not.toBeNull()
    expect(() => s.decide({ messageId: p.id, decision: 'approve' }, s.store.owner(CO).id)).toThrow(/already approved/)
  })

  it('agent proposal: approve with edits hires a seat that joins the Forum; agents cannot decide; reject keeps a note', async () => {
    const s = service()
    const c = callerFor(s, 'agt_marcus')
    await s.api.call(c, 'forum_post', { channel: '#marketing', text: 'We need SEO help', proposal: { kind: 'agent', role: 'SEO writer', department: 'marketing', instructions: 'Write SEO pages', capabilities: 'SEO', reason: 'Organic traffic' } })
    const p = s.store.openProposals(CO)[0]
    expect(() => s.decide({ messageId: p.id, decision: 'approve' }, c.memberId)).toThrow(/owner and admins/)
    const out = s.decide({ messageId: p.id, decision: 'approve', edits: { role: 'SEO lead' } }, s.store.owner(CO).id)
    expect(out.proposal?.result?.agentId).toBe('agt_seolead')
    expect(s.store.memberForAgent('agt_seolead')).toMatchObject({ name: 'Junia' })
    expect(s.store.channelByName(CO, 'marketing')!.memberIds).toContain(s.store.memberForAgent('agt_seolead')!.id)
    const c2 = callerFor(s, 'agt_livia')
    await s.api.call(c2, 'forum_post', { channel: '#development', text: 'QA?', proposal: { kind: 'agent', role: 'QA', department: 'nope', reason: 'tests' } })
    const p2 = s.store.openProposals(CO)[0]
    expect(() => s.decide({ messageId: p2.id, decision: 'approve' }, s.store.owner(CO).id)).toThrow(/No department "nope"/)
    expect(s.store.message(p2.id).proposal).toMatchObject({ status: 'open', error: expect.stringMatching(/nope/) })
    expect(s.decide({ messageId: p2.id, decision: 'reject', note: 'later' }, s.store.owner(CO).id).proposal).toMatchObject({ status: 'rejected', note: 'later' })
  })

  it("PR-55: the founder's go-ahead on a task approves the hire its agent proposed for it; a 'not yet' does not", async () => {
    const s = service()
    const c = callerFor(s, 'agt_marcus', { taskId: 'task_9' })
    tasks.set('task_9', { id: 'task_9', companyId: CO, identifier: 'PRN-9', status: 'in_progress', blockReason: null, runId: 'r_run1', ask: null, report: null, agentId: 'agt_marcus', createdAt: clock.toISOString() })
    await s.api.call(c, 'forum_post', { channel: '#marketing', text: 'Need a release manager', proposal: { kind: 'agent', role: 'Release manager', department: 'marketing', instructions: 'Merge and deploy', capabilities: 'deploy', reason: 'Nobody can merge' } })
    await s.api.call(c, 'forum_ask', { question: 'Approve the Release manager hire?' })
    Object.assign(tasks.get('task_9')!, { status: 'blocked', blockReason: 'needs_input' })
    const ask = s.store.openAsks(CO)[0]
    s.answer(ask.id, s.store.owner(CO).id, 'not yet, wait for Monday')
    expect(created.agent).toEqual([])
    // asked again; this time the founder says go
    Object.assign(tasks.get('task_9')!, { status: 'in_progress', ask: null })
    await s.api.call(c, 'forum_ask', { question: 'Approve it now?' })
    Object.assign(tasks.get('task_9')!, { status: 'blocked', blockReason: 'needs_input' })
    const again = s.store.openAsks(CO)[0]
    s.answer(again.id, s.store.owner(CO).id, 'sounds good go ahead, just hire it')
    expect(created.agent).toEqual(['Release manager'])
    expect(s.store.openProposals(CO)).toEqual([])
    expect(tasks.get('task_9')!.answered).toBe('sounds good go ahead, just hire it')
  })

  it('agents create at most 3 channels a day', async () => {
    const s = service()
    const c = callerFor(s, 'agt_marcus')
    for (const n of ['a-1', 'a-2', 'a-3']) await s.api.call(c, 'forum_create_channel', { name: n, purpose: 'a purpose here' })
    await expect(s.api.call(c, 'forum_create_channel', { name: 'a-4', purpose: 'a purpose here' })).rejects.toThrow(/limit 3/)
  })

  it('make task from a message picks the channel department and the mentioned seat', () => {
    const s = service()
    s.store.sync(CO)
    const owner = s.store.owner(CO)
    const m = s.store.post(owner.id, { channelId: s.store.channelByName(CO, 'marketing')!.id, text: '@marcus write the launch email\nmore detail' })
    expect(s.toTask(m.id, owner.id)).toEqual({ id: 'task_1', identifier: 'PRN-1' })
    expect(created.tasks).toEqual(['write the launch email'])
  })

  it('make task posts a live task card, and its result comes back into the channel once (CHAT-UI.md §8)', () => {
    const s = service()
    s.store.sync(CO)
    const owner = s.store.owner(CO)
    const ch = s.store.channelByName(CO, 'marketing')!.id
    const m = s.store.post(owner.id, { channelId: ch, text: '@marcus write the launch email' })
    tasks.set('task_1', { id: 'task_1', companyId: CO, identifier: 'PRN-1', status: 'todo', blockReason: null, runId: null, ask: null, report: null, agentId: 'agt_marcus' })
    s.toTask(m.id, owner.id)
    const card = s.store.thread(m.id).replies.find((r) => r.task)!
    expect(card.kind).toBe('system')
    expect(card.text).toBe('Lautaro started PRN-1: write the launch email')
    expect(card.task).toMatchObject({ taskId: 'task_1', identifier: 'PRN-1', state: 'queued', agentId: 'agt_marcus', messageId: m.id })
    // nothing came back yet: no post
    expect(s.reconcileTaskCards(CO, { post: true })).toBe(0)
    // the run ended in review with no post of its own: Principia posts the result as Marcus, once
    Object.assign(tasks.get('task_1')!, { status: 'in_review', runId: 'run_9', report: { summary: 'Drafted the email\nmore lines' }, prUrl: 'https://github.com/acme/site/pull/7', updatedAt: clock.toISOString() })
    expect(s.reconcileTaskCards(CO, { post: true })).toBe(1)
    expect(s.reconcileTaskCards(CO, { post: true })).toBe(0)
    const back = s.store.messages(ch).filter((x) => x.origin === 'principia:run_9')
    expect(back.map((x) => x.text)).toEqual(['PRN-1 is ready for your review: Drafted the email\nPull request: https://github.com/acme/site/pull/7'])
    expect(back[0]!.authorId).toBe(s.store.memberForAgent('agt_marcus')!.id)
    expect(s.store.message(card.id).task).toMatchObject({ state: 'in_review', result: 'Drafted the email', prUrl: 'https://github.com/acme/site/pull/7', resultFor: 'run_9' })
    // done for good: final, and no longer followed
    tasks.get('task_1')!.status = 'done'
    s.reconcileTaskCards(CO, { post: true })
    expect(s.store.message(card.id).task).toMatchObject({ state: 'done', final: true })
    expect(s.store.taskCards(CO, { open: true })).toEqual([])
  })

  it('forum_reply task: a person asked, so the agent files it once, for itself; an agent message never becomes a task', async () => {
    const s = service()
    s.store.sync(CO)
    const owner = s.store.owner(CO)
    const ch = s.store.channelByName(CO, 'marketing')!.id
    const m = s.store.post(owner.id, { channelId: ch, text: '@marcus put a short changelog post on the board' })
    const c = callerFor(s, 'agt_marcus')
    expect(await s.api.call(c, 'forum_reply', { to: m.ref, text: 'On the Board now.', task: { title: 'Short changelog post' } })).toMatch(/ · filed PRN-1$/)
    expect(created.tasks).toEqual(['Short changelog post'])
    expect(await s.api.call(c, 'forum_reply', { to: m.ref, text: 'Again', task: { title: 'Short changelog post' } })).toMatch(/ · already filed as PRN-1: not filed again/)
    expect(created.tasks).toHaveLength(1)
    const mine = s.store.thread(m.id).replies.find((x) => x.text === 'On the Board now.')!
    expect(await s.api.call(c, 'forum_reply', { to: mine.ref, text: 'x', task: { title: 'Self made' } })).toMatch(/only a person’s request becomes a task/)
    expect(created.tasks).toHaveLength(1)
  })
})

describe('engine bridge, HTTP, CLI and MCP (§3, §4.1)', () => {
  let s: ForumService
  afterEach(async () => {
    await s?.stop()
  })

  it('open() issues a step token with the brief; close() revokes it; HTTP serves only valid tokens', async () => {
    s = service()
    const url = await s.start()
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    s.store.sync(CO)
    s.store.post(s.store.owner(CO).id, { channelId: s.store.channelByName(CO, 'marketing')!.id, text: '@marcus ping' })
    expect(s.open({ runId: 'r_1', stepId: 'st_1', taskId: null, agentId: null, adapter: 'claude', companyId: CO })).toBeNull()
    const spawn = s.open({ runId: 'r_1', stepId: 'st_1', taskId: null, agentId: 'agt_marcus', adapter: 'gemini', companyId: CO })!
    expect(spawn.env).toMatchObject({ PRINCIPIA_FORUM_URL: url, PRINCIPIA_FORUM_ME: '@marcus' })
    expect(spawn.server).toBeNull() // no CLI bundle in tests: inject transport
    expect(spawn.prompt).toMatch(/^<principia-forum you="@marcus" v="1">\nUnread mentions \(1\): m[0-9a-z]+ #marketing @lautaro "@marcus ping"/)
    expect(spawn.prompt.length).toBeLessThanOrEqual(FORUM_LIMITS.injectBriefMax)
    const token = spawn.env.PRINCIPIA_FORUM_TOKEN
    const post = (tok: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${url}/v1/forum_post`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, ...headers }, body: JSON.stringify(body) })
    const ok = await post(token, { channel: '#marketing', text: 'from http' })
    expect(ok.status).toBe(200)
    expect(await ok.text()).toMatch(/^ok m/)
    expect((await post(token, { channel: '#marketing' })).status).toBe(400)
    expect((await post('x'.repeat(40), { channel: '#marketing', text: 'y' })).status).toBe(401)
    expect((await post(token, { channel: '#marketing', text: 'y' }, { origin: 'https://evil.example' })).status).toBe(403)
    const schema = await (await fetch(`${url}/v1/schema`)).json()
    expect(schema.tools.map((t: { name: string }) => t.name)).toEqual([...FORUM_TOOLS])
    // the MCP server and the CLI speak the same endpoint
    const mcp = forumMcpHandlers({ PRINCIPIA_FORUM_URL: url!, PRINCIPIA_FORUM_TOKEN: token })
    expect(mcp.listTools()).toHaveLength(10)
    const res = await mcp.callTool('forum_read', { channel: '#marketing' })
    expect(res.content[0].text).toMatch(/from http/)
    s.close('st_1')
    expect((await post(token, { channel: '#marketing', text: 'late' })).status).toBe(401)
    expect(s.tokenCount()).toBe(0)
  })

  it('harvests fenced ops of a seat run, idempotently per step', async () => {
    s = service()
    db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, agent_id TEXT, task_id TEXT, company_id TEXT)")
    db.prepare('INSERT INTO runs VALUES (?,?,?,?)').run('r_h', 'agt_livia', null, CO)
    const output = 'Fixed it.\n```forum\n{"ops":[{"op":"post","channel":"#development","text":"Build is green again"},{"op":"mention","who":["@lautaro"],"text":"deploy when ready"}]}\n```\n'
    const e = { runId: 'r_h', stepId: 'st_h', adapter: 'codex', status: 'passed', output, companyId: CO }
    expect(await s.harvest(e)).toBe(2)
    expect(await s.harvest(e)).toBe(2)
    const dev = s.store.channelByName(CO, 'development')!
    expect(s.store.messages(dev.id).filter((m) => m.text === 'Build is green again')).toHaveLength(1)
    expect(await s.harvest({ ...e, stepId: 'st_c', status: 'canceled' })).toBe(0)
  })

  it('attachForum merges into claude --mcp-config and --allowedTools, and codex -c overrides', () => {
    const server = { name: 'principia-forum' as const, command: '/bin/p', args: ['/x/forum-cli.js', 'mcp'], env: { PRINCIPIA_FORUM_TOKEN: 't' } }
    const prev = { args: ['--mcp-config', '/d/a.json', '--allowedTools', 'mcp__hivemem__ask_user'], env: {}, files: [{ path: '/d/a.json', content: JSON.stringify({ mcpServers: { hivemem: {} } }) }] }
    const a = attachForum('claude', server, ['forum_read', 'forum_post'], prev, '/d/f.json')!
    expect(a.args).toEqual(['--mcp-config', '/d/a.json', '--allowedTools', 'mcp__hivemem__ask_user,mcp__principia-forum__forum_read,mcp__principia-forum__forum_post'])
    expect(Object.keys(JSON.parse(a.files[0].content).mcpServers)).toEqual(['hivemem', 'principia-forum'])
    const fresh = attachForum('claude', server, ['forum_read'], null, '/d/f.json')!
    expect(fresh.args).toEqual(['--mcp-config', '/d/f.json', '--allowedTools', 'mcp__principia-forum__forum_read'])
    const codex = attachForum('codex', server, ['forum_read'], null, '/d/f.json')!
    expect(codex.args.join(' ')).toMatch(/mcp_servers\.principia-forum\.enabled_tools=\["forum_read"\]/)
    expect(attachForum('gemini', server, ['forum_read'], null, '/d/f.json')).toBeNull()
  })

  it('CLI argv maps to tool calls', () => {
    expect(parseCli(['post', '#marketing', 'hello', 'world'])).toEqual(['forum_post', { channel: '#marketing', text: 'hello world' }])
    expect(parseCli(['ask', 'Which?', '--to', '@ana', '--option', 'a', '--option', 'b', '--wait', '60'])).toEqual(['forum_ask', { question: 'Which?', to: ['@ana'], options: ['a', 'b'], wait_s: 60 }])
    expect(parseCli(['channel', 'new', 'growth', 'A', 'growth', 'room', '--propose-department', 'Growth', '--does', 'x'])[1]).toMatchObject({ name: 'growth', purpose: 'A growth room', proposal: { kind: 'department', name: 'Growth', does: 'x' } })
    expect(parseCli(['read'])).toEqual(['forum_read', {}])
    expect(() => parseCli(['nope'])).toThrow(/forum read/)
  })
})

describe('format (§4.3, §5)', () => {
  it('message lines mark kinds and the MCP brief stays under its cap', () => {
    const s = store()
    s.sync(CO)
    const owner = s.owner(CO)
    const marcus = s.memberForAgent('agt_marcus')!
    const ch = s.channelByName(CO, 'marketing')!
    const ask = s.post(marcus.id, { channelId: ch.id, text: 'Tone?\nplease', kind: 'ask', ask: { status: 'open', to: [owner.id], options: ['a', 'b'] } })
    const l = { me: marcus.id, member: (id: string) => s.member(id), channel: (id: string) => s.channel(id) }
    expect(messageLine(l, ask)).toMatch(/^m[0-9a-z]+ \d\d:\d\d @marcus \?ask→@lautaro \[open\] Tone\? ↵ please \(a\|b\)$/)
    const many = Array.from({ length: 10 }, (_, i) => s.post(owner.id, { channelId: ch.id, text: `@marcus ${'long text '.repeat(30)} ${i}` }))
    const brief = formatBrief(l, { me: marcus, mentions: many, answered: [], openAsks: [ask], transport: 'mcp' })
    expect(brief.length).toBeLessThanOrEqual(FORUM_LIMITS.briefMax)
    expect(brief).toMatch(/<\/principia-forum>$/)
    // the habit line survives clipping: agents are told to keep the team posted in their room
    const homed = formatBrief(l, { me: marcus, mentions: many, answered: [], openAsks: [], transport: 'mcp', home: 'marketing' })
    expect(homed).toMatch(/reply in the thread to unread mentions, and before you end post one short update in #marketing/)
    expect(homed.length).toBeLessThanOrEqual(FORUM_LIMITS.briefMax)
    // a Forum reply run (no task) answers its thread only: no extra room update
    const reply = formatBrief(l, { me: marcus, mentions: [], answered: [], openAsks: [], transport: 'mcp', home: 'marketing', update: false })
    expect(reply).toContain('Answer in the thread you were asked in; do not post anywhere else in this run.')
    expect(reply).not.toContain('post one short update')
  })
})

describe('agents answer people and post their work (§6.4)', () => {
  const seats = (companyId: string, departmentId: string | null) => deps.agents.filter((a) => a.companyId === companyId && !a.archivedAt && (!departmentId || a.departmentId === departmentId)).map((a) => a.id)

  function setup() {
    const s = service()
    s.store.sync(CO)
    const owner = s.store.owner(CO)
    const ch = (n: string) => s.store.channelByName(CO, n)!
    const post = (by: string, channel: string, text: string, threadId?: string) => s.store.post(by, { channelId: ch(channel).id, text, threadId: threadId ?? null })
    return { s, owner, ch, post, marcus: s.store.memberForAgent('agt_marcus')!, livia: s.store.memberForAgent('agt_livia')! }
  }

  it('picks who a message is for: mentions, one agent per department, the thread, the room', () => {
    const { s, owner, post, marcus, livia } = setup()
    const pick = (m: Parameters<typeof pickResponders>[1]) => pickResponders(s.store, m, { seats }).map((x) => x.handle)
    expect(pick(post(owner.id, 'marketing', 'ciao'))).toEqual(['marcus'])
    expect(pick(post(owner.id, 'development', 'heyyy'))).toEqual(['livia'])
    expect(pick(post(owner.id, 'general', 'hello @livia'))).toEqual(['livia'])
    expect(pick(post(owner.id, 'general', 'anyone?'))).toEqual(['marcus'])
    expect(pick(post(owner.id, 'general', '@development status?'))).toEqual(['livia'])
    // a thread goes to the last agent that wrote in it, even in another department's room
    const root = post(owner.id, 'general', 'launch plan')
    post(livia.id, 'general', 'I can take the deploy', root.id)
    expect(pick(post(owner.id, 'general', 'great, when?', root.id))).toEqual(['livia'])
    // agents never wake agents (no loops); system lines never wake anyone
    expect(pick(post(marcus.id, 'general', '@livia ping'))).toEqual([])
    expect(pick(s.store.systemPost(s.store.channelByName(CO, 'general')!.id, 'Marcus joined')!)).toEqual([])
  })

  it('CHAT-UI.md §7: a conversation (private chat-… channel) wakes every agent in it; an @name wakes only them', () => {
    const { s, owner, marcus, livia } = setup()
    const pick = (m: Parameters<typeof pickResponders>[1]) => pickResponders(s.store, m, { seats }).map((x) => x.handle)
    const conv = s.store.createChannel(owner.id, { name: 'chat-launch-plan-ab12', kind: 'private', purpose: 'Principia brought in Marcus and Livia.', memberIds: [marcus.id, livia.id] })
    s.store.updateChannel(owner.id, conv.id, { topic: 'Launch plan' })
    const say = (text: string) => s.store.post(owner.id, { channelId: conv.id, text, threadId: null })
    expect(pick(say('we need a post and a fix')).sort()).toEqual(['livia', 'marcus'])
    expect(pick(say('@livia only you'))).toEqual(['livia'])
    // a private channel that is not a conversation keeps the room rule (nobody: no department, not #general)
    const other = s.store.createChannel(owner.id, { name: 'secret-plans', kind: 'private', memberIds: [marcus.id] })
    expect(pick(s.store.post(owner.id, { channelId: other.id, text: 'hello', threadId: null }))).toEqual([])
    // the reply run is named by the conversation's title, never its slug
    const starts: { agentId: string; prompt: string; reply: { messageId: string } }[] = []
    responder(s, starts).onHumanPost(say('status?'))
    // who and where: "Marcus replying in “Launch plan”" (the Live rows name the agent, never two identical rows)
    expect(starts[0]?.prompt).toMatch(/^\S+ replying in “Launch plan”/)
    expect(starts.map((x) => x.prompt.split('\n')[0]).sort()).toEqual([`${livia.name} replying in “Launch plan”`, `${marcus.name} replying in “Launch plan”`].sort())
  })

  it('CHAT-UI.md §7: a reply run is present IN its conversation, so only that conversation shows "answering…"', () => {
    const { s, owner, marcus } = setup()
    const conv = s.store.createChannel(owner.id, { name: 'chat-oat-milk-ab12', kind: 'private', purpose: '', memberIds: [marcus.id] })
    // the run opened its Forum before the responder noted what it answers
    s.setPresence(CO, marcus.id, 'working', null)
    s.noteReplyRun('r_x', { memberId: marcus.id, channelId: conv.id, messageId: 'm_x' })
    expect(s.presenceOf(CO).find((p) => p.memberId === marcus.id)?.channelId).toBe(conv.id)
  })

  function responder(s: ForumService, starts: { agentId: string; prompt: string; reply: { messageId: string } }[], over: Partial<ResponderDeps> = {}) {
    let n = 0
    return new ForumResponder({
      store: () => s.store,
      enabled: () => true,
      seat: (agentId) => {
        const a = deps.agents.find((x) => x.id === agentId)
        return a ? { id: a.id, companyId: a.companyId, departmentId: a.departmentId, name: a.name, instructions: 'Write copy.', profileId: 'prof_claude', repoId: null, active: !a.archivedAt } : null
      },
      departmentName: (id) => deps.departments.find((d) => d.id === id)?.name ?? null,
      seats,
      start: (input) => {
        starts.push(input)
        return `r_reply${++n}`
      },
      now: () => clock,
      ...over
    })
  }

  it('a post in a department room starts a reply run for its agent; more posts queue until it ends', () => {
    const { s, owner, post } = setup()
    const starts: { agentId: string; prompt: string; reply: { messageId: string } }[] = []
    const r = responder(s, starts)
    const first = post(owner.id, 'marketing', 'ciao')
    expect(r.onHumanPost(first)).toEqual(['r_reply1'])
    expect(starts[0]).toMatchObject({ agentId: 'agt_marcus', reply: { messageId: first.id } })
    expect(starts[0].prompt).toMatch(/^Forum reply in #marketing/)
    expect(starts[0].prompt).toContain('<principia-role department="Marketing" agent="Copywriter">')
    expect(starts[0].prompt).toContain(`- ${first.ref} @lautaro: ciao`)
    expect(starts[0].prompt).toContain(`forum_reply {"to":"${first.ref}"`)
    const second = post(owner.id, 'marketing', 'are you there?')
    const third = post(owner.id, 'marketing', 'hello??')
    expect(r.onHumanPost(second)).toEqual([])
    expect(r.onHumanPost(third)).toEqual([])
    expect(r.isAnswering('agt_marcus')).toBe(true)
    r.onRunEnded('r_reply1')
    expect(starts).toHaveLength(2)
    expect(starts[1].prompt).toContain(`- ${second.ref} @lautaro: are you there?`)
    expect(starts[1].prompt).toContain(`- ${third.ref} @lautaro: hello??`)
    expect(starts[1].reply.messageId).toBe(third.id)
  })

  it('a person is never capped: every message past the hourly cap still gets a reply run', () => {
    const { s, owner, post } = setup()
    const starts: { agentId: string; prompt: string; reply: { messageId: string } }[] = []
    const r = responder(s, starts)
    for (let i = 0; i < RESPONDER_LIMITS.perHour + 2; i++) {
      r.onHumanPost(post(owner.id, 'marketing', `msg ${i}`))
      r.onRunEnded(`r_reply${starts.length}`)
    }
    expect(starts).toHaveLength(RESPONDER_LIMITS.perHour + 2)
  })

  it('a message nobody can answer gets a line saying why, in its thread', () => {
    const { s, owner, post, marcus } = setup()
    const told: [string, string, string][] = []
    const off = responder(s, [], { seat: () => null, onUnanswered: (...a) => told.push(a) })
    const msg = post(owner.id, 'marketing', 'hi')
    expect(off.onHumanPost(msg)).toEqual([])
    expect(told).toHaveLength(1)
    s.noteUnanswered(told[0]![0], told[0]![1], told[0]![2])
    const line = s.store.thread(msg.id).replies.find((m) => m.kind === 'system')
    expect(line?.text).toMatch(new RegExp(`^${marcus.name} could not answer this: .*Send it again to retry\\.$`))
  })

  it('a queued message whose run cannot start is told too', () => {
    const { s, owner, post } = setup()
    const starts: { agentId: string; prompt: string; reply: { messageId: string } }[] = []
    const told: string[] = []
    let up = true
    const r = responder(s, starts, {
      onUnanswered: (id) => told.push(id),
      start: (input) => {
        if (!up) throw new Error('no profile')
        starts.push(input)
        return `r_reply${starts.length}`
      }
    })
    r.onHumanPost(post(owner.id, 'marketing', 'first'))
    const queued = post(owner.id, 'marketing', 'second')
    r.onHumanPost(queued)
    up = false
    r.onRunEnded('r_reply1')
    expect(told).toEqual([queued.id])
  })

  it('a reply run that failed, or ended with nothing, says so once; an answered or canceled one stays quiet', async () => {
    const { s, owner, post, marcus } = setup()
    db.exec('CREATE TABLE runs (id TEXT PRIMARY KEY, agent_id TEXT, task_id TEXT, company_id TEXT)')
    const reply = (id: string, text: string) => {
      db.prepare('INSERT INTO runs VALUES (?,?,?,?)').run(id, 'agt_marcus', null, CO)
      const msg = post(owner.id, 'marketing', text)
      s.noteReplyRun(id, { memberId: marcus.id, channelId: msg.channelId, messageId: msg.id })
      return msg
    }
    const lines = (id: string) => s.store.thread(id).replies.filter((m) => m.kind === 'system').map((m) => m.text)
    const failed = reply('r_f', 'a')
    await s.harvest({ runId: 'r_f', stepId: 'st_f', adapter: 'claude', status: 'failed', output: '', companyId: CO })
    s.settleReply('r_f', 'failed', 'Timed out after 15 min')
    s.settleReply('r_f', 'failed', 'Timed out after 15 min')
    expect(lines(failed.id)).toEqual([`${marcus.name} could not answer this: Timed out after 15 min. Send it again to retry.`])
    const empty = reply('r_e', 'b')
    await s.harvest({ runId: 'r_e', stepId: 'st_e', adapter: 'claude', status: 'passed', output: '', companyId: CO })
    s.settleReply('r_e', 'passed', null)
    expect(lines(empty.id)).toHaveLength(1)
    const good = reply('r_g', 'c')
    await s.harvest({ runId: 'r_g', stepId: 'st_g', adapter: 'claude', status: 'passed', output: 'Done.', companyId: CO })
    s.settleReply('r_g', 'passed', null)
    expect(lines(good.id)).toEqual([])
    const stopped = reply('r_c', 'd')
    s.settleReply('r_c', 'canceled', 'Canceled')
    expect(lines(stopped.id)).toEqual([])
  })

  it('a reply run with no slot after a moment shows as queued, until it starts or ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { s, owner, post, marcus } = setup()
      const msg = post(owner.id, 'marketing', 'hi')
      s.noteReplyRun('r_q', { memberId: marcus.id, channelId: msg.channelId, messageId: msg.id })
      expect(s.presenceOf(CO)).toEqual([])
      vi.advanceTimersByTime(3000)
      expect(s.presenceOf(CO)).toMatchObject([{ memberId: marcus.id, state: 'queued', channelId: msg.channelId }])
      s.settleReply('r_q', 'canceled', 'Canceled')
      expect(s.presenceOf(CO)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  describe('a quit or a crash does not lose a person\'s message', () => {
    type Start = { agentId: string; prompt: string; reply: { memberId: string; channelId: string; messageId: string } }
    /** The app: a new service and responder over the same db, wired like wire.ts. `start` numbers runs across restarts. */
    let runs = 0
    const runsSoFar = () => runs
    function app(over: Partial<ResponderDeps> = {}, quitting: { now: boolean } = { now: false }, extra: Partial<ForumServiceDeps> = {}) {
      const s = service({ quitting: () => quitting.now, ...extra })
      s.store.sync(CO)
      const starts: Start[] = []
      const r = responder(s, starts, {
        journal: s.owed,
        quitting: () => quitting.now,
        onUnanswered: (messageId, memberId, reason) => s.noteUnanswered(messageId, memberId, reason),
        start: (input) => {
          const id = `r_run${++runs}`
          starts.push(input)
          s.noteReplyRun(id, input.reply)
          return id
        },
        ...over
      })
      s.onHumanPost = (m) => void r.onHumanPost(m)
      return { s, r, starts, quitting }
    }
    const say = (s: ForumService, text: string, threadId?: string) => s.store.post(s.store.owner(CO).id, { channelId: s.store.channelByName(CO, 'marketing')!.id, text, threadId: threadId ?? null })
    const lines = (s: ForumService, id: string) => s.store.thread(id).replies.filter((m) => m.kind === 'system').map((m) => m.text)
    const interrupted = (s: ForumService) => `${s.store.memberForAgent('agt_marcus')!.name} could not answer this: Principia closed before the reply finished. Send it again to retry.`
    /** What the run hook does when a run ends (wire.ts). */
    const ended = (a: ReturnType<typeof app>, runId: string, status: string, reason: string | null) => {
      a.r.onRunEnded(runId)
      a.s.settleReply(runId, status, reason)
    }

    it('a crash mid-reply: the message is answered again after the restart, told so, and only once', () => {
      const before = app()
      const msg = say(before.s, 'hello?')
      expect(before.r.onHumanPost(msg)).toHaveLength(1)
      const after = app()
      after.r.recover()
      expect(after.starts.map((x) => x.reply.messageId)).toEqual([msg.id])
      expect(after.starts[0]!.prompt).toContain('Principia closed while you were answering this')
      // a second crash while answering: no third try, the person reads why
      const third = app()
      third.r.recover()
      expect(third.starts).toEqual([])
      expect(lines(third.s, msg.id)).toEqual([interrupted(third.s)])
      expect(third.s.owed.all()).toEqual([])
    })

    it('a clean quit: canceled runs start nothing new, and the running and queued messages both come back', () => {
      const before = app()
      const first = say(before.s, 'first')
      const second = say(before.s, 'second')
      const [runId] = before.r.onHumanPost(first)
      before.r.onHumanPost(second)
      before.quitting.now = true
      ended(before, runId!, 'canceled', 'Hive quit during run')
      expect(before.starts).toHaveLength(1)
      expect(lines(before.s, first.id)).toEqual([])
      const after = app()
      after.r.recover()
      expect(after.starts).toHaveLength(1)
      expect(after.starts[0]!.reply.messageId).toBe(second.id)
      expect(after.starts[0]!.prompt).toContain('first')
      expect(after.starts[0]!.prompt).toContain('second')
    })

    it('a message that was only queued never ran: its restart says nothing about a cut-off reply', () => {
      const before = app()
      const first = say(before.s, 'opening ask')
      const second = say(before.s, 'second')
      const [runId] = before.r.onHumanPost(first)
      before.r.onHumanPost(second)
      before.s.store.post(before.s.store.memberForAgent('agt_marcus')!.id, { channelId: first.channelId, threadId: first.id, text: 'Answer to the opening ask.' })
      before.quitting.now = true
      ended(before, runId!, 'passed', null)
      const after = app()
      after.r.recover()
      expect(after.starts.map((x) => x.reply.messageId)).toEqual([second.id])
      expect(after.starts[0]!.prompt).not.toContain('Principia closed while')
      expect(after.starts[0]!.prompt).not.toContain('opening ask')
    })

    it('an answer that got out before the crash stands: no second reply and no line', () => {
      const before = app()
      const msg = say(before.s, 'hello?')
      before.r.onHumanPost(msg)
      before.s.store.post(before.s.store.memberForAgent('agt_marcus')!.id, { channelId: msg.channelId, threadId: msg.id, text: 'Hi!' })
      const after = app()
      after.r.recover()
      expect(after.starts).toEqual([])
      expect(lines(after.s, msg.id)).toEqual([])
      expect(after.s.owed.all()).toEqual([])
    })

    /** A conversation with one open task question: a person's next message there waits for the classifier. */
    function asked(s: ForumService) {
      const owner = s.store.owner(CO)
      const marcus = s.store.memberForAgent('agt_marcus')!
      const conv = s.store.createChannel(owner.id, { name: 'chat-ask-ab12', kind: 'private', purpose: 'x', memberIds: [marcus.id] })
      tasks.set('t_1', { id: 't_1', identifier: 'AC-1', title: 'x', status: 'blocked', ask: { prompt: 'Which one?' } } as never)
      s.store.post(marcus.id, { channelId: conv.id, text: 'Which one?', kind: 'ask', ask: { status: 'open', to: [owner.id], taskId: 't_1', runId: null } })
      return s.store.post(owner.id, { channelId: conv.id, text: 'the blue one, I think', threadId: null })
    }
    const stuck = () => (() => new Promise<string>(() => undefined)) as never
    const tick = () => new Promise((r) => setTimeout(r, 0))

    it('a quit while the classifier reads a message: the next boot answers it', async () => {
      const before = app({}, { now: false }, { replyKind: stuck })
      const msg = asked(before.s)
      void before.s.routeHumanPost(msg, before.s.store.owner(CO).id)
      await tick()
      expect(before.starts).toEqual([])
      const after = app()
      after.r.recover()
      expect(after.starts.map((x) => x.reply.messageId)).toEqual([msg.id])
      expect(after.starts[0]!.prompt).not.toContain('Principia closed while')
    })

    it('a second quit before anyone is picked gets a line', async () => {
      const held = app({}, { now: false }, { replyKind: stuck })
      const msg = asked(held.s)
      void held.s.routeHumanPost(msg, held.s.store.owner(CO).id)
      await tick()
      db.prepare('UPDATE forum_owed_replies SET attempts=1').run()
      const last = app()
      last.r.recover()
      expect(last.starts).toEqual([])
      expect(lines(last.s, msg.id)).toEqual(['Principia could not answer this: it closed before anyone could reply. Send it again to retry.'])
      expect(last.s.owed.all()).toEqual([])
    })

    it('a message the classifier says answers the question owes nothing', async () => {
      const a = app({}, { now: false }, { replyKind: () => (async () => '{"kind":"answer"}') as never })
      const msg = asked(a.s)
      expect(await a.s.routeHumanPost(msg, a.s.store.owner(CO).id)).toBe('answered')
      expect(a.s.owed.all()).toEqual([])
    })

    it('a message that arrives during a quit starts nothing and is answered at the next boot', () => {
      const before = app()
      before.quitting.now = true
      const msg = say(before.s, 'one last thing')
      expect(before.r.onHumanPost(msg)).toEqual([])
      expect(before.starts).toEqual([])
      const after = app()
      after.r.recover()
      expect(after.starts.map((x) => x.reply.messageId)).toEqual([msg.id])
    })

    it('a long queue loses nothing: oldest first, a few at a time, each message in a reply', () => {
      const a = app()
      const first = say(a.s, 'first')
      const [runId] = a.r.onHumanPost(first)
      const queued = Array.from({ length: RESPONDER_LIMITS.pending + 2 }, (_, i) => say(a.s, `queued ${i}`))
      for (const m of queued) a.r.onHumanPost(m)
      expect(a.s.owed.all()).toHaveLength(queued.length + 1)
      ended(a, runId!, 'canceled', 'Canceled')
      expect(a.starts).toHaveLength(2)
      expect(a.starts[1]!.prompt).toContain('queued 0')
      expect(a.starts[1]!.prompt).toContain(`queued ${RESPONDER_LIMITS.pending - 1}`)
      expect(a.starts[1]!.prompt).not.toContain(`queued ${RESPONDER_LIMITS.pending}`)
      ended(a, 'r_run' + runsSoFar(), 'canceled', 'Canceled')
      expect(a.starts).toHaveLength(3)
      expect(a.starts[2]!.prompt).toContain(`queued ${RESPONDER_LIMITS.pending}`)
      expect(a.starts[2]!.prompt).toContain(`queued ${RESPONDER_LIMITS.pending + 1}`)
      ended(a, 'r_run' + runsSoFar(), 'canceled', 'Canceled')
      expect(a.s.owed.all()).toEqual([])
    })

    it('more owed than one run takes: the boot answers them all, in turn', () => {
      const before = app()
      const first = say(before.s, 'first')
      before.r.onHumanPost(first)
      const queued = Array.from({ length: RESPONDER_LIMITS.pending }, (_, i) => say(before.s, `queued ${i}`))
      for (const m of queued) before.r.onHumanPost(m)
      const after = app()
      after.r.recover()
      expect(after.starts).toHaveLength(1)
      expect(after.starts[0]!.prompt).toContain('first')
      expect(after.starts[0]!.prompt).not.toContain(`queued ${RESPONDER_LIMITS.pending - 1}`)
      ended(after, 'r_run' + runsSoFar(), 'passed', null)
      expect(after.starts).toHaveLength(2)
      expect(after.starts[1]!.prompt).toContain(`queued ${RESPONDER_LIMITS.pending - 1}`)
    })

    it('settled replies leave nothing owed: answered, failed with its line, canceled by the person', () => {
      const a = app()
      for (const [status, reason] of [['passed', null], ['failed', 'Timed out'], ['canceled', 'Canceled']] as const) {
        const msg = say(a.s, status)
        const [runId] = a.r.onHumanPost(msg)
        expect(a.s.owed.all()).toHaveLength(1)
        if (status === 'passed') a.s.store.post(a.s.store.memberForAgent('agt_marcus')!.id, { channelId: msg.channelId, threadId: msg.id, text: 'Hi!' })
        ended(a, runId!, status, reason)
      }
      expect(a.s.owed.all()).toEqual([])
      const after = app()
      after.r.recover()
      expect(after.starts).toEqual([])
    })

    it('old messages and seats that cannot answer get a line, never a late answer or silence', () => {
      const before = app()
      const old = say(before.s, 'from days ago')
      before.r.onHumanPost(old)
      clock = new Date(clock.getTime() + 25 * 3600_000)
      const later = app()
      later.r.recover()
      expect(later.starts).toEqual([])
      expect(lines(later.s, old.id)).toEqual([interrupted(later.s)])

      const paused = say(later.s, 'hi')
      later.r.onHumanPost(paused)
      const off = app({ seat: () => null })
      off.r.recover()
      expect(off.starts).toEqual([])
      expect(lines(off.s, paused.id)[0]).toContain('cannot answer')
      expect(off.s.owed.all()).toEqual([])
    })

    it('a reply that cannot start gets a line, the next agent still recovers, and a message gone since is dropped', () => {
      const a = app()
      const owner = a.s.store.owner(CO)
      const gone = say(a.s, 'never mind')
      a.r.onHumanPost(gone)
      db.prepare('DELETE FROM forum_messages WHERE id=?').run(gone.id)
      const conv = a.s.store.createChannel(owner.id, { name: 'chat-both-ab12', kind: 'private', purpose: 'x', memberIds: [a.s.store.memberForAgent('agt_marcus')!.id, a.s.store.memberForAgent('agt_livia')!.id] })
      const both = a.s.store.post(owner.id, { channelId: conv.id, text: 'both of you', threadId: null })
      a.r.onHumanPost(both)
      expect(a.s.owed.all()).toHaveLength(2)
      const started: string[] = []
      const after = app({
        start: (input) => {
          if (input.agentId === 'agt_marcus') throw new Error('no slot')
          started.push(input.agentId)
          return 'r_ok'
        }
      })
      after.r.recover()
      expect(started).toEqual(['agt_livia'])
      expect(lines(after.s, both.id)).toEqual([expect.stringContaining('could not start @')])
      // Livia's reply is running; nothing else is left
      expect(after.s.owed.all().map((r) => [r.memberId, r.runId])).toEqual([[after.s.store.memberForAgent('agt_livia')!.id, 'r_ok']])
    })
  })

  it('skips inactive seats', () => {
    const { s, owner, post } = setup()
    const off = responder(s, [], { seat: () => null })
    expect(off.onHumanPost(post(owner.id, 'development', 'hi'))).toEqual([])
  })

  it('a reply run that does not post has its answer posted in the thread; a fenced post counts as posting', async () => {
    const { s, owner, post, marcus } = setup()
    db.exec('CREATE TABLE runs (id TEXT PRIMARY KEY, agent_id TEXT, task_id TEXT, company_id TEXT)')
    db.prepare('INSERT INTO runs VALUES (?,?,?,?)').run('r_reply1', 'agt_marcus', null, CO)
    const msg = post(owner.id, 'marketing', 'ciao')
    s.noteReplyRun('r_reply1', { memberId: marcus.id, channelId: msg.channelId, messageId: msg.id })
    await s.harvest({ runId: 'r_reply1', stepId: 'st_r1', adapter: 'claude', status: 'passed', output: 'Ciao! I write the launch copy. What do you need?', companyId: CO })
    expect(s.store.thread(msg.id).replies.map((m) => [m.authorId, m.text])).toEqual([[marcus.id, 'Ciao! I write the launch copy. What do you need?']])
    // the same step again: idempotent
    await s.harvest({ runId: 'r_reply1', stepId: 'st_r1', adapter: 'claude', status: 'passed', output: 'Ciao! I write the launch copy. What do you need?', companyId: CO })
    expect(s.store.thread(msg.id).replies).toHaveLength(1)
    // a failed step posts nothing
    await s.harvest({ runId: 'r_reply1', stepId: 'st_r2', adapter: 'claude', status: 'failed', output: 'boom', companyId: CO })
    expect(s.store.thread(msg.id).replies).toHaveLength(1)
    // a step that wrote with a fenced block gets no extra post
    const out = `Done.\n\`\`\`forum\n{"ops":[{"op":"reply","to":"${msg.ref}","text":"replied myself"}]}\n\`\`\`\n`
    await s.harvest({ runId: 'r_reply1', stepId: 'st_r3', adapter: 'gemini', status: 'passed', output: out, companyId: CO })
    expect(s.store.thread(msg.id).replies.map((m) => m.text)).toEqual(['Ciao! I write the launch copy. What do you need?', 'replied myself'])
  })

  it('a task run that never posted leaves its update in the seat room; one that posted through the endpoint does not', async () => {
    const { s } = setup()
    db.exec('CREATE TABLE runs (id TEXT PRIMARY KEY, agent_id TEXT, task_id TEXT, company_id TEXT)')
    db.prepare('INSERT INTO runs VALUES (?,?,?,?)').run('r_task', 'agt_marcus', 'task_9', CO)
    tasks.set('task_9', { id: 'task_9', companyId: CO, identifier: 'PRN-9', status: 'in_progress', blockReason: null, runId: 'r_task', ask: null, report: null })
    const mkt = s.store.channelByName(CO, 'marketing')!
    await s.harvest({ runId: 'r_task', stepId: 'st_t1', adapter: 'claude', status: 'passed', output: 'Landing page drafted and moved to review.\n```principia-report\n{"outcome":"review"}\n```', companyId: CO })
    expect(s.store.messages(mkt.id).map((m) => m.text)).toEqual(['PRN-9: Landing page drafted and moved to review.'])
    // a step that posted itself (forum_post through the HTTP endpoint) is not posted for again
    await s.start()
    const spawn = s.open({ runId: 'r_task', stepId: 'st_t2', taskId: 'task_9', agentId: 'agt_marcus', adapter: 'gemini', companyId: CO })!
    expect(spawn.prompt).toContain('post one short update in #marketing')
    const res = await fetch(`${s.http.url}/v1/forum_post`, { method: 'POST', headers: { authorization: `Bearer ${spawn.env.PRINCIPIA_FORUM_TOKEN}` }, body: JSON.stringify({ channel: '#marketing', text: 'Started the email sequence' }) })
    expect(res.status).toBe(200)
    await s.harvest({ runId: 'r_task', stepId: 'st_t2', adapter: 'gemini', status: 'passed', output: 'All done', companyId: CO })
    expect(s.store.messages(mkt.id).map((m) => m.text)).toEqual(['PRN-9: Landing page drafted and moved to review.', 'Started the email sequence'])
    s.close('st_t2')
    await s.stop()
  })

  it('humanPosted hands the message to the responder and never throws', () => {
    const { s, owner, post } = setup()
    const seen: string[] = []
    s.onHumanPost = (m) => seen.push(m.text)
    s.humanPosted(post(owner.id, 'general', 'hi all'))
    s.onHumanPost = () => {
      throw new Error('boom')
    }
    expect(() => s.humanPosted(post(owner.id, 'general', 'again'))).not.toThrow()
    expect(seen).toEqual(['hi all'])
  })
})
