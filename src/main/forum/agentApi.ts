/**
 * FORUM.md §4: the protocol's main side. Every transport (MCP via the forum CLI, HTTP, CLI, fenced block) ends here
 * with a caller resolved from the step token (never from the arguments). Results are the compact text of §4.3; a
 * refusal throws ForumRefusal with the one line the agent sees. Rate limits (§2.3) are enforced here.
 */
import { FORUM_LIMITS, FORUM_PROTOCOL_VERSION, isConversationChannel, parseSeqRef, takesAnswer, type ForumAsk, type ForumChannel, type ForumMember, type ForumMessage, type ForumProposal } from '../../shared/forum'
import { HiveError } from '../../shared/errors'
import { ForumArgError, parseForumArgs, type ForumArgs, type ForumTool, type ProposalArg } from './protocol'
import { flat, formatDigest, formatList, messageLine, type FormatLookup } from './format'
import type { ForumStore } from './store'
import type { AgentCollab, CollabOutcome } from './collab'
import type { TeamTools } from './teamTools'
import type { AgentCollabSettings } from '../../shared/collab'

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

/** A task's go-ahead (Dispatcher.goAhead): did its run start, and the true state in one line. */
export interface TaskGoLine { state: 'started' | 'running' | 'queued' | 'refused'; line: string }
/** answer_task / start_task: the note for the agent, and when the task did not resume, what to say instead. */
export interface TaskReplyOutcome { note: string; identifier?: string; go?: TaskGoLine | null }
const goStarted = (go: TaskGoLine | null | undefined): boolean => !go || go.state === 'started' || go.state === 'running'

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
  /** AGENT-COLLAB.md: agent-to-agent wakes (absent = agents never wake agents, the v1 rule) */
  collab?: AgentCollab | null
  collabSettings?: () => AgentCollabSettings
  /** the lead agent (first active seat) of a department, for @department asks */
  leadOf?: (companyId: string, departmentId: string) => string | null
  /** an agent seat's department id */
  departmentOf?: (agentId: string) => string | null
  /** AGENT-COLLAB.md §3: team_activity, team_usage, team_board */
  team?: TeamTools | null
  /** forum_reply `task`: files a person's message as a Board task for the replying agent (null when already filed) */
  fileTask?: (c: ForumCaller, me: ForumMember, from: ForumMessage, title: string) => { identifier: string; existing?: { by: string | null }; card?: () => void; go?: TaskGoLine | null } | null
  /**
   * forum_reply answer_task (CHAT-UI.md §8): the person's message (`from`) answers the open question of a task in that
   * conversation; returns the note for the agent (" · passed the answer on to VO-15")
   */
  answerTask?: (me: ForumMember, from: ForumMessage, task: string, answer: string | undefined) => TaskReplyOutcome
  /** forum_reply start_task: the person's message (`from`) says go ahead with this agent's task in that conversation */
  startTask?: (me: ForumMember, from: ForumMessage, task: string) => TaskReplyOutcome
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
        case 'forum_ask_agent':
          return await this.askAgent(c, me, args as ForumArgs['forum_ask_agent'], origin, opts)
        case 'team_activity':
          return this.teamTool(() => this.d.team!.activity(c.companyId, args as ForumArgs['team_activity'], c.runId))
        case 'team_usage':
          return this.teamTool(() => this.d.team!.usage(c.companyId, args as ForumArgs['team_usage']))
        case 'team_board':
          return this.teamTool(() => this.d.team!.board(c.companyId, args as ForumArgs['team_board']))
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
    return `ok ${m.ref} ${ch.name ? `#${ch.name}` : a.channel}${this.wakeMentions(c, me, m)}`
  }

  private reply(c: ForumCaller, me: ForumMember, a: ForumArgs['forum_reply'], origin: string, opKey?: string): string {
    this.checkRate(c, me, origin)
    const seq = parseSeqRef(a.to, 'm') ?? refuse('Bad message ref')
    const t = this.safeThread(c, me, seq!)
    // CHAT-UI.md §7.2: a hire proposed mid-conversation is a card in the thread; once created, the hire answers this message
    if (a.proposal) {
      const ch = this.s.channel(t.root.channelId, me.id)
      const from = t.root.seq === seq ? t.root : (t.replies.find((r) => r.seq === seq) ?? t.root)
      const p = this.propose(c, me, ch, a.text, a.proposal, origin, opKey, { threadId: t.root.id, forMessageId: this.s.member(from.authorId)?.kind === 'human' ? from.id : t.root.id })
      this.d.presence?.(c, 'working', null)
      return `ok ${p.ref} ↳${t.root.ref} · proposal open: the person decides (Create & bring in, Edit, or not now)`
    }
    // the task first, so "I started {task}" can name it; its card goes under the reply (CHAT-UI.md §8)
    const filing = this.fileFromReply(c, me, t, seq!, a.task?.title)
    let text = filing.identifier ? fillTask(a.text, filing.identifier, filing.already) : a.text
    if (filing.identifier && !filing.already && !goStarted(filing.go)) text = notStarted(text, filing.identifier, filing.go!.line)
    // answer_task / start_task before the reply is posted: "back on VO-15" / "starting it" only when its run really started
    const from = t.root.seq === seq ? t.root : t.replies.find((r) => r.seq === seq)
    let passed = ''
    for (const out of [
      a.answer_task ? (!from ? { note: ' · no such message: nothing passed on' } : this.d.answerTask ? this.d.answerTask(me, from, a.answer_task.task, a.answer_task.answer) : { note: ' · no Board here: nothing passed on' }) : null,
      a.start_task ? (!from ? { note: ' · no such message: not started' } : this.d.startTask ? this.d.startTask(me, from, a.start_task) : { note: ' · no Board here: not started' }) : null
    ]) {
      if (!out) continue
      passed += out.note
      if (out.identifier && !goStarted(out.go)) text = notStarted(text, out.identifier, out.go!.line)
    }
    const m = this.s.post(me.id, { channelId: t.root.channelId, threadId: t.root.id, text, refs: a.refs, origin, opKey })
    try {
      filing.card?.()
    } catch {
      /* the card is a courtesy: the task is filed */
    }
    this.d.presence?.(c, 'working', null)
    // a woken agent that writes in the thread it was woken for has answered (AGENT-COLLAB.md §2)
    try {
      this.d.collab?.noteReplied(me.id, t.root.seq, text)
    } catch {
      /* bookkeeping only */
    }
    const woke = this.wakeMentions(c, me, m) + filing.note + passed
    if (t.root.kind === 'ask' && takesAnswer(t.root.ask) && t.root.ask!.to.includes(me.id) && this.d.answerAsk) {
      try {
        this.d.answerAsk(t.root.id, me.id, text, m.id)
        return `ok ${m.ref} ↳${t.root.ref} · answered the ask${woke}`
      } catch {
        /* it stays a reply */
      }
    }
    return `ok ${m.ref} ↳${t.root.ref}${woke}`
  }

  /** forum_reply `task`: only a person's message becomes a task, once, assigned to the agent who replied. */
  private fileFromReply(c: ForumCaller, me: ForumMember, t: { root: ForumMessage; replies: ForumMessage[] }, seq: number, title: string | undefined): { note: string; identifier?: string; card?: () => void; already?: string; go?: TaskGoLine | null } {
    if (!title) return { note: '' }
    if (!this.d.fileTask) return { note: ' · no Board here: the task was not filed' }
    const from = t.root.seq === seq ? t.root : t.replies.find((r) => r.seq === seq)
    const author = from ? this.s.member(from.authorId) : null
    if (!from || author?.kind !== 'human') return { note: ' · only a person’s request becomes a task: not filed' }
    try {
      const made = this.d.fileTask(c, me, from, title)
      if (!made) return { note: ' · already filed for this message: do not file another' }
      // CHAT-UI.md §8: never a second task for the same request (two agents in one conversation)
      if (made.existing) return { identifier: made.identifier, already: made.existing.by && made.existing.by !== me.name ? made.existing.by : 'A teammate', note: ` · already filed as ${made.identifier}${made.existing.by && made.existing.by !== me.name ? ` by ${made.existing.by}` : ''}: not filed again. Say who is on it; do not start the same work` }
      return { identifier: made.identifier, card: made.card, go: made.go ?? null, note: ` · filed ${made.identifier}${goStarted(made.go) ? (made.go ? ' · started' : '') : ` · not started: ${made.go!.line} (said so in your reply)`}` }
    } catch (e) {
      return { note: ` · task not filed: ${clip(e instanceof Error ? e.message : String(e), 160)}` }
    }
  }

  private async ask(c: ForumCaller, me: ForumMember, a: ForumArgs['forum_ask'], origin: string, opts: { signal?: AbortSignal; opKey?: string }): Promise<string> {
    this.checkRate(c, me, origin)
    const open = this.s.openAsks(c.companyId, me.id)
    if (open.length >= FORUM_LIMITS.openAsksPerAgent) refuse(`You have ${open.length} open asks (${open.map((m) => m.ref).join(', ')}); wait for answers or end your turn.`)
    const to = (a.to?.length ? a.to : []).map((h) => {
      const m = this.s.memberByHandle(c.companyId, h) ?? this.s.agentByName(c.companyId, h)
      if (!m || m.status !== 'active') refuse(`No member ${h.startsWith('@') ? h : `@${h}`} in this company`)
      if (m!.kind === 'guest') refuse('Agents do not ask guests; ask a human member')
      return m!.id
    })
    if (!to.length) to.push(this.s.owner(c.companyId).id)
    // AGENT-COLLAB.md: an ask to agents only wakes them (it never parks the task for a person)
    const targets = to.map((id) => this.s.member(id)).filter((m): m is ForumMember => !!m && m.id !== me.id)
    if (this.d.collab && targets.length && targets.every((m) => m.kind === 'agent')) {
      return this.askAgents(c, me, targets, { question: a.question, channel: a.channel, wait_s: a.wait_s ?? 0, options: a.options }, origin, opts)
    }
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

  private propose(c: ForumCaller, me: ForumMember, ch: ForumChannel, text: string, p: ProposalArg, origin: string, opKey?: string, at: { threadId?: string; forMessageId?: string } = {}): ForumMessage {
    const dayAgo = new Date(this.now().getTime() - DAY).toISOString()
    const n = this.s.countProposals(c.companyId, dayAgo)
    if (n >= FORUM_LIMITS.proposalsPerDay) refuse(`${n} proposals were made in this company today (limit ${FORUM_LIMITS.proposalsPerDay}).`)
    const mine = this.s.openProposals(c.companyId, me.id).filter((m) => m.proposal?.kind === p.kind)
    if (mine.length) refuse(`Your ${p.kind} proposal ${mine[0].ref} is still open; wait for the decision.`)
    const proposal: ForumProposal =
      p.kind === 'department'
        ? { kind: 'department', status: 'open', reason: p.reason, department: { name: p.name!.trim(), does: p.does ?? '', doesNot: p.doesNot ?? '' } }
        : { kind: 'agent', status: 'open', reason: p.reason, agent: { departmentKey: p.department ?? null, role: p.role!.trim(), instructions: p.instructions ?? '', capabilities: p.capabilities ?? '', ...(p.adapter ? { adapter: p.adapter } : {}) }, ...(at.forMessageId && isConversationChannel(ch) ? { forMessageId: at.forMessageId } : {}) }
    const m = this.s.post(me.id, { channelId: ch.id, threadId: at.threadId ?? null, text, kind: 'proposal', proposal, origin, opKey })
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
    return `ok ${m.ref} ${ch.name ? `#${ch.name}` : handles.map((h) => `@${h}`).join(',')}${this.wakeMentions(c, me, m, false)}`
  }

  // ---------- agents asking agents (AGENT-COLLAB.md §2) ----------

  /**
   * The agents an agent's message wakes (max 3): one lead per @department, plus every @agent named on its own.
   * `addressed` (forum_post, forum_reply): only handles the message opens with ("@livia can you…", "@development
   * @sergio …") count; a @handle inside a sentence ("based on @livia's answer") is a reference and wakes no one.
   * A live haiku run showed agents credit each other by handle all the time, which would wake them for nothing.
   */
  private mentionTargets(me: ForumMember, m: ForumMessage, addressed: boolean): ForumMember[] {
    const out: ForumMember[] = []
    const add = (x: ForumMember | null) => {
      if (x && x.kind === 'agent' && x.id !== me.id && !out.some((o) => o.id === x.id)) out.push(x)
    }
    const lead = addressed ? leadingHandles(m.text) : null
    const depIds = new Set(m.mentionDepartments)
    for (const depId of depIds) {
      if (lead) {
        const key = this.s.channels(m.companyId, this.s.owner(m.companyId).id).find((ch) => ch.departmentId === depId && ch.system === 'department')?.name
        if (!key || !lead.has(key)) continue
      }
      const agentId = this.d.leadOf?.(m.companyId, depId)
      add(agentId ? this.s.memberForAgent(agentId) : null)
    }
    for (const id of m.mentions) {
      const x = this.s.member(id)
      if (!x) continue
      if (lead) {
        if (lead.has(x.handle)) add(x)
        continue
      }
      // an @department mention expands to all its agents in the store; only its lead wakes
      if (x?.agentId && depIds.size && this.d.departmentOf && depIds.has(this.d.departmentOf(x.agentId) ?? '') && !new RegExp(`@${x.handle}\\b`, 'i').test(m.text)) continue
      add(x)
    }
    return out.slice(0, 3)
  }

  /** Wakes the agents an agent's own post mentions; returns the suffix for the tool result. Never throws. */
  private wakeMentions(c: ForumCaller, me: ForumMember, m: ForumMessage, addressed = true): string {
    if (!this.d.collab || me.kind !== 'agent') return ''
    try {
      const targets = this.mentionTargets(me, m, addressed)
      if (!targets.length) return ''
      return notes(this.d.collab.request(c, m, targets, 'mention', ''))
    } catch {
      return ''
    }
  }

  private teamTool(f: () => string): string {
    if (!this.d.team) return refuse('Team tools are not available in this Principia')
    try {
      return f()
    } catch (e) {
      if (e instanceof ForumRefusal) throw e
      return refuse(e instanceof Error ? e.message : String(e))
    }
  }

  /** `@handle` → that agent; a department key → its lead agent. */
  private resolveAgent(c: ForumCaller, raw: string): ForumMember {
    const h = raw.trim().replace(/^[@#]/, '').toLowerCase()
    const m = this.s.memberByHandle(c.companyId, h)
    if (m && m.status === 'active') {
      if (m.kind !== 'agent') refuse(`@${m.handle} is a person; ask people with forum_ask`)
      return m
    }
    const dep = this.s.channels(c.companyId, this.s.owner(c.companyId).id).find((ch) => ch.system === 'department' && !ch.archivedAt && ch.name === h)
    if (dep?.departmentId) {
      const lead = this.d.leadOf?.(c.companyId, dep.departmentId)
      const lm = lead ? this.s.memberForAgent(lead) : null
      if (!lm || lm.status !== 'active') refuse(`#${dep.name} has no agent that can answer`)
      return lm!
    }
    // a name or role an agent wrote ("Marcus", "Brand Voice Writer"), in this company only
    const named = this.s.agentByName(c.companyId, raw)
    if (named) return named
    const mates = this.s.roster(c.companyId).filter((t) => t.memberId !== c.memberId).slice(0, 8).map((t) => `@${t.handle}`).join(', ')
    return refuse(`No agent or department @${h} in this company${mates ? ` (teammates: ${mates})` : ''}`)
  }

  private async askAgent(c: ForumCaller, me: ForumMember, a: ForumArgs['forum_ask_agent'], origin: string, opts: { signal?: AbortSignal; opKey?: string }): Promise<string> {
    if (!this.d.collab) refuse('Agents cannot ask agents in this Principia')
    const target = this.resolveAgent(c, a.to)
    if (target.id === me.id) refuse('You cannot ask yourself')
    return this.askAgents(c, me, [target], { question: a.question, why: a.why, channel: a.channel, wait_s: a.wait_s }, origin, opts)
  }

  private async askAgents(
    c: ForumCaller,
    me: ForumMember,
    targets: ForumMember[],
    a: { question: string; why?: string; channel?: string; wait_s?: number; options?: string[] },
    origin: string,
    opts: { signal?: AbortSignal; opKey?: string }
  ): Promise<string> {
    const collab = this.d.collab!
    this.checkRate(c, me, origin)
    // the guards run before anything is posted: a refused ask leaves no orphan card
    const ok: ForumMember[] = []
    const refused: string[] = []
    const home = this.defaultChannel(c, me)
    for (const t of targets) {
      const v = collab.check(c, t, null)
      if (v.refusal) refused.push(collab.recordRefusal(c, t, v.refusal, a.why ?? a.question, home.id))
      else ok.push(t)
    }
    if (!ok.length) refuse(refused.join('; '))
    const open = this.s.openAsks(c.companyId, me.id)
    if (open.length >= FORUM_LIMITS.openAsksPerAgent) refuse(`You have ${open.length} open asks (${open.map((m) => m.ref).join(', ')}); wait for answers or end your turn.`)
    const ch = a.channel ? this.resolveChannel(c, me, a.channel) : (this.agentHome(c, ok[0]) ?? home)
    const ask: ForumAsk = { status: 'open', to: ok.map((t) => t.id), ...(a.options ? { options: a.options } : {}), taskId: null, runId: c.runId }
    const handles = ok.map((t) => `@${t.handle}`).join(' ')
    const text = `${handles} ${a.question}${a.why ? `\n(why: ${a.why})` : ''}`
    const m = this.s.post(me.id, { channelId: ch.id, text, kind: 'ask', ask, origin, opKey: opts.opKey })
    const where = ch.name ? `#${ch.name}` : 'DM'
    const res = collab.request(c, m, ok, 'ask', a.why ?? '')
    const tail = `${notes(res)}${refused.length ? ` · ${refused.join('; ')}` : ''}`
    const st = this.d.collabSettings?.()
    const woke = res.some((r) => r.status === 'started' || r.status === 'queued')
    const wait = woke ? Math.min(a.wait_s ?? st?.waitDefaultS ?? 0, st?.waitMaxS ?? FORUM_LIMITS.waitMaxS, FORUM_LIMITS.waitMaxS) : 0
    if (wait > 0 && this.d.waitAnswer) {
      this.d.presence?.(c, 'working', ch.id)
      const answered = await this.d.waitAnswer(m.id, wait * 1000, opts.signal)
      if (answered?.ask?.status === 'answered') {
        const by = answered.ask.answeredBy ? this.s.member(answered.ask.answeredBy) : null
        return `answered ${m.ref} by @${by?.handle ?? 'someone'}: ${clip(flat(answered.ask.answer ?? ''), 1500)}`
      }
      return `open ${m.ref} ${where}${tail} · no answer within ${wait}s; it will be in forum_read {"thread":"${m.ref}"} and your next brief. Continue with what you know.`
    }
    return `open ${m.ref} ${where}${tail} · the answer will be in forum_read {"thread":"${m.ref}"} and your next brief`
  }

  /** The target agent's department channel (where it reads), else null. */
  private agentHome(c: ForumCaller, target: ForumMember): ForumChannel | null {
    const dep = target.agentId ? this.d.departmentOf?.(target.agentId) : null
    const chans = this.s.channels(c.companyId, target.id)
    return chans.find((ch) => ch.system === 'department' && !ch.archivedAt && (dep ? ch.departmentId === dep : ch.memberIds.includes(target.id))) ?? null
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

/** The handles a message opens with ("@livia @sergio: can you…" → livia, sergio), lowercase. */
export function leadingHandles(text: string): Set<string> {
  const m = /^\s*((?:@[a-z0-9._-]+[\s,:]*)+)/i.exec(text)
  return new Set(m ? [...m[1].matchAll(/@([a-z0-9._-]+)/gi)].map((x) => x[1].toLowerCase().replace(/\.+$/, '')) : [])
}

/** Tool-result suffix for wake outcomes (" · woke @livia (hop 1/3, run r_…)"). */
function notes(res: CollabOutcome[]): string {
  const lines = res.map((r) => r.note).filter(Boolean)
  return lines.length ? ` · ${lines.join('; ')}` : ''
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

/**
 * CHAT-UI.md §8: `{task}` in a forum_reply becomes the task's identifier. When a teammate had already filed it, the
 * reply must not claim the work: "I started {task}" reads "Julia already started VO-9".
 */
/**
 * The agent's reply when the task it names did not resume: "Got it, back on VO-16." / "Starting VO-16 now." give way to
 * the true state (Dispatcher.goAhead's line), "I started VO-16" reads "I filed VO-16" with the state after it, and a
 * reply that claims none of these gets the state added.
 */
export function notStarted(text: string, identifier: string, line: string): string {
  const id = identifier.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
  let said = false
  const say = (): string => (said ? '' : ((said = true), line))
  let out = text
    .replace(new RegExp(`Got it,? (?:I'm |I am )?back on ${id}\\.?`, 'gi'), say)
    .replace(new RegExp(`\\b(?:I'm starting|I am starting|Starting|Back on|I'm back on|I'm on) ${id}(?: now)?\\.?`, 'gi'), say)
    .replace(new RegExp(`\\bI(?:'ve|’ve| have)? started ${id}\\b`, 'gi'), `I filed ${identifier}`)
  if (!said) out = `${out.trim()} ${line}`
  return out.replace(/[ \t]{2,}/g, ' ').trim()
}

export function fillTask(text: string, identifier: string, alreadyBy?: string): string {
  const named = alreadyBy ? text.replace(/\bI(?:'ve|’ve| have)? started \{task\}/gi, `${alreadyBy} already started ${identifier}`).replace(/\bI'll post the result here\.?/gi, `${alreadyBy} will post the result here.`) : text
  return named.replace(/\{task\}/g, identifier)
}

