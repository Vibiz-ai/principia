/**
 * AskPort on the live hub (SLACK.md §8.3, D7): a Slack draft is an Ask (kind 'slack_reply', channel 'slack') on the
 * caller's agent (session root or step root), so it reuses Needs you, the coalesced notifications, the tray and the
 * badge. The Ask outlives its step: run-end and boot cleanup skip asks with slack_draft_id (liveStore).
 */
import { newId } from '../../../shared/ids'
import type { Ask } from '../../../shared/live'
import type { Hive } from '../../hive'
import type { AskPort, SlackDraftOwner } from './core/ports'

const DAY = 86400_000

export function createSlackAskPort(h: Hive): AskPort {
  const rootFor = (o: SlackDraftOwner) => {
    if (!h.live) return null
    if (o.agentId) {
      const a = h.live.getAgent(o.agentId)
      if (a) return h.live.getAgent(a.rootId) ?? a
    }
    if (o.sessionId) return h.live.rootOfSession(o.sessionId)
    if (o.stepId) return h.live.rootOfStep(o.stepId)
    return null
  }
  return {
    async open(a) {
      const root = rootFor(a.owner)
      if (!root) return null
      const now = new Date()
      const ask: Ask = {
        id: newId('ask'),
        agentId: root.id,
        rootId: root.rootId,
        sessionId: a.owner.sessionId ?? root.sessionId,
        runId: a.owner.runId ?? root.runId,
        stepId: a.owner.stepId ?? root.stepId,
        provider: root.provider,
        kind: 'slack_reply',
        channel: 'slack',
        title: a.title.slice(0, 200),
        detail: a.owner.label.slice(0, 300),
        toolName: null,
        toolInput: null,
        question: a.question.slice(0, 2000),
        options: [
          { id: 'send', label: 'Send', kind: 'allow' },
          { id: 'discard', label: 'Discard', kind: 'deny' }
        ],
        status: 'open',
        answer: null,
        answeredVia: null,
        createdAt: now.toISOString(),
        answeredAt: null,
        expiresAt: new Date(now.getTime() + 7 * DAY).toISOString(),
        slackDraftId: a.draftId
      }
      const stored = h.live.insertAsk(ask)
      h.onLiveEvent({ type: 'ask.updated', ask: stored })
      return stored.id
    },
    async close(askId, outcome, answer) {
      if (!h.live) return
      const cur = h.live.getAsk(askId)
      if (!cur || cur.status !== 'open') return
      const u = h.live.updateAsk(askId, {
        status: outcome === 'answered' ? 'answered' : 'canceled',
        answer: answer ? { askId, optionId: answer.optionId, ...(answer.message ? { message: answer.message } : {}) } : null,
        answeredVia: outcome === 'answered' ? 'hive' : null,
        answeredAt: new Date().toISOString()
      })
      h.onLiveEvent({ type: 'ask.updated', ask: u })
    }
  }
}
