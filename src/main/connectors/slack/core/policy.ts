/**
 * The one rule that decides "post or draft" (SLACK.md §8.2) plus the PO-S3 hard anti-spam floor. Pure: the caller
 * identity comes from main (live dir -> owner -> run -> trigger), never from tool arguments, and the counters come
 * from slack_outbox (store.autoPostsSince) so they survive restarts and are the same in a cloud store.
 * This file is the safety-critical code and moves unchanged with the core.
 */
import { SLACK_AUTO_LIMITS, dmThreadKey, type SlackChannelKind, type SlackDraftReason, type SlackReplyPolicy, type SlackRunContext, type SlackTriggerLimits } from '../../../../shared/slack'
import { userMentions } from './format'
import type { SlackStore } from './ports'

export interface ReplyTriggerView {
  id: string
  enabled: boolean
  reply: SlackReplyPolicy
  limits: SlackTriggerLimits
}
/** Who is asking. Resolved by main from the live dir; `trigger` is re-read at decision time. */
export type ReplyCaller =
  | { kind: 'session'; sessionId: string }
  | { kind: 'step'; runId: string; stepId: string | null; ctx: SlackRunContext | null; trigger: ReplyTriggerView | null }
export interface ReplyTarget {
  channelId: string
  channelKind: SlackChannelKind
  /** The thread the caller wants to reply in (null = top-level). */
  threadTs: string | null
}
export interface PolicyCounters {
  /** Auto-posts this run already made (fixed cap 1, PO-S3b). */
  runAutoPosts: number
  /** Auto-posts in this thread key in the last hour, any trigger. */
  threadAutoPostsHour: number
  /** Auto-posts in this channel in the last hour, all triggers (hard floor 6, PO-S3a). */
  channelAutoPostsHour: number
}
export interface PolicyEnv {
  autoPaused: boolean
  /** Slack connected and not paused (sleep). */
  live: boolean
}
export type ReplyDecision =
  | { action: 'post'; threadTs: string | null; threadKey: string }
  | { action: 'draft'; reason: SlackDraftReason }
  | { action: 'refused'; reason: string }

const isDm = (k: SlackChannelKind) => k === 'dm' || k === 'group_dm'

/** The thread key a post lands in: channels -> thread root; DMs -> `dm:<channel>` (PO-S4). */
export const threadKeyFor = (channelId: string, kind: SlackChannelKind, threadTs: string | null, ts?: string): string =>
  isDm(kind) ? dmThreadKey(channelId) : (threadTs ?? ts ?? '')

export const REFUSED_NONE = "This workflow's Slack trigger has replies turned off."

// ---------- the conversation a Slack-triggered run is scoped to (review blocker: no cross-conversation reads/posts) ----------

/** The one rule for writes: a Slack-triggered run replies (posts or drafts) only in the conversation that started it. */
export function inRunConversation(ctx: Pick<SlackRunContext, 'channelId' | 'channelKind' | 'threadTs'>, target: { channelId: string; threadTs: string | null }): boolean {
  if (target.channelId !== ctx.channelId) return false
  // a DM / group DM is one conversation (PO-S4): top-level, or the batched ts the run knows
  if (isDm(ctx.channelKind)) return !target.threadTs || target.threadTs === ctx.threadTs
  return target.threadTs === ctx.threadTs
}

export const outsideRunConversation = (ctx: Pick<SlackRunContext, 'channelId' | 'threadTs' | 'channelKind'>): string =>
  isDm(ctx.channelKind)
    ? `A Slack-triggered run can only reply in the conversation that started it (channel ${ctx.channelId}).`
    : `A Slack-triggered run can only reply in the thread that started it (channel ${ctx.channelId}, thread_ts ${ctx.threadTs}).`

/**
 * What the slack_* read tools of a Slack-triggered run may see: the triggering conversation (the thread in a channel;
 * the whole DM / group DM), plus the channels the trigger lists in `access.readChannels` (never DMs or group DMs).
 */
export interface RunReadScope {
  channelId: string
  /** null = the whole triggering conversation (a DM or group DM). */
  threadTs: string | null
  /** Channels readable in full. */
  extra: string[]
}
export function runReadScope(ctx: Pick<SlackRunContext, 'channelId' | 'channelKind' | 'threadTs' | 'access'>): RunReadScope {
  const extra = Array.isArray(ctx.access?.readChannels) ? ctx.access!.readChannels.filter((c) => typeof c === 'string' && c !== ctx.channelId) : []
  return { channelId: ctx.channelId, threadTs: isDm(ctx.channelKind) ? null : ctx.threadTs, extra }
}
/**
 * May the scoped run read `channel` (threadTs = the thread root it reads; null = channel-level history / listing)?
 * Fail closed: DMs and group DMs other than the triggering one never pass, whatever readChannels says.
 */
