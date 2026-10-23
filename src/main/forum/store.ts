/**
 * FORUM.md §1-§2: the Forum's storage over hive.db. Every method is scoped by company; permissions come from policy.ts
 * and are checked here, so the IPC handlers and the agent API cannot forget them. Writes emit ForumEvents through
 * `onEvent` (the service forwards them to the renderer). No Electron imports (tests run it on an in-memory db).
 */
import { createHash, randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  CHANNEL_NAME_RE,
  FORUM_LIMITS,
  HANDLE_RE,
  channelSlug,
  handleSlug,
  messageRef,
  type ForumAsk,
  type ForumChannel,
  type ForumChannelKind,
  type ForumChannelSystem,
  type ForumEvent,
  type ForumInvite,
  type ForumInviteRole,
  type ForumMember,
  type ForumMessage,
  type ForumMessageKind,
  type ForumProposal,
  type ForumRef,
  type ForumRole
} from '../../shared/forum'
import { HiveError } from '../../shared/errors'
import { ensureForumSchema } from './schema'
import { parseRefArg, parseText } from './refs'
import * as policy from './policy'

type DB = Database.Database
const fail = (message: string): never => {
  throw new HiveError('bad_request', message)
}
const notFound = (what: string): never => {
  throw new HiveError('not_found', `${what} not found`)
}
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
export function forumId(prefix: 'fmb' | 'fch' | 'fmsg' | 'finv'): string {
  let s = ''
  for (const b of randomBytes(10)) s += ALPHABET[b % 36]
  return `${prefix}_${s}`
}
const parseJson = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' ? (v as T) : fallback
  } catch {
    return fallback
  }
}

/** What the Forum needs to know about the company (CompanyStore in the app, a fake in tests). */
export interface ForumDirectory {
  departments(companyId: string): { id: string; key: string; name: string; archivedAt: string | null }[]
  /** the company's agent seats with their display persona (stored or resolved) */
  agents(companyId: string): { id: string; departmentId: string | null; name: string; archivedAt: string | null; personaName: string | null }[]
  /** the owner's display name on this Mac */
  ownerName(): string
  /** company exists (unknown ids are refused) */
  hasCompany(companyId: string): boolean
}

export interface ForumStoreDeps {
  directory: ForumDirectory
  now?: () => Date
  onEvent?: (e: ForumEvent) => void
  /** h.vault.redact: every stored text */
  redact?: (s: string) => string
}

interface MemberRow { id: string; company_id: string; kind: string; role: string; agent_id: string | null; handle: string; name: string; status: string; created_at: string; data: string }
interface ChannelRow { id: string; company_id: string; kind: string; name: string | null; topic: string; purpose: string; department_id: string | null; system: string | null; dm_key: string | null; created_by: string | null; created_at: string; archived_at: string | null; data: string }
interface MessageRow { seq: number; id: string; company_id: string; channel_id: string; thread_seq: number | null; author_id: string; kind: string; text: string; reply_count: number; last_reply_at: string | null; created_at: string; edited_at: string | null; deleted_at: string | null; origin: string; data: string }
interface MessageData { mentions?: string[]; mentionDepartments?: string[]; refs?: ForumRef[]; reactions?: Record<string, string[]>; ask?: ForumAsk; proposal?: ForumProposal; repliers?: string[]; opKey?: string }

export interface PostInput {
  channelId: string
  text: string
  /** thread root (message id or seq) */
  threadId?: string | null
  kind?: ForumMessageKind
  ask?: ForumAsk
  proposal?: ForumProposal
  /** explicit refs (protocol `refs`), merged with the ones parsed from the text */
  refs?: string[]
  origin?: string
  /** idempotency key (fenced ops: stepId:index): a second post with the same key returns the first */
  opKey?: string
}

export class ForumStore {
  readonly db: DB
  private readonly now: () => Date
  private readonly redact: (s: string) => string

  constructor(db: DB, private readonly d: ForumStoreDeps) {
    this.db = db
    ensureForumSchema(db)
    this.now = d.now ?? (() => new Date())
    this.redact = d.redact ?? ((s) => s)
  }

  private iso(): string {
    return this.now().toISOString()
  }
  private emit(e: ForumEvent): void {
    try {
      this.d.onEvent?.(e)
    } catch {
      /* an event listener never fails a write */
    }
  }

  // ---------- rows ----------

  private toMember(r: MemberRow): ForumMember {
    return { id: r.id, companyId: r.company_id, kind: r.kind as ForumMember['kind'], role: r.role as ForumRole, agentId: r.agent_id, handle: r.handle, name: r.name, status: r.status as ForumMember['status'], createdAt: r.created_at, data: parseJson(r.data, {}) }
  }
  toMessage(r: MessageRow): ForumMessage {
    const d = parseJson<MessageData>(r.data, {})
    const root = r.thread_seq ? (this.db.prepare('SELECT id FROM forum_messages WHERE seq=?').get(r.thread_seq) as { id: string } | undefined) : undefined
    return {
      id: r.id,
      seq: r.seq,
      ref: messageRef(r.seq),
      companyId: r.company_id,
      channelId: r.channel_id,
      threadId: root?.id ?? null,
      authorId: r.author_id,
      kind: r.kind as ForumMessageKind,
      text: r.deleted_at ? '' : r.text,
      createdAt: r.created_at,
      editedAt: r.edited_at,
      deletedAt: r.deleted_at,
      replyCount: r.reply_count,
      lastReplyAt: r.last_reply_at,
      repliers: d.repliers ?? [],
      mentions: d.mentions ?? [],
      mentionDepartments: d.mentionDepartments ?? [],
      refs: d.refs ?? [],
      reactions: d.reactions ?? {},
      ...(d.ask ? { ask: d.ask } : {}),
      ...(d.proposal ? { proposal: d.proposal } : {}),
      origin: r.origin
    }
  }

  // ---------- members ----------

  members(companyId: string, opts: { includeRemoved?: boolean } = {}): ForumMember[] {
    const rows = this.db.prepare(`SELECT * FROM forum_members WHERE company_id=? ${opts.includeRemoved ? '' : "AND status!='removed'"} ORDER BY kind='agent', created_at`).all(companyId) as MemberRow[]
    return rows.map((r) => this.toMember(r))
  }
  member(id: string): ForumMember | null {
    const r = this.db.prepare('SELECT * FROM forum_members WHERE id=?').get(id) as MemberRow | undefined
    return r ? this.toMember(r) : null
  }
  mustMember(id: string): ForumMember {
    return this.member(id) ?? notFound('Member')
  }
  memberByHandle(companyId: string, handle: string): ForumMember | null {
    const r = this.db.prepare('SELECT * FROM forum_members WHERE company_id=? AND handle=?').get(companyId, handle.replace(/^@/, '').toLowerCase()) as MemberRow | undefined
    return r ? this.toMember(r) : null
  }
  memberForAgent(agentId: string): ForumMember | null {
    const r = this.db.prepare('SELECT * FROM forum_members WHERE agent_id=?').get(agentId) as MemberRow | undefined
    return r ? this.toMember(r) : null
  }
  owner(companyId: string): ForumMember {
    this.sync(companyId)
    const r = this.db.prepare("SELECT * FROM forum_members WHERE company_id=? AND role='owner' LIMIT 1").get(companyId) as MemberRow | undefined
    return r ? this.toMember(r) : notFound('Owner')
  }

