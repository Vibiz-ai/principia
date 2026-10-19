/**
 * The `slack_*` tools of the `hive` MCP server, main side (SLACK.md §11). The broker hands every call here with the
 * owner it read from the live dir; the caller identity (session / step -> run -> trigger) is resolved here and never
 * from tool arguments. Reads are restricted to channels the bot is in and DMs with it. A Slack-triggered run is scoped
 * further (fail closed): its reads see only the conversation that started it plus the trigger's `access.readChannels`
 * (never another DM), and its drafts / posts go only to that conversation. Every result is redacted and trimmed;
 * tokens never appear. No Electron imports.
 */
import { HiveError } from '../../../shared/errors'
import type { LiveOwner } from '../../../shared/engine'
import type { SlackChannel, SlackMessage, SlackRunContext, SlackTool } from '../../../shared/slack'
import type { SlackConnector } from './core/connector'
import { fallbackPermalink, parsePermalink, tsToIso } from './core/format'
import { userLabel } from './core/ingest'
import { REASON_TEXT, runReadScope, scopeAllowsRead, type ReplyCaller, type ReplyTriggerView, type RunReadScope } from './core/policy'
import type { SlackSqlite } from './store/sqlite'

export const MAX_RESULT_CHARS = 12_000
export const READS_PER_MIN = 20
const READ_TOOLS = new Set<SlackTool>(['slack_list_channels', 'slack_read_thread', 'slack_search'])
const FRESH_MS = 60_000
const FETCH_WAIT_MS = 3000

export interface SlackToolDeps {
  connector: SlackConnector
  sql: SlackSqlite
  redact(s: string): string
  now(): number
  /** Session owner -> label + live root agent; null = unknown session. */
  session(sessionId: string): { label: string; agentId: string | null } | null
  /** Step owner -> its run's Slack context + slackTools flag + label + the step's root agent; null = unknown. */
  step(owner: { stepId: string; runId: string }): { ctx: SlackRunContext | null; slackTools: boolean; label: string; agentId: string | null } | null
  /** Re-read at decision time (PO: switching to draft or pausing takes effect mid-run). */
  trigger(id: string): ReplyTriggerView | null
}

type Args = Record<string, unknown>
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const int = (v: unknown, def: number, min: number, max: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : def)
const TS_RE = /^\d+\.\d+$/
const CHANNEL_ID_RE = /^[CGD][A-Z0-9]+$/
const isDmKind = (k: SlackChannel['kind']) => k === 'dm' || k === 'group_dm'

export class SlackTools {
  private reads = new Map<string, number[]>()
  constructor(private d: SlackToolDeps) {}

  /** May this owner use the slack toolset at all? (SA2: a step needs a Slack run or workflow.slackTools.) */
  allowed(owner: LiveOwner): boolean {
    if (!this.d.connector.isConfigured()) return false
    if ('sessionId' in owner) return !!this.d.session(owner.sessionId)
    const s = this.d.step(owner)
    return !!s && (!!s.ctx || s.slackTools)
  }

  private caller(owner: LiveOwner): { caller: ReplyCaller; label: string; agentId: string | null } {
    if ('sessionId' in owner) {
      const s = this.d.session(owner.sessionId)
      if (!s) throw new HiveError('forbidden', 'Unknown tool')
      return { caller: { kind: 'session', sessionId: owner.sessionId }, label: s.label, agentId: s.agentId }
    }
    const st = this.d.step(owner)
    if (!st || (!st.ctx && !st.slackTools)) throw new HiveError('forbidden', 'Unknown tool')
    const trig = st.ctx ? this.d.trigger(st.ctx.triggerId) : null
    return { caller: { kind: 'step', runId: owner.runId, stepId: owner.stepId, ctx: st.ctx, trigger: trig }, label: st.label, agentId: st.agentId }
  }

  /** The read scope of a Slack-triggered run's step; null = not scoped (sessions, slackTools runs without a trigger). */
  private scope(owner: LiveOwner): RunReadScope | null {
    if ('sessionId' in owner) return null
    const ctx = this.d.step(owner)?.ctx ?? null
    return ctx ? runReadScope(ctx) : null
  }

  private scopeError(scope: RunReadScope): Error {
    const extra = scope.extra.map((id) => `#${this.d.connector.names.channel(id) ?? id}`)
    const where = scope.threadTs ? `channel ${scope.channelId}, thread_ts ${scope.threadTs}` : `channel ${scope.channelId}`
    return new Error(
      `This Slack-triggered run can only read the conversation that started it (${where})${extra.length ? ` and ${extra.join(', ')}` : ''}. Other channels need the trigger's read channels; other DMs are never readable.`
    )
  }

