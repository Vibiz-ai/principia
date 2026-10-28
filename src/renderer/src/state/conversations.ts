/**
 * CHAT-UI.md §7: conversations with the team. A conversation is a private Forum channel named `chat-…`
 * (shared/forum.ts isConversationChannel) holding you and the agents Principia brought in; its topic is the title,
 * its purpose the handoff line ("Principia brought in Marcus (Content Writer)…"). The Forum responder wakes its
 * agents on every message (main/forum/responder.ts), so routing stays in Principia, never in a CLI harness. The UI
 * never says "channel" or "Forum".
 *
 * A conversation with ONE agent you picked is your private conversation with them (`private`): picking them again
 * continues it, so there is one thread per person (Team › Message opens it too).
 */
import { useEffect, useMemo } from 'react'
import type { ForumMessage } from '@shared/forum'
import type { Id } from '@shared/types'
import { errorMessage, hive } from '../lib/hive'
import type { DeskAgent } from '../lib/desk'
import { conversationRows, conversationSlug, conversationTitle, everyone, handoffLine, mentionedAll, privateWith, type ConversationRow, type TeamRoute } from '../lib/conversations'

export { conversationRows, conversationText, privateWith, whoLine, type ConversationRow } from '../lib/conversations'
import { getForum, initForumEvents, loadChannel, loadForum, loadThread, post, useForum } from './forum'
import { openChatsIn, toast } from './store'

// ---------- the list ----------

/** Loads the company's Forum once and follows its events. */
export function useForumLoaded(companyId: Id | null | undefined): void {
  useEffect(() => {
    if (!companyId) return
    initForumEvents()
    void loadForum(companyId)
  }, [companyId])
}

/** The company's conversations, newest first. */
export function useConversations(companyId: Id | null | undefined): ConversationRow[] {
  useForumLoaded(companyId)
  const state = useForum((s) => (companyId ? (s.byCompany[companyId]?.state ?? null) : null))
  return useMemo(() => (state && companyId ? conversationRows(state, companyId) : []), [state, companyId])
}

/**
 * "Message Marcus" (Team, the agent page, ⌘K): your private conversation with them, or New conversation already
 * addressed to them. One kind of one-on-one everywhere.
 */
export async function messageAgent(companyId: Id, agentId: Id): Promise<void> {
  await loadForum(companyId).catch(() => undefined)
  const st = getForum().byCompany[companyId]?.state
  const mine = st ? privateWith(conversationRows(st, companyId), agentId) : null
  openChatsIn(companyId, mine ? `conv:${mine.id}` : `new:agent:${agentId}`)
}

// ---------- start, reply ----------

let starting = false
/**
 * Starts a conversation (main: forum:startConversation): the channel titled by your first words, the handoff line,
 * your message. People you picked (To: a person, @names, Everyone) answer at once; with "Principia picks" (route by
 * words, or no clear fit) main reads the request against the team and brings in the best fit, or proposes a new
 * specialist in the conversation (CHAT-UI.md §7.2); this route is its fallback without a model. Principia renames it
 * from the first message and answer (§7.1). Returns the conversation id, or null (the error is a toast).
 */
export async function startConversation(companyId: Id, text: string, route: TeamRoute, left: readonly DeskAgent[] = []): Promise<Id | null> {
  const t = text.trim()
  if (!t || starting) return null
  starting = true
  try {
    await loadForum(companyId)
    const st = getForum().byCompany[companyId]?.state
    if (!st) throw new Error(getForum().byCompany[companyId]?.error ?? 'Conversations need Companies and Departments (Settings › Experimental)')
    const ids = route.agents.filter((a) => st.members.some((m) => m.agentId === a.id && m.status === 'active')).map((a) => a.id)
    if (!ids.length) throw new Error(`${route.agents.map((a) => a.name).join(', ')} cannot join a conversation yet`)
    const title = conversationTitle(t)
    const picks = route.by === 'words' || route.by === 'lead'
    const purpose = handoffLine(route, left)
    const ch = await hive.forum.startConversation({
      companyId,
      text: t,
      title,
      name: conversationSlug(title, Math.random().toString(36).slice(2, 6)),
      purpose,
      ...(picks ? { pick: { agentIds: ids, handoff: purpose } } : { agentIds: ids })
    })
    void loadForum(companyId)
    return ch.id
  } catch (e) {
    toast(errorMessage(e), 'error')
    return null
  } finally {
    starting = false
  }
}

