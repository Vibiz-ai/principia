/**
 * SlackStore on better-sqlite3 (SLACK.md §2.2, §7.1). The only SQL for the slack_* connector tables. Every method is
 * a synchronous transaction wrapped in a resolved Promise (PO-S5: a cloud store implements the same async interface
 * on a pool). Text stored here is what Slack sent; agents and tool results are redacted by the caller.
 */
import type Database from 'better-sqlite3'
import type { SlackChannel, SlackMessage, SlackSearchHit, SlackSearchQuery, SlackUser } from '../../../../shared/slack'
import { tsToMs, toFtsQuery } from '../core/format'
import type {
  MessageSource,
  OutboxRow,
  SlackChannelRow,
  SlackDraftRow,
  SlackMessageRow,
  SlackStore,
  SlackWorkspace,
  SyncState,
  ThreadSync
} from '../core/ports'

type DB = Database.Database
const DAY = 86400_000

const j = <T>(s: string | null | undefined, fb: T): T => {
  if (s == null) return fb
  try {
    return JSON.parse(s) as T
  } catch {
    return fb
  }
}

interface MsgRow {
  team_id: string
  channel_id: string
  ts: string
  thread_ts: string | null
  user_id: string | null
  bot_id: string | null
  subtype: string | null
  text: string
  plain: string
  files_json: string | null
  reactions_json: string | null
  reply_count: number
  latest_reply: string | null
  edited_ts: string | null
  deleted: number
  hive_ref: string | null
}
interface ChanRow {
  team_id: string
  id: string
  kind: SlackChannel['kind']
  name: string
  dm_user_id: string | null
  topic: string | null
  is_member: number
  is_archived: number
  member_count: number | null
  last_message_ts: string | null
  last_read_ts: string | null
  backfill_status?: string | null
}
interface DraftRowDb {
  id: string
  status: string
  team_id: string
  channel_id: string
  thread_ts: string | null
  text: string
  original_text: string
  edited: number
  reason: string
  owner_kind: string
  session_id: string | null
  run_id: string | null
  step_id: string | null
  agent_id: string | null
  trigger_id: string | null
  owner_label: string
  note: string | null
  ask_id: string | null
  outbox_id: string | null
  sent_ts: string | null
  error: string | null
  created_at: string
  decided_at: string | null
  expires_at: string
}
interface OutboxDb {
  id: string
  purpose: string
  team_id: string
  channel_id: string
  thread_ts: string | null
  thread_key: string | null
  text: string
  draft_id: string | null
  run_id: string | null
  step_id: string | null
  status: string
  attempts: number
  ts: string | null
  error: string | null
  created_at: string
  sent_at: string | null
}

export const userFromRow = (r: {
  id: string
  name: string
  real_name: string | null
  display_name: string | null
  is_bot: number
  deleted: number
  avatar_url: string | null
  tz: string | null
  is_restricted?: number | null
  is_ultra_restricted?: number | null
  home_team_id?: string | null
  enterprise_id?: string | null
}): SlackUser => ({
  id: r.id,
  name: r.name,
  realName: r.real_name,
  displayName: r.display_name,
  isBot: !!r.is_bot,
  deleted: !!r.deleted,
  avatarUrl: r.avatar_url,
  tz: r.tz,
  restricted: !!r.is_restricted,
  ultraRestricted: !!r.is_ultra_restricted,
  homeTeamId: r.home_team_id ?? null,
  enterpriseId: r.enterprise_id ?? null
})

const draftFromRow = (r: DraftRowDb): SlackDraftRow => ({
  id: r.id,
  status: r.status as SlackDraftRow['status'],
  teamId: r.team_id,
  channelId: r.channel_id,
  threadTs: r.thread_ts,
  text: r.text,
  originalText: r.original_text,
  edited: !!r.edited,
  reason: r.reason as SlackDraftRow['reason'],
  owner: {
    kind: r.owner_kind as SlackDraftRow['owner']['kind'],
    sessionId: r.session_id,
    runId: r.run_id,
    stepId: r.step_id,
    agentId: r.agent_id,
    triggerId: r.trigger_id,
    label: r.owner_label
  },
  note: r.note,
  askId: r.ask_id,
  outboxId: r.outbox_id,
  sentTs: r.sent_ts,
  error: r.error,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
  expiresAt: r.expires_at
})
const outboxFromRow = (r: OutboxDb): OutboxRow => ({
  id: r.id,
  purpose: r.purpose as OutboxRow['purpose'],
  teamId: r.team_id,
  channelId: r.channel_id,
  threadTs: r.thread_ts,
  threadKey: r.thread_key,
  text: r.text,
  draftId: r.draft_id,
  runId: r.run_id,
  stepId: r.step_id,
  status: r.status as OutboxRow['status'],
  attempts: r.attempts,
  ts: r.ts,
  error: r.error,
  createdAt: r.created_at,
  sentAt: r.sent_at
})

const DRAFT_COLS: Record<string, string> = {
  status: 'status',
  text: 'text',
  edited: 'edited',
  reason: 'reason',
  note: 'note',
  askId: 'ask_id',
  outboxId: 'outbox_id',
  sentTs: 'sent_ts',
  error: 'error',
  decidedAt: 'decided_at',
  expiresAt: 'expires_at',
  threadTs: 'thread_ts'
}
const OUTBOX_COLS: Record<string, string> = {
  status: 'status',
  attempts: 'attempts',
  ts: 'ts',
  error: 'error',
  sentAt: 'sent_at',
  text: 'text'
}

