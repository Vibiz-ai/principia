/**
 * FORUM.md §4: the protocol's main side. Every transport (MCP via the forum CLI, HTTP, CLI, fenced block) ends here
 * with a caller resolved from the step token (never from the arguments). Results are the compact text of §4.3; a
 * refusal throws ForumRefusal with the one line the agent sees. Rate limits (§2.3) are enforced here.
 */
import { FORUM_LIMITS, FORUM_PROTOCOL_VERSION, parseSeqRef, type ForumAsk, type ForumChannel, type ForumMember, type ForumMessage, type ForumProposal } from '../../shared/forum'
import { HiveError } from '../../shared/errors'
import { ForumArgError, parseForumArgs, type ForumArgs, type ForumTool, type ProposalArg } from './protocol'
import { flat, formatDigest, formatList, messageLine, type FormatLookup } from './format'
import type { ForumStore } from './store'

export class ForumRefusal extends Error {}
const refuse = (m: string): never => {
  throw new ForumRefusal(m)
}
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const HOUR = 3_600_000
const DAY = 24 * HOUR

/** Who is calling: bound to the step token in main. */
export interface ForumCaller {
  companyId: string
  memberId: string
  runId: string | null
  stepId: string | null
  taskId: string | null
}

/** The board side of asks (DEPARTMENTS.md §5), implemented by the service over CompanyStore. */
export interface ForumTaskHooks {
  /** Sets the in-flight task's ask like task_ask, unless the run already reported. false = not set. */
  setAsk(taskId: string, runId: string | null, ask: { prompt: string; options?: string[] }): boolean
  clearAsk(taskId: string, runId: string | null): void
}

export interface ForumAgentDeps {
  store: () => ForumStore
  tasks?: ForumTaskHooks | null
  /** waits for an ask's answer (service waiters); resolves null on timeout or abort */
  waitAnswer?: (messageId: string, ms: number, signal?: AbortSignal) => Promise<ForumMessage | null>
  presence?: (c: ForumCaller, state: 'reading' | 'composing' | 'working', channelId: string | null) => void
  companyName?: (companyId: string) => string
  /** a reply in an open ask's thread by someone it asked answers it (service.answer) */
  answerAsk?: (askId: string, byId: string, text: string, replyId: string) => void
  /** role label + department name of an agent member (header line) */
  seatLabel?: (memberId: string) => string | null
  now?: () => Date
}

export class ForumAgentApi {
  constructor(private readonly d: ForumAgentDeps) {}
  private get s(): ForumStore {
    return this.d.store()
  }
  private now(): Date {
    return this.d.now ? this.d.now() : new Date()
  }

  /** One call. Returns the text result; throws ForumRefusal with the message for the agent. */
  async call(c: ForumCaller, tool: ForumTool, raw: unknown, opts: { signal?: AbortSignal; origin?: string; opKey?: string } = {}): Promise<string> {
    let args: ForumArgs[ForumTool]
    try {
      args = parseForumArgs(tool, raw)
    } catch (e) {
      if (e instanceof ForumArgError) refuse(e.message)
      throw e
    }
    try {
      this.s.sync(c.companyId)
      const me = this.me(c)
      const origin = opts.origin ?? (c.stepId ? `agent:${c.stepId}` : 'agent')
      switch (tool) {
        case 'forum_read':
          return this.read(c, me, args as ForumArgs['forum_read'])
        case 'forum_post':
          return this.postTool(c, me, args as ForumArgs['forum_post'], origin, opts.opKey)
        case 'forum_reply':
          return this.reply(c, me, args as ForumArgs['forum_reply'], origin, opts.opKey)
        case 'forum_ask':
          return await this.ask(c, me, args as ForumArgs['forum_ask'], origin, opts)
        case 'forum_create_channel':
          return this.createChannel(c, me, args as ForumArgs['forum_create_channel'], origin, opts.opKey)
        case 'forum_mention':
          return this.mention(c, me, args as ForumArgs['forum_mention'], origin, opts.opKey)
      }
    } catch (e) {
      if (e instanceof HiveError) refuse(e.message)
      throw e
    }
    return refuse(`Unknown tool: ${String(tool)}`)
  }

  private me(c: ForumCaller): ForumMember {
    const m = this.s.member(c.memberId)
    if (!m || m.companyId !== c.companyId) refuse('Your Forum seat is unknown; the step token is stale')
    if (m!.status !== 'active') refuse('Your Forum seat is not active')
    return m!
  }

