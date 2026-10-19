/**
 * Typed access to the Slack IPC channels (CONTRACT Slack.5 + SLACK.md §0.3: `slack:connect`, `slack:join`,
 * `slack:joinAll`). Goes through `window.hive` like every other call, but tolerates a main that doesn't serve the
 * channels yet (SLACK.md §14 "Fakes for parallel work"): a missing method rejects with code `not_implemented` and a
 * missing event name subscribes to nothing, so the UI degrades to the setup guide and empty lists.
 */
import type { Id, Session } from '@shared/types'
import type { NotifyResult } from '@shared/authoring'
import type {
  SlackChannel,
  SlackDraft,
  SlackDraftDetail,
  SlackDraftStatus,
  SlackMessage,
  SlackMessagePage,
  SlackSearchHit,
  SlackSearchQuery,
  SlackStatus,
  SlackTestResult,
  SlackThread,
  SlackTrigger,
  SlackTriggerEvent,
  SlackTriggerInput,
  SlackTriggerTestResult,
  SlackUser
} from '@shared/slack'

type V = void
export interface SlackInvokeMap {
  'slack:status': [V, SlackStatus]
  'slack:manifest': [{ name?: string }, { json: string; yaml: string; createUrl?: string }]
  /** PO-S1: one Connect button (validate both tokens, store, start). Plaintext crosses IPC only here. */
  'slack:connect': [{ botToken: string; appToken: string }, SlackStatus]
  'slack:test': [V, SlackTestResult]
  'slack:retry': [V, SlackStatus]
  'slack:disconnect': [{ purge: boolean }, SlackStatus]
  'slack:channels': [{ query?: string }, SlackChannel[]]
  /** PO-S2: explicit click only. */
  'slack:join': [{ channelId: string }, SlackChannel]
  'slack:joinAll': [V, { joined: number; failed?: number }]
  'slack:markRead': [{ channelId: string; ts: string }, V]
  'slack:users': [{ query?: string; includeBots?: boolean }, SlackUser[]]
  'slack:messages': [{ channelId: string; beforeTs?: string; limit?: number }, SlackMessagePage]
  'slack:thread': [{ channelId: string; threadTs: string }, SlackThread]
  'slack:search': [SlackSearchQuery, SlackSearchHit[]]
  'slack:backfill': [{ channelId?: string; days: number }, SlackStatus]
  'slack:askAgent': [{ channelId: string; threadTs: string; profileId?: Id; repoId?: Id | null; cols: number; rows: number }, Session]
  'slack:drafts': [{ status?: SlackDraftStatus[]; channelId?: string; threadTs?: string; runId?: Id }, SlackDraft[]]
  'slack:draftGet': [{ id: Id }, SlackDraftDetail]
  'slack:draftDecide': [{ id: Id; decision: 'send' | 'discard'; text?: string }, SlackDraft]
  'slack:testAlert': [V, NotifyResult]
  'slack:permalink': [{ channelId: string; ts: string }, { url: string }]
  'slackTriggers:list': [{ workflowId?: Id } | V, SlackTrigger[]]
  'slackTriggers:create': [SlackTriggerInput, SlackTrigger]
  'slackTriggers:update': [{ id: Id; input: SlackTriggerInput }, SlackTrigger]
  'slackTriggers:remove': [{ id: Id }, V]
  'slackTriggers:setEnabled': [{ id: Id; enabled: boolean }, SlackTrigger]
  'slackTriggers:test': [{ input: SlackTriggerInput; sample: { permalink: string } | { channelId: string; ts: string } }, SlackTriggerTestResult]
  'slackTriggers:events': [{ triggerId: Id; limit?: number }, SlackTriggerEvent[]]
}
export interface SlackEventMap {
  'slack:status': SlackStatus
  'slack:channels': SlackChannel[]
  'slack:messages': { channelId: string; messages: SlackMessage[] }
  'slack:draft': SlackDraft
  'slackTrigger:updated': SlackTrigger
}
export type SlackUiCommand = { kind: 'openSlack'; channelId?: string; threadTs?: string } | { kind: 'openSlackDraft'; draftId: Id }

type Ch = keyof SlackInvokeMap
type Req<C extends Ch> = SlackInvokeMap[C][0]
type Res<C extends Ch> = SlackInvokeMap[C][1]
type AnyFn = (req?: unknown) => Promise<unknown>

function bridge(): Record<string, unknown> {
  return (typeof window !== 'undefined' ? (window as unknown as { hive?: Record<string, unknown> }).hive : undefined) ?? {}
}

export class SlackUnavailableError extends Error {
  code = 'not_implemented' as const
  constructor(channel: string) {
    super(`Slack isn’t available in this build yet (${channel}).`)
    this.name = 'HiveError'
  }
}

export function slackCall<C extends Ch>(channel: C, ...req: [Req<C>] extends [V] ? [] : [Req<C>]): Promise<Res<C>> {
  const [domain, method] = channel.split(':') as [string, string]
  const fn = (bridge()[domain] as Record<string, AnyFn> | undefined)?.[method]
  if (typeof fn !== 'function') return Promise.reject(new SlackUnavailableError(channel))
  return fn(req[0]) as Promise<Res<C>>
}

/** True when main serves the Slack channels at all. */
export function slackServed(): boolean {
  const ns = bridge().slack as Record<string, unknown> | undefined
  return typeof ns?.status === 'function'
}

/** Subscribe to a Slack event; a main that doesn't emit it yet just never calls back. */
export function onSlackEvent<E extends keyof SlackEventMap>(event: E, cb: (payload: SlackEventMap[E]) => void): () => void {
  const on = bridge().on as ((e: string, cb: (p: unknown) => void) => () => void) | undefined
  if (typeof on !== 'function') return () => undefined
  try {
    return on(event, cb as (p: unknown) => void)
  } catch {
    return () => undefined
  }
}

export function isNotImplemented(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code
  return code === 'not_implemented' || (typeof (e as Error | null)?.message === 'string' && /No handler registered|not_implemented/i.test((e as Error).message))
}