function patchSql(p: Record<string, unknown>, cols: Record<string, string>): { set: string; params: Record<string, unknown> } {
  const sets: string[] = []
  const params: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(p)) {
    const c = cols[k]
    if (!c || v === undefined) continue
    sets.push(`${c} = @${c}`)
    params[c] = typeof v === 'boolean' ? (v ? 1 : 0) : v
  }
  return { set: sets.join(', '), params }
}

/** Synchronous core used by the async SlackStore and by main-side readers (SlackBridge needs sync transcripts). */
export class SlackSqlite {
  private botCache: { teamId: string; botUserId: string; botId: string } | null = null
  constructor(
    readonly db: DB,
    private now: () => Date = () => new Date()
  ) {}

  private iso(): string {
    return this.now().toISOString()
  }

  // ---------- workspace ----------
  getWorkspace(): SlackWorkspace | null {
    const r = this.db.prepare('SELECT * FROM slack_workspaces ORDER BY updated_at DESC LIMIT 1').get() as
      | { team_id: string; team_name: string; domain: string | null; url: string | null; enterprise_id: string | null; app_id: string | null; bot_user_id: string; bot_id: string; scopes_json: string; connected_at: string; updated_at: string }
      | undefined
    if (!r) return null
    this.botCache = { teamId: r.team_id, botUserId: r.bot_user_id, botId: r.bot_id }
    return {
      teamId: r.team_id,
      teamName: r.team_name,
      domain: r.domain,
      url: r.url,
      enterpriseId: r.enterprise_id,
      appId: r.app_id,
      botUserId: r.bot_user_id,
      botId: r.bot_id,
      scopes: j<string[]>(r.scopes_json, []),
      connectedAt: r.connected_at,
      updatedAt: r.updated_at
    }
  }
  saveWorkspace(w: SlackWorkspace): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM slack_workspaces WHERE team_id <> ?').run(w.teamId)
      this.db
        .prepare(
          `INSERT INTO slack_workspaces(team_id, team_name, domain, url, enterprise_id, app_id, bot_user_id, bot_id, scopes_json, connected_at, updated_at)
           VALUES (@teamId, @teamName, @domain, @url, @enterpriseId, @appId, @botUserId, @botId, @scopes, @connectedAt, @updatedAt)
           ON CONFLICT(team_id) DO UPDATE SET team_name = excluded.team_name, domain = excluded.domain, url = excluded.url,
             enterprise_id = excluded.enterprise_id, app_id = excluded.app_id, bot_user_id = excluded.bot_user_id, bot_id = excluded.bot_id,
             scopes_json = excluded.scopes_json, updated_at = excluded.updated_at`
        )
        .run({ ...w, scopes: JSON.stringify(w.scopes) })
    })()
    this.botCache = { teamId: w.teamId, botUserId: w.botUserId, botId: w.botId }
  }
  private bot(): { botUserId: string; botId: string } {
    if (!this.botCache) this.getWorkspace()
    return this.botCache ?? { botUserId: '', botId: '' }
  }

  clearAll(keepMessages: boolean): void {
    if (keepMessages) return
    this.db.transaction(() => {
      for (const t of ['slack_messages', 'slack_users', 'slack_channels', 'slack_sync_state', 'slack_thread_sync', 'slack_event_log', 'slack_inbound_log', 'slack_drafts', 'slack_outbox', 'slack_workspaces']) {
        this.db.prepare(`DELETE FROM ${t}`).run()
      }
      this.db.prepare("INSERT INTO slack_messages_fts(slack_messages_fts) VALUES ('rebuild')").run()
    })()
    this.botCache = null
  }

  // ---------- users ----------
  upsertUsers(teamId: string, users: SlackUser[]): void {
    const st = this.db.prepare(
      `INSERT INTO slack_users(team_id, id, name, real_name, display_name, is_bot, deleted, tz, avatar_url, is_restricted, is_ultra_restricted, home_team_id, enterprise_id, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(team_id, id) DO UPDATE SET name = excluded.name, real_name = excluded.real_name, display_name = excluded.display_name,
         is_bot = excluded.is_bot, deleted = excluded.deleted, tz = excluded.tz, avatar_url = excluded.avatar_url,
         is_restricted = excluded.is_restricted, is_ultra_restricted = excluded.is_ultra_restricted,
         home_team_id = excluded.home_team_id, enterprise_id = excluded.enterprise_id, updated_at = excluded.updated_at`
    )
    const ts = this.iso()
    this.db.transaction(() => {
      for (const u of users)
        st.run(teamId, u.id, u.name, u.realName, u.displayName, u.isBot ? 1 : 0, u.deleted ? 1 : 0, u.tz, u.avatarUrl, u.restricted ? 1 : 0, u.ultraRestricted ? 1 : 0, u.homeTeamId ?? null, u.enterpriseId ?? null, ts)
    })()
  }
  getUser(teamId: string, id: string): SlackUser | null {
    const r = this.db.prepare('SELECT * FROM slack_users WHERE team_id = ? AND id = ?').get(teamId, id) as Parameters<typeof userFromRow>[0] | undefined
    return r ? userFromRow(r) : null
  }
  listUsers(teamId: string): SlackUser[] {
    return (this.db.prepare('SELECT * FROM slack_users WHERE team_id = ? ORDER BY COALESCE(display_name, real_name, name) COLLATE NOCASE').all(teamId) as Parameters<typeof userFromRow>[0][]).map(userFromRow)
  }

  // ---------- channels ----------
  upsertChannels(teamId: string, rows: SlackChannelRow[]): void {
    const st = this.db.prepare(
      `INSERT INTO slack_channels(team_id, id, kind, name, dm_user_id, topic, purpose, is_member, is_archived, member_count, last_message_ts, updated_at)
       VALUES (@teamId, @id, @kind, @name, @dmUserId, @topic, @purpose, @isMember, @isArchived, @memberCount, @lastMessageTs, @updatedAt)
       ON CONFLICT(team_id, id) DO UPDATE SET kind = excluded.kind, name = excluded.name, dm_user_id = excluded.dm_user_id,
         topic = excluded.topic, purpose = excluded.purpose, is_member = excluded.is_member, is_archived = excluded.is_archived,
         member_count = excluded.member_count,
         last_message_ts = CASE WHEN excluded.last_message_ts IS NOT NULL AND (last_message_ts IS NULL OR excluded.last_message_ts > last_message_ts) THEN excluded.last_message_ts ELSE last_message_ts END,
         updated_at = excluded.updated_at`
    )
    const ts = this.iso()
    this.db.transaction(() => {
      for (const c of rows) st.run({ ...c, teamId, isMember: c.isMember ? 1 : 0, isArchived: c.isArchived ? 1 : 0, updatedAt: ts })
    })()
  }
  setMember(teamId: string, channelId: string, isMember: boolean): void {
    const r = this.db.prepare('UPDATE slack_channels SET is_member = ?, updated_at = ? WHERE team_id = ? AND id = ?').run(isMember ? 1 : 0, this.iso(), teamId, channelId)
    if (!r.changes) {
      this.db
        .prepare("INSERT OR IGNORE INTO slack_channels(team_id, id, kind, name, is_member, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(teamId, channelId, channelId.startsWith('D') ? 'dm' : channelId.startsWith('G') ? 'private' : 'channel', channelId, isMember ? 1 : 0, this.iso())
    }
  }
  private chanFromRow(r: ChanRow): SlackChannel {
    return {
      id: r.id,
      teamId: r.team_id,
      kind: r.kind,
      name: r.name,
      dmUserId: r.dm_user_id,
      topic: r.topic,
      isMember: !!r.is_member,
      isArchived: !!r.is_archived,
      memberCount: r.member_count,
      lastMessageTs: r.last_message_ts,
      unread: !!r.last_message_ts && (!r.last_read_ts || r.last_message_ts > r.last_read_ts),
      sync: ((r.backfill_status as SlackChannel['sync']) ?? (r.is_member ? 'pending' : 'skipped')) || 'pending'
    }
  }
  private CHAN_SELECT = `SELECT c.*, s.backfill_status FROM slack_channels c LEFT JOIN slack_sync_state s ON s.team_id = c.team_id AND s.channel_id = c.id`
  listChannels(teamId: string): SlackChannel[] {
    return (this.db.prepare(`${this.CHAN_SELECT} WHERE c.team_id = ? ORDER BY c.kind, c.name COLLATE NOCASE`).all(teamId) as ChanRow[]).map((r) => this.chanFromRow(r))
  }
  getChannel(teamId: string, id: string): SlackChannel | null {
    const r = this.db.prepare(`${this.CHAN_SELECT} WHERE c.team_id = ? AND c.id = ?`).get(teamId, id) as ChanRow | undefined
    return r ? this.chanFromRow(r) : null
  }
  markRead(teamId: string, channelId: string, ts: string): void {
    this.db.prepare('UPDATE slack_channels SET last_read_ts = CASE WHEN last_read_ts IS NULL OR ? > last_read_ts THEN ? ELSE last_read_ts END WHERE team_id = ? AND id = ?').run(ts, ts, teamId, channelId)
  }

  // ---------- messages ----------
  private msgFromRow(r: MsgRow): SlackMessage {
    const b = this.bot()
    return {
      teamId: r.team_id,
      channelId: r.channel_id,
      ts: r.ts,
      threadTs: r.thread_ts,
      userId: r.user_id,
      botId: r.bot_id,
      subtype: r.subtype,
      text: r.text,
      plain: r.plain,
      files: j(r.files_json, []),
      reactions: j(r.reactions_json, []),
      replyCount: r.reply_count,
      latestReply: r.latest_reply,
      editedTs: r.edited_ts,
      deleted: !!r.deleted,
      fromHive: !!r.hive_ref || (!!b.botUserId && r.user_id === b.botUserId) || (!!b.botId && r.bot_id === b.botId),
      isMention: !!b.botUserId && r.text.includes(`<@${b.botUserId}`)
    }
  }

  upsertMessages(teamId: string, rows: SlackMessageRow[], source: MessageSource): { inserted: number; updated: number } {
    const exists = this.db.prepare('SELECT 1 FROM slack_messages WHERE team_id = ? AND channel_id = ? AND ts = ?')
    const st = this.db.prepare(
      `INSERT INTO slack_messages(team_id, channel_id, ts, thread_ts, user_id, bot_id, subtype, text, plain, files_json, reactions_json,
         reply_count, latest_reply, reply_users_json, edited_ts, hive_ref, source, received_at)
       VALUES (@teamId, @channelId, @ts, @threadTs, @userId, @botId, @subtype, @text, @plain, @files, @reactions,
         COALESCE(@replyCount, 0), @latestReply, @replyUsers, @editedTs, @hiveRef, @source, @receivedAt)
       ON CONFLICT(team_id, channel_id, ts) DO UPDATE SET
         thread_ts = COALESCE(excluded.thread_ts, thread_ts), user_id = COALESCE(excluded.user_id, user_id),
         bot_id = COALESCE(excluded.bot_id, bot_id), subtype = excluded.subtype,
         text = CASE WHEN deleted = 1 THEN text ELSE excluded.text END, plain = CASE WHEN deleted = 1 THEN plain ELSE excluded.plain END,
         files_json = COALESCE(excluded.files_json, files_json), reactions_json = COALESCE(@reactions, reactions_json),
         reply_count = COALESCE(@replyCount, reply_count),
         latest_reply = CASE WHEN @latestReply IS NOT NULL AND (latest_reply IS NULL OR @latestReply > latest_reply) THEN @latestReply ELSE latest_reply END,
         reply_users_json = COALESCE(excluded.reply_users_json, reply_users_json), edited_ts = COALESCE(excluded.edited_ts, edited_ts),
         hive_ref = COALESCE(hive_ref, excluded.hive_ref)`
    )
    const bumpChan = this.db.prepare(
      `UPDATE slack_channels SET last_message_ts = ? WHERE team_id = ? AND id = ? AND (last_message_ts IS NULL OR last_message_ts < ?)`
    )
    let inserted = 0
    let updated = 0
    const at = this.iso()
    this.db.transaction(() => {
      for (const m of rows) {
        const had = !!exists.get(teamId, m.channelId, m.ts)
        st.run({
          teamId,
          channelId: m.channelId,
          ts: m.ts,
          threadTs: m.threadTs,
          userId: m.userId,
          botId: m.botId,
          subtype: m.subtype,
          text: m.text,
          plain: m.plain,
          files: m.files.length ? JSON.stringify(m.files) : null,
          reactions: m.reactions ? JSON.stringify(m.reactions) : null,
          replyCount: m.replyCount,
          latestReply: m.latestReply,
          replyUsers: m.replyUsers ? JSON.stringify(m.replyUsers) : null,
          editedTs: m.editedTs,
          hiveRef: m.hiveRef,
          source,
          receivedAt: at
        })
        if (had) updated++
        else inserted++
        const topLevel = !m.threadTs || m.threadTs === m.ts || m.subtype === 'thread_broadcast'
        if (topLevel && (!m.subtype || m.subtype === 'thread_broadcast' || m.subtype === 'file_share' || m.subtype === 'me_message' || m.subtype === 'bot_message')) bumpChan.run(m.ts, teamId, m.channelId, m.ts)
      }
    })()
    return { inserted, updated }
  }
  bumpParent(teamId: string, channelId: string, threadTs: string, replyTs: string, userId: string | null): void {
    const r = this.db.prepare('SELECT reply_count, latest_reply, reply_users_json FROM slack_messages WHERE team_id = ? AND channel_id = ? AND ts = ?').get(teamId, channelId, threadTs) as
      | { reply_count: number; latest_reply: string | null; reply_users_json: string | null }
      | undefined
    if (!r) return
    if (r.latest_reply && r.latest_reply >= replyTs) return
    const users = j<string[]>(r.reply_users_json, [])
    if (userId && !users.includes(userId)) users.push(userId)
    const count = (this.db.prepare('SELECT count(*) AS n FROM slack_messages WHERE team_id = ? AND channel_id = ? AND thread_ts = ? AND ts <> ? AND deleted = 0').get(teamId, channelId, threadTs, threadTs) as { n: number }).n
    this.db
      .prepare('UPDATE slack_messages SET reply_count = ?, latest_reply = ?, reply_users_json = ?, thread_ts = COALESCE(thread_ts, ts) WHERE team_id = ? AND channel_id = ? AND ts = ?')
      .run(Math.max(r.reply_count, count), replyTs, JSON.stringify(users), teamId, channelId, threadTs)
  }
  /**
   * Tombstones a message. A thread reply also lowers its parent's reply_count by one (once: a second delete event is a
   * no-op) and moves latest_reply back to the newest reply left. Returns the parent's ts for a reply, else null.
   * Slack's own number wins whenever the parent arrives again (message_changed / conversations.replies).
   */
  markDeleted(teamId: string, channelId: string, ts: string): { parentTs: string | null } {
    return this.db.transaction(() => {
      const r = this.db.prepare('SELECT thread_ts, deleted FROM slack_messages WHERE team_id = ? AND channel_id = ? AND ts = ?').get(teamId, channelId, ts) as
        | { thread_ts: string | null; deleted: number }
        | undefined
      this.db.prepare("UPDATE slack_messages SET text = '', plain = '', files_json = NULL, deleted = 1, received_at = ? WHERE team_id = ? AND channel_id = ? AND ts = ?").run(this.iso(), teamId, channelId, ts)
      const parentTs = r?.thread_ts && r.thread_ts !== ts ? r.thread_ts : null
      if (!parentTs || r?.deleted) return { parentTs }
      const latest = (
        this.db.prepare('SELECT MAX(ts) AS t FROM slack_messages WHERE team_id = ? AND channel_id = ? AND thread_ts = ? AND ts <> ? AND deleted = 0').get(teamId, channelId, parentTs, parentTs) as {
          t: string | null
        }
      ).t
      this.db
        .prepare(
          `UPDATE slack_messages SET reply_count = MAX(reply_count - 1, 0),
             latest_reply = CASE WHEN latest_reply = @ts THEN @latest ELSE latest_reply END
           WHERE team_id = @teamId AND channel_id = @channelId AND ts = @parentTs`
        )
        .run({ ts, latest, teamId, channelId, parentTs })
      return { parentTs }
    })()
  }
  getMessage(teamId: string, channelId: string, ts: string): SlackMessage | null {
    const r = this.db.prepare('SELECT * FROM slack_messages WHERE team_id = ? AND channel_id = ? AND ts = ?').get(teamId, channelId, ts) as MsgRow | undefined
    return r ? this.msgFromRow(r) : null
  }
  /** Channel timeline: top-level messages (and broadcasts), oldest first. */
  getMessages(q: { teamId: string; channelId: string; beforeTs?: string; limit: number }): SlackMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM slack_messages WHERE team_id = ? AND channel_id = ? AND (thread_ts IS NULL OR thread_ts = ts OR subtype = 'thread_broadcast')
         ${q.beforeTs ? 'AND ts < ?' : ''} ORDER BY ts DESC LIMIT ?`
      )
      .all(...[q.teamId, q.channelId, ...(q.beforeTs ? [q.beforeTs] : []), q.limit]) as MsgRow[]
    return rows.reverse().map((r) => this.msgFromRow(r))
  }
  /** Parent + replies, oldest first. */
  getThread(q: { teamId: string; channelId: string; threadTs: string; limit: number }): SlackMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM slack_messages WHERE team_id = ? AND channel_id = ? AND (ts = ? OR thread_ts = ?) ORDER BY ts DESC LIMIT ?`)
      .all(q.teamId, q.channelId, q.threadTs, q.threadTs, q.limit) as MsgRow[]
    return rows.reverse().map((r) => this.msgFromRow(r))
  }
  /** Oldest local message ts in a channel (the "Load older" boundary). */
  oldestTs(teamId: string, channelId: string): string | null {
    return (this.db.prepare('SELECT MIN(ts) AS t FROM slack_messages WHERE team_id = ? AND channel_id = ?').get(teamId, channelId) as { t: string | null }).t
  }
  search(q: SlackSearchQuery & { teamId: string }): SlackSearchHit[] {
    const fts = toFtsQuery(q.query)
    if (!fts) return []
    const where = ['slack_messages_fts MATCH @fts', 'm.team_id = @teamId', 'm.deleted = 0']
    const p: Record<string, unknown> = { fts, teamId: q.teamId, limit: Math.min(Math.max(q.limit ?? 20, 1), 100) }
    if (q.channelId) (where.push('m.channel_id = @channelId'), (p.channelId = q.channelId))
    if (q.userId) (where.push('m.user_id = @userId'), (p.userId = q.userId))
    if (q.after) (where.push('m.ts >= @after'), (p.after = (Date.parse(q.after) / 1000).toFixed(6)))
    if (q.before) (where.push('m.ts < @before'), (p.before = (Date.parse(q.before) / 1000).toFixed(6)))
    const rows = this.db
      .prepare(
        `SELECT m.*, snippet(slack_messages_fts, 0, '«', '»', '…', 24) AS snip, COALESCE(c.name, m.channel_id) AS cname
         FROM slack_messages_fts JOIN slack_messages m ON m.rowid = slack_messages_fts.rowid
         LEFT JOIN slack_channels c ON c.team_id = m.team_id AND c.id = m.channel_id
         WHERE ${where.join(' AND ')} ORDER BY m.ts DESC LIMIT @limit`
      )
      .all(p) as (MsgRow & { snip: string; cname: string })[]
    return rows.map((r) => ({ message: this.msgFromRow(r), channelName: r.cname, snippet: r.snip.slice(0, 300) }))
  }
  /** What search covers ("local copy: 14 channels, since 2026-10-09"). */
  coverage(teamId: string): { channels: number; since: string | null } {
    const r = this.db.prepare('SELECT count(DISTINCT channel_id) AS n, MIN(ts) AS t FROM slack_messages WHERE team_id = ?').get(teamId) as { n: number; t: string | null }
    return { channels: r.n, since: r.t ? new Date(tsToMs(r.t)).toISOString().slice(0, 10) : null }
  }

  // ---------- events ----------
  recordEvent(eventId: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO slack_event_log(event_id, received_at) VALUES (?, ?)').run(eventId, this.iso()).changes > 0
  }
  forgetEvent(eventId: string): void {
    this.db.prepare('DELETE FROM slack_event_log WHERE event_id = ?').run(eventId)
  }
  /** First delivery of (channel, ts) to trigger matching: true once, across restarts. */
  claimInbound(teamId: string, channelId: string, ts: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO slack_inbound_log(team_id, channel_id, ts, received_at) VALUES (?, ?, ?, ?)').run(teamId, channelId, ts, this.iso()).changes > 0
  }

  // ---------- sync state ----------
  getSyncState(teamId: string, channelId: string): SyncState | null {
    const r = this.db.prepare('SELECT * FROM slack_sync_state WHERE team_id = ? AND channel_id = ?').get(teamId, channelId) as
      | { team_id: string; channel_id: string; backfill_status: string; backfill_days: number; backfill_oldest_ts: string | null; backfill_cursor: string | null; latest_ts: string | null; error: string | null }
      | undefined
    return r
      ? {
          teamId: r.team_id,
          channelId: r.channel_id,
          backfillStatus: r.backfill_status as SyncState['backfillStatus'],
          backfillDays: r.backfill_days,
          backfillOldestTs: r.backfill_oldest_ts,
          backfillCursor: r.backfill_cursor,
          latestTs: r.latest_ts,
          error: r.error
        }
      : null
  }
  listSyncStates(teamId: string): SyncState[] {
    return (this.db.prepare('SELECT channel_id FROM slack_sync_state WHERE team_id = ?').all(teamId) as { channel_id: string }[]).map((r) => this.getSyncState(teamId, r.channel_id)!)
  }
  putSyncState(s: SyncState): void {
    this.db
      .prepare(
        `INSERT INTO slack_sync_state(team_id, channel_id, backfill_status, backfill_days, backfill_oldest_ts, backfill_cursor, latest_ts, error, updated_at)
         VALUES (@teamId, @channelId, @backfillStatus, @backfillDays, @backfillOldestTs, @backfillCursor, @latestTs, @error, @at)
         ON CONFLICT(team_id, channel_id) DO UPDATE SET backfill_status = excluded.backfill_status, backfill_days = excluded.backfill_days,
           backfill_oldest_ts = excluded.backfill_oldest_ts, backfill_cursor = excluded.backfill_cursor,
           latest_ts = CASE WHEN excluded.latest_ts IS NOT NULL AND (latest_ts IS NULL OR excluded.latest_ts > latest_ts) THEN excluded.latest_ts ELSE latest_ts END,
           error = excluded.error, updated_at = excluded.updated_at`
      )
      .run({ ...s, at: this.iso() })
  }
  getThreadSync(teamId: string, channelId: string, threadTs: string): ThreadSync | null {
    const r = this.db.prepare('SELECT * FROM slack_thread_sync WHERE team_id = ? AND channel_id = ? AND thread_ts = ?').get(teamId, channelId, threadTs) as
      | { team_id: string; channel_id: string; thread_ts: string; synced_through_ts: string | null; fetched_at: string | null; status: string }
      | undefined
    return r ? { teamId: r.team_id, channelId: r.channel_id, threadTs: r.thread_ts, syncedThroughTs: r.synced_through_ts, fetchedAt: r.fetched_at, status: r.status as ThreadSync['status'] } : null
  }
  putThreadSync(s: ThreadSync): void {
    this.db
      .prepare(
        `INSERT INTO slack_thread_sync(team_id, channel_id, thread_ts, synced_through_ts, fetched_at, status) VALUES (?,?,?,?,?,?)
         ON CONFLICT(team_id, channel_id, thread_ts) DO UPDATE SET synced_through_ts = COALESCE(excluded.synced_through_ts, synced_through_ts),
           fetched_at = COALESCE(excluded.fetched_at, fetched_at), status = excluded.status`
      )
      .run(s.teamId, s.channelId, s.threadTs, s.syncedThroughTs, s.fetchedAt, s.status)
  }
  pendingThreads(teamId: string): ThreadSync[] {
    return (this.db.prepare("SELECT channel_id, thread_ts FROM slack_thread_sync WHERE team_id = ? AND status = 'pending'").all(teamId) as { channel_id: string; thread_ts: string }[]).map(
      (r) => this.getThreadSync(teamId, r.channel_id, r.thread_ts)!
    )
  }

  // ---------- outbox ----------
  outboxInsert(o: OutboxRow): void {
    this.db
      .prepare(
        `INSERT INTO slack_outbox(id, purpose, team_id, channel_id, thread_ts, thread_key, text, draft_id, run_id, step_id, status, attempts, ts, error, created_at, sent_at)
         VALUES (@id, @purpose, @teamId, @channelId, @threadTs, @threadKey, @text, @draftId, @runId, @stepId, @status, @attempts, @ts, @error, @createdAt, @sentAt)`
      )
      .run(o)
  }
  outboxGet(id: string): OutboxRow | null {
    const r = this.db.prepare('SELECT * FROM slack_outbox WHERE id = ?').get(id) as OutboxDb | undefined
    return r ? outboxFromRow(r) : null
  }
  outboxUpdate(id: string, p: Partial<OutboxRow>): OutboxRow {
    const { set, params } = patchSql(p as Record<string, unknown>, OUTBOX_COLS)
    if (set) this.db.prepare(`UPDATE slack_outbox SET ${set} WHERE id = @__id`).run({ ...params, __id: id })
    const r = this.outboxGet(id)
    if (!r) throw new Error(`outbox ${id} not found`)
    return r
  }
  outboxPending(): OutboxRow[] {
    return (this.db.prepare("SELECT * FROM slack_outbox WHERE status IN ('queued','sending','unknown') ORDER BY created_at").all() as OutboxDb[]).map(outboxFromRow)
  }
  autoPostsSince(q: { teamId: string; channelId?: string; threadKey?: string; runId?: string; sinceMs: number; withNotify?: boolean }): number {
    const where = ["team_id = @teamId", q.withNotify ? "purpose IN ('auto', 'notify')" : "purpose = 'auto'", "status <> 'failed'", 'created_at >= @since']
    const p: Record<string, unknown> = { teamId: q.teamId, since: new Date(q.sinceMs).toISOString() }
    if (q.channelId) (where.push('channel_id = @channelId'), (p.channelId = q.channelId))
    if (q.threadKey) (where.push('thread_key = @threadKey'), (p.threadKey = q.threadKey))
    if (q.runId) (where.push('run_id = @runId'), (p.runId = q.runId))
    return (this.db.prepare(`SELECT count(*) AS n FROM slack_outbox WHERE ${where.join(' AND ')}`).get(p) as { n: number }).n
  }
  /** Notify-node posts (purpose 'notify', not failed) since a time, optionally for one run: the durable alert rate guard. */
  notifyPostsSince(q: { runId?: string | null; sinceMs: number }): number {
    const where = ["purpose = 'notify'", "status <> 'failed'", 'created_at >= @since']
    const p: Record<string, unknown> = { since: new Date(q.sinceMs).toISOString() }
    if (q.runId) (where.push('run_id = @runId'), (p.runId = q.runId))
    return (this.db.prepare(`SELECT count(*) AS n FROM slack_outbox WHERE ${where.join(' AND ')}`).get(p) as { n: number }).n
  }

  // ---------- drafts ----------
  draftInsert(d: SlackDraftRow): void {
    this.db
      .prepare(
        `INSERT INTO slack_drafts(id, status, team_id, channel_id, thread_ts, text, original_text, edited, reason, owner_kind, session_id, run_id, step_id,
           agent_id, trigger_id, owner_label, note, ask_id, outbox_id, sent_ts, error, created_at, decided_at, expires_at)
         VALUES (@id, @status, @teamId, @channelId, @threadTs, @text, @originalText, @edited, @reason, @ownerKind, @sessionId, @runId, @stepId,
           @agentId, @triggerId, @ownerLabel, @note, @askId, @outboxId, @sentTs, @error, @createdAt, @decidedAt, @expiresAt)`
      )
      .run({
        ...d,
        edited: d.edited ? 1 : 0,
        ownerKind: d.owner.kind,
        sessionId: d.owner.sessionId,
        runId: d.owner.runId,
        stepId: d.owner.stepId,
        agentId: d.owner.agentId,
        triggerId: d.owner.triggerId,
        ownerLabel: d.owner.label,
        owner: undefined
      })
  }
  draftGet(id: string): SlackDraftRow | null {
    const r = this.db.prepare('SELECT * FROM slack_drafts WHERE id = ?').get(id) as DraftRowDb | undefined
    return r ? draftFromRow(r) : null
  }
  draftUpdate(id: string, p: Partial<SlackDraftRow>): SlackDraftRow {
    const { set, params } = patchSql(p as Record<string, unknown>, DRAFT_COLS)
    if (set) this.db.prepare(`UPDATE slack_drafts SET ${set} WHERE id = @__id`).run({ ...params, __id: id })
    const r = this.draftGet(id)
    if (!r) throw new Error(`draft ${id} not found`)
    return r
  }
  draftList(q: { status?: string[]; channelId?: string; threadTs?: string; runId?: string; limit?: number }): SlackDraftRow[] {
    const where: string[] = []
    const p: Record<string, unknown> = { limit: Math.min(Math.max(q.limit ?? 200, 1), 1000) }
    if (q.status?.length) {
      where.push(`status IN (${q.status.map((_, i) => `@s${i}`).join(',')})`)
      q.status.forEach((s, i) => (p[`s${i}`] = s))
    }
    if (q.channelId) (where.push('channel_id = @channelId'), (p.channelId = q.channelId))
    if (q.threadTs) (where.push('thread_ts = @threadTs'), (p.threadTs = q.threadTs))
    if (q.runId) (where.push('run_id = @runId'), (p.runId = q.runId))
    return (
      this.db.prepare(`SELECT * FROM slack_drafts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT @limit`).all(p) as DraftRowDb[]
    ).map(draftFromRow)
  }
  draftsExpired(nowIso: string): SlackDraftRow[] {
    return (this.db.prepare("SELECT * FROM slack_drafts WHERE status = 'pending' AND expires_at <= ?").all(nowIso) as DraftRowDb[]).map(draftFromRow)
  }
  draftsPendingForOwner(o: { sessionId?: string | null; stepId?: string | null }): number {
    if (o.stepId) return (this.db.prepare("SELECT count(*) AS n FROM slack_drafts WHERE status = 'pending' AND step_id = ?").get(o.stepId) as { n: number }).n
    if (o.sessionId) return (this.db.prepare("SELECT count(*) AS n FROM slack_drafts WHERE status = 'pending' AND session_id = ?").get(o.sessionId) as { n: number }).n
    return 0
  }
  /** Drafts + auto posts a run made itself (reply binding skips when > 0). */
  countForRun(runId: string): number {
    const a = (this.db.prepare('SELECT count(*) AS n FROM slack_drafts WHERE run_id = ?').get(runId) as { n: number }).n
    const b = (this.db.prepare("SELECT count(*) AS n FROM slack_outbox WHERE run_id = ? AND purpose IN ('auto','reply') AND draft_id IS NULL AND status <> 'failed'").get(runId) as { n: number }).n
    return a + b
  }

  pruneOld(nowMs: number, backfillDays: number): void {
    const keepDays = Math.max(30, backfillDays + 30)
    const cutoffTs = ((nowMs - keepDays * DAY) / 1000).toFixed(6)
    const iso = (ms: number) => new Date(ms).toISOString()
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM slack_messages WHERE ts < ? AND source <> ?').run(cutoffTs, 'post')
      this.db.prepare('DELETE FROM slack_messages WHERE deleted = 1 AND received_at < ?').run(iso(nowMs - 7 * DAY))
      this.db.prepare('DELETE FROM slack_event_log WHERE received_at < ?').run(iso(nowMs - 2 * DAY))
      this.db.prepare('DELETE FROM slack_inbound_log WHERE received_at < ?').run(iso(nowMs - 2 * DAY))
      this.db.prepare('DELETE FROM slack_trigger_events WHERE created_at < ?').run(iso(nowMs - 30 * DAY))
      this.db
        .prepare(
          `DELETE FROM slack_trigger_events WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY trigger_id ORDER BY created_at DESC) AS rn FROM slack_trigger_events) WHERE rn > 500)`
        )
        .run()
      this.db.prepare("DELETE FROM slack_drafts WHERE status IN ('sent','discarded','expired') AND created_at < ?").run(iso(nowMs - 90 * DAY))
      this.db.prepare('DELETE FROM slack_outbox WHERE created_at < ?').run(iso(nowMs - 30 * DAY))
    })()
  }
}

