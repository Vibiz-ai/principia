/**
 * Draft state machine (SLACK.md §8.3, PO-S5): pending -> sending -> sent | failed (Retry keeps the Ask open);
 * pending -> discarded; pending -> expired (daily sweep, Ask cancelled). The draft row is the source of truth; the Ask
 * (AskPort) is only the approval surface and outlives the step that drafted it.
 */
import { HiveError } from '../../../../shared/errors'
import type { SlackDraftReason } from '../../../../shared/slack'
import { MAX_POST_CHARS, prepareOutgoing } from './format'
import { OutboxError, type Outbox } from './outbox'
import type { AskPort, Clock, Logger, SlackDraftOwner, SlackDraftRow, SlackStore, SlackWorkspace } from './ports'

export const MAX_PENDING_PER_OWNER = 5
export const DRAFT_TTL_MS = 7 * 86400_000

export interface DraftCreate {
  owner: SlackDraftOwner
  channelId: string
  threadTs: string | null
  text: string
  reason: SlackDraftReason
  note?: string | null
}

export class SlackDrafts {
  constructor(
    private d: {
      store: SlackStore
      asks: AskPort
      outbox: Outbox
      clock: Clock
      log: Logger
      newId(): string
      redact(s: string): string
      workspace(): SlackWorkspace | null
      /** "Reply in #support" / "Reply to Dana Lee (DM)". */
      title(channelId: string): string
      emit(d: SlackDraftRow): void
    }
  ) {}

  private iso(ms = this.d.clock.now()): string {
    return new Date(ms).toISOString()
  }

  async create(req: DraftCreate): Promise<SlackDraftRow> {
    const ws = this.d.workspace()
    if (!ws) throw new HiveError('conflict', 'Slack is not connected')
    const text = prepareOutgoing(req.text, this.d.redact)
    if (!text.trim()) throw new HiveError('validation', 'The reply is empty')
    const pending = await this.d.store.drafts.pendingForOwner({ sessionId: req.owner.sessionId, stepId: req.owner.stepId })
    if (pending >= MAX_PENDING_PER_OWNER) throw new HiveError('conflict', 'Too many drafts waiting for the user')
    const now = this.d.clock.now()
    const row: SlackDraftRow = {
      id: this.d.newId(),
      status: 'pending',
      teamId: ws.teamId,
      channelId: req.channelId,
      threadTs: req.threadTs,
      text,
      originalText: text,
      edited: false,
      reason: req.reason,
      owner: req.owner,
      note: req.note ? this.d.redact(req.note).slice(0, 500) : null,
      askId: null,
      outboxId: null,
      sentTs: null,
      error: null,
      createdAt: this.iso(now),
      decidedAt: null,
      expiresAt: this.iso(now + DRAFT_TTL_MS)
    }
    await this.d.store.drafts.insert(row)
    let out = row
    try {
      const askId = await this.d.asks.open({ draftId: row.id, title: this.d.title(req.channelId), question: text.slice(0, 200), owner: req.owner })
      if (askId) out = await this.d.store.drafts.update(row.id, { askId })
    } catch (e) {
      this.d.log.warn('slack draft: could not open the ask', { id: row.id, e: String(e) })
    }
    this.d.emit(out)
    return out
  }

  /** Send (optionally edited text) or Discard. conflict unless pending or failed. */
  async decide(id: string, decision: 'send' | 'discard', editedText?: string | null): Promise<SlackDraftRow> {
    const cur = await this.d.store.drafts.get(id)
    if (!cur) throw new HiveError('not_found', 'Draft not found')
    if (cur.status !== 'pending' && cur.status !== 'failed') throw new HiveError('conflict', `This draft is already ${cur.status}`)
    if (decision === 'discard') {
      const u = await this.d.store.drafts.update(id, { status: 'discarded', decidedAt: this.iso() })
      if (u.askId) await this.d.asks.close(u.askId, 'answered', { optionId: 'discard' }).catch(() => {})
      this.d.emit(u)
      return u
    }
    let text = cur.text
    if (editedText != null) {
      const t = editedText.trim()
      if (!t || t.length > MAX_POST_CHARS) throw new HiveError('validation', `The reply must be 1..${MAX_POST_CHARS} characters`, [{ path: 'text', message: `1..${MAX_POST_CHARS} characters` }])
      text = prepareOutgoing(editedText, this.d.redact)
    }
    let row = await this.d.store.drafts.update(id, { status: 'sending', text, edited: cur.edited || text !== cur.originalText, error: null })
    this.d.emit(row)
    try {
      const sent = await this.d.outbox.post({
        purpose: 'reply',
        channelId: row.channelId,
        threadTs: row.threadTs,
        text,
        prepared: true,
        draftId: row.id,
        runId: row.owner.runId,
        stepId: row.owner.stepId
      })
      row = await this.d.store.drafts.update(id, { status: 'sent', sentTs: sent.ts, outboxId: sent.id, decidedAt: this.iso() })
      if (row.askId) await this.d.asks.close(row.askId, 'answered', { optionId: 'send', message: row.edited ? text : null }).catch(() => {})
    } catch (e) {
      const msg = e instanceof OutboxError ? e.message : e instanceof Error ? e.message : String(e)
      row = await this.d.store.drafts.update(id, { status: 'failed', error: msg, outboxId: e instanceof OutboxError ? e.row.id : row.outboxId })
    }
    this.d.emit(row)
    return row
  }

  /** Daily sweep: pending past expires_at -> expired, Ask cancelled. */
  async expire(): Promise<number> {
    const rows = await this.d.store.drafts.expired(this.iso())
    for (const r of rows) {
      const u = await this.d.store.drafts.update(r.id, { status: 'expired', decidedAt: this.iso() })
      if (u.askId) await this.d.asks.close(u.askId, 'cancelled').catch(() => {})
      this.d.emit(u)
    }
    return rows.length
  }
}