/** A reply in a conversation. An @name of a teammate not in it adds them first (ChatGPT-style), then they answer. */
export async function replyInConversation(companyId: Id, channelId: Id, text: string, agents: readonly DeskAgent[], threadId?: Id | null): Promise<boolean> {
  const t = text.trim()
  if (!t) return false
  try {
    const st = getForum().byCompany[companyId]?.state
    const ch = st?.channels.find((c) => c.id === channelId)
    // @all adds the whole team; @name adds that teammate (ChatGPT-style), then they answer
    const said = mentionedAll(t, agents)
    const found = said.everyone ? everyone(agents) : said.found
    const add = found.map((a) => st?.members.find((m) => m.agentId === a.id && m.status === 'active')?.id).filter((id): id is string => !!id && !ch?.memberIds.includes(id))
    if (add.length) await hive.forum.membership({ op: 'add', channelId, memberIds: add })
    // CHAT-UI.md §8: a reply to a task's question goes in its thread, so it answers that question
    await post({ companyId, channelId, text: t, ...(threadId ? { threadId } : {}) })
    void loadForum(companyId)
    return true
  } catch (e) {
    toast(errorMessage(e), 'error')
    return false
  }
}

/** Your name for a conversation: Principia never renames it after this (CHAT-UI.md §7.1). */
export async function renameConversation(companyId: Id, channelId: Id, title: string): Promise<void> {
  const t = title.trim().slice(0, 80)
  const cur = getForum().byCompany[companyId]?.state?.channels.find((c) => c.id === channelId)
  if (!t || t === cur?.topic) return
  try {
    await hive.forum.updateChannel({ channelId, topic: t })
    void loadForum(companyId)
  } catch (e) {
    toast(errorMessage(e), 'error')
  }
}

// ---------- drafts ----------

/**
 * What you typed and did not send yet, per box ("new:<company>" for New conversation, "conv:<id>" for a reply): a
 * reload or a trip to the Board never loses it. Per window convenience, so localStorage (and nothing breaks without).
 */
const DRAFT_KEY = 'principia.chatDrafts'
export function loadDraft(key: string): string {
  try {
    return (JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}') as Record<string, string>)[key] ?? ''
  } catch {
    return ''
  }
}
export function saveDraft(key: string, text: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}') as Record<string, string>
    if (text.trim()) all[key] = text.slice(0, 8000)
    else delete all[key]
    // keep the twenty newest boxes
    const keys = Object.keys(all)
    for (const k of keys.slice(0, Math.max(0, keys.length - 20))) delete all[k]
    localStorage.setItem(DRAFT_KEY, JSON.stringify(all))
  } catch {
    /* no storage: the draft lasts while the box is on screen */
  }
}

// ---------- one conversation's messages ----------

/**
 * Every message of a conversation in time order: your messages and each agent's answer (agents answer in the
 * message's thread, so threads are folded in flat), without the Forum's "created #chat-…" line.
 */
export function useConversationMessages(companyId: Id, channelId: Id): ForumMessage[] {
  useForumLoaded(companyId)
  const page = useForum((s) => s.byCompany[companyId]?.pages[channelId] ?? null)
  const threads = useForum((s) => s.byCompany[companyId]?.threads ?? null)
  const lastAt = useForum((s) => s.byCompany[companyId]?.state?.channels.find((c) => c.id === channelId)?.lastMessageAt ?? null)
  useEffect(() => {
    void loadChannel(companyId, channelId)
  }, [companyId, channelId, lastAt])
  const roots = page?.list ?? []
  const replyKey = roots.map((m) => `${m.id}:${m.replyCount}`).join(',')
  useEffect(() => {
    for (const m of roots) if (m.replyCount > 0 && (threads?.[m.id]?.replies.length ?? 0) < m.replyCount) void loadThread(companyId, m.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, replyKey])
  // a reply can land before its root's count changes: poll the open conversation's threads gently while it is fresh
  useEffect(() => {
    const id = setInterval(() => {
      const fresh = roots.filter((m) => Date.now() - Date.parse(m.createdAt) < 5 * 60_000)
      for (const m of fresh) void loadThread(companyId, m.id)
    }, 2500)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, replyKey])
  return useMemo(() => {
    const out: ForumMessage[] = []
    for (const m of roots) {
      if (m.kind === 'system' && /created #chat-|set the topic|changed the topic/i.test(m.text)) continue
      out.push(m)
      for (const r of threads?.[m.id]?.replies ?? []) out.push(r)
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.seq - b.seq))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyKey, roots, threads])
}
