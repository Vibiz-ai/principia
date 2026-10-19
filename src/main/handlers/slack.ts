/**
 * Slack IPC (CONTRACT "Slack.5", SLACK.md §0.3 PO-S1/PO-S2): slack:* and slackTriggers:*. Every channel answers even
 * when the service is missing. Plaintext tokens cross IPC only in slack:connect's request; no response carries one.
 */
import { BrowserWindow, dialog } from 'electron'
import { HiveError } from '../../shared/errors'
import type { Hive } from '../hive'
import { handle } from '../ipc'

export function registerSlackHandlers(h: Hive): void {
  const svc = () => {
    if (!h.slack) throw new HiveError('internal', 'Slack is not available in this build')
    return h.slack
  }
  handle('slack:status', () => svc().status())
  handle('slack:manifest', (q) => svc().manifest(q?.name))
  handle('slack:connect', (req, sender) =>
    svc().connect(req, async (from, to) => {
      const win = BrowserWindow.fromWebContents(sender) ?? undefined
      const opts = {
        type: 'warning' as const,
        message: `Switch from ${from} to ${to}?`,
        detail: `Hive will clear the local copy of ${from}'s messages.`,
        buttons: ['Switch', 'Cancel'],
        defaultId: 1,
        cancelId: 1
      }
      const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
      return r.response === 0
    })
  )
  handle('slack:test', () => svc().connector.test())
  handle('slack:retry', () => svc().connector.retry())
  handle('slack:disconnect', ({ purge }) => svc().disconnect(purge))
  handle('slack:channels', (q) => svc().channels(q?.query))
  handle('slack:join', async ({ channelId }) => {
    const c = await svc().connector.join(channelId)
    if (!c) throw new HiveError('not_found', 'Channel not found')
    return c
  })
  handle('slack:joinAll', async () => {
    const r = await svc().connector.joinAll()
    return { joined: r.joined, failed: r.failed.length }
  })
  handle('slack:markRead', ({ channelId, ts }) => svc().markRead(channelId, ts))
  handle('slack:users', (q) => svc().users(q ?? {}))
  handle('slack:messages', (q) => svc().messages(q))
  handle('slack:thread', ({ channelId, threadTs }) => svc().thread(channelId, threadTs))
  handle('slack:search', (q) => {
    const ws = svc().connector.workspace()
    if (!ws) return []
    return svc().sql.search({ ...q, teamId: ws.teamId })
  })
  handle('slack:backfill', ({ channelId, days }) => svc().backfill(channelId, days))
  handle('slack:askAgent', (req) => svc().askAgent(req))
  handle('slack:drafts', (q) => svc().drafts(q ?? {}))
  handle('slack:draftGet', ({ id }) => svc().draftGet(id))
  handle('slack:draftDecide', async ({ id, decision, text }) => {
    const d = await svc().draftDecide(id, decision, text)
    h.statusChanged()
    return d
  })
  handle('slack:testAlert', () => svc().testAlert(h.notifyNode))
  handle('slack:permalink', async ({ channelId, ts }) => ({ url: await svc().connector.permalink(channelId, ts) }))

  handle('slackTriggers:list', (q) => svc().listTriggers(q?.workflowId))
  handle('slackTriggers:create', (input) => svc().createTrigger(input))
  handle('slackTriggers:update', ({ id, input }) => svc().updateTrigger(id, input))
  handle('slackTriggers:remove', ({ id }) => svc().removeTrigger(id))
  handle('slackTriggers:setEnabled', ({ id, enabled }) => svc().setTriggerEnabled(id, enabled))
  handle('slackTriggers:test', ({ input, sample }) => svc().testTrigger(input, sample))
  handle('slackTriggers:events', ({ triggerId, limit }) => svc().triggers.events(triggerId, limit ?? 50))
}