export function scopeAllowsRead(scope: RunReadScope, channel: { id: string; kind: SlackChannelKind }, threadTs: string | null): boolean {
  if (channel.id === scope.channelId) return scope.threadTs === null || threadTs === scope.threadTs
  if (isDm(channel.kind)) return false
  return scope.extra.includes(channel.id)
}

/** SLACK.md §8.2, in order. */
export function decideReply(caller: ReplyCaller, target: ReplyTarget, text: string, env: PolicyEnv, c: PolicyCounters): ReplyDecision {
  if (caller.kind === 'session') return { action: 'draft', reason: 'interactive' }
  const ctx = caller.ctx
  const trig = caller.trigger
  // a Slack-triggered run never posts or drafts outside the conversation that started it (fail closed)
  if (ctx && !inRunConversation(ctx, target)) return { action: 'refused', reason: outsideRunConversation(ctx) }
  if (!ctx || !trig) return { action: 'draft', reason: 'no_trigger' }
  if (trig.reply.mode === 'none') return { action: 'refused', reason: REFUSED_NONE }
  if (trig.reply.mode === 'draft') return { action: 'draft', reason: 'draft_mode' }
  // auto:
  if (env.autoPaused) return { action: 'draft', reason: 'auto_paused' }
  if (target.channelId !== ctx.channelId) return { action: 'draft', reason: 'other_thread' }
  const dm = isDm(ctx.channelKind)
  if (!dm && target.threadTs !== ctx.threadTs) return { action: 'draft', reason: 'other_thread' }
  if (dm && target.threadTs && target.threadTs !== ctx.threadTs) return { action: 'draft', reason: 'other_thread' }
  const allow = trig.reply.autoChannels
  // '*' = wherever this mention/DM trigger fired (validation keeps it off 'any message' triggers)
  if (!(allow.includes('*') || allow.includes(ctx.channelId) || (dm && allow.includes('dm')))) return { action: 'draft', reason: 'not_allowlisted' }
  if (c.runAutoPosts >= SLACK_AUTO_LIMITS.perRun) return { action: 'draft', reason: 'auto_limit' }
  if (c.threadAutoPostsHour >= trig.limits.maxRunsPerThreadPerHour) return { action: 'draft', reason: 'auto_limit' }
  if (c.channelAutoPostsHour >= SLACK_AUTO_LIMITS.perChannelPerHour) return { action: 'draft', reason: 'auto_limit' }
  if (userMentions(text).length > SLACK_AUTO_LIMITS.maxUserMentions) return { action: 'draft', reason: 'auto_limit' }
  if (!trig.enabled || !env.live) return { action: 'draft', reason: 'auto_limit' }
  // channels: in the triggering thread; DMs: top-level (PO-S4)
  return { action: 'post', threadTs: dm ? null : ctx.threadTs, threadKey: threadKeyFor(ctx.channelId, ctx.channelKind, ctx.threadTs) }
}

const HOUR = 3600_000

/** Reads the counters for one decision from the outbox. */
export async function policyCounters(store: SlackStore, q: { teamId: string; runId: string | null; channelId: string; threadKey: string; nowMs: number }): Promise<PolicyCounters> {
  const since = q.nowMs - HOUR
  const [runAutoPosts, threadAutoPostsHour, channelAutoPostsHour] = await Promise.all([
    q.runId ? store.autoPostsSince({ teamId: q.teamId, runId: q.runId, sinceMs: 0 }) : Promise.resolve(0),
    store.autoPostsSince({ teamId: q.teamId, channelId: q.channelId, threadKey: q.threadKey, sinceMs: since }),
    // the channel floor counts every automatic post there: auto replies and notify-node posts (PO-S3a)
    store.autoPostsSince({ teamId: q.teamId, channelId: q.channelId, sinceMs: since, withNotify: true })
  ])
  return { runAutoPosts, threadAutoPostsHour, channelAutoPostsHour }
}

export const REASON_TEXT: Record<SlackDraftReason, string> = {
  draft_mode: 'this trigger replies with drafts',
  not_allowlisted: 'this channel is not in the auto list',
  other_thread: 'auto replies only go to the thread that started the run',
  interactive: 'replies from an interactive session are always drafts',
  auto_limit: 'the auto-reply limit was reached',
  auto_paused: 'auto-replies are paused',
  no_trigger: 'this run was not started by a Slack trigger',
  manual: 'drafted by you'
}
