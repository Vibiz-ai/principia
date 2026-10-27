/**
 * CHAT-UI.md §7: who a message typed in "New conversation" brings in, and the words that say so before you send.
 * Pure: no hive, no store, no DOM (conversations.test.ts).
 *
 * routeTeam: the people a new conversation starts with:
 * 1. @all / @team / @everyone (or To: Everyone): the whole active team, at most eight (the responder's cap).
 * 2. @names: exactly those agents ("→ Marcus directly").
 * 3. else the request's words (scoreAgents: role, department and what each seat does): the best match, plus anyone
 *    scoring close to it, at most three ("a post and a hero image" brings in the writer and the designer).
 * 4. else nobody fits: Principia starts with the team's first active agent and says so; an @name changes it.
 */
import type { ForumState } from '@shared/forum'
import { isConversationChannel } from '@shared/forum'
import { mentioned, scoreAgents, stripMention, taskTitleFor, type DeskAgent } from './desk'

/** the Forum responder answers with at most three agents per message routed by words (main/forum/responder.ts) */
export const RESPONDER_MAX = 3
/** …and at most eight in a conversation (RESPONDER_LIMITS.conversationAgents): "Everyone on the team" */
export const EVERYONE_MAX = 8

export type TeamRouteBy = 'everyone' | 'mention' | 'words' | 'lead'
export interface TeamRoute {
  agents: DeskAgent[]
  by: TeamRouteBy
  /** words that picked each agent (by id), for the route line's tooltip and the handoff line */
  why: Record<string, string[]>
  /** an @name nobody in this company has */
  unknown: string | null
}

const MENTIONS = /(^|\s)@([\p{L}\p{N}_-]+)/gu
/** @all, @team, @everyone, @everybody: the whole team (Slack's @channel) */
export const EVERYONE_WORDS = ['all', 'team', 'everyone', 'everybody'] as const
const isEveryone = (w: string): boolean => (EVERYONE_WORDS as readonly string[]).includes(w.toLowerCase())

/** Every @name in the text that is one of the agents, in order, de-duplicated; `everyone` for @all and friends. */
export function mentionedAll(text: string, agents: readonly DeskAgent[]): { found: DeskAgent[]; unknown: string | null; everyone: boolean } {
  const found: DeskAgent[] = []
  let unknown: string | null = null
  let everyone = false
  for (const m of text.matchAll(MENTIONS)) {
    if (isEveryone(m[2]!) && !agents.some((a) => a.name.toLowerCase() === m[2]!.toLowerCase())) {
      everyone = true
      continue
    }
    const a = mentioned(`@${m[2]}`, agents)
    if (a && !found.some((x) => x.id === a.id)) found.push(a)
    else if (!a && !unknown) unknown = m[2]!
  }
  return { found, unknown, everyone }
}

/** The whole active team (everyone when all are paused), at most EVERYONE_MAX. */
export function everyone(agents: readonly DeskAgent[]): DeskAgent[] {
  const active = agents.filter((a) => !a.paused)
  return (active.length ? active : [...agents]).slice(0, EVERYONE_MAX)
}

/** Who a new conversation starts with (see the module doc). null: the company has no agent (a chat with Claude). */
export function routeTeam(text: string, agents: readonly DeskAgent[], opts: { exclude?: readonly string[]; everyone?: boolean } = {}): TeamRoute | null {
  const pool = agents.filter((a) => !opts.exclude?.includes(a.id))
  if (!pool.length) return null
  const { found, unknown, everyone: all } = mentionedAll(text, pool)
  if (opts.everyone || all) return { agents: everyone(pool), by: 'everyone', why: {}, unknown }
  if (found.length) return { agents: found.slice(0, RESPONDER_MAX), by: 'mention', why: {}, unknown }
  const scored = scoreAgents(text, pool)
  if (scored.length) {
    const top = scored[0]!.score
    // a second or third person joins when the words point at them nearly as much (e.g. a post AND an image)
    const picked = scored.filter((s, i) => i === 0 || s.score >= Math.max(2, top * 0.6)).slice(0, RESPONDER_MAX)
    return { agents: picked.map((s) => s.agent), by: 'words', why: Object.fromEntries(picked.map((s) => [s.agent.id, s.why])), unknown }
  }
  const lead = pool.find((a) => !a.paused) ?? pool[0]!
  return { agents: [lead], by: 'lead', why: {}, unknown }
}

