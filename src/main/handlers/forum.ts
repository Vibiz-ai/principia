/**
 * FORUM.md §9: the forum:* channels. The viewer is always the company's owner (one human on this Mac, §0.9); every
 * rule is checked again by ForumStore / ForumService (policy.ts), and every id is resolved to its own company, never
 * one the renderer names.
 */
import { HiveError } from '../../shared/errors'
import type { Hive } from '../hive'
import { handle } from '../ipc'
import type { ForumService } from '../forum/service'

export function registerForumHandlers(h: Hive): void {
  const svc = (): ForumService => {
    const s = h.forum
    if (!s) throw new HiveError('not_implemented', 'The Forum is not available in this Principia')
    s.assertEnabled()
    return s
  }
  /** the owner of the company a row belongs to */
  const meOf = (companyId: string) => svc().me(companyId).id
  const channelCompany = (channelId: string) => svc().store.channel(channelId).companyId
  const messageCompany = (messageId: string) => svc().store.message(messageId).companyId

  handle('forum:state', ({ companyId }) => {
    const s = svc()
    // CHAT-UI.md §7.1: older conversations get a real title once (background, one call at a time)
    s.pilot?.backfill(companyId)
    return s.state(companyId)
  })
  handle('forum:messages', ({ companyId, channelId, beforeSeq, limit }) => {
    const s = svc()
    const me = meOf(companyId)
    if (channelCompany(channelId) !== companyId) throw new HiveError('not_found', 'Channel not found')
    s.store.assertCanRead(me, channelId)
    const n = limit ?? 60
    const page = s.store.messages(channelId, { beforeSeq, limit: n + 1 })
    const hasMore = page.length > n
    return { messages: hasMore ? page.slice(1) : page, hasMore }
  })
  handle('forum:thread', ({ messageId }) => {
    const s = svc()
    const companyId = messageCompany(messageId)
    const me = meOf(companyId)
    const t = s.store.thread(messageId)
    s.store.assertCanRead(me, t.root.channelId)
    s.store.markThreadRead(me, t.root.seq)
    return t
  })
  handle('forum:post', ({ companyId, channelId, text, threadId, ask, proposal }) => {
    const s = svc()
    if (channelCompany(channelId) !== companyId) throw new HiveError('not_found', 'Channel not found')
    const me = meOf(companyId)
    for (const id of ask?.to ?? []) if (s.store.member(id)?.companyId !== companyId) throw new HiveError('not_found', 'Member not found')
    const msg = s.store.post(me, {
      channelId, text, threadId: threadId ?? null,
      ...(ask ? { kind: 'ask' as const, ask: { status: 'open' as const, to: ask.to.filter((id) => id !== me), ...(ask.options ? { options: ask.options } : {}) } } : {}),
      ...(proposal ? { kind: 'proposal' as const, proposal: { ...proposal, status: 'open' as const } } : {})
    })
    // a reply in an open ask's thread answers it (§6): the asking agent gets the answer, no extra reply run
    let answered = false
    if (msg.threadId) {
      const root = s.store.message(msg.threadId)
      if (root.kind === 'ask' && root.ask?.status === 'open') {
        try {
          s.answer(root.id, me, text, msg.id)
          answered = true
        } catch {
          /* not the asked person: it stays a reply */
        }
      }
    }
    // §6.4: everything else a person writes wakes the agents it is for
    if (!answered && !proposal) s.humanPosted(msg)
    return msg
  })
  handle('forum:edit', ({ messageId, text }) => svc().store.edit(meOf(messageCompany(messageId)), messageId, text))
  handle('forum:react', ({ messageId, emoji }) => svc().store.react(meOf(messageCompany(messageId)), messageId, emoji))
  handle('forum:markRead', ({ channelId, seq }) => {
    svc().store.markRead(meOf(channelCompany(channelId)), channelId, seq)
  })
  handle('forum:createChannel', ({ companyId, name, kind, purpose, memberIds }) => svc().store.createChannel(meOf(companyId), { name, kind, purpose, memberIds }))
  handle('forum:startConversation', (req) => {
    const s = svc()
    if (!s.pilot) throw new HiveError('not_implemented', 'Conversations are not available in this Principia')
    s.store.sync(req.companyId)
    for (const agentId of req.agentIds ?? []) if (s.store.memberForAgent(agentId)?.companyId !== req.companyId) throw new HiveError('not_found', 'Agent not found')
    return s.pilot.start(req).channel
  })
  handle('forum:updateChannel', ({ channelId, ...patch }) => svc().store.updateChannel(meOf(channelCompany(channelId)), channelId, patch))
  handle('forum:membership', (q) => {
    const s = svc()
    if (q.op === 'remove') {
      const m = s.store.mustMember(q.memberId)
      s.store.removeMember(meOf(m.companyId), q.memberId)
      return
    }
    const me = meOf(channelCompany(q.channelId))
    if (q.op === 'add') s.store.addMembers(me, q.channelId, q.memberIds)
    else if (q.op === 'join') s.store.join(me, q.channelId)
    else s.store.leave(me, q.channelId)
  })
  handle('forum:openDm', ({ companyId, memberIds }) => svc().store.openDm(meOf(companyId), memberIds))
  handle('forum:search', ({ companyId, query, limit }) => svc().store.search(companyId, meOf(companyId), query, limit))
  handle('forum:decide', (req) => svc().decide(req, meOf(messageCompany(req.messageId))))
  handle('forum:answer', ({ messageId, answer }) => svc().answer(messageId, meOf(messageCompany(messageId)), answer))
  handle('forum:invite', ({ companyId, ...input }) => svc().store.createInvite(meOf(companyId), input))
  handle('forum:invites', ({ companyId }) => svc().store.invites(companyId, meOf(companyId)))
  handle('forum:revokeInvite', ({ inviteId }) => {
    const s = svc()
    const row = s.store.db.prepare('SELECT company_id FROM forum_invites WHERE id=?').get(inviteId) as { company_id: string } | undefined
    if (!row) throw new HiveError('not_found', 'Invite not found')
    return s.store.revokeInvite(meOf(row.company_id), inviteId)
  })
  handle('forum:acceptInvite', (req) => svc().store.acceptInvite(req))
  handle('forum:collab', ({ companyId }) => svc().collabState(companyId))
  handle('forum:runConversation', ({ runId }) => {
    const s = h.forum
    if (!s || !s.enabled()) return null
    const run = h.db.prepare('SELECT company_id FROM runs WHERE id=?').get(runId) as { company_id: string | null } | undefined
    if (!run?.company_id) return null
    return s.runConversation(runId)
  })
  handle('forum:toTask', ({ messageId, agentId }) => svc().toTask(messageId, meOf(messageCompany(messageId)), agentId ?? null))
}