  /** Scoped runs: refuse an id outside the scope before resolving it (no lookups, no side effects). */
  private precheck(scope: RunReadScope | null, ref: string): void {
    if (scope && CHANNEL_ID_RE.test(ref) && ref !== scope.channelId && !scope.extra.includes(ref)) throw this.scopeError(scope)
  }

  private ownerKey(owner: LiveOwner): string {
    return 'sessionId' in owner ? owner.sessionId : owner.stepId
  }

  /** One slack_* call. Throws Error with a readable message (the broker turns it into a tool error). */
  async call(owner: LiveOwner, tool: SlackTool, args: Args): Promise<Record<string, unknown>> {
    if (!this.allowed(owner)) throw new Error(`Unknown tool: ${tool}`)
    if (!this.d.connector.workspace()) throw new Error('Slack is not connected. Ask the user to connect it in Hive › Settings › Connections.')
    if (READ_TOOLS.has(tool)) {
      const k = this.ownerKey(owner)
      const t = this.d.now()
      const hits = (this.reads.get(k) ?? []).filter((x) => t - x < 60_000)
      if (hits.length >= READS_PER_MIN) throw new Error('Too many Slack reads (limit 20 per minute). Wait a minute.')
      hits.push(t)
      this.reads.set(k, hits)
    }
    let out: Record<string, unknown>
    try {
      switch (tool) {
        case 'slack_list_channels':
          out = await this.listChannels(args, this.scope(owner))
          break
        case 'slack_read_thread':
          out = await this.readThread(args, this.scope(owner))
          break
        case 'slack_search':
          out = await this.search(args, this.scope(owner))
          break
        case 'slack_draft_reply':
          out = await this.draft(owner, args)
          break
        case 'slack_post':
          out = await this.post(owner, args)
          break
        default:
          throw new Error(`Unknown tool: ${tool}`)
      }
    } catch (e) {
      throw new Error(this.d.redact(e instanceof Error ? e.message : String(e)))
    }
    return this.finish(out)
  }

  /** Redact, then trim list fields until the JSON fits 12,000 chars. */
  private finish(o: Record<string, unknown>): Record<string, unknown> {
    let out = JSON.parse(this.d.redact(JSON.stringify(o))) as Record<string, unknown>
    const listKey = ['channels', 'messages', 'hits'].find((k) => Array.isArray(out[k]))
    if (!listKey) return out
    let list = out[listKey] as unknown[]
    let truncated = !!out.truncated
    while (JSON.stringify(out).length > MAX_RESULT_CHARS && list.length > 1) {
      // threads keep the parent (first) and the newest; lists drop from the end
      list = listKey === 'messages' ? [list[0], ...list.slice(2)] : list.slice(0, -1)
      truncated = true
      out = { ...out, [listKey]: list, truncated }
    }
    return { ...out, truncated }
  }

  private names = (id: string | null): { id: string | null; name: string | null; is_bot: boolean } => {
    if (!id) return { id: null, name: null, is_bot: false }
    const u = this.d.connector.names.users.get(id)
    return { id, name: userLabel(u, id), is_bot: !!u?.isBot }
  }

  private async channel(ref: string, opts: { openDm: boolean; read: boolean }): Promise<SlackChannel> {
    const c = await this.d.connector.resolveChannelRef(ref, { openDm: opts.openDm })
    if (opts.read && !c.isMember && c.kind !== 'dm') throw new Error(`Hive is not in #${c.name}. Ask the user to /invite @hive.`)
    return c
  }

