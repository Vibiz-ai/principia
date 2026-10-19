/** Notify node (SLACK.md §10, SA3): Mac notification always + Slack DM / channel; iMessage is gone. */
import { describe, expect, it } from 'vitest'
import { NOT_CONNECTED_NOTE, NO_ALERT_USER_NOTE, NotifyNode, RATE_NOTE, type SlackAlertPort } from '../notifyNode'

function make(o: { connected?: boolean; user?: string | null; fail?: string } = {}) {
  const posted: { title: string; body: string; runId: string | null }[] = []
  const sent: { to: unknown; text: string }[] = []
  const port: SlackAlertPort = {
    connected: () => o.connected ?? true,
    alertUserId: () => (o.user === undefined ? 'U1' : o.user),
    post: async (to, text) => {
      if (o.fail) throw new Error(o.fail)
      sent.push({ to, text })
    }
  }
  let t = 1_000_000
  const n = new NotifyNode({ post: (x) => posted.push(x), redact: (s) => s.replace('sk-SECRET', '••••KEY'), slack: () => port, now: () => t })
  return { n, posted, sent, tick: (ms: number) => (t += ms) }
}
const req = { runId: 'r_1', stepId: 'st_1', title: 'Daily brief', message: 'all green sk-SECRET', slack: null }

describe('NotifyNode (Slack replaces iMessage)', () => {
  it('Mac only when slack is null; never touches Slack', async () => {
    const m = make()
    const r = await m.n.send({ ...req, slack: null })
    expect(r).toEqual({ notified: true, slack: 'not_requested', note: null })
    expect(m.posted).toHaveLength(1)
    expect(m.sent).toHaveLength(0)
  })
  it('me -> DM to the alert user, redacted, bold title', async () => {
    const m = make()
    const r = await m.n.send({ ...req, slack: { kind: 'me' } })
    expect(r.slack).toBe('sent')
    expect(m.sent[0].to).toEqual({ userId: 'U1' })
    expect(m.sent[0].text).toContain('*Daily brief*')
    expect(m.sent[0].text).not.toContain('sk-SECRET')
  })
  it('channel target posts there', async () => {
    const m = make()
    await m.n.send({ ...req, slack: { kind: 'channel', channel: 'C9' } })
    expect(m.sent[0].to).toEqual({ channelId: 'C9' })
  })
  it('no target -> Mac notification only', async () => {
    const m = make()
    const r = await m.n.send({ ...req, slack: null })
    expect(r).toMatchObject({ notified: true, slack: 'not_requested' })
    expect(m.sent).toHaveLength(0)
  })
  it('notes never fail the step: not connected, no alert user, Slack error', async () => {
    expect((await make({ connected: false }).n.send({ ...req, slack: { kind: 'me' } })).note).toBe(NOT_CONNECTED_NOTE)
    const noUser = await make({ user: null }).n.send({ ...req, slack: { kind: 'me' } })
    expect(noUser).toMatchObject({ notified: true, slack: 'skipped', note: NO_ALERT_USER_NOTE })
    const f = await make({ fail: 'Invite @hive to #eng, then retry' }).n.send({ ...req, slack: { kind: 'channel', channel: 'C9' } })
    expect(f).toMatchObject({ slack: 'failed' })
    expect(f.note).toMatch(/Invite @hive/)
  })
  it('rate guard: 10 per run, 60 per hour', async () => {
    const m = make()
    for (let i = 0; i < 10; i++) expect((await m.n.send({ ...req, slack: { kind: 'me' } })).slack).toBe('sent')
    expect((await m.n.send({ ...req, slack: { kind: 'me' } })).note).toBe(RATE_NOTE)
    for (let i = 0; i < 50; i++) await m.n.send({ ...req, runId: `r_x${i}`, slack: { kind: 'me' } })
    expect((await m.n.send({ ...req, runId: 'r_new', slack: { kind: 'me' } })).slack).toBe('failed')
    m.tick(3600_001)
    expect((await m.n.send({ ...req, runId: 'r_new2', slack: { kind: 'me' } })).slack).toBe('sent')
  })
})
