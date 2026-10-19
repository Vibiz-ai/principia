/**
 * Notify node (SLACK.md §10, SA3; replaces AUTHORING.md §7.2's iMessage): macOS notification + optional Slack.
 * Implements the engine's NotifyBridge. iMessage and its osascript code are gone.
 * - Always posts the Mac notification (user-authored: ignores notifyOnSuccess, honors notificationSound).
 * - `slack: {kind:'me'}` DMs Settings.slackAlertUserId; `{kind:'channel'}` posts there. A legacy `imessage: true`
 *   in an old run snapshot is mapped to `{kind:'me'}` by the executor (notifyTarget): "Slack DM if configured, else
 *   Mac-only with a note" is met at send time.
 * - Notes never fail the step: not connected / no alert user -> 'skipped'; Slack errors -> 'failed' with the reason.
 * - Rate guard: <= 10 Slack notifies per run, <= 60 per hour across Hive. Counted from the Slack outbox (purpose
 *   'notify') when the port offers it, so the cap survives restarts and moves with the connector; in-memory otherwise.
 * No Electron imports (the notification poster and the Slack sender are injected).
 */
import type { NotifyBridge } from '../shared/engine'
import type { NotifyResult } from '../shared/authoring'
import type { NotifySlackTarget } from '../shared/slack'
import type { Id } from '../shared/types'

export const NOT_CONNECTED_NOTE = 'Slack is not connected; sent a Mac notification only. Connect it in Settings › Connections.'
export const NO_ALERT_USER_NOTE = 'Pick who gets alerts in Settings › Notifications; sent a Mac notification only.'
export const RATE_NOTE = 'Slack alert rate limit (10 per run, 60 per hour); sent a Mac notification only.'

/** The Slack half (connectors/slack/notify.ts). */
export interface SlackAlertPort {
  connected(): boolean
  alertUserId(): string | null
  /** Posts (outbox purpose 'notify'). Rejects with a readable message. */
  post(target: { userId: string } | { channelId: string }, text: string, runId: Id | null, stepId: Id | null): Promise<void>
  /** Durable count of notify posts since `sinceMs` (all of Hive, or one run). Absent = in-memory counting. */
  recentPosts?(q: { runId: Id | null; sinceMs: number }): Promise<number>
}

export interface NotifyNodeDeps {
  /** Posts a macOS notification; onClick opens the run. */
  post(n: { title: string; body: string; runId: Id | null }): void
  redact(s: string): string
  slack?: () => SlackAlertPort | null
  now?: () => number
  log?: { warn(m: string, meta?: Record<string, unknown>): void }
}

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export class NotifyNode implements NotifyBridge {
  private perRun = new Map<Id, number>()
  private sentAt: number[] = []
  private chain: Promise<unknown> = Promise.resolve()
  private now: () => number
  constructor(private d: NotifyNodeDeps) {
    this.now = d.now ?? (() => Date.now())
  }

  async send(req: { runId: Id; stepId: Id; title: string; message: string; slack?: NotifySlackTarget | null }): Promise<NotifyResult> {
    const title = cap(this.d.redact(req.title.trim() || 'Hive'), 120)
    const message = cap(this.d.redact(req.message.trim()), 2000)
    let notified = false
    try {
      this.d.post({ title, body: cap(message, 250) || ' ', runId: req.runId })
      notified = true
    } catch (e) {
      this.d.log?.warn('notify node: notification failed', { e: String(e) })
    }
    const target: NotifySlackTarget | null = req.slack ?? null
    if (!target) return { notified, slack: 'not_requested', note: null }
    const r = await this.slack(target, title, message, req.runId, req.stepId)
    return { notified, ...r }
  }

  /** notify nodes and slack:testAlert. */
  async slack(target: NotifySlackTarget, title: string, message: string, runId: Id | null, stepId: Id | null): Promise<Pick<NotifyResult, 'slack' | 'note'>> {
    const port = this.d.slack?.() ?? null
    if (!port || !port.connected()) return { slack: 'skipped', note: NOT_CONNECTED_NOTE }
    let to: { userId: string } | { channelId: string }
    if (target.kind === 'me') {
      const u = port.alertUserId()
      if (!u) return { slack: 'skipped', note: NO_ALERT_USER_NOTE }
      to = { userId: u }
    } else to = { channelId: target.channel }
    const text = cap(`*${title}*${message ? `\n${message}` : ''}${runId ? `\n_Hive · run ${runId}_` : ''}`, 3000)
    // check + post one at a time, so two parallel notify steps cannot both pass the last free slot
    const run = this.chain.then(() => this.guardedPost(port, to, text, runId, stepId))
    this.chain = run.catch(() => undefined)
    return run
  }

  private async guardedPost(port: SlackAlertPort, to: { userId: string } | { channelId: string }, text: string, runId: Id | null, stepId: Id | null): Promise<Pick<NotifyResult, 'slack' | 'note'>> {
    const t = this.now()
    if (port.recentPosts) {
      try {
        const [hour, perRun] = await Promise.all([port.recentPosts({ runId: null, sinceMs: t - 3600_000 }), runId ? port.recentPosts({ runId, sinceMs: 0 }) : Promise.resolve(0)])
        if (hour >= 60 || perRun >= 10) return { slack: 'failed', note: RATE_NOTE }
      } catch (e) {
        this.d.log?.warn('notify node: rate count failed; using in-memory counts', { e: String(e) })
        if (this.memoryLimited(t, runId)) return { slack: 'failed', note: RATE_NOTE }
      }
    } else if (this.memoryLimited(t, runId)) return { slack: 'failed', note: RATE_NOTE }
    try {
      await port.post(to, text, runId, stepId)
      return { slack: 'sent', note: null }
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      this.d.log?.warn('notify node: slack failed', { why: this.d.redact(why).slice(0, 300) })
      return { slack: 'failed', note: `Slack alert failed: ${cap(this.d.redact(why), 200)}` }
    }
  }

  /** In-memory fallback guard; records the send when allowed. */
  private memoryLimited(t: number, runId: Id | null): boolean {
    this.sentAt = this.sentAt.filter((x) => t - x < 3600_000)
    const n = runId ? (this.perRun.get(runId) ?? 0) : 0
    if (this.sentAt.length >= 60 || n >= 10) return true
    this.sentAt.push(t)
    if (runId) this.perRun.set(runId, n + 1)
    if (this.perRun.size > 200) this.perRun = new Map([...this.perRun].slice(-100))
    return false
  }
}
