/**
 * Outbox (SLACK.md §8.4): every post goes here. queued -> sending (attempts+1) -> chat.postMessage with the outbox id in
 * message metadata -> sent + ts (and the message is stored locally, source 'post', hive_ref). Crash recovery never
 * re-posts blindly: rows left `sending` (crash) or whose post timed out / hit a network error / 5xx become `unknown` and
 * are resolved by finding the metadata in recent history; only a confirmed miss is sent again.
 */
import { SlackApiError, type SlackApi } from './api'
import { prepareOutgoing, tsCmp } from './format'
import { hiveRefOf, messageRow } from './ingest'
import type { Resolver } from './format'
import type { Clock, Logger, OutboxPurpose, OutboxRow, SlackStore, SlackWorkspace } from './ports'
import type { WireMessage } from './types'

export interface PostRequest {
  purpose: OutboxPurpose
  channelId: string
  threadTs: string | null
  threadKey?: string | null
  text: string
  draftId?: string | null
  runId?: string | null
  stepId?: string | null
  /** Already passed through prepareOutgoing (drafts store the final text). */
  prepared?: boolean
}

/** chat.postMessage tries per row when Slack's answer is lost (each one only after history shows it was not posted). */
const MAX_ATTEMPTS = 3
/** Wait before the history lookup, so a post Slack accepted is visible. */
const CONFIRM_DELAY_MS = 1500
const RESEND_DELAYS_MS = [2000, 8000]

export class OutboxError extends Error {
  constructor(
    message: string,
    readonly row: OutboxRow
  ) {
    super(message)
    this.name = 'OutboxError'
  }
}

export class Outbox {
  constructor(
    private d: {
      store: SlackStore
      api: SlackApi
      clock: Clock
      log: Logger
      redact(s: string): string
      workspace(): SlackWorkspace | null
      newId(): string
      resolver: Resolver
      channelLabel(channelId: string): string
      onPosted?(row: OutboxRow): void
    }
  ) {}

  private iso(): string {
    return new Date(this.d.clock.now()).toISOString()
  }