  /** A free handle for `base` in the company (`marcus`, `marcus2`, …). */
  private freeHandle(companyId: string, base: string, exceptId?: string): string {
    const root = handleSlug(base).slice(0, 28)
    const taken = (h: string) => {
      const r = this.db.prepare('SELECT id FROM forum_members WHERE company_id=? AND handle=?').get(companyId, h) as { id: string } | undefined
      return !!r && r.id !== exceptId
    }
    if (!taken(root) && !RESERVED_HANDLES.has(root)) return root
    for (let i = 2; i < 1000; i++) if (!taken(`${root}${i}`)) return `${root}${i}`
    return `${root}${randomBytes(2).toString('hex')}`
  }

  private insertMember(m: { companyId: string; kind: ForumMember['kind']; role: ForumRole; agentId?: string | null; handle: string; name: string; status?: ForumMember['status']; data?: ForumMember['data'] }): ForumMember {
    const id = forumId('fmb')
    const at = this.iso()
    this.db
      .prepare('INSERT INTO forum_members(id,company_id,kind,role,agent_id,handle,name,status,created_at,updated_at,data) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, m.companyId, m.kind, m.role, m.agentId ?? null, m.handle, m.name, m.status ?? 'active', at, at, JSON.stringify(m.data ?? {}))
    return this.mustMember(id)
  }

  // ---------- auto-membership (§1.2) ----------

  /**
   * Idempotent: the owner, #general, #proposals, one channel per active department, one member per agent seat, and
   * the auto-joins. Cheap when nothing changed (a handful of indexed reads).
   */
  sync(companyId: string): void {
    if (!this.d.directory.hasCompany(companyId)) notFound('Company')
    const changed = this.db.transaction(() => {
      let dirty = false
      const at = this.iso()
      // 1. owner
      let owner = this.db.prepare("SELECT * FROM forum_members WHERE company_id=? AND role='owner' LIMIT 1").get(companyId) as MemberRow | undefined
      if (!owner) {
        const name = this.d.directory.ownerName().trim() || 'You'
        this.insertMember({ companyId, kind: 'human', role: 'owner', handle: this.freeHandle(companyId, name), name })
        owner = this.db.prepare("SELECT * FROM forum_members WHERE company_id=? AND role='owner' LIMIT 1").get(companyId) as MemberRow
        dirty = true
      }
      // 2. system channels
      const general = this.ensureSystemChannel(companyId, 'general', 'general', 'Company-wide news and questions. Everyone is here.', owner.id)
      this.ensureSystemChannel(companyId, 'proposals', 'proposals', 'New departments and hires proposed by agents. Approve or reject here.', owner.id)
      // 3. departments
      const deps = this.d.directory.departments(companyId)
      const depChannel = new Map<string, string>()
      for (const dep of deps) {
        let row = this.db.prepare('SELECT * FROM forum_channels WHERE company_id=? AND department_id=? LIMIT 1').get(companyId, dep.id) as ChannelRow | undefined
        if (!row && !dep.archivedAt) {
          const name = this.freeChannelName(companyId, dep.key)
          const id = forumId('fch')
          this.db
            .prepare("INSERT INTO forum_channels(id,company_id,kind,name,topic,purpose,department_id,system,created_by,created_at,updated_at) VALUES (?,?,'public',?,'',?,?,'department',?,?,?)")
            .run(id, companyId, name, `${dep.name}: the department's room.`, dep.id, owner.id, at, at)
          this.joinRaw(id, owner.id, at)
          row = this.db.prepare('SELECT * FROM forum_channels WHERE id=?').get(id) as ChannelRow
          dirty = true
        }
        if (!row) continue
        if (dep.archivedAt && !row.archived_at) {
          this.db.prepare('UPDATE forum_channels SET archived_at=?, updated_at=? WHERE id=?').run(at, at, row.id)
          dirty = true
        } else if (!dep.archivedAt && row.archived_at) {
          this.db.prepare('UPDATE forum_channels SET archived_at=NULL, updated_at=? WHERE id=?').run(at, row.id)
          dirty = true
        }
        if (!dep.archivedAt) depChannel.set(dep.id, row.id)
      }
      // 4. agent seats
      const agents = this.d.directory.agents(companyId)
      for (const a of agents) {
        const display = (a.personaName ?? '').trim() || a.name
        let m = this.db.prepare('SELECT * FROM forum_members WHERE agent_id=?').get(a.id) as MemberRow | undefined
        if (!m) {
          if (a.archivedAt) continue
          this.insertMember({ companyId, kind: 'agent', role: 'agent', agentId: a.id, handle: this.freeHandle(companyId, display), name: display })
          m = this.db.prepare('SELECT * FROM forum_members WHERE agent_id=?').get(a.id) as MemberRow
          dirty = true
        }
        const status = a.archivedAt ? 'removed' : 'active'
        if (m.status !== status || m.name !== display) {
          // a renamed persona takes the new handle only when it is free (old mentions keep the member id)
          const handle = m.name !== display ? this.freeHandle(companyId, display, m.id) : m.handle
          this.db.prepare('UPDATE forum_members SET status=?, name=?, handle=?, updated_at=? WHERE id=?').run(status, display, handle, at, m.id)
          dirty = true
        }
        if (status !== 'active') continue
        if (this.joinRaw(general.id, m.id, at)) dirty = true
        const dc = a.departmentId ? depChannel.get(a.departmentId) : undefined
        if (dc && this.joinRaw(dc, m.id, at)) dirty = true
      }
      // every active human and agent is in #general (guests never)
      const others = this.db.prepare("SELECT id FROM forum_members WHERE company_id=? AND status='active' AND kind!='guest'").all(companyId) as { id: string }[]
      for (const o of others) if (this.joinRaw(general.id, o.id, at)) dirty = true
      return dirty
    })()
    if (changed) this.emit({ kind: 'members', companyId })
  }

  private ensureSystemChannel(companyId: string, system: ForumChannelSystem, name: string, purpose: string, ownerId: string): ChannelRow {
    const row = this.db.prepare('SELECT * FROM forum_channels WHERE company_id=? AND system=? LIMIT 1').get(companyId, system) as ChannelRow | undefined
    if (row) return row
    const id = forumId('fch')
    const at = this.iso()
    this.db
      .prepare("INSERT INTO forum_channels(id,company_id,kind,name,topic,purpose,system,created_by,created_at,updated_at) VALUES (?,?,'public',?,'',?,?,?,?,?)")
      .run(id, companyId, this.freeChannelName(companyId, name), purpose, system, ownerId, at, at)
    this.joinRaw(id, ownerId, at)
    return this.db.prepare('SELECT * FROM forum_channels WHERE id=?').get(id) as ChannelRow
  }

  private freeChannelName(companyId: string, base: string): string {
    const root = channelSlug(base) || 'channel'
    const taken = (n: string) => !!this.db.prepare('SELECT 1 FROM forum_channels WHERE company_id=? AND name=?').get(companyId, n)
    if (!taken(root)) return root
    for (let i = 2; i < 1000; i++) if (!taken(`${root}-${i}`.slice(0, 40))) return `${root}-${i}`.slice(0, 40)
    return `${root.slice(0, 33)}-${randomBytes(3).toString('hex')}`
  }

  /** Adds a membership; true when it was new. Read state starts at the channel's current end (no backlog of unread). */
  private joinRaw(channelId: string, memberId: string, at: string): boolean {
    const last = (this.db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM forum_messages WHERE channel_id=?').get(channelId) as { s: number }).s
    return this.db.prepare('INSERT OR IGNORE INTO forum_channel_members(channel_id,member_id,joined_at,last_read_seq) VALUES (?,?,?,?)').run(channelId, memberId, at, last).changes > 0
  }

  // ---------- channels ----------

  private channelRow(id: string): ChannelRow {
    return (this.db.prepare('SELECT * FROM forum_channels WHERE id=?').get(id) as ChannelRow | undefined) ?? notFound('Channel')
  }
  isMember(channelId: string, memberId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM forum_channel_members WHERE channel_id=? AND member_id=?').get(channelId, memberId)
  }
  channelMemberIds(channelId: string): string[] {
    return (this.db.prepare('SELECT member_id FROM forum_channel_members WHERE channel_id=? ORDER BY joined_at').all(channelId) as { member_id: string }[]).map((r) => r.member_id)
  }
  private like(r: ChannelRow): policy.ChannelLike {
    return { id: r.id, companyId: r.company_id, kind: r.kind as ForumChannelKind, system: r.system as ForumChannelSystem | null, archivedAt: r.archived_at, createdBy: r.created_by }
  }

  /** One channel as `viewer` sees it (counts for the viewer). */
  channel(id: string, viewerId?: string): ForumChannel {
    const r = this.channelRow(id)
    const memberIds = this.channelMemberIds(id)
    const viewer = viewerId ? (this.db.prepare('SELECT last_read_seq FROM forum_channel_members WHERE channel_id=? AND member_id=?').get(id, viewerId) as { last_read_seq: number } | undefined) : undefined
    const last = this.db.prepare('SELECT seq, created_at FROM forum_messages WHERE channel_id=? AND thread_seq IS NULL ORDER BY seq DESC LIMIT 1').get(id) as { seq: number; created_at: string } | undefined
    const lastReadSeq = viewer?.last_read_seq ?? 0
    const unread = viewer && viewerId
      ? (this.db.prepare('SELECT COUNT(*) AS n FROM forum_messages WHERE channel_id=? AND thread_seq IS NULL AND seq>? AND author_id!=? AND deleted_at IS NULL').get(id, lastReadSeq, viewerId) as { n: number }).n
      : 0
    const mentions = viewerId
      ? (this.db.prepare('SELECT COUNT(*) AS n FROM forum_mentions x JOIN forum_messages m ON m.seq=x.seq WHERE x.member_id=? AND x.read_at IS NULL AND m.channel_id=? AND m.deleted_at IS NULL').get(viewerId, id) as { n: number }).n
      : 0
    return {
      id: r.id,
      companyId: r.company_id,
      kind: r.kind as ForumChannelKind,
      name: r.name,
      topic: r.topic,
      purpose: r.purpose,
      departmentId: r.department_id,
      system: r.system as ForumChannelSystem | null,
      createdBy: r.created_by,
      createdAt: r.created_at,
      archivedAt: r.archived_at,
      memberIds,
      lastSeq: last?.seq ?? 0,
      lastMessageAt: last?.created_at ?? null,
      joined: !!viewer,
      lastReadSeq,
      unread,
      mentions
    }
  }

  /** Channels `viewer` can read (public ones even when not joined; DMs only their own). */
  channels(companyId: string, viewerId: string): ForumChannel[] {
    const viewer = this.mustMember(viewerId)
    const rows = this.db.prepare('SELECT * FROM forum_channels WHERE company_id=? ORDER BY system IS NULL, name, created_at').all(companyId) as ChannelRow[]
    const out: ForumChannel[] = []
    for (const r of rows) {
      const joined = this.isMember(r.id, viewerId)
      if (!policy.canRead(memberLike(viewer), this.like(r), joined).ok) continue
      out.push(this.channel(r.id, viewerId))
    }
    return out
  }

  channelByName(companyId: string, name: string): ForumChannel | null {
    const r = this.db.prepare('SELECT id FROM forum_channels WHERE company_id=? AND name=?').get(companyId, name.replace(/^#/, '').toLowerCase()) as { id: string } | undefined
    return r ? this.channel(r.id) : null
  }

  createChannel(byId: string, input: { name: string; kind: 'public' | 'private'; purpose?: string; topic?: string; memberIds?: string[]; data?: Record<string, unknown> }): ForumChannel {
    const by = this.mustMember(byId)
    const v = policy.canCreateChannel(memberLike(by), input.kind)
    if (!v.ok) fail(v.reason)
    const name = channelSlug(input.name)
    if (!CHANNEL_NAME_RE.test(name)) fail('Channel names are 2-40 lowercase letters, digits or dashes')
    if (this.db.prepare('SELECT 1 FROM forum_channels WHERE company_id=? AND name=?').get(by.companyId, name)) fail(`#${name} already exists`)
    const id = forumId('fch')
    const at = this.iso()
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO forum_channels(id,company_id,kind,name,topic,purpose,created_by,created_at,updated_at,data) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, by.companyId, input.kind, name, this.redact((input.topic ?? '').trim()).slice(0, 250), this.redact((input.purpose ?? '').trim()).slice(0, 300), by.id, at, at, JSON.stringify(input.data ?? {}))
      this.joinRaw(id, by.id, at)
      for (const mid of input.memberIds ?? []) {
        const m = this.member(mid)
        if (!m || m.companyId !== by.companyId || m.status !== 'active') continue
        if (m.kind === 'guest' && by.kind === 'agent') continue
        this.joinRaw(id, m.id, at)
      }
    })()
    const c = this.channel(id, byId)
    this.emit({ kind: 'channel', companyId: by.companyId, channel: c, channelId: id })
    this.systemPost(id, `${by.name} created #${name}${input.purpose?.trim() ? `: ${clip(input.purpose.trim(), 200)}` : ''}`)
    return this.channel(id, byId)
  }

  updateChannel(byId: string, id: string, patch: { topic?: string; purpose?: string; archived?: boolean }): ForumChannel {
    const by = this.mustMember(byId)
    const r = this.channelRow(id)
    if (r.company_id !== by.companyId) notFound('Channel')
    const action = patch.archived !== undefined ? 'archive' : 'edit'
    const v = policy.canManageChannel(memberLike(by), this.like(r), action)
    if (!v.ok) fail(v.reason)
    const at = this.iso()
    if (patch.topic !== undefined) this.db.prepare('UPDATE forum_channels SET topic=?, updated_at=? WHERE id=?').run(this.redact(patch.topic.trim()).slice(0, 250), at, id)
    if (patch.purpose !== undefined) this.db.prepare('UPDATE forum_channels SET purpose=?, updated_at=? WHERE id=?').run(this.redact(patch.purpose.trim()).slice(0, 300), at, id)
    if (patch.archived !== undefined) this.db.prepare('UPDATE forum_channels SET archived_at=?, updated_at=? WHERE id=?').run(patch.archived ? at : null, at, id)
    if (patch.topic !== undefined) this.systemPost(id, `${by.name} set the topic: ${clip(patch.topic.trim(), 200) || '(cleared)'}`)
    const c = this.channel(id, byId)
    this.emit({ kind: 'channel', companyId: by.companyId, channel: c, channelId: id })
    return c
  }

  join(memberId: string, channelId: string): ForumChannel {
    const m = this.mustMember(memberId)
    const r = this.channelRow(channelId)
    const v = policy.canRead(memberLike(m), this.like(r), this.isMember(channelId, memberId))
    if (!v.ok) fail(v.reason)
    if (this.joinRaw(channelId, memberId, this.iso())) {
      this.emit({ kind: 'channel', companyId: r.company_id, channel: this.channel(channelId), channelId })
      this.systemPost(channelId, `${m.name} joined #${r.name ?? 'conversation'}`)
    }
    return this.channel(channelId, memberId)
  }

  leave(memberId: string, channelId: string): void {
    const m = this.mustMember(memberId)
    const r = this.channelRow(channelId)
    if (r.system === 'general') fail('Everyone stays in #general')
    if (r.kind === 'dm') fail('You cannot leave a direct message')
    if (this.db.prepare('DELETE FROM forum_channel_members WHERE channel_id=? AND member_id=?').run(channelId, memberId).changes) {
      this.emit({ kind: 'channel', companyId: r.company_id, channel: this.channel(channelId), channelId })
      if (r.name) this.systemPost(channelId, `${m.name} left #${r.name}`)
    }
  }

  addMembers(byId: string, channelId: string, memberIds: string[]): ForumChannel {
    const by = this.mustMember(byId)
    const r = this.channelRow(channelId)
    if (r.company_id !== by.companyId) notFound('Channel')
    const v = policy.canAddMembers(memberLike(by), this.like(r), this.isMember(channelId, byId))
    if (!v.ok) fail(v.reason)
    const added: string[] = []
    const at = this.iso()
    for (const id of memberIds) {
      const m = this.member(id)
      if (!m || m.companyId !== by.companyId || m.status !== 'active') continue
      if (this.joinRaw(channelId, m.id, at)) added.push(m.name)
    }
    if (added.length) {
      this.emit({ kind: 'channel', companyId: r.company_id, channel: this.channel(channelId), channelId })
      this.systemPost(channelId, `${by.name} added ${added.join(', ')}`)
    }
    return this.channel(channelId, byId)
  }

  /** The DM (2 members) or group DM (3-9) of these members, created on first use. */
  openDm(byId: string, otherIds: string[]): ForumChannel {
    const by = this.mustMember(byId)
    const ids = [...new Set([by.id, ...otherIds])]
    if (ids.length < 2) fail('Pick someone to message')
    if (ids.length > 9) fail('Group messages hold up to 9 people')
    for (const id of ids) {
      if (id === by.id) continue
      const m = this.member(id) ?? notFound('Member')
      const share = this.shareChannel(by.id, m.id)
      const v = policy.canDm(memberLike(by), memberLike(m), share)
      if (!v.ok) fail(v.reason)
    }
    const key = [...ids].sort().join(',')
    const existing = this.db.prepare('SELECT id FROM forum_channels WHERE company_id=? AND dm_key=?').get(by.companyId, key) as { id: string } | undefined
    if (existing) return this.channel(existing.id, byId)
    const id = forumId('fch')
    const at = this.iso()
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO forum_channels(id,company_id,kind,name,dm_key,created_by,created_at,updated_at) VALUES (?,?,?,NULL,?,?,?,?)').run(id, by.companyId, ids.length === 2 ? 'dm' : 'group', key, by.id, at, at)
      for (const mid of ids) this.joinRaw(id, mid, at)
    })()
    const c = this.channel(id, byId)
    this.emit({ kind: 'channel', companyId: by.companyId, channel: c, channelId: id })
    return c
  }

  private shareChannel(a: string, b: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM forum_channel_members x JOIN forum_channel_members y ON x.channel_id=y.channel_id WHERE x.member_id=? AND y.member_id=? LIMIT 1').get(a, b)
  }

  // ---------- messages ----------

  private messageRow(idOrSeq: string | number): MessageRow {
    const r = typeof idOrSeq === 'number'
      ? this.db.prepare('SELECT * FROM forum_messages WHERE seq=?').get(idOrSeq)
      : this.db.prepare('SELECT * FROM forum_messages WHERE id=?').get(idOrSeq)
    return (r as MessageRow | undefined) ?? notFound('Message')
  }
  message(idOrSeq: string | number): ForumMessage {
    return this.toMessage(this.messageRow(idOrSeq))
  }

  /** Posts as `byId`. Checks permission, auto-joins public channels, resolves mentions and refs, updates thread counters. */
  post(byId: string, input: PostInput): ForumMessage {
    const by = this.mustMember(byId)
    if (input.opKey) {
      const prev = this.db.prepare("SELECT seq FROM forum_messages WHERE company_id=? AND json_extract(data,'$.opKey')=?").get(by.companyId, input.opKey) as { seq: number } | undefined
      if (prev) return this.message(prev.seq)
    }
    const r = this.channelRow(input.channelId)
    if (r.company_id !== by.companyId) notFound('Channel')
    const joined = this.isMember(r.id, by.id)
    const v = policy.canPost(memberLike(by), this.like(r), joined)
    if (!v.ok) fail(v.reason)
    const max = by.kind === 'agent' ? FORUM_LIMITS.agentText : FORUM_LIMITS.humanText
    const raw = input.text.trim()
    if (!raw) fail('The message is empty')
    if (raw.length > max) fail(`Messages are at most ${max} characters`)
    const text = this.redact(raw)
    let root: MessageRow | null = null
    if (input.threadId) {
      root = this.messageRow(/^\d+$/.test(input.threadId) ? Number(input.threadId) : input.threadId)
      if (root.channel_id !== r.id) fail('That thread is in another channel')
      if (root.thread_seq) root = this.messageRow(root.thread_seq) // one level deep: reply to the root
    }
    const parsed = parseText(text)
    if (parsed.broadcast && !policy.canBroadcast(memberLike(by))) fail('@here and @channel are for people, not agents')
    const mentions = new Set<string>()
    const mentionDepartments = new Set<string>()
    const deps = this.d.directory.departments(by.companyId).filter((d) => !d.archivedAt)
    const agents = this.d.directory.agents(by.companyId)
    for (const h of parsed.handles) {
      const m = this.memberByHandle(by.companyId, h)
      if (m && m.status === 'active') {
        if (m.id !== by.id) mentions.add(m.id)
        continue
      }
      const dep = deps.find((d) => d.key === h)
      if (dep) {
        mentionDepartments.add(dep.id)
        for (const a of agents) {
          if (a.departmentId !== dep.id || a.archivedAt) continue
          const am = this.memberForAgent(a.id)
          if (am && am.id !== by.id && am.status === 'active') mentions.add(am.id)
        }
      }
    }
    if (parsed.broadcast) for (const id of this.channelMemberIds(r.id)) if (id !== by.id) mentions.add(id)
    if (mentions.size > FORUM_LIMITS.mentionsPerMessage && by.kind === 'agent') fail(`Mention at most ${FORUM_LIMITS.mentionsPerMessage} members in one message`)
    if (input.ask) for (const id of input.ask.to) if (id !== by.id) mentions.add(id)
    const refs = [...parsed.refs]
    for (const s of input.refs ?? []) {
      const ref = parseRefArg(s)
      if (!ref) continue
      if ('message' in ref) parsed.messageRefs.push(ref.message)
      else if (!refs.some((x) => x.kind === ref.kind && x.id === ref.id)) refs.push(ref)
    }
    for (const mr of [...new Set(parsed.messageRefs)].slice(0, 6)) {
      const seq = parseInt(mr.slice(1), 36)
      const target = Number.isSafeInteger(seq) ? (this.db.prepare('SELECT seq FROM forum_messages WHERE seq=? AND company_id=?').get(seq, by.companyId) as { seq: number } | undefined) : undefined
      if (target) refs.push({ kind: 'message', id: mr, label: mr })
    }
    const id = forumId('fmsg')
    const at = this.iso()
    const data: MessageData = {
      ...(mentions.size ? { mentions: [...mentions] } : {}),
      ...(mentionDepartments.size ? { mentionDepartments: [...mentionDepartments] } : {}),
      ...(refs.length ? { refs: refs.slice(0, 12) } : {}),
      ...(input.ask ? { ask: input.ask } : {}),
      ...(input.proposal ? { proposal: input.proposal } : {}),
      ...(input.opKey ? { opKey: input.opKey } : {})
    }
    const seq = this.db.transaction(() => {
      // posting in a public channel joins it (agents and humans alike)
      if (!joined) this.joinRaw(r.id, by.id, at)
      const info = this.db
        .prepare('INSERT INTO forum_messages(id,company_id,channel_id,thread_seq,author_id,kind,text,created_at,origin,data) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, by.companyId, r.id, root?.seq ?? null, by.id, input.kind ?? 'text', text, at, input.origin ?? 'local', JSON.stringify(data))
      const seq = Number(info.lastInsertRowid)
      for (const mid of mentions) this.db.prepare('INSERT OR IGNORE INTO forum_mentions(seq,member_id,company_id) VALUES (?,?,?)').run(seq, mid, by.companyId)
      if (root) {
        const rd = parseJson<MessageData>(root.data, {})
        const repliers = [...new Set([...(rd.repliers ?? []), by.id])].slice(-5)
        this.db.prepare("UPDATE forum_messages SET reply_count=reply_count+1, last_reply_at=?, data=json_set(data,'$.repliers',json(?)) WHERE seq=?").run(at, JSON.stringify(repliers), root.seq)
      }
      // the author has read everything up to their own message
      this.db.prepare('UPDATE forum_channel_members SET last_read_seq=MAX(last_read_seq,?) WHERE channel_id=? AND member_id=?').run(root ? 0 : seq, r.id, by.id)
      this.db.prepare('UPDATE forum_channels SET updated_at=? WHERE id=?').run(at, r.id)
      return seq
    })()
    const msg = this.message(seq)
    this.emit({ kind: 'message', companyId: by.companyId, message: msg })
    if (root) this.emit({ kind: 'message', companyId: by.companyId, message: this.message(root.seq) })
    if (!joined) this.emit({ kind: 'channel', companyId: by.companyId, channel: this.channel(r.id), channelId: r.id })
    return msg
  }

  /** A system line ("Marcus joined #growth") authored by the company owner, kind 'system'. */
  systemPost(channelId: string, text: string, threadSeq?: number): ForumMessage | null {
    const r = this.channelRow(channelId)
    const owner = this.db.prepare("SELECT id FROM forum_members WHERE company_id=? AND role='owner' LIMIT 1").get(r.company_id) as { id: string } | undefined
    if (!owner) return null
    const id = forumId('fmsg')
    const at = this.iso()
    const info = this.db
      .prepare("INSERT INTO forum_messages(id,company_id,channel_id,thread_seq,author_id,kind,text,created_at,origin,data) VALUES (?,?,?,?,?,'system',?,?,'local','{}')")
      .run(id, r.company_id, r.id, threadSeq ?? null, owner.id, this.redact(text).slice(0, 1000), at)
    const msg = this.message(Number(info.lastInsertRowid))
    this.emit({ kind: 'message', companyId: r.company_id, message: msg })
    return msg
  }

  /** Top-level messages of a channel, oldest first: the page ending before `beforeSeq` (default: the newest). */
  messages(channelId: string, opts: { beforeSeq?: number; afterSeq?: number; limit?: number } = {}): ForumMessage[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
    let rows: MessageRow[]
    if (opts.afterSeq !== undefined) {
      rows = this.db.prepare('SELECT * FROM forum_messages WHERE channel_id=? AND thread_seq IS NULL AND seq>? ORDER BY seq LIMIT ?').all(channelId, opts.afterSeq, limit) as MessageRow[]
    } else {
      rows = (this.db.prepare('SELECT * FROM forum_messages WHERE channel_id=? AND thread_seq IS NULL AND seq<? ORDER BY seq DESC LIMIT ?').all(channelId, opts.beforeSeq ?? Number.MAX_SAFE_INTEGER, limit) as MessageRow[]).reverse()
    }
    return rows.map((r) => this.toMessage(r))
  }

  /** A thread: its root and replies (oldest first). */
  thread(rootIdOrSeq: string | number, limit = 200): { root: ForumMessage; replies: ForumMessage[] } {
    let root = this.messageRow(rootIdOrSeq)
    if (root.thread_seq) root = this.messageRow(root.thread_seq)
    const replies = this.db.prepare('SELECT * FROM forum_messages WHERE thread_seq=? ORDER BY seq LIMIT ?').all(root.seq, Math.min(Math.max(limit, 1), 500)) as MessageRow[]
    return { root: this.toMessage(root), replies: replies.map((r) => this.toMessage(r)) }
  }

  /** Readable by `viewer`? (channel membership or public channel) */
  assertCanRead(viewerId: string, channelId: string): void {
    const m = this.mustMember(viewerId)
    const r = this.channelRow(channelId)
    const v = policy.canRead(memberLike(m), this.like(r), this.isMember(channelId, viewerId))
    if (!v.ok) fail(v.reason)
  }

  edit(byId: string, messageId: string, text: string | null): ForumMessage {
    const by = this.mustMember(byId)
    const r = this.messageRow(messageId)
    if (r.company_id !== by.companyId) notFound('Message')
    const admin = by.role === 'owner' || by.role === 'admin'
    if (r.author_id !== by.id && !(text === null && admin)) fail('You can only edit your own messages')
    if (r.kind === 'system') fail('System lines cannot be changed')
    const at = this.iso()
    if (text === null) this.db.prepare("UPDATE forum_messages SET deleted_at=?, text='' WHERE seq=?").run(at, r.seq)
    else {
      const t = text.trim()
      if (!t) fail('The message is empty')
      if (t.length > (by.kind === 'agent' ? FORUM_LIMITS.agentText : FORUM_LIMITS.humanText)) fail('That message is too long')
      this.db.prepare('UPDATE forum_messages SET text=?, edited_at=? WHERE seq=?').run(this.redact(t), at, r.seq)
    }
    const msg = this.message(r.seq)
    this.emit({ kind: 'message', companyId: r.company_id, message: msg })
    return msg
  }

  react(byId: string, messageId: string, emoji: string): ForumMessage {
    const by = this.mustMember(byId)
    const r = this.messageRow(messageId)
    if (r.company_id !== by.companyId) notFound('Message')
    this.assertCanRead(byId, r.channel_id)
    const e = emoji.trim()
    if (!e || e.length > 16 || /\s/.test(e)) fail('Pick one emoji')
    const d = parseJson<MessageData>(r.data, {})
    const reactions = { ...(d.reactions ?? {}) }
    const who = new Set(reactions[e] ?? [])
    if (who.has(by.id)) who.delete(by.id)
    else {
      if (!reactions[e] && Object.keys(reactions).length >= FORUM_LIMITS.reactionKinds) fail('Too many different reactions on this message')
      who.add(by.id)
    }
    if (who.size) reactions[e] = [...who]
    else delete reactions[e]
    this.db.prepare("UPDATE forum_messages SET data=json_set(data,'$.reactions',json(?)) WHERE seq=?").run(JSON.stringify(reactions), r.seq)
    const msg = this.message(r.seq)
    this.emit({ kind: 'message', companyId: r.company_id, message: msg })
    return msg
  }

  /** Replaces the ask / proposal payload of a message (service-side state changes). */
  patchPayload(messageId: string, patch: { ask?: ForumAsk; proposal?: ForumProposal }): ForumMessage {
    const r = this.messageRow(messageId)
    if (patch.ask) this.db.prepare("UPDATE forum_messages SET data=json_set(data,'$.ask',json(?)) WHERE seq=?").run(JSON.stringify(patch.ask), r.seq)
    if (patch.proposal) this.db.prepare("UPDATE forum_messages SET data=json_set(data,'$.proposal',json(?)) WHERE seq=?").run(JSON.stringify(patch.proposal), r.seq)
    const msg = this.message(r.seq)
    this.emit({ kind: 'message', companyId: r.company_id, message: msg })
    return msg
  }

  /** Read up to `seq` in a channel (never moves back) and clears the member's mentions there up to it. */
  markRead(memberId: string, channelId: string, seq?: number): number {
    const m = this.mustMember(memberId)
    const r = this.channelRow(channelId)
    if (r.company_id !== m.companyId) notFound('Channel')
    const upTo = seq ?? (this.db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM forum_messages WHERE channel_id=?').get(channelId) as { s: number }).s
    const at = this.iso()
    this.db.prepare('UPDATE forum_channel_members SET last_read_seq=MAX(last_read_seq,?) WHERE channel_id=? AND member_id=?').run(upTo, channelId, memberId)
    this.db
      .prepare('UPDATE forum_mentions SET read_at=? WHERE member_id=? AND read_at IS NULL AND seq<=? AND seq IN (SELECT seq FROM forum_messages WHERE channel_id=?)')
      .run(at, memberId, upTo, channelId)
    this.emit({ kind: 'read', companyId: r.company_id, channelId, seq: upTo })
    return upTo
  }

  /** Clears the member's mentions in one thread (opening it). */
  markThreadRead(memberId: string, rootSeq: number): void {
    this.db.prepare('UPDATE forum_mentions SET read_at=? WHERE member_id=? AND read_at IS NULL AND seq IN (SELECT seq FROM forum_messages WHERE seq=? OR thread_seq=?)').run(this.iso(), memberId, rootSeq, rootSeq)
  }

  /** Unread mentions of a member, newest last (agent brief, digest). */
  unreadMentions(memberId: string, limit = 20): ForumMessage[] {
    const rows = this.db
      .prepare('SELECT m.* FROM forum_mentions x JOIN forum_messages m ON m.seq=x.seq WHERE x.member_id=? AND x.read_at IS NULL AND m.deleted_at IS NULL ORDER BY m.seq DESC LIMIT ?')
      .all(memberId, limit) as MessageRow[]
    return rows.reverse().map((r) => this.toMessage(r))
  }
  markMentionsRead(memberId: string, seqs: number[]): void {
    const st = this.db.prepare('UPDATE forum_mentions SET read_at=? WHERE member_id=? AND seq=? AND read_at IS NULL')
    const at = this.iso()
    for (const s of seqs) st.run(at, memberId, s)
  }

  /** Messages in threads the member started or replied to, after `afterSeq`, in a channel. */
  threadActivity(memberId: string, channelId: string, afterSeq: number, limit = 20): ForumMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM forum_messages m WHERE m.channel_id=? AND m.thread_seq IS NOT NULL AND m.seq>? AND m.author_id!=? AND m.deleted_at IS NULL
         AND m.thread_seq IN (SELECT seq FROM forum_messages WHERE author_id=? AND channel_id=? AND thread_seq IS NULL
                              UNION SELECT thread_seq FROM forum_messages WHERE author_id=? AND channel_id=? AND thread_seq IS NOT NULL)
         ORDER BY m.seq LIMIT ?`
      )
      .all(channelId, afterSeq, memberId, memberId, channelId, memberId, channelId, limit) as MessageRow[]
    return rows.map((r) => this.toMessage(r))
  }

  /** Full-text-ish search over what `viewer` can read: `in:#chan`, `from:@who`, `is:ask|proposal` filters. */
  search(companyId: string, viewerId: string, query: string, limit = 40): ForumMessage[] {
    const viewer = this.mustMember(viewerId)
    let q = query.trim()
    const where: string[] = ['m.company_id=?', 'm.deleted_at IS NULL', "m.kind!='system'"]
    const params: unknown[] = [companyId]
    q = q.replace(/\bin:#?([a-z0-9-]+)/gi, (_, n: string) => {
      where.push('m.channel_id=(SELECT id FROM forum_channels WHERE company_id=? AND name=?)')
      params.push(companyId, n.toLowerCase())
      return ' '
    })
    q = q.replace(/\bfrom:@?([a-z0-9._-]+)/gi, (_, n: string) => {
      where.push('m.author_id=(SELECT id FROM forum_members WHERE company_id=? AND handle=?)')
      params.push(companyId, n.toLowerCase())
      return ' '
    })
    q = q.replace(/\bis:(ask|proposal)\b/gi, (_, k: string) => {
      where.push('m.kind=?')
      params.push(k.toLowerCase())
      return ' '
    })
    for (const word of q.split(/\s+/).filter(Boolean).slice(0, 6)) {
      where.push("m.text LIKE ? ESCAPE '\\'")
      params.push(`%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    }
    if (where.length <= 3) return []
    const rows = this.db.prepare(`SELECT m.* FROM forum_messages m WHERE ${where.join(' AND ')} ORDER BY m.seq DESC LIMIT ?`).all(...params, Math.min(limit * 3, 300)) as MessageRow[]
    const out: ForumMessage[] = []
    const readable = new Map<string, boolean>()
    for (const r of rows) {
      let ok = readable.get(r.channel_id)
      if (ok === undefined) {
        ok = policy.canRead(memberLike(viewer), this.like(this.channelRow(r.channel_id)), this.isMember(r.channel_id, viewerId)).ok
        readable.set(r.channel_id, ok)
      }
      if (ok) out.push(this.toMessage(r))
      if (out.length >= limit) break
    }
    return out
  }

  /** Posts by an agent member since `since` (rate limits). */
  countPosts(memberId: string, sinceIso: string, origin?: string): number {
    if (origin) return (this.db.prepare("SELECT COUNT(*) AS n FROM forum_messages WHERE author_id=? AND created_at>=? AND origin=? AND kind!='system'").get(memberId, sinceIso, origin) as { n: number }).n
    return (this.db.prepare("SELECT COUNT(*) AS n FROM forum_messages WHERE author_id=? AND created_at>=? AND kind!='system'").get(memberId, sinceIso) as { n: number }).n
  }
  /** Channels created by agents of the company since `since`. */
  countAgentChannels(companyId: string, sinceIso: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM forum_channels c JOIN forum_members m ON m.id=c.created_by WHERE c.company_id=? AND m.kind='agent' AND c.created_at>=?").get(companyId, sinceIso) as { n: number }).n
  }
  countProposals(companyId: string, sinceIso: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM forum_messages WHERE company_id=? AND kind='proposal' AND created_at>=?").get(companyId, sinceIso) as { n: number }).n
  }
  openProposals(companyId: string, authorId?: string): ForumMessage[] {
    const rows = (authorId
      ? this.db.prepare("SELECT * FROM forum_messages WHERE company_id=? AND kind='proposal' AND author_id=? AND json_extract(data,'$.proposal.status')='open' ORDER BY seq").all(companyId, authorId)
      : this.db.prepare("SELECT * FROM forum_messages WHERE company_id=? AND kind='proposal' AND json_extract(data,'$.proposal.status')='open' ORDER BY seq").all(companyId)) as MessageRow[]
    return rows.map((r) => this.toMessage(r))
  }
  openAsks(companyId: string, authorId?: string): ForumMessage[] {
    const rows = (authorId
      ? this.db.prepare("SELECT * FROM forum_messages WHERE company_id=? AND kind='ask' AND author_id=? AND json_extract(data,'$.ask.status')='open' ORDER BY seq").all(companyId, authorId)
      : this.db.prepare("SELECT * FROM forum_messages WHERE company_id=? AND kind='ask' AND json_extract(data,'$.ask.status')='open' ORDER BY seq").all(companyId)) as MessageRow[]
    return rows.map((r) => this.toMessage(r))
  }
  /** Asks by this member answered after `sinceIso` (brief: "your asks were answered"). */
  answeredAsks(authorId: string, limit = 5): ForumMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM forum_messages WHERE author_id=? AND kind='ask' AND json_extract(data,'$.ask.status')='answered' ORDER BY json_extract(data,'$.ask.answeredAt') DESC LIMIT ?")
      .all(authorId, limit) as MessageRow[]
    return rows.map((r) => this.toMessage(r))
  }

  // ---------- invites (§2.2) ----------

  private inviteStatus(r: { expires_at: string | null; max_uses: number; uses: number; revoked_at: string | null }): ForumInvite['status'] {
    if (r.revoked_at) return 'revoked'
    if (r.uses >= r.max_uses) return 'used'
    if (r.expires_at && Date.parse(r.expires_at) <= this.now().getTime()) return 'expired'
    return 'active'
  }
  private toInvite(r: InviteRow): ForumInvite {
    return {
      id: r.id, companyId: r.company_id, role: r.role as ForumInviteRole, channelIds: parseJson<string[]>(r.channel_ids, []), label: r.label, codeHint: r.code_hint,
      createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at, maxUses: r.max_uses, uses: r.uses, revokedAt: r.revoked_at, status: this.inviteStatus(r)
    }
  }

  createInvite(byId: string, input: { role: ForumInviteRole; channelIds?: string[]; label?: string; expiresInDays?: number; maxUses?: number }): ForumInvite {
    const by = this.mustMember(byId)
    const v = policy.canInvite(memberLike(by), input.role)
    if (!v.ok) fail(v.reason)
    const channelIds = [...new Set(input.channelIds ?? [])]
    for (const id of channelIds) {
      const r = this.channelRow(id)
      if (r.company_id !== by.companyId) notFound('Channel')
      if (r.kind === 'dm' || r.kind === 'group') fail('Invite guests to channels, not to direct messages')
    }
    if (input.role === 'guest' && !channelIds.length) fail('Pick at least one channel for a guest')
    const code = newInviteCode()
    const id = forumId('finv')
    const at = this.iso()
    const days = input.expiresInDays ?? 7
    const expires = days > 0 ? new Date(this.now().getTime() + days * 86_400_000).toISOString() : null
    const maxUses = Math.min(Math.max(input.maxUses ?? 1, 1), 100)
    this.db
      .prepare('INSERT INTO forum_invites(id,company_id,code_hash,code_hint,role,channel_ids,label,created_by,created_at,expires_at,max_uses) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, by.companyId, hashCode(code), code.slice(-4), input.role, JSON.stringify(input.role === 'guest' ? channelIds : []), this.redact((input.label ?? '').trim()).slice(0, 120), by.id, at, expires, maxUses)
    return { ...this.toInvite(this.db.prepare('SELECT * FROM forum_invites WHERE id=?').get(id) as InviteRow), code, link: `principia://forum/join/${code}` }
  }

  invites(companyId: string, viewerId: string): ForumInvite[] {
    const v = this.mustMember(viewerId)
    if (v.companyId !== companyId || (v.role !== 'owner' && v.role !== 'admin')) return []
    return (this.db.prepare('SELECT * FROM forum_invites WHERE company_id=? ORDER BY created_at DESC LIMIT 200').all(companyId) as InviteRow[]).map((r) => this.toInvite(r))
  }

  revokeInvite(byId: string, inviteId: string): ForumInvite {
    const by = this.mustMember(byId)
    const r = (this.db.prepare('SELECT * FROM forum_invites WHERE id=?').get(inviteId) as InviteRow | undefined) ?? notFound('Invite')
    if (r.company_id !== by.companyId) notFound('Invite')
    if (by.role !== 'owner' && !(by.role === 'admin' && r.role !== 'admin')) fail('Only the owner and admins revoke invites')
    this.db.prepare('UPDATE forum_invites SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(this.iso(), inviteId)
    return this.toInvite(this.db.prepare('SELECT * FROM forum_invites WHERE id=?').get(inviteId) as InviteRow)
  }

  /** Redeems a code (hash, expiry, uses, revocation, one transaction) and creates the member. */
  acceptInvite(input: { code: string; name: string; handle?: string; email?: string }): ForumMember {
    const code = normalizeInviteCode(input.code)
    const name = input.name.trim().slice(0, 60)
    if (!name) fail('Your name is empty')
    const member = this.db.transaction(() => {
      const r = this.db.prepare('SELECT * FROM forum_invites WHERE code_hash=?').get(hashCode(code)) as InviteRow | undefined
      if (!r) fail('That invite code is not valid')
      const status = this.inviteStatus(r!)
      if (status !== 'active') fail(`That invite is ${status}`)
      const handle = input.handle?.trim() ? handleSlug(input.handle) : handleSlug(name)
      if (!HANDLE_RE.test(handle)) fail('Handles are lowercase letters, digits, dots, dashes or underscores')
      if (this.memberByHandle(r!.company_id, handle) || RESERVED_HANDLES.has(handle)) fail(`@${handle} is taken; pick another handle`)
      const m = this.insertMember({
        companyId: r!.company_id, kind: r!.role === 'guest' ? 'guest' : 'human', role: r!.role as ForumRole, handle, name,
        data: { inviteId: r!.id, ...(input.email ? { email: input.email.slice(0, 200) } : {}) }
      })
      this.db.prepare('UPDATE forum_invites SET uses=uses+1 WHERE id=?').run(r!.id)
      const at = this.iso()
      if (r!.role === 'guest') for (const cid of parseJson<string[]>(r!.channel_ids, [])) this.joinRaw(cid, m.id, at)
      return m
    })()
    this.sync(member.companyId)
    this.emit({ kind: 'members', companyId: member.companyId })
    const general = this.db.prepare("SELECT id FROM forum_channels WHERE company_id=? AND system='general'").get(member.companyId) as { id: string } | undefined
    if (general && member.kind !== 'guest') this.systemPost(general.id, `${member.name} joined the Forum as ${member.role}`)
    return member
  }

  removeMember(byId: string, memberId: string): ForumMember {
    const by = this.mustMember(byId)
    const target = this.mustMember(memberId)
    if (target.companyId !== by.companyId) notFound('Member')
    const v = policy.canRemoveMember(memberLike(by), memberLike(target))
    if (!v.ok) fail(v.reason)
    this.db.transaction(() => {
      this.db.prepare("UPDATE forum_members SET status='removed', updated_at=? WHERE id=?").run(this.iso(), memberId)
      this.db.prepare('DELETE FROM forum_channel_members WHERE member_id=?').run(memberId)
    })()
    this.emit({ kind: 'members', companyId: target.companyId })
    return this.mustMember(memberId)
  }
}

interface InviteRow { id: string; company_id: string; code_hash: string; code_hint: string; role: string; channel_ids: string; label: string; created_by: string; created_at: string; expires_at: string | null; max_uses: number; uses: number; revoked_at: string | null }

/** Handles that never belong to a member. */
const RESERVED_HANDLES = new Set(['here', 'channel', 'everyone', 'forum', 'principia', 'system', 'owner', 'admin', 'agents'])

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** PF-XXXX-XXXX: 40 random bits in Crockford base32. */
export function newInviteCode(): string {
  const bytes = randomBytes(5)
  let bits = 0n
  for (const b of bytes) bits = (bits << 8n) | BigInt(b)
  let s = ''
  for (let i = 0; i < 8; i++) {
    s = CROCKFORD[Number(bits & 31n)] + s
    bits >>= 5n
  }
  return `PF-${s.slice(0, 4)}-${s.slice(4)}`
}
/** Upper-case, Crockford aliases (O→0, I/L→1), dashes re-inserted; a link is accepted too. */
export function normalizeInviteCode(raw: string): string {
  const s = raw.trim().replace(/^principia:\/\/forum\/join\//i, '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  const body = s.startsWith('PF') ? s.slice(2) : s
  return `PF-${body.slice(0, 4)}-${body.slice(4, 8)}`
}
const hashCode = (code: string): string => createHash('sha256').update(`principia-forum:${code}`).digest('hex')

export function memberLike(m: ForumMember): policy.MemberLike {
  return { id: m.id, companyId: m.companyId, kind: m.kind, role: m.role, status: m.status }
}
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
