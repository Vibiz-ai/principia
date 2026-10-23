import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  it('six tools, strict schemas, a compact schema document', () => {
    expect(FORUM_TOOLS).toHaveLength(6)
    for (const t of FORUM_TOOLS) expect(FORUM_TOOL_DEFS[t].inputSchema.additionalProperties).toBe(false)
    expect(() => parseForumArgs('forum_post', { channel: '#a', text: 'x', extra: 1 })).toThrow(/Invalid arguments/)
    expect(() => parseForumArgs('forum_create_channel', { name: 'Bad Name', purpose: 'long enough purpose' })).toThrow()
    expect(() => parseForumArgs('forum_ask', { question: 'ok?', wait_s: 601 })).toThrow()
    expect(FORUM_ARGS.forum_read.parse({})).toEqual({})
    // budget: the tool list an agent pays for stays small
    expect(JSON.stringify(forumSchema().tools).length).toBeLessThan(5200)
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
    expect(mcp.listTools()).toHaveLength(6)
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

  it('caps reply runs per agent per hour and skips inactive seats', () => {
    const { s, owner, post } = setup()
    const starts: { agentId: string; prompt: string; reply: { messageId: string } }[] = []
    const r = responder(s, starts)
    for (let i = 0; i < RESPONDER_LIMITS.perHour + 2; i++) {
      r.onHumanPost(post(owner.id, 'marketing', `msg ${i}`))
      r.onRunEnded(`r_reply${starts.length}`)
    }
    expect(starts).toHaveLength(RESPONDER_LIMITS.perHour)
    clock = new Date(clock.getTime() + 3601_000)
    r.onHumanPost(post(owner.id, 'marketing', 'next hour'))
    expect(starts).toHaveLength(RESPONDER_LIMITS.perHour + 1)
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