/** "Marcus", "Marcus and Vitruvius", "Marcus, Livia and Vitruvius". */
export function names(list: readonly { name: string }[]): string {
  const n = list.map((a) => a.name)
  return n.length <= 1 ? (n[0] ?? '') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`
}

/** The line under the composer, as you type: who will answer before you send. Empty text: what sending does at all. */
export function routeLine(text: string, route: TeamRoute | null): string {
  if (!route) return text.trim() ? '→ A new chat with Claude' : '→ Starts a chat with Claude'
  if (route.by === 'everyone') return `→ Everyone: ${names(route.agents)}`
  if (!text.trim()) return '→ Principia brings in the right people · type @ to pick someone'
  const who = names(route.agents)
  const miss = route.unknown ? `No ${route.unknown} here · ` : ''
  if (route.by === 'mention') return `${miss}→ ${who} directly`
  if (route.by === 'words') return `${miss}→ Principia brings in ${who}`
  return `${miss}→ No clear fit · Principia starts with ${who} (first on the team) · @someone to change`
}

/** The handoff line a conversation opens with: who Principia brought in, and why. */
export function handoffLine(route: TeamRoute, left: readonly { name: string }[] = []): string {
  const out = handoffCore(route)
  return left.length ? `${out} You left out ${names(left)}.` : out
}
/** The handoff line of a private conversation starts so (state/conversations.ts reads it back). */
export const PRIVATE_HANDOFF = 'A private conversation with '
function handoffCore(route: TeamRoute): string {
  const who = route.agents.map((a) => `${a.name} (${a.role})`)
  const list = who.length <= 1 ? who[0] : `${who.slice(0, -1).join(', ')} and ${who[who.length - 1]}`
  if (route.by === 'everyone') return `You asked everyone on the team: ${list}.`
  if (route.by === 'mention') return route.agents.length === 1 ? `${PRIVATE_HANDOFF}${list}. Nobody else on the team sees it.` : `You asked for ${list}.`
  if (route.by === 'words') {
    const words = [...new Set(Object.values(route.why).flat())].slice(0, 3)
    return `Principia brought in ${list}${words.length ? `: the request mentions ${words.map((w) => `“${w}”`).join(', ')}` : ''}.`
  }
  return `Principia brought in ${list}, first on the team: nobody matched the request yet. Type @name to add someone.`
}

/** Longest title shown whole (the sidebar's Recent fits about this much). */
export const TITLE_MAX = 48

/**
 * A conversation's first title: what the request is about, from its FIRST real sentence (the topic comes first: "We're
 * raising the 250g price to $16. Draft a note…" is about the price, not the note), politeness removed, cut at a word,
 * never mid-word. Renamed by you any time.
 */
export function conversationTitle(text: string): string {
  const body = stripMention(text).replace(/\s+/g, ' ').trim()
  const sentences = body.split(/(?<=[.!?:])\s+(?=\S)/).map((x) => x.trim()).filter(Boolean)
  // skip a bare greeting or a two-word aside ("Hey!", "Quick one:")
  const first = sentences.find((x) => x.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length >= 3) ?? sentences[0] ?? ''
  let t = taskTitleFor(first).replace(/[:;,]+$/, '')
  if (t === 'New request') t = ''
  return clipWords(t, TITLE_MAX) || 'New conversation'
}

/** Cuts at the last whole word within `max` characters, with "…" when something was cut. */
export function clipWords(s: string, max: number): string {
  const t = s.trim()
  if (t.length <= max) return t
  const head = t.slice(0, max - 1)
  // the cut lands inside a word: drop that partial word
  const cut = (/\s/.test(t[max - 1] ?? ' ') ? head : head.replace(/\s+\S*$/, '')).replace(/[\s,;:.–-]+$/, '')
  return `${cut || t.slice(0, max - 1)}…`
}

/** The channel slug behind a conversation: chat-<title words>-<4 random>, 2..40 chars (CHANNEL_NAME_RE). */
export function conversationSlug(title: string, rand: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 26)
    .replace(/-+$/g, '')
  return `chat-${base ? `${base}-` : ''}${rand.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4) || 'x'}`
}

/**
 * The conversation a reply run belongs to, from the run's title ("Marcus replying in “Launch plan”", or the older
 * "Replying in “…”"): Live, Working now and ⌘K open the conversation, never the run's internals. null: not a reply run
 * or no such conversation.
 */
export function conversationOfRunTitle<T extends { title: string }>(runTitle: string, convs: readonly T[]): { conv: T | null; who: string | null } | null {
  const m = /^(?:(.+?) )?replying in “(.+?)(?:”|…)?$/i.exec(runTitle.trim())
  if (!m) return null
  const quoted = m[2]!.replace(/[”…]+$/, '').trim()
  const conv = convs.find((c) => c.title === quoted) ?? convs.find((c) => c.title.startsWith(quoted) || quoted.startsWith(c.title.replace(/…$/, ''))) ?? null
  return { conv, who: m[1] && !/^replying$/i.test(m[1]) ? m[1] : null }
}

/** The @word being typed at the caret ("@ma" → "ma"), for the @ picker; null when the caret is not in one. */
export function mentionAtCaret(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret)
  const m = /(^|\s)@([\p{L}\p{N}_-]*)$/u.exec(before)
  if (!m) return null
  return { query: m[2]!, start: caret - m[2]!.length - 1 }
}

/** The agents an @ picker offers for `query`: name or role starts with it, then contains it; Everyone first for "a…". */
export function mentionOptions(query: string, agents: readonly DeskAgent[]): DeskAgent[] {
  const q = query.toLowerCase()
  if (!q) return [...agents]
  const starts = agents.filter((a) => a.name.toLowerCase().startsWith(q) || a.role.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)))
  const has = agents.filter((a) => !starts.includes(a) && (a.name.toLowerCase().includes(q) || a.role.toLowerCase().includes(q)))
  return [...starts, ...has]
}

// ---------- the list (state/conversations.ts useConversations) ----------

export interface ConversationRow {
  id: string
  companyId: string
  title: string
  handoff: string
  /** Forum member ids of the agents in it */
  agentMemberIds: string[]
  /** company agent ids of the agents in it */
  agentIds: string[]
  /** the agents' names, for the rows ("Marcus, Cato") and search */
  who: string[]
  /** the agents answering in THIS conversation now (presence in its channel, never another conversation's run) */
  workingIds: string[]
  lastAt: string
  unread: number
  /** someone is answering in it now */
  working: boolean
  /** one agent, you picked them: your private conversation with them */
  private: boolean
}

/** Pure: the conversation rows of a Forum state (conversations.test.ts). */
export function conversationRows(state: Pick<ForumState, 'members' | 'presence' | 'channels'>, companyId: string): ConversationRow[] {
  const agentOf = new Map(state.members.filter((m) => m.kind === 'agent' && m.agentId).map((m) => [m.id, m]))
  return state.channels
    .filter((c) => isConversationChannel(c) && !c.archivedAt)
    .map((c) => {
      const agentMemberIds = c.memberIds.filter((id) => agentOf.has(id))
      // presence is per agent; only a run working IN this channel makes this conversation "answering…"
      const workingIds = state.presence.filter((p) => p.state !== 'idle' && p.channelId === c.id && agentMemberIds.includes(p.memberId)).map((p) => p.memberId)
      return {
        id: c.id,
        companyId,
        title: c.topic || 'Conversation',
        handoff: c.purpose,
        agentMemberIds,
        agentIds: agentMemberIds.map((id) => agentOf.get(id)!.agentId!),
        who: agentMemberIds.map((id) => agentOf.get(id)!.name),
        workingIds,
        lastAt: c.lastMessageAt ?? c.createdAt,
        unread: c.unread,
        working: workingIds.length > 0,
        private: agentMemberIds.length === 1 && c.purpose.startsWith(PRIVATE_HANDOFF)
      }
    })
    .sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0))
}

/** Your private conversation with one agent (the newest), if you have one. */
export function privateWith(rows: readonly ConversationRow[], agentId: string): ConversationRow | null {
  return rows.find((r) => r.private && r.agentIds[0] === agentId) ?? null
}

/** One line of who is in a conversation: "Marcus", "Marcus, Cato", "Private · Seneca". */
export function whoLine(r: Pick<ConversationRow, 'who' | 'private'>): string {
  return r.private ? `Private · ${r.who[0] ?? ''}` : r.who.join(', ') || 'the team'
}

/** Searches a conversation by its title, who is in it and why they were brought in (Chats search, ⌘K). */
export function conversationText(r: ConversationRow): string {
  return [r.title, ...r.who, r.private ? 'private one-on-one' : 'team', r.handoff].join(' ')
}