/** The async SlackStore (PO-S5) over the synchronous SQLite core. */
export function createSqliteSlackStore(s: SlackSqlite): SlackStore {
  const r = <T>(fn: () => T): Promise<T> => {
    try {
      return Promise.resolve(fn())
    } catch (e) {
      return Promise.reject(e)
    }
  }
  return {
    getWorkspace: () => r(() => s.getWorkspace()),
    saveWorkspace: (w) => r(() => s.saveWorkspace(w)),
    clearAll: (o) => r(() => s.clearAll(o.keepMessages)),
    upsertUsers: (t, u) => r(() => s.upsertUsers(t, u)),
    getUser: (t, id) => r(() => s.getUser(t, id)),
    listUsers: (t) => r(() => s.listUsers(t)),
    upsertChannels: (t, c) => r(() => s.upsertChannels(t, c)),
    setMember: (t, c, m) => r(() => s.setMember(t, c, m)),
    listChannels: (t) => r(() => s.listChannels(t)),
    getChannel: (t, id) => r(() => s.getChannel(t, id)),
    upsertMessages: (t, m, src) => r(() => s.upsertMessages(t, m, src)),
    bumpParent: (t, c, th, ts, u) => r(() => s.bumpParent(t, c, th, ts, u)),
    markDeleted: (t, c, ts) => r(() => s.markDeleted(t, c, ts)),
    getMessage: (t, c, ts) => r(() => s.getMessage(t, c, ts)),
    getMessages: (q) => r(() => s.getMessages(q)),
    getThread: (q) => r(() => s.getThread(q)),
    search: (q) => r(() => s.search(q)),
    recordEvent: (id) => r(() => s.recordEvent(id)),
    forgetEvent: (id) => r(() => s.forgetEvent(id)),
    claimInbound: (t, c, ts) => r(() => s.claimInbound(t, c, ts)),
    getSyncState: (t, c) => r(() => s.getSyncState(t, c)),
    putSyncState: (x) => r(() => s.putSyncState(x)),
    getThreadSync: (t, c, th) => r(() => s.getThreadSync(t, c, th)),
    putThreadSync: (x) => r(() => s.putThreadSync(x)),
    pendingThreads: (t) => r(() => s.pendingThreads(t)),
    listSyncStates: (t) => r(() => s.listSyncStates(t)),
    outbox: {
      insert: (o) => r(() => s.outboxInsert(o)),
      update: (id, p) => r(() => s.outboxUpdate(id, p)),
      get: (id) => r(() => s.outboxGet(id)),
      pending: () => r(() => s.outboxPending())
    },
    drafts: {
      insert: (d) => r(() => s.draftInsert(d)),
      update: (id, p) => r(() => s.draftUpdate(id, p)),
      get: (id) => r(() => s.draftGet(id)),
      list: (q) => r(() => s.draftList(q)),
      expired: (iso) => r(() => s.draftsExpired(iso)),
      pendingForOwner: (o) => r(() => s.draftsPendingForOwner(o)),
      countForRun: (id) => r(() => s.countForRun(id))
    },
    autoPostsSince: (q) => r(() => s.autoPostsSince(q)),
    notifyPostsSince: (q) => r(() => s.notifyPostsSince(q)),
    pruneOld: (now, o) => r(() => s.pruneOld(now, o.backfillDays))
  }
}