  private lookup(c: ForumCaller): FormatLookup {
    const members = new Map<string, ForumMember>()
    const channels = new Map<string, ForumChannel>()
    return {
      me: c.memberId,
      now: this.now(),
      member: (id) => {
        if (!members.has(id)) {
          const m = this.s.member(id)
          if (m) members.set(id, m)
        }
        return members.get(id) ?? null
      },
      channel: (id) => {
        if (!channels.has(id)) {
          try {
            channels.set(id, this.s.channel(id))
          } catch {
            return null
          }
        }
        return channels.get(id) ?? null
      }
    }
  }

  /** `#name` | `name` | `@handle` (DM) | `@a,@b` (group DM). Opens DMs on first use. */
  private resolveChannel(c: ForumCaller, me: ForumMember, raw: string): ForumChannel {
    const s = raw.trim()
    if (s.startsWith('@')) {
      const handles = s.split(',').map((h) => h.trim().replace(/^@/, '').toLowerCase()).filter(Boolean)
      const ids = handles.map((h) => {
        const m = this.s.memberByHandle(c.companyId, h)
        if (!m || m.status !== 'active') refuse(`No member @${h} in this company`)
        return m!.id
      })
      return this.s.openDm(me.id, ids.filter((id) => id !== me.id))
    }
    const ch = this.s.channelByName(c.companyId, s.replace(/^#/, ''))
    if (!ch) {
      const names = this.s.channels(c.companyId, me.id).filter((x) => x.name && !x.archivedAt).map((x) => `#${x.name}`)
      refuse(`No channel ${s.startsWith('#') ? s : `#${s}`}. Known: ${names.slice(0, 12).join(', ') || 'none'}`)
    }
    return ch!
  }

  private header(c: ForumCaller, me: ForumMember): string {
    const seat = this.d.seatLabel?.(me.id)
    const company = this.d.companyName?.(c.companyId)
    return `forum v${FORUM_PROTOCOL_VERSION} · @${me.handle}${seat ? ` (${seat})` : ''}${company ? ` · ${company}` : ''}`
  }

  // ---------- reads ----------

  private read(c: ForumCaller, me: ForumMember, a: ForumArgs['forum_read'], mark = true): string {
    const l = this.lookup(c)
    const budget = a.budget ?? FORUM_LIMITS.digestBudget
    const since = a.since ? parseSeqRef(a.since, 'c') : null
    if (a.thread) {
      const seq = parseSeqRef(a.thread, 'm') ?? refuse('Bad message ref')
      const t = this.safeThread(c, me, seq!)
      this.s.markThreadRead(me.id, t.root.seq)
      this.d.presence?.(c, 'reading', t.root.channelId)
      const header = `thread ${t.root.ref} in ${l.channel(t.root.channelId)?.name ? `#${l.channel(t.root.channelId)!.name}` : 'a DM'} (${t.replies.length} replies)`
      return formatList(l, header, [t.root, ...t.replies.slice(-(a.limit ?? 20))], budget, { max: FORUM_LIMITS.threadLine })
    }
    if (a.channel) {
      const ch = this.resolveChannel(c, me, a.channel)
      this.s.assertCanRead(me.id, ch.id)
      const msgs = since ? this.s.messages(ch.id, { afterSeq: since, limit: a.limit ?? 20 }) : this.s.messages(ch.id, { limit: a.limit ?? 20 })
      const last = msgs.length ? msgs[msgs.length - 1].seq : ch.lastSeq
      if (ch.joined || this.s.isMember(ch.id, me.id)) this.s.markRead(me.id, ch.id, last)
      this.d.presence?.(c, 'reading', ch.id)
      const purpose = ch.purpose ? ` · ${clip(flat(ch.purpose), 120)}` : ''
      const tag = ch.name ? `#${ch.name}` : l.channel(ch.id) ? `DM ${a.channel}` : a.channel
      return formatList(l, `${tag}${purpose}`, msgs, budget, { cursor: last })
    }
    // the digest: unread mentions, then every joined channel's new messages and new replies in my threads
    const mentions = this.s.unreadMentions(me.id, 10)
    const joined = this.s.channels(c.companyId, me.id).filter((ch) => ch.joined)
    const channels = joined
      .map((ch) => {
        const after = since ?? ch.lastReadSeq
        const messages = this.s.messages(ch.id, { afterSeq: after, limit: 30 }).filter((m) => m.authorId !== me.id)
        const threadReplies = this.s.threadActivity(me.id, ch.id, after, 10).map((m) => withRootRef(this.s, m))
        return { channelId: ch.id, messages, threadReplies, unreadAfter: after }
      })
      .sort((x, y) => (y.messages.length + y.threadReplies.length) - (x.messages.length + x.threadReplies.length))
    const cursor = Math.max(0, ...joined.map((ch) => ch.lastSeq), ...mentions.map((m) => m.seq))
    const out = formatDigest(l, { header: this.header(c, me), mentions: mentions.map((m) => withRootRef(this.s, m)), channels, budget, cursor })
    if (!mark) return out.text
    // mark exactly what was shown: a channel is read up to the first message the budget left out
    for (const ch of channels) {
      const all = [...ch.messages, ...ch.threadReplies].sort((x, y) => x.seq - y.seq)
      if (!all.length) continue
      const firstUnshown = all.find((m) => !out.shown.has(m.seq))
      const upTo = firstUnshown ? firstUnshown.seq - 1 : all[all.length - 1].seq
      if (upTo > ch.unreadAfter) this.s.markRead(me.id, ch.channelId, upTo)
    }
    this.s.markMentionsRead(me.id, mentions.filter((m) => out.shown.has(m.seq)).map((m) => m.seq))
    this.d.presence?.(c, 'reading', null)
    return out.text
  }

  private safeThread(c: ForumCaller, me: ForumMember, seq: number): { root: ForumMessage; replies: ForumMessage[] } {
    let t: { root: ForumMessage; replies: ForumMessage[] }
    try {
      t = this.s.thread(seq)
    } catch {
      return refuse(`No message m${seq.toString(36)}`)
    }
    if (t.root.companyId !== c.companyId) refuse(`No message m${seq.toString(36)}`)
    this.s.assertCanRead(me.id, t.root.channelId)
    return t
  }

  // ---------- writes ----------

  /** §2.3 post limits (per step, per hour). */
  private checkRate(c: ForumCaller, me: ForumMember, origin: string): void {
    const hourAgo = new Date(this.now().getTime() - HOUR).toISOString()
    const perHour = this.s.countPosts(me.id, hourAgo)
    if (perHour >= FORUM_LIMITS.postsPerHour) refuse(`You posted ${perHour} messages in the last hour (limit ${FORUM_LIMITS.postsPerHour}). Put the rest in your report.`)
    if (c.stepId) {
      const perStep = this.s.countPosts(me.id, '0000', origin)
      if (perStep >= FORUM_LIMITS.postsPerStep) refuse(`You posted ${perStep} messages in this step (limit ${FORUM_LIMITS.postsPerStep}). Put the rest in your report.`)
    }
  }

  private postTool(c: ForumCaller, me: ForumMember, a: ForumArgs['forum_post'], origin: string, opKey?: string): string {
    this.checkRate(c, me, origin)
    const ch = this.resolveChannel(c, me, a.channel)
    if (a.proposal) {
      const m = this.propose(c, me, ch, a.text, a.proposal, origin, opKey)
      return `ok ${m.ref} ${ch.name ? `#${ch.name}` : a.channel} · proposal open`
    }
    const m = this.s.post(me.id, { channelId: ch.id, text: a.text, refs: a.refs, origin, opKey })
    this.d.presence?.(c, 'working', null)
    return `ok ${m.ref} ${ch.name ? `#${ch.name}` : a.channel}`
  }

  private reply(c: ForumCaller, me: ForumMember, a: ForumArgs['forum_reply'], origin: string, opKey?: string): string {
    this.checkRate(c, me, origin)
    const seq = parseSeqRef(a.to, 'm') ?? refuse('Bad message ref')
    const t = this.safeThread(c, me, seq!)
    const m = this.s.post(me.id, { channelId: t.root.channelId, threadId: t.root.id, text: a.text, refs: a.refs, origin, opKey })
    this.d.presence?.(c, 'working', null)
    if (t.root.kind === 'ask' && t.root.ask?.status === 'open' && t.root.ask.to.includes(me.id) && this.d.answerAsk) {
      try {
        this.d.answerAsk(t.root.id, me.id, a.text, m.id)
        return `ok ${m.ref} ↳${t.root.ref} · answered the ask`
      } catch {
        /* it stays a reply */
      }
    }
    return `ok ${m.ref} ↳${t.root.ref}`
  }

  private async ask(c: ForumCaller, me: ForumMember, a: ForumArgs['forum_ask'], origin: string, opts: { signal?: AbortSignal; opKey?: string }): Promise<string> {
    this.checkRate(c, me, origin)
    const open = this.s.openAsks(c.companyId, me.id)
    if (open.length >= FORUM_LIMITS.openAsksPerAgent) refuse(`You have ${open.length} open asks (${open.map((m) => m.ref).join(', ')}); wait for answers or end your turn.`)
    const to = (a.to?.length ? a.to : []).map((h) => {
      const m = this.s.memberByHandle(c.companyId, h)
      if (!m || m.status !== 'active') refuse(`No member ${h.startsWith('@') ? h : `@${h}`} in this company`)
      if (m!.kind === 'guest') refuse('Agents do not ask guests; ask a human member')
      return m!.id
    })
    if (!to.length) to.push(this.s.owner(c.companyId).id)
    const ch = a.channel ? this.resolveChannel(c, me, a.channel) : this.defaultChannel(c, me)
    const ask: ForumAsk = { status: 'open', to: [...new Set(to)].filter((id) => id !== me.id), ...(a.options ? { options: a.options } : {}), taskId: c.taskId, runId: c.runId }
    if (!ask.to.length) refuse('Ask someone other than yourself')
    const handles = ask.to.map((id) => `@${this.s.member(id)?.handle}`).join(' ')
    const m = this.s.post(me.id, { channelId: ch.id, text: `${handles} ${a.question}`, kind: 'ask', ask, origin, opKey: opts.opKey })
    const where = ch.name ? `#${ch.name}` : 'DM'
    // a task run: the task waits for this answer at run end (unless the agent already reported)
    let parked = false
    if (c.taskId && this.d.tasks) parked = this.d.tasks.setAsk(c.taskId, c.runId, { prompt: `${a.question} (asked in the Forum, ${where} ${m.ref})`, options: a.options })
    const wait = Math.min(a.wait_s ?? 0, FORUM_LIMITS.waitMaxS)
    if (wait > 0 && this.d.waitAnswer) {
      this.d.presence?.(c, 'working', ch.id)
      const answered = await this.d.waitAnswer(m.id, wait * 1000, opts.signal)
      if (answered?.ask?.status === 'answered') {
        if (c.taskId && this.d.tasks) this.d.tasks.clearAsk(c.taskId, c.runId)
        const by = answered.ask.answeredBy ? this.s.member(answered.ask.answeredBy) : null
        return `answered ${m.ref} by @${by?.handle ?? 'someone'}: ${clip(flat(answered.ask.answer ?? ''), 1500)}`
      }
    }
    if (parked) return `open ${m.ref} ${where} · parked: your task waits for the answer after this turn. End your turn now; you resume with the answer.`
    return `open ${m.ref} ${where} · the answer will be in your next forum_read or brief`
  }

  /** The agent's department channel, else #general. */
  private defaultChannel(c: ForumCaller, me: ForumMember): ForumChannel {
    const chans = this.s.channels(c.companyId, me.id)
    const dep = chans.find((ch) => ch.system === 'department' && ch.joined && !ch.archivedAt)
    return dep ?? chans.find((ch) => ch.system === 'general') ?? refuse('No channel to ask in')
  }

  private createChannel(c: ForumCaller, me: ForumMember, a: ForumArgs['forum_create_channel'], origin: string, opKey?: string): string {
    // a replayed fenced op (same key) finds its channel instead of failing on the name
    const existing = this.s.channelByName(c.companyId, a.name)
    if (existing && opKey && existing.createdBy === me.id) return `ok #${existing.name} (already created)`
    const dayAgo = new Date(this.now().getTime() - DAY).toISOString()
    const made = this.s.countAgentChannels(c.companyId, dayAgo)
    if (made >= FORUM_LIMITS.agentChannelsPerDay) refuse(`Agents created ${made} channels today (limit ${FORUM_LIMITS.agentChannelsPerDay}). Post in an existing channel instead.`)
    this.checkRate(c, me, origin)
    const invite = (a.invite ?? []).map((h) => {
      const m = this.s.memberByHandle(c.companyId, h)
      if (!m || m.status !== 'active') refuse(`No member ${h.startsWith('@') ? h : `@${h}`} in this company`)
      return m!.id
    })
    // the owner always sees what agents open
    const owner = this.s.owner(c.companyId)
    const ch = this.s.createChannel(me.id, { name: a.name, kind: 'public', purpose: a.purpose, memberIds: [...new Set([owner.id, ...invite])] })
    let tail = ''
    if (a.first_message) this.s.post(me.id, { channelId: ch.id, text: a.first_message, origin, opKey: opKey ? `${opKey}:first` : undefined })
    if (a.proposal) {
      const p = this.propose(c, me, ch, a.first_message || a.purpose, a.proposal, origin, opKey ? `${opKey}:proposal` : undefined)
      tail = ` · proposal ${p.ref} open`
    }
    return `ok #${ch.name}${tail}`
  }

  private propose(c: ForumCaller, me: ForumMember, ch: ForumChannel, text: string, p: ProposalArg, origin: string, opKey?: string): ForumMessage {
    const dayAgo = new Date(this.now().getTime() - DAY).toISOString()
    const n = this.s.countProposals(c.companyId, dayAgo)
    if (n >= FORUM_LIMITS.proposalsPerDay) refuse(`${n} proposals were made in this company today (limit ${FORUM_LIMITS.proposalsPerDay}).`)
    const mine = this.s.openProposals(c.companyId, me.id).filter((m) => m.proposal?.kind === p.kind)
    if (mine.length) refuse(`Your ${p.kind} proposal ${mine[0].ref} is still open; wait for the decision.`)
    const proposal: ForumProposal =
      p.kind === 'department'
        ? { kind: 'department', status: 'open', reason: p.reason, department: { name: p.name!.trim(), does: p.does ?? '', doesNot: p.doesNot ?? '' } }
        : { kind: 'agent', status: 'open', reason: p.reason, agent: { departmentKey: p.department ?? null, role: p.role!.trim(), instructions: p.instructions ?? '', capabilities: p.capabilities ?? '', ...(p.adapter ? { adapter: p.adapter } : {}) } }
    const m = this.s.post(me.id, { channelId: ch.id, text, kind: 'proposal', proposal, origin, opKey })
    const proposals = this.s.channels(c.companyId, me.id).find((x) => x.system === 'proposals')
    if (proposals && proposals.id !== ch.id) {
      const what = proposal.kind === 'department' ? `a new department, "${proposal.department!.name}"` : `a new agent, "${proposal.agent!.role}"`
      this.s.systemPost(proposals.id, `${me.name} proposed ${what} in ${ch.name ? `#${ch.name}` : 'a DM'} (${m.ref}): ${clip(p.reason, 200)}`)
    }
    return m
  }

  private mention(c: ForumCaller, me: ForumMember, a: ForumArgs['forum_mention'], origin: string, opKey?: string): string {
    this.checkRate(c, me, origin)
    const handles = a.who.map((h) => h.trim().replace(/^@/, '').toLowerCase())
    const members: ForumMember[] = []
    let department: ForumChannel | null = null
    for (const h of handles) {
      const m = this.s.memberByHandle(c.companyId, h)
      if (m && m.status === 'active') {
        if (m.id !== me.id) members.push(m)
        continue
      }
      const dep = this.s.channels(c.companyId, me.id).find((ch) => ch.system === 'department' && ch.name === h && !ch.archivedAt)
      if (dep) {
        department ??= dep
        continue
      }
      refuse(`No member or department @${h}`)
    }
    const ch = department ?? (members.length ? this.s.openDm(me.id, members.map((m) => m.id)) : refuse('Mention someone other than yourself'))
    const prefix = handles.filter((h) => !a.text.toLowerCase().includes(`@${h}`)).map((h) => `@${h}`).join(' ')
    const m = this.s.post(me.id, { channelId: ch.id, text: prefix ? `${prefix} ${a.text}` : a.text, refs: a.ref ? [a.ref] : undefined, origin, opKey })
    return `ok ${m.ref} ${ch.name ? `#${ch.name}` : handles.map((h) => `@${h}`).join(',')}`
  }

  /** The digest an inject agent gets in its brief: same text as forum_read, nothing marked read. */
  preview(c: ForumCaller, budget: number): string {
    try {
      return this.read(c, this.me(c), { budget: Math.max(500, budget) }, false)
    } catch {
      return ''
    }
  }

  /** §5: the unread state of a member for the brief (no side effects). */
  briefState(memberId: string): { mentions: ForumMessage[]; answered: ForumMessage[]; openAsks: ForumMessage[] } {
    const m = this.s.member(memberId)
    if (!m) return { mentions: [], answered: [], openAsks: [] }
    const recent = Date.now() - DAY
    return {
      mentions: this.s.unreadMentions(memberId, 6),
      answered: this.s.answeredAsks(memberId, 3).filter((x) => Date.parse(x.ask?.answeredAt ?? '') > recent),
      openAsks: this.s.openAsks(m.companyId, memberId)
    }
  }

  lookupFor(c: ForumCaller): FormatLookup {
    return this.lookup(c)
  }
  /** One line for a message (tests, harvest notes). */
  line(c: ForumCaller, m: ForumMessage): string {
    return messageLine(this.lookup(c), m)
  }
}

/** Thread replies in a digest name their root (`m3g1 ↳m3fk …`). */
function withRootRef(s: ForumStore, m: ForumMessage): ForumMessage & { rootRef?: string } {
  if (!m.threadId) return m
  try {
    return { ...m, rootRef: s.message(m.threadId).ref }
  } catch {
    return m
  }
}
