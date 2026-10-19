/** agents:* and asks:* IPC handlers (CONTRACT §12.6, LIVE.md §4.3, §6). Rows were redacted when persisted. */
import type { AgentDetail, AgentStatus } from '../../shared/live'
import { HiveError } from '../../shared/errors'
import type { Hive } from '../hive'
import { handle, onSend } from '../ipc'

const LIVE: AgentStatus[] = ['starting', 'working', 'needs_you', 'idle']

export function registerAgentHandlers(h: Hive): void {
  handle('agents:list', (q) => h.live.listAgents(q ?? { status: LIVE }))
  handle('agents:get', ({ id, eventsLimit }): AgentDetail => {
    const agent = h.live.getAgent(id)
    if (!agent) throw new HiveError('not_found', 'Agent not found')
    return {
      agent,
      descendants: h.live.descendants(id),
      events: h.live.listEvents(id, { limit: eventsLimit ?? 200 }),
      // root: every ask of its tree; subagent: its own and its descendants'
      asks: (() => {
        const all = h.live.asksForRoot(agent.rootId)
        if (agent.parentId === null) return all
        const mine = new Set([id, ...h.live.descendants(id).map((x) => x.id)])
        return all.filter((a) => mine.has(a.agentId))
      })()
    }
  })
  handle('agents:events', ({ agentId, beforeSeq, limit }) => {
    if (!h.live.getAgent(agentId)) throw new HiveError('not_found', 'Agent not found')
    return h.live.listEvents(agentId, { beforeSeq, limit })
  })
  handle('agents:reply', ({ agentId, text }) => {
    const a = h.live.getAgent(agentId)
    if (!a) throw new HiveError('not_found', 'Agent not found')
    if (!a.sessionId || a.parentId !== null) throw new HiveError('conflict', 'Only a live terminal session can take a reply')
    h.sessionLive.reply(agentId, text)
  })

  handle('asks:list', (q) => h.live.listAsks(q ?? { status: 'open' }))
  handle('asks:answer', async (a) => {
    const ask = h.live.getAsk(a.askId)
    if (!ask) throw new HiveError('not_found', 'Request not found')
    if (ask.status !== 'open') throw new HiveError('conflict', 'Already answered in the terminal')
    if (a.optionId && !ask.options.some((o) => o.id === a.optionId)) throw new HiveError('bad_request', 'That option is not offered')
    if (ask.options.find((o) => o.id === a.optionId)?.kind === 'focus') throw new HiveError('bad_request', 'Open the terminal to answer this')
    // SLACK.md §8.3: a Slack draft card answered from the hub / tray = slack:draftDecide (message = edited text)
    if (ask.kind === 'slack_reply' && ask.slackDraftId) {
      if (!h.slack) throw new HiveError('internal', 'Slack is not available')
      if (a.optionId !== 'send' && a.optionId !== 'discard') throw new HiveError('bad_request', 'Choose Send or Discard')
      await h.slack.draftDecide(ask.slackDraftId, a.optionId, a.message)
      h.statusChanged()
      return h.live.getAsk(ask.id) ?? ask
    }
    // AUTHORING.md §2.3: an approval card answered from the hub / tray = author:decide
    if (ask.kind === 'approval' && ask.draftId) {
      if (!h.author) throw new HiveError('internal', 'Authoring is not available')
      if (a.optionId !== 'approve' && a.optionId !== 'reject') throw new HiveError('bad_request', 'Choose Approve or Reject')
      h.author.decide({ id: ask.draftId, decision: a.optionId, note: a.message })
      h.statusChanged()
      return h.live.getAsk(ask.id) ?? ask
    }
    if (ask.runId) {
      const asks = h.engine.asks
      if (!asks) throw new HiveError('internal', 'Answering run requests is not available yet')
      return asks.answer(ask.id, a)
    }
    if (ask.sessionId) {
      const r = h.sessionLive.answer(ask, a)
      h.statusChanged()
      return r
    }
    throw new HiveError('conflict', 'This request has no live owner')
  })

  onSend('ui:visibleOwner', (v) => h.setVisibleOwner(v))
}