  private async listChannels(a: Args, scope: RunReadScope | null): Promise<Record<string, unknown>> {
    const ws = this.d.connector.workspace()!
    const q = str(a.query, 100)?.toLowerCase() ?? null
    const includeDms = a.include_dms !== false
    const onlyMember = a.only_member !== false
    const limit = int(a.limit, 100, 1, 200)
    const all = this.d.sql
      .listChannels(ws.teamId)
      .filter((c) => (includeDms ? true : c.kind !== 'dm' && c.kind !== 'group_dm'))
      .filter((c) => (onlyMember ? c.isMember || c.kind === 'dm' : true))
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      // a Slack-triggered run sees its own conversation and its read channels only
      .filter((c) => !scope || c.id === scope.channelId || (!isDmKind(c.kind) && scope.extra.includes(c.id)))
    return {
      workspace: ws.teamName,
      channels: all.slice(0, limit).map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        topic: c.topic,
        is_member: c.isMember,
        member_count: c.memberCount,
        last_message_at: c.lastMessageTs ? tsToIso(c.lastMessageTs) : null
      })),
      truncated: all.length > limit
    }
  }

  private wireMessage(ch: SlackChannel, m: SlackMessage): Record<string, unknown> {
    const ws = this.d.connector.workspace()
    return {
      ts: m.ts,
      thread_ts: m.threadTs,
      user: this.names(m.userId),
      text: m.deleted ? '(deleted)' : m.plain,
      reply_count: m.replyCount,
      reactions: m.reactions,
      files: m.files.map((f) => ({ name: f.name, mimetype: f.mimetype })),
      edited: !!m.editedTs,
      from_hive: m.fromHive,
      permalink: fallbackPermalink(ws?.domain ?? null, ch.id, m.ts, m.threadTs)
    }
  }

  /** Fetch first when older than 60 s; wait at most 3 s, else return the cached copy marked stale. */
  private async fresh(fetch: () => Promise<void>, fetchedAt: string | null): Promise<boolean> {
    if (fetchedAt && this.d.now() - Date.parse(fetchedAt) < FRESH_MS) return true
    const p = fetch().then(
      () => true,
      () => false
    )
    const timeout = new Promise<boolean>((r) => setTimeout(() => r(false), FETCH_WAIT_MS).unref?.())
    return Promise.race([p, timeout])
  }

  private async readThread(a: Args, scope: RunReadScope | null): Promise<Record<string, unknown>> {
    const ws = this.d.connector.workspace()!
    let ref = str(a.channel, 100)
    let threadTs = str(a.thread_ts, 40)
    const link = str(a.permalink, 500)
    if (link) {
      const p = parsePermalink(link)
      if (!p) throw new Error('That permalink is not a Slack message link')
      ref = p.channelId
      threadTs = p.threadTs ?? p.ts
    }
    if (!ref) throw new Error('Pass channel (and thread_ts) or permalink')
    if (threadTs && !TS_RE.test(threadTs)) throw new Error('thread_ts looks like "1729070000.123456"')
    this.precheck(scope, ref)
    const ch = await this.channel(ref, { openDm: false, read: true })
    if (scope && !scopeAllowsRead(scope, ch, threadTs ?? null)) throw this.scopeError(scope)
    const limit = int(a.limit, 50, 1, 200)
    let fresh: boolean
    let msgs: SlackMessage[]
    if (threadTs) {
      const ts = this.d.sql.getThreadSync(ws.teamId, ch.id, threadTs)
      fresh = await this.fresh(() => this.d.connector.sync.fetchThread(ch.id, threadTs!), ts?.fetchedAt ?? null)
      msgs = this.d.sql.getThread({ teamId: ws.teamId, channelId: ch.id, threadTs, limit: limit + 1 })
    } else {
      fresh = await this.fresh(() => this.d.connector.sync.fetchLatest(ch.id), null)
      const before = str(a.before_ts, 40)
      msgs = this.d.sql.getMessages({ teamId: ws.teamId, channelId: ch.id, beforeTs: before && TS_RE.test(before) ? before : undefined, limit: limit + 1 })
    }
    const hasMore = msgs.length > limit
    if (hasMore) msgs = threadTs ? [msgs[0], ...msgs.slice(msgs.length - (limit - 1))] : msgs.slice(msgs.length - limit)
    return {
      channel: { id: ch.id, name: ch.name, kind: ch.kind },
      thread_ts: threadTs ?? null,
      messages: msgs.map((m) => this.wireMessage(ch, m)),
      has_more: hasMore,
      fresh_at: new Date(this.d.now()).toISOString(),
      ...(fresh ? {} : { stale: true })
    }
  }

  private async search(a: Args, scope: RunReadScope | null): Promise<Record<string, unknown>> {
    const ws = this.d.connector.workspace()!
    const query = str(a.query, 200)
    if (!query) throw new Error('query is required')
    const chRef = str(a.channel, 100)
    if (chRef) this.precheck(scope, chRef)
    const ch = chRef ? await this.channel(chRef, { openDm: false, read: true }) : null
    if (ch && scope && ch.id !== scope.channelId && !(scope.extra.includes(ch.id) && !isDmKind(ch.kind))) throw this.scopeError(scope)
    const fromRef = str(a.from_user, 100)
    let userId: string | undefined
    if (fromRef) {
      const h = fromRef.replace(/^@/, '').toLowerCase()
      const u = [...this.d.connector.names.users.values()].find((x) => x.id.toLowerCase() === h || x.name.toLowerCase() === h || (x.displayName ?? '').toLowerCase() === h || (x.realName ?? '').toLowerCase() === h)
      if (!u) throw new Error(`No Slack user ${fromRef}`)
      userId = u.id
    }
    const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00.000Z` : undefined)
    const limit = int(a.limit, 20, 1, 50)
    // scoped runs filter after the search, so they look further back for the same number of visible hits
    const hits = this.d.sql.search({ teamId: ws.teamId, query, channelId: ch?.id, userId, after: date(a.after), before: date(a.before), limit: scope ? 200 : limit + 1 })
    const chans = new Map(this.d.sql.listChannels(ws.teamId).map((c) => [c.id, c]))
    const visible = hits.filter((x) => {
      const c = chans.get(x.message.channelId)
      if (!c || !(c.isMember || c.kind === 'dm')) return false
      return !scope || scopeAllowsRead(scope, c, x.message.threadTs ?? x.message.ts)
    })
    const cov = this.d.sql.coverage(ws.teamId)
    return {
      hits: visible.slice(0, limit).map((x) => ({
        channel: { id: x.message.channelId, name: x.channelName },
        ts: x.message.ts,
        thread_ts: x.message.threadTs,
        user: this.names(x.message.userId),
        snippet: x.snippet.slice(0, 300),
        permalink: fallbackPermalink(ws.domain, x.message.channelId, x.message.ts, x.message.threadTs)
      })),
      searched: `local copy: ${cov.channels} channels${cov.since ? `, since ${cov.since}` : ''}`,
      truncated: visible.length > limit
    }
  }

  private target(a: Args): { ref: string; threadTs: string | null; text: string } {
    const ref = str(a.channel, 100)
    const text = typeof a.text === 'string' ? a.text : ''
    const threadTs = str(a.thread_ts, 40)
    if (!ref) throw new Error('channel is required')
    if (!text.trim()) throw new Error('text is required')
    if (text.length > 3000) throw new Error('text is at most 3,000 characters')
    if (threadTs && !TS_RE.test(threadTs)) throw new Error('thread_ts looks like "1729070000.123456"')
    return { ref, threadTs, text }
  }

  /**
   * Where a write goes. A Slack-triggered run may write only in its own conversation: it never opens a DM, an id outside
   * it is refused before any lookup, and a missing thread_ts in its channel means its thread (placement is fixed, §8.1).
   * The connector enforces the same rule again (refused, fail closed).
   */
  private async writeTarget(caller: ReplyCaller, t: { ref: string; threadTs: string | null }): Promise<{ ch: SlackChannel; threadTs: string | null }> {
    const ctx = caller.kind === 'step' ? caller.ctx : null
    if (!ctx) return { ch: await this.channel(t.ref, { openDm: true, read: false }), threadTs: t.threadTs }
    if (CHANNEL_ID_RE.test(t.ref) && t.ref !== ctx.channelId) return { ch: { id: t.ref, kind: 'channel' } as SlackChannel, threadTs: t.threadTs }
    const ch = await this.channel(t.ref, { openDm: false, read: false })
    const dm = isDmKind(ctx.channelKind)
    return { ch, threadTs: ch.id === ctx.channelId && !dm && !t.threadTs ? ctx.threadTs : t.threadTs }
  }

  private async draft(owner: LiveOwner, a: Args): Promise<Record<string, unknown>> {
    const { caller, label, agentId } = this.caller(owner)
    const t = this.target(a)
    const { ch, threadTs } = await this.writeTarget(caller, t)
    const r = await this.d.connector.draftReply({ caller, channel: ch, threadTs, text: t.text, note: str(a.note, 500), ownerLabel: label, agentId })
    if (r.status === 'refused') return { status: 'refused', reason: r.reason }
    if (r.status !== 'drafted') throw new Error('Unexpected result')
    return { status: 'drafted', draft_id: r.draftId, message: 'The user will review it in Hive (Needs you).' }
  }

  private async post(owner: LiveOwner, a: Args): Promise<Record<string, unknown>> {
    const { caller, label, agentId } = this.caller(owner)
    const t = this.target(a)
    const { ch, threadTs } = await this.writeTarget(caller, t)
    const r = await this.d.connector.reply({ caller, channel: ch, threadTs, text: t.text, ownerLabel: label, agentId })
    if (r.status === 'posted') return { status: 'posted', ts: r.ts, permalink: await this.d.connector.permalink(r.channelId, r.ts) }
    if (r.status === 'refused') return { status: 'refused', reason: r.reason }
    const why = REASON_TEXT[r.reason as keyof typeof REASON_TEXT] ?? r.reason
    return { status: 'drafted', draft_id: r.draftId, reason: r.reason, message: `Saved as a draft for the user to approve: ${why}` }
  }
}