  /** Inserts and sends. Resolves with the sent row; rejects with OutboxError (row failed) on a permanent error. */
  async post(req: PostRequest): Promise<OutboxRow> {
    const ws = this.d.workspace()
    if (!ws) throw new Error('Slack is not connected')
    const text = req.prepared ? req.text : prepareOutgoing(req.text, this.d.redact)
    const row: OutboxRow = {
      id: this.d.newId(),
      purpose: req.purpose,
      teamId: ws.teamId,
      channelId: req.channelId,
      threadTs: req.threadTs,
      threadKey: req.threadKey ?? null,
      text,
      draftId: req.draftId ?? null,
      runId: req.runId ?? null,
      stepId: req.stepId ?? null,
      status: 'queued',
      attempts: 0,
      ts: null,
      error: null,
      createdAt: this.iso(),
      sentAt: null
    }
    await this.d.store.outbox.insert(row)
    return this.send(row)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => this.d.clock.setTimeout(r, ms))
  }

  /**
   * One chat.postMessage per attempt, never retried blindly (chat.postMessage is not idempotent). On a transient failure
   * (timeout, network, 5xx) Slack may have posted anyway, so the row goes `unknown` and is resolved like recover():
   * look for the outbox id in the message metadata; found -> sent; not found -> send again (at most MAX_ATTEMPTS
   * in total); lookup failed -> failed "could not confirm, not re-sent".
   */
  private async send(row: OutboxRow): Promise<OutboxRow> {
    let cur = row
    for (;;) {
      cur = await this.d.store.outbox.update(row.id, { status: 'sending', attempts: cur.attempts + 1, error: null })
      let body: { ts: string; channel: string; message?: WireMessage }
      try {
        body = (
          await this.d.api.call<{ ts: string; channel: string; message?: WireMessage }>(
            'chat.postMessage',
            {
              channel: cur.channelId,
              ...(cur.threadTs ? { thread_ts: cur.threadTs } : {}),
              text: cur.text,
              mrkdwn: true,
              unfurl_links: false,
              unfurl_media: false,
              metadata: { event_type: 'hive_post', event_payload: { outbox_id: cur.id, ...(cur.runId ? { run_id: cur.runId } : {}) } }
            },
            { lane: 'interactive', token: 'bot', channel: cur.channelId, json: true, retryTransient: false }
          )
        ).body
      } catch (e) {
        if (e instanceof SlackApiError && e.transient) {
          cur = await this.d.store.outbox.update(row.id, { status: 'unknown' })
          this.d.log.warn('slack post outcome unknown; checking history before any resend', { id: cur.id, why: e.slack, attempt: cur.attempts })
          let hit: WireMessage | null
          try {
            await this.sleep(CONFIRM_DELAY_MS)
            hit = await this.lookup(cur)
          } catch (le) {
            this.d.log.warn('slack post confirmation failed', { id: cur.id, e: le instanceof Error ? le.message : String(le) })
            const msg = `Slack did not answer (${e.slack}) and Hive could not confirm whether it was posted; not re-sent`
            cur = await this.d.store.outbox.update(row.id, { status: 'failed', error: msg })
            throw new OutboxError(msg, cur)
          }
          if (hit) return this.confirmed(cur, hit)
          if (cur.attempts < MAX_ATTEMPTS) {
            await this.sleep(RESEND_DELAYS_MS[Math.min(cur.attempts - 1, RESEND_DELAYS_MS.length - 1)])
            continue
          }
          const msg = `Slack did not answer (${e.slack}) after ${cur.attempts} tries; not sent`
          cur = await this.d.store.outbox.update(row.id, { status: 'failed', error: msg })
          throw new OutboxError(msg, cur)
        }
        const msg = e instanceof SlackApiError ? e.toHive(this.d.channelLabel(cur.channelId)).message : e instanceof Error ? e.message : String(e)
        cur = await this.d.store.outbox.update(row.id, { status: 'failed', error: msg })
        throw new OutboxError(msg, cur)
      }
      return this.sentWith(cur, body)
    }
  }

  private async sentWith(row: OutboxRow, body: { ts: string; message?: WireMessage }): Promise<OutboxRow> {
    const ws = this.d.workspace()
    const cur = await this.d.store.outbox.update(row.id, { status: 'sent', ts: body.ts, sentAt: this.iso(), error: null })
    if (ws) {
      const m: WireMessage = body.message
        ? { ...body.message, ts: body.ts }
        : { type: 'message', ts: body.ts, text: row.text, user: ws.botUserId, bot_id: ws.botId, thread_ts: row.threadTs ?? null }
      const r = messageRow(m, row.channelId, this.d.resolver)
      await this.d.store.upsertMessages(ws.teamId, [{ ...r, hiveRef: row.id, threadTs: r.threadTs ?? row.threadTs }], 'post')
      if (row.threadTs) await this.d.store.bumpParent(ws.teamId, row.channelId, row.threadTs, body.ts, ws.botUserId)
    }
    this.d.onPosted?.(cur)
    return cur
  }

  /** The post was found in Slack's history after an unknown outcome. */
  private confirmed(row: OutboxRow, hit: WireMessage): Promise<OutboxRow> {
    this.d.log.info('slack post confirmed from history; not re-sent', { id: row.id })
    return this.sentWith(row, { ts: hit.ts, message: hit })
  }

  /**
   * The message carrying this row's outbox id in its hive_post metadata, from conversations.replies (thread) or
   * conversations.history (top level) since a minute before the row was created. null = not posted. Throws when Slack
   * cannot be asked.
   */
  private async lookup(row: OutboxRow): Promise<WireMessage | null> {
    const oldest = ((Date.parse(row.createdAt) - 60_000) / 1000).toFixed(6)
    const method = row.threadTs ? 'conversations.replies' : 'conversations.history'
    const { body } = await this.d.api.call<{ messages?: WireMessage[] }>(
      method,
      { channel: row.channelId, ...(row.threadTs ? { ts: row.threadTs } : {}), oldest, limit: 200, include_all_metadata: true },
      { lane: 'interactive', token: 'bot' }
    )
    return (body.messages ?? []).find((m) => hiveRefOf(m) === row.id && tsCmp(m.ts, oldest) >= 0) ?? null
  }

  /** Retry a failed row (draft card "Retry"). A row that ever reached Slack is looked up first, so Retry never doubles a post. */
  async retry(id: string): Promise<OutboxRow> {
    const row = await this.d.store.outbox.get(id)
    if (!row) throw new Error('Outbox row not found')
    if (row.status === 'sent') return row
    if (row.attempts > 0 && this.d.workspace()) {
      const hit = await this.lookup(row).catch(() => null)
      if (hit) return this.confirmed(row, hit)
    }
    return this.send(row)
  }

  /**
   * Boot / connect: rows still `sending` -> `unknown`, then look for their metadata in the last 10 min of the channel or
   * thread. Found -> sent. Not found -> failed "Hive quit while sending; not sent". `queued` rows never reached Slack.
   */
  async recover(): Promise<{ sent: number; failed: number }> {
    const ws = this.d.workspace()
    let sent = 0
    let failed = 0
    for (const row of await this.d.store.outbox.pending()) {
      if (row.status === 'queued') {
        await this.d.store.outbox.update(row.id, { status: 'failed', error: 'Hive quit before sending; not sent' })
        failed++
        continue
      }
      await this.d.store.outbox.update(row.id, { status: 'unknown' })
      if (!ws) continue
      try {
        const hit = await this.lookup(row)
        if (hit) {
          await this.d.store.outbox.update(row.id, { status: 'sent', ts: hit.ts, sentAt: this.iso(), error: null })
          await this.d.store.upsertMessages(ws.teamId, [{ ...messageRow(hit, row.channelId, this.d.resolver), hiveRef: row.id }], 'post')
          sent++
        } else {
          await this.d.store.outbox.update(row.id, { status: 'failed', error: 'Hive quit while sending; not sent' })
          failed++
        }
      } catch (e) {
        this.d.log.warn('outbox recovery check failed', { id: row.id, e: e instanceof Error ? e.message : String(e) })
        await this.d.store.outbox.update(row.id, { status: 'failed', error: 'Hive quit while sending; could not confirm, not re-sent' })
        failed++
      }
    }
    return { sent, failed }
  }
}
