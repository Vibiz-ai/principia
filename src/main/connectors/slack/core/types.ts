/**
 * Wire types for the Slack payloads Hive reads (subset), validated with zod (SLACK.md §4.3). Unknown fields pass
 * through; anything that does not parse is logged (redacted, 2 KB) and dropped.
 */
import { z } from 'zod'

const str = z.string()
const optStr = z.string().nullish()

export const fileSchema = z
  .object({
    id: optStr,
    name: optStr,
    title: optStr,
    mimetype: optStr,
    size: z.number().nullish(),
    permalink: optStr,
    url_private: optStr,
    url_private_download: optStr
  })
  .passthrough()
export const reactionSchema = z.object({ name: str, count: z.number().int().nonnegative() }).passthrough()

export const messageSchema = z
  .object({
    type: optStr,
    subtype: optStr,
    channel: optStr,
    channel_type: optStr,
    user: optStr,
    bot_id: optStr,
    text: z.string().nullish(),
    ts: str,
    thread_ts: optStr,
    event_ts: optStr,
    reply_count: z.number().int().nullish(),
    latest_reply: optStr,
    reply_users: z.array(str).nullish(),
    edited: z.object({ ts: optStr, user: optStr }).passthrough().nullish(),
    files: z.array(fileSchema).nullish(),
    reactions: z.array(reactionSchema).nullish(),
    metadata: z.object({ event_type: optStr, event_payload: z.record(z.string(), z.unknown()).nullish() }).passthrough().nullish(),
    bot_profile: z.object({ app_id: optStr }).passthrough().nullish(),
    app_id: optStr
  })
  .passthrough()
export type WireMessage = z.infer<typeof messageSchema>

export const eventSchema = z
  .object({
    type: str,
    subtype: optStr,
    channel: z.union([str, z.object({ id: str }).passthrough()]).nullish(),
    channel_type: optStr,
    user: z.union([str, z.object({ id: str }).passthrough()]).nullish(),
    bot_id: optStr,
    text: z.string().nullish(),
    ts: optStr,
    thread_ts: optStr,
    event_ts: optStr,
    message: messageSchema.nullish(),
    previous_message: messageSchema.nullish(),
    deleted_ts: optStr,
    hidden: z.boolean().nullish(),
    /** The author's home team (Slack Connect: another organization's team id). */
    user_team: optStr,
    source_team: optStr,
    metadata: z.object({ event_type: optStr, event_payload: z.record(z.string(), z.unknown()).nullish() }).passthrough().nullish()
  })
  .passthrough()
export type WireEvent = z.infer<typeof eventSchema>

export const envelopeSchema = z
  .object({
    type: str,
    envelope_id: optStr,
    accepts_response_payload: z.boolean().nullish(),
    retry_attempt: z.number().int().nullish(),
    retry_reason: optStr,
    reason: optStr,
    num_connections: z.number().int().nullish(),
    debug_info: z.record(z.string(), z.unknown()).nullish(),
    connection_info: z.object({ app_id: optStr }).passthrough().nullish(),
    payload: z
      .object({
        team_id: optStr,
        api_app_id: optStr,
        event_id: optStr,
        event_time: z.number().nullish(),
        type: optStr,
        event: z.unknown().optional(),
        authorizations: z.array(z.unknown()).nullish()
      })
      .passthrough()
      .nullish()
  })
  .passthrough()
export type WireEnvelope = z.infer<typeof envelopeSchema>

export const channelSchema = z
  .object({
    id: str,
    name: optStr,
    is_channel: z.boolean().nullish(),
    is_group: z.boolean().nullish(),
    is_im: z.boolean().nullish(),
    is_mpim: z.boolean().nullish(),
    is_private: z.boolean().nullish(),
    is_member: z.boolean().nullish(),
    is_archived: z.boolean().nullish(),
    user: optStr,
    num_members: z.number().int().nullish(),
    topic: z.object({ value: optStr }).passthrough().nullish(),
    purpose: z.object({ value: optStr }).passthrough().nullish(),
    updated: z.number().nullish(),
    last_read: optStr
  })
  .passthrough()
export type WireChannel = z.infer<typeof channelSchema>

export const userSchema = z
  .object({
    id: str,
    name: optStr,
    real_name: optStr,
    deleted: z.boolean().nullish(),
    is_bot: z.boolean().nullish(),
    is_restricted: z.boolean().nullish(),
    is_ultra_restricted: z.boolean().nullish(),
    team_id: optStr,
    enterprise_user: z.object({ enterprise_id: optStr }).passthrough().nullish(),
    tz: optStr,
    profile: z
      .object({ display_name: optStr, real_name: optStr, image_72: optStr, image_48: optStr, bot_id: optStr })
      .passthrough()
      .nullish()
  })
  .passthrough()
export type WireUser = z.infer<typeof userSchema>

export const idOf = (v: string | { id: string } | null | undefined): string | null => (v == null ? null : typeof v === 'string' ? v : v.id)
