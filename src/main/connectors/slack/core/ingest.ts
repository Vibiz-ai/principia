/**
 * Event / history payload -> normalized rows (SLACK.md §6.3). Pure: no store, no network. The connector applies the
 * resulting action in one local write (ingest is sub-millisecond; unknown ids are resolved later in the background).
 */
import type { SlackChannelKind, SlackFile, SlackUser } from '../../../../shared/slack'
import { mentionsUser, mrkdwnToPlain, type Resolver } from './format'
import type { SlackChannelRow, SlackMessageRow, SlackWorkspace } from './ports'
import { idOf, type WireChannel, type WireEvent, type WireMessage, type WireUser } from './types'

/** Subtypes stored as normal messages (and the only ones that may trigger, besides none). */
export const CONTENT_SUBTYPES = new Set(['thread_broadcast', 'file_share', 'me_message', 'bot_message'])
export const TRIGGER_SUBTYPES = new Set(['thread_broadcast', 'file_share', 'me_message'])

export function kindFromChannelType(t: string | null | undefined, id?: string): SlackChannelKind {
  if (t === 'im') return 'dm'
  if (t === 'mpim') return 'group_dm'
  if (t === 'group' || t === 'private_channel') return 'private'
  if (t === 'channel' || t === 'public_channel') return 'channel'
  if (id?.startsWith('D')) return 'dm'
  if (id?.startsWith('G')) return 'private'
  return 'channel'
}

export function channelRow(c: WireChannel): SlackChannelRow {
  const kind: SlackChannelKind = c.is_im ? 'dm' : c.is_mpim ? 'group_dm' : c.is_private || c.is_group ? 'private' : 'channel'
  return {
    id: c.id,
    kind,
    name: kind === 'dm' ? (c.user ?? c.id) : (c.name ?? c.id),
    dmUserId: kind === 'dm' ? (c.user ?? null) : null,
    topic: c.topic?.value || null,
    purpose: c.purpose?.value || null,
    // DMs with the bot are always readable
    isMember: kind === 'dm' ? true : !!c.is_member,
    isArchived: !!c.is_archived,
    memberCount: c.num_members ?? null,
    lastMessageTs: null
  }
}

export function userFromWire(u: WireUser): SlackUser {
  return {
    id: u.id,
    name: u.name ?? u.id,
    realName: u.real_name || u.profile?.real_name || null,
    displayName: u.profile?.display_name || null,
    isBot: !!u.is_bot || u.id === 'USLACKBOT',
    deleted: !!u.deleted,
    avatarUrl: u.profile?.image_72 || u.profile?.image_48 || null,
    tz: u.tz ?? null,
    restricted: !!u.is_restricted,
    ultraRestricted: !!u.is_ultra_restricted,
    homeTeamId: u.team_id ?? null,
    enterpriseId: u.enterprise_user?.enterprise_id ?? null
  }
}

/** Best readable name: display name, real name, handle. */
export const userLabel = (u: SlackUser | null | undefined, fallback: string): string => u?.displayName || u?.realName || u?.name || fallback

const files = (m: WireMessage): SlackFile[] =>
  (m.files ?? []).map((f) => ({ name: f.name || f.title || 'file', mimetype: f.mimetype ?? null, size: f.size ?? null, permalink: f.permalink ?? null }))

export const hiveRefOf = (m: Pick<WireMessage, 'metadata'>): string | null => {
  if (m.metadata?.event_type !== 'hive_post') return null
  const id = m.metadata.event_payload?.outbox_id
  return typeof id === 'string' ? id : 'hive'
}

export function messageRow(m: WireMessage, channelId: string, r: Resolver): SlackMessageRow {
  const text = m.text ?? ''
  return {
    channelId,
    ts: m.ts,
    threadTs: m.thread_ts ?? null,
    userId: m.user ?? null,
    botId: m.bot_id ?? null,
    subtype: m.subtype ?? null,
    text,
    plain: mrkdwnToPlain(text, r),
    files: files(m),
    reactions: m.reactions ? m.reactions.map((x) => ({ name: x.name, count: x.count })) : null,
    replyCount: m.reply_count ?? null,
    latestReply: m.latest_reply ?? null,
    replyUsers: m.reply_users ?? null,
    editedTs: m.edited?.ts ?? null,
    hiveRef: hiveRefOf(m)
  }
}

export function isOwnMessage(m: { userId: string | null; botId: string | null; hiveRef: string | null }, ws: Pick<SlackWorkspace, 'botUserId' | 'botId'>): boolean {
  return (!!m.userId && m.userId === ws.botUserId) || (!!m.botId && m.botId === ws.botId) || !!m.hiveRef
}

export type IngestAction =
  | { kind: 'upsert'; channelId: string; channelType: string | null; row: SlackMessageRow; isMention: boolean; fromAppMention: boolean; userTeam: string | null }
  | { kind: 'changed'; channelId: string; row: SlackMessageRow }
  | { kind: 'deleted'; channelId: string; ts: string }
  | { kind: 'replied'; channelId: string; row: SlackMessageRow }
  | { kind: 'member'; channelId: string; userId: string; joined: boolean }
  | { kind: 'ignore'; reason: string }

/** One Events API `event` -> what to store (SLACK.md §6.3 table). */
export function classifyEvent(ev: WireEvent, ws: Pick<SlackWorkspace, 'botUserId' | 'botId'>, r: Resolver): IngestAction {
  const channelId = idOf(ev.channel)
  if (ev.type === 'member_joined_channel' || ev.type === 'member_left_channel') {
    const user = idOf(ev.user)
    if (!channelId || !user) return { kind: 'ignore', reason: 'member event without ids' }
    return { kind: 'member', channelId, userId: user, joined: ev.type === 'member_joined_channel' }
  }
  if (ev.type !== 'message' && ev.type !== 'app_mention') return { kind: 'ignore', reason: `event ${ev.type}` }
  if (!channelId) return { kind: 'ignore', reason: 'no channel' }
  const sub = ev.subtype ?? null
  if (sub === 'message_changed' && ev.message) {
    const row = messageRow({ ...ev.message, ts: ev.message.ts }, channelId, r)
    return { kind: 'changed', channelId, row: { ...row, subtype: ev.message.subtype ?? null } }
  }
  if (sub === 'message_deleted') {
    const ts = ev.deleted_ts ?? ev.previous_message?.ts
    return ts ? { kind: 'deleted', channelId, ts } : { kind: 'ignore', reason: 'delete without ts' }
  }
  if (sub === 'message_replied' && ev.message) return { kind: 'replied', channelId, row: messageRow(ev.message, channelId, r) }
  if (!ev.ts) return { kind: 'ignore', reason: 'no ts' }
  const wire: WireMessage = {
    type: 'message',
    subtype: sub,
    user: idOf(ev.user),
    bot_id: ev.bot_id ?? null,
    text: ev.text ?? '',
    ts: ev.ts,
    thread_ts: ev.thread_ts ?? null,
    files: (ev as { files?: WireMessage['files'] }).files ?? null,
    metadata: ev.metadata ?? null
  }
  const row = messageRow(wire, channelId, r)
  const isMention = ev.type === 'app_mention' || mentionsUser(row.text, ws.botUserId)
  return { kind: 'upsert', channelId, channelType: ev.channel_type ?? null, row, isMention, fromAppMention: ev.type === 'app_mention', userTeam: ev.user_team ?? null }
}
