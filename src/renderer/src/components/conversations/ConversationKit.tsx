/**
 * CHAT-UI.md §7: where you talk, who answers, where it goes.
 * - TeamComposer: "New conversation…" with **To: Principia picks ▾** (Everyone on the team, Talk to one person, or
 *   outside the team: Claude directly, Claude in <repository>) and a line under it that says, before you send, who
 *   will answer (lib/conversations.ts routeTeam, the same rules Principia uses). Typing @ opens a picker of the team
 *   with each role. Send starts a conversation (state/conversations.ts) and the caller opens it in Chats; a person you
 *   already talk to privately gets the message in that same private conversation (one thread per person).
 * - ConversationThread: one conversation: title (rename), who is in it (and "Private" when it is just you and them),
 *   Principia's handoff line, every message, "Marcus is working…" while an answer is on its way, and a reply box
 *   where @name (or @all) adds someone.
 * - RecentConversations: the last few conversations with who is in each, a shimmer while someone answers in it.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ForumMessage } from '@shared/forum'
import type { Id } from '@shared/types'
import { Button } from '../ui'
import { Icon } from '../Icon'
import { MemberAvatar, useMemberDisplay } from '../forum/Avatar'
import { MarkdownLite } from '../diagrams/MarkdownLite'
import { reposOf } from '../../lib/companyModel'
import { taskTitleFor, type DeskAgent } from '../../lib/desk'
import { mentionAtCaret, mentionedAll, mentionOptions, names, routeLine, routeTeam, type TeamRoute } from '../../lib/conversations'
import { age } from '../../lib/time'
import { useDeskAgents } from '../../state/desk'
import { useForum, markRead, setViewing } from '../../state/forum'
import { loadDraft, privateWith, replyInConversation, renameConversation, saveDraft, startConversation, useConversationMessages, useConversations, whoLine } from '../../state/conversations'
import { navigate, startSession, useStore } from '../../state/store'
import '../../styles/conversations.css'

/** Opens a conversation in Chats (the one destination after Send, from Home, ⌘K or New conversation). */
export function openConversation(id: Id): void {
  void navigate({ name: 'chats', filter: 'all', chat: `conv:${id}` })
}

// ---------- the composer ----------

export type To = { kind: 'team' } | { kind: 'everyone' } | { kind: 'agent'; id: Id } | { kind: 'claude' } | { kind: 'repo'; id: Id }

/** `to` from a Chats link: "new:agent:<id>" (Team › Message), "new:everyone", else the team. */
export function toFromChat(chat: string | undefined): To {
  const m = /^new:(agent|repo):(.+)$/.exec(chat ?? '')
  if (m) return m[1] === 'agent' ? { kind: 'agent', id: m[2]! } : { kind: 'repo', id: m[2]! }
  if (chat === 'new:everyone') return { kind: 'everyone' }
  if (chat === 'new:claude') return { kind: 'claude' }
  return { kind: 'team' }
}

export function TeamComposer({ companyId, onStarted, autoFocus = false, initialTo, variant = 'home' }: { companyId: Id; onStarted: (conversationId: Id) => void; autoFocus?: boolean; initialTo?: To; variant?: 'home' | 'pane' }): React.JSX.Element {
  const agents = useDeskAgents(companyId)
  const allRepos = useStore((s) => s.repos)
  const repos = useMemo(() => reposOf(allRepos, companyId), [allRepos, companyId])
  const convs = useConversations(companyId)
  const draftKey = `new:${companyId}`
  const [text, setTextRaw] = useState(() => loadDraft(draftKey))
  const setText = (t: string): void => {
    setTextRaw(t)
    saveDraft(draftKey, t)
  }
  const [chosen, setTo] = useState<To>(initialTo ?? { kind: 'team' })
  useEffect(() => {
    if (initialTo) setTo(initialTo)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(initialTo)])
  // a company with no team (Personal, or not loaded yet) talks to Claude
  const to: To = (chosen.kind === 'team' || chosen.kind === 'everyone') && !agents.length ? { kind: 'claude' } : chosen
  const [fresh, setFresh] = useState(false)
  const [menu, setMenu] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])
  const toKey = JSON.stringify(to)
  useEffect(() => setFresh(false), [toKey])
  const picked = to.kind === 'agent' ? agents.find((a) => a.id === to.id) : undefined
  const route: TeamRoute | null =
    to.kind === 'team' || to.kind === 'everyone' ? routeTeam(text, agents, { everyone: to.kind === 'everyone' }) : picked ? { agents: [picked], by: 'mention', why: {}, unknown: null } : null
  // one person (picked, or one @name): your private conversation with them continues, unless you ask for a new topic
  const solo = route && route.by === 'mention' && route.agents.length === 1 ? route.agents[0]! : null
  const existing = solo ? privateWith(convs, solo.id) : null
  const continues = existing && !fresh ? existing : null
  const repoName = (id: Id): string => repos.find((r) => r.id === id)?.name ?? 'the repository'
  const toLabel = to.kind === 'team' ? 'Principia picks' : to.kind === 'everyone' ? 'Everyone on the team' : to.kind === 'agent' ? (picked ? `${picked.name} · ${picked.role}` : 'Someone') : to.kind === 'claude' ? 'Claude directly' : `Claude in ${repoName(to.id)}`
  const line =
    to.kind === 'claude'
      ? '→ A chat with Claude, outside the team · none of your agents see it'
      : to.kind === 'repo'
        ? `→ A Claude Code session in ${repoName(to.id)} (its terminal opens)`
        : continues
          ? `→ ${solo!.name}, in your private conversation “${continues.title}”`
          : solo && (to.kind === 'agent' || !text.trim().startsWith('@') || route?.by === 'mention')
            ? `${route?.unknown ? `No ${route.unknown} here · ` : ''}→ ${solo.name} directly · a private conversation, nobody else sees it`
            : routeLine(text, route)
  const why = route?.by === 'words' ? Object.entries(route.why).map(([id, w]) => `${agents.find((a) => a.id === id)?.name}: ${w.map((x) => `“${x}”`).join(', ')}`).join(' · ') : ''

  const send = async (): Promise<void> => {
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    try {
      if (to.kind === 'claude' || to.kind === 'repo') {
        const s = await startSession({ repoId: to.kind === 'repo' ? to.id : null, forceNew: true, companyId, adapter: 'claude', initialPrompt: t, title: taskTitleFor(t).slice(0, 80), focus: to.kind === 'repo' })
        if (s) {
          setText('')
          if (to.kind === 'claude') void navigate({ name: 'chats', filter: 'all', chat: `session:${s.id}` })
        }
        return
      }
      if (continues) {
        if (await replyInConversation(companyId, continues.id, t, agents)) {
          setText('')
          onStarted(continues.id)
        }
        return
      }
      if (!route) return
      const id = await startConversation(companyId, t, route)
      if (id) {
        setText('')
        onStarted(id)
      }
    } finally {
      setBusy(false)
    }
  }
  const mentions = useMentionPicker({ text, setText, input: ref, agents })

  return (
    <div className={`cx-composer cx-composer--${variant}`} data-chatux="composer">
      <form
        className="cx-composer__box"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <div className="cx-composer__to">
          <span className="cx-composer__to-label" id={`cx-to-${companyId}`}>
            To
          </span>
          <ToPicker
            open={menu}
            setOpen={setMenu}
            label={toLabel}
            to={to}
            agents={agents}
            repos={repos}
            labelledBy={`cx-to-${companyId}`}
            onPick={(t) => {
              setTo(t)
              ref.current?.focus()
            }}
          />
        </div>
        <textarea
          ref={ref}
          className="cx-composer__input"
          data-chatux="composer-input"
          rows={variant === 'pane' ? 3 : 1}
          value={text}
          disabled={busy}
          maxLength={8000}
          aria-label="New conversation"
          aria-autocomplete="list"
          aria-expanded={mentions.open}
          placeholder={agents.length ? (to.kind === 'agent' && picked ? `Message ${picked.name}…` : to.kind === 'everyone' ? 'Tell everyone…' : 'New conversation… say what you need') : 'Ask Claude anything…'}
          onChange={(e) => {
            setText(e.target.value)
            mentions.update(e.target.value, e.target.selectionStart)
          }}
          onClick={(e) => mentions.update(e.currentTarget.value, e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if (mentions.onKeyDown(e)) return
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
        />
        {mentions.menu}
        <div className="cx-composer__foot">
          <button type="button" className="cx-routeline" data-chatux="route-line" onClick={() => setMenu(true)} title={why ? `Why: ${why}. Click to pick who gets it.` : 'Pick who gets it'}>
            {line}
          </button>
          {existing && (
            <button type="button" className="cx-newtopic" data-chatux="new-topic" aria-pressed={fresh} onClick={() => setFresh((v) => !v)} title={fresh ? `Back to your conversation “${existing.title}”` : `Start a separate conversation with ${solo?.name}`}>
              {fresh ? 'Continue instead' : 'New topic'}
            </button>
          )}
          <span className="flex1" />
          <Button type="submit" size="sm" variant="primary" icon="send" data-chatux="composer-send" disabled={busy || !text.trim()} title="Send (↵)" aria-label="Send" />
        </div>
      </form>
    </div>
  )
}

/** The To: menu: a listbox you can drive from the keyboard (↑ ↓, type to filter, ↵ picks, Esc closes). */
function ToPicker({ open, setOpen, label, to, agents, repos, onPick, labelledBy }: { open: boolean; setOpen: (v: boolean) => void; label: string; to: To; agents: DeskAgent[]; repos: { id: Id; name: string }[]; onPick: (t: To) => void; labelledBy: string }): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  type Opt = { to: To; value: string; title: string; sub: string; section?: string; disabled?: boolean; icon?: 'branch' | 'chat' }
  const options: Opt[] = useMemo(() => {
    const out: Opt[] = []
    if (agents.length) {
      out.push({ to: { kind: 'team' }, value: 'team', title: 'Principia picks', sub: 'Brings in whoever fits, up to three' })
      if (agents.length > 1) out.push({ to: { kind: 'everyone' }, value: 'everyone', title: 'Everyone on the team', sub: `All ${Math.min(agents.length, 8)} answer · or type @all` })
      agents.forEach((a, i) => out.push({ to: { kind: 'agent', id: a.id }, value: `agent:${a.name}`, title: a.name, sub: `${a.role}${a.paused ? ' · paused' : ''}`, section: i === 0 ? 'Talk to one person' : undefined, disabled: a.paused }))
    }
    out.push({ to: { kind: 'claude' }, value: 'claude', title: 'Claude directly', sub: 'Plain Claude, not one of your agents', section: 'Outside the team', icon: 'chat' })
    for (const r of repos) out.push({ to: { kind: 'repo', id: r.id }, value: `repo:${r.name}`, title: `Claude in ${r.name}`, sub: 'Code session with its terminal', icon: 'branch' })
    return out
  }, [agents, repos])
  const shown = q ? options.filter((o) => `${o.title} ${o.sub}`.toLowerCase().includes(q.toLowerCase())) : options
  const enabled = shown.filter((o) => !o.disabled)
  useEffect(() => {
    if (!open) return
    setQ('')
    const cur = options.findIndex((o) => JSON.stringify(o.to) === JSON.stringify(to))
    setActive(Math.max(0, cur))
    setTimeout(() => filterRef.current?.focus(), 0)
    const down = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', down)
    return () => window.removeEventListener('mousedown', down)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const pick = (o: Opt | undefined): void => {
    if (!o || o.disabled) return
    onPick(o.to)
    setOpen(false)
  }
  const activeOpt = shown[Math.min(active, shown.length - 1)]
  const move = (d: 1 | -1): void => {
    if (!enabled.length) return
    const i = activeOpt ? enabled.indexOf(activeOpt) : -1
    const next = enabled[(i + d + enabled.length) % enabled.length]!
    setActive(shown.indexOf(next))
  }
  return (
    <div className="cx-to" ref={box}>
      <button
        type="button"
        className="cx-to__pill"
        data-chatux="to-pill"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${labelledBy} cx-to-pill-${labelledBy}`}
        id={`cx-to-pill-${labelledBy}`}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        {(to.kind === 'team' || to.kind === 'everyone') && (
          <span className="cx-to__mark" aria-hidden>
            ◆
          </span>
        )}
        {label}
        <Icon name="chevronDown" size={10} />
      </button>
      {open && (
        <div className="cx-menu" data-chatux="to-menu">
          <input
            ref={filterRef}
            className="cx-menu__filter"
            placeholder="Type a name or role…"
            aria-label="Filter who gets it"
            aria-controls={`cx-to-list-${labelledBy}`}
            aria-activedescendant={activeOpt ? `cx-to-opt-${labelledBy}-${activeOpt.value}` : undefined}
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setActive(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                move(e.key === 'ArrowDown' ? 1 : -1)
              } else if (e.key === 'Enter' || (e.key === 'Tab' && q)) {
                e.preventDefault()
                pick(activeOpt)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setOpen(false)
              }
            }}
          />
          <div role="listbox" id={`cx-to-list-${labelledBy}`} aria-label="Who gets it">
            {shown.length === 0 && <div className="cx-menu__none">Nobody called “{q}”</div>}
            {shown.map((o) => (
              <div key={o.value}>
                {!q && o.section && <div className="cx-menu__sec">{o.section}</div>}
                <div
                  role="option"
                  id={`cx-to-opt-${labelledBy}-${o.value}`}
                  aria-selected={JSON.stringify(o.to) === JSON.stringify(to)}
                  aria-disabled={o.disabled || undefined}
                  className={`cx-menu__row ${o === activeOpt ? 'is-active' : ''} ${o.disabled ? 'is-disabled' : ''}`}
                  data-chatux="to-option"
                  data-value={o.value}
                  onMouseEnter={() => setActive(shown.indexOf(o))}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(o)}
                >
                  {o.to.kind === 'team' || o.to.kind === 'everyone' ? (
                    <span className="cx-to__mark" aria-hidden>
                      ◆
                    </span>
                  ) : o.icon ? (
                    <Icon name={o.icon} size={12} />
                  ) : null}
                  <span className="cx-menu__main">
                    {o.title}
                    <span className="cx-menu__sub">{o.sub}</span>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The @ picker of a text box: typing @ lists the team (name and role), ↑ ↓ move, ↵ or Tab inserts "@Marcus ", Esc
 * closes. "@all" is offered first while it matches (everyone on the team).
 */
function useMentionPicker({ text, setText, input, agents }: { text: string; setText: (t: string) => void; input: React.RefObject<HTMLTextAreaElement | null>; agents: DeskAgent[] }): { open: boolean; menu: React.ReactNode; update: (value: string, caret: number | null) => void; onKeyDown: (e: React.KeyboardEvent) => boolean } {
  const [at, setAt] = useState<{ query: string; start: number } | null>(null)
  const [active, setActive] = useState(0)
  type Opt = { insert: string; title: string; sub: string }
  const options: Opt[] = useMemo(() => {
    if (!at || !agents.length) return []
    const q = at.query.toLowerCase()
    const all: Opt[] = agents.length > 1 && 'all everyone team'.split(' ').some((w) => w.startsWith(q)) ? [{ insert: 'all', title: 'all', sub: 'Everyone on the team' }] : []
    return [...all, ...mentionOptions(at.query, agents).map((a) => ({ insert: a.name, title: a.name, sub: `${a.role}${a.paused ? ' · paused' : ''}` }))].slice(0, 8)
  }, [at, agents])
  const open = options.length > 0
  const update = (value: string, caret: number | null): void => {
    const m = caret == null ? null : mentionAtCaret(value, caret)
    setAt(m)
    setActive(0)
  }
  const choose = (o: Opt | undefined): void => {
    if (!o || !at) return
    const end = at.start + 1 + at.query.length
    const next = `${text.slice(0, at.start)}@${o.insert} ${text.slice(end).replace(/^\s+/, '')}`
    setText(next)
    setAt(null)
    const caret = at.start + o.insert.length + 2
    requestAnimationFrame(() => {
      input.current?.focus()
      input.current?.setSelectionRange(caret, caret)
    })
  }
  const onKeyDown = (e: React.KeyboardEvent): boolean => {
    if (!open) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length)
      return true
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      choose(options[active])
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setAt(null)
      return true
    }
    return false
  }
  const menu = open ? (
    <div className="cx-menu cx-menu--mention" role="listbox" aria-label="Mention someone" data-chatux="mention-menu">
      {options.map((o, i) => (
        <div key={o.insert} role="option" aria-selected={i === active} className={`cx-menu__row ${i === active ? 'is-active' : ''}`} data-chatux="mention-option" data-value={o.insert} onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(o)}>
          <span className="cx-menu__main">
            @{o.title}
            <span className="cx-menu__sub">{o.sub}</span>
          </span>
        </div>
      ))}
    </div>
  ) : null
  return { open, menu, update, onKeyDown }
}

// ---------- one conversation ----------

export function ConversationThread({ companyId, channelId }: { companyId: Id; channelId: Id }): React.JSX.Element {
  const state = useForum((s) => s.byCompany[companyId]?.state ?? null)
  const channel = state?.channels.find((c) => c.id === channelId) ?? null
  const msgs = useConversationMessages(companyId, channelId)
  const display = useMemberDisplay(state?.members ?? [])
  const agents = useDeskAgents(companyId)
  const row = useConversations(companyId).find((c) => c.id === channelId) ?? null
  const draftKey = `conv:${channelId}`
  const [text, setTextRaw] = useState(() => loadDraft(draftKey))
  const setText = (t: string): void => {
    setTextRaw(t)
    saveDraft(draftKey, t)
  }
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const me = state?.me ?? null
  const agentMembers = (channel?.memberIds ?? []).filter((id) => display(id)?.kind === 'agent')
  // working IN this conversation (a run answering here), never because the same agent works somewhere else
  const busyMembers = new Set((state?.presence ?? []).filter((p) => p.state !== 'idle' && p.channelId === channelId).map((p) => p.memberId))
  useEffect(() => {
    setViewing({ companyId, channelId })
    return () => setViewing(null)
  }, [companyId, channelId])
  useEffect(() => {
    if (channel?.unread) void markRead(companyId, channelId)
  }, [companyId, channelId, channel?.unread])
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [msgs.length])
  useEffect(() => {
    input.current?.focus()
  }, [channelId])
  const pending = usePending(msgs, agentMembers, busyMembers, (id) => display(id)?.kind === 'human')
  const said = mentionedAll(text, agents)
  const inIt = (a: DeskAgent): boolean => agentMembers.some((id) => state?.members.find((m) => m.id === id)?.agentId === a.id)
  const adds = (said.everyone ? agents.filter((a) => !a.paused) : said.found).filter((a) => !inIt(a))
  const send = async (): Promise<void> => {
    if (busy || !text.trim()) return
    setBusy(true)
    const ok = await replyInConversation(companyId, channelId, text, agents)
    setBusy(false)
    if (ok) setText('')
    input.current?.focus()
  }
  const mentions = useMentionPicker({ text, setText, input, agents })
  const title = channel?.topic || 'Conversation'
  const whoNames = agentMembers.map((id) => ({ name: display(id)?.name ?? '' }))
  return (
    <section className="cx-thread" data-chatux="thread" data-conversation={channelId} aria-label={`Conversation: ${title}`}>
      <header className="cx-thread__head">
        {renaming !== null ? (
          <input
            className="input input--sm cx-thread__rename"
            autoFocus
            value={renaming}
            aria-label="Conversation title"
            onChange={(e) => setRenaming(e.target.value)}
            onBlur={() => {
              void renameConversation(companyId, channelId, renaming)
              setRenaming(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') {
                e.preventDefault()
                setRenaming(null)
              }
            }}
          />
        ) : (
          <button type="button" className="cx-thread__title" title={`${title} · click to rename`} onClick={() => setRenaming(title)}>
            <span className="cx-thread__title-text">{title}</span> <Icon name="edit" size={11} />
          </button>
        )}
        {row?.private && (
          <span className="cx-private" data-chatux="private" title={`Only you and ${whoNames[0]?.name} see this conversation`}>
            <Icon name="lock" size={10} /> Private
          </span>
        )}
        <span className="flex1" />
        <span className="cx-thread__who" aria-label="In this conversation">
          {agentMembers.map((id) => (
            <span key={id} className="cx-thread__member" title={`${display(id)?.name} · ${display(id)?.role}`}>
              <MemberAvatar display={display(id)} size={20} working={busyMembers.has(id)} />
              <span>{display(id)?.name}</span>
            </span>
          ))}
        </span>
      </header>
      <div className="cx-thread__body scroll">
        {channel?.purpose && (
          <div className="cx-handoff" data-chatux="handoff">
            <span className="cx-handoff__mark" aria-hidden>
              ◆
            </span>
            <span>{channel.purpose}</span>
          </div>
        )}
        {msgs.map((m, i) => (
          <MessageBubble key={m.id} m={m} mine={m.authorId === me} head={i === 0 || msgs[i - 1]!.authorId !== m.authorId || msgs[i - 1]!.kind === 'system'} display={display} />
        ))}
        {pending.map((p) => (
          <div key={p.id} className="cx-pending" data-chatux="thread-pending">
            <MemberAvatar display={display(p.id)} size={20} working />
            <span className="shimmer-text">
              {display(p.id)?.name} is {p.state}…
            </span>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <form
        className="cx-thread__reply"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <textarea
          ref={input}
          className="cx-composer__input"
          data-chatux="thread-input"
          rows={1}
          value={text}
          disabled={busy}
          maxLength={8000}
          placeholder={row?.private ? `Message ${whoNames[0]?.name ?? ''}… (@someone brings them in)` : 'Reply, or @someone to add them…'}
          aria-label="Reply"
          aria-autocomplete="list"
          aria-expanded={mentions.open}
          onChange={(e) => {
            setText(e.target.value)
            mentions.update(e.target.value, e.target.selectionStart)
          }}
          onKeyDown={(e) => {
            if (mentions.onKeyDown(e)) return
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
        />
        {mentions.menu}
        <div className="cx-composer__foot">
          <span className="cx-routeline cx-routeline--static" data-chatux="thread-route">
            {adds.length ? `→ Adds ${names(adds)} to this conversation` : said.found.length ? `→ ${names(said.found)} answers` : `→ ${names(whoNames)} ${whoNames.length === 1 ? 'answers' : 'answer'}`}
          </span>
          <span className="flex1" />
          <Button type="submit" size="sm" variant="primary" icon="send" data-chatux="thread-send" disabled={busy || !text.trim()} aria-label="Send" />
        </div>
      </form>
    </section>
  )
}

/** Who still owes an answer to your last message: "working" while their run is on here, "reading" in the first minutes. */
function usePending(msgs: ForumMessage[], agentMembers: string[], busy: Set<string>, isHuman: (id: string) => boolean): { id: string; state: 'working' | 'reading' }[] {
  let lastHuman = -1
  for (let i = msgs.length - 1; i >= 0; i--)
    if (msgs[i]!.kind !== 'system' && isHuman(msgs[i]!.authorId)) {
      lastHuman = i
      break
    }
  if (lastHuman < 0) return []
  const last = msgs[lastHuman]!
  const asked = last.mentions.filter((id) => agentMembers.includes(id))
  const expect = asked.length ? asked : agentMembers
  const answered = new Set(msgs.slice(lastHuman + 1).map((m) => m.authorId))
  const fresh = Date.now() - Date.parse(last.createdAt) < 3 * 60_000
  return expect.filter((id) => !answered.has(id) && (busy.has(id) || fresh)).map((id) => ({ id, state: busy.has(id) ? 'working' : 'reading' }))
}

function MessageBubble({ m, mine, head, display }: { m: ForumMessage; mine: boolean; head: boolean; display: ReturnType<typeof useMemberDisplay> }): React.JSX.Element {
  if (m.kind === 'system')
    return (
      <div className="cx-handoff cx-handoff--small" data-chatux="thread-msg" data-kind="system">
        <span className="cx-handoff__mark" aria-hidden>
          ◆
        </span>
        <span>{m.text.replace(/#chat-[a-z0-9-]+/g, 'this conversation')}</span>
      </div>
    )
  const d = display(m.authorId)
  return (
    <div className={`cx-msg ${mine ? 'is-mine' : ''} ${head ? 'is-head' : ''}`} data-chatux="thread-msg" data-author={d?.name ?? ''}>
      <div className="cx-msg__face">{head && !mine && <MemberAvatar display={d} size={26} />}</div>
      <div className="cx-msg__body">
        {head && (
          <div className="cx-msg__who">
            {mine ? 'You' : d?.name}
            {!mine && d?.role && <span className="cx-msg__role">{d.role}</span>}
            <span className="cx-msg__time">{age(m.createdAt)}</span>
          </div>
        )}
        <div className="cx-msg__bubble selectable">
          <MarkdownLite text={m.text} />
        </div>
      </div>
    </div>
  )
}

// ---------- recents ----------

export function RecentConversations({ companyId, limit = 5, onOpen, selected, compact = false, empty }: { companyId: Id; limit?: number; onOpen: (id: Id) => void; selected?: Id | null; compact?: boolean; empty?: string }): React.JSX.Element | null {
  const rows = useConversations(companyId).slice(0, limit)
  if (!rows.length) return empty ? <div className="cx-recent__empty">{empty}</div> : null
  return (
    <div className={`cx-recent ${compact ? 'cx-recent--compact' : ''}`} data-chatux="recent">
      {rows.map((r) => (
        <button key={r.id} type="button" className={`cx-recent__row ${r.working ? 'is-shimmering' : ''} ${selected === r.id ? 'is-selected' : ''}`} data-chatux="recent-row" data-title={r.title} title={`${r.title}\n${whoLine(r)}${r.working ? ' · answering…' : ''}`} onClick={() => onOpen(r.id)}>
          <span className={`cx-recent__dot ${r.working ? 'is-working' : r.unread ? 'is-unread' : ''}`} aria-hidden />
          <span className="cx-recent__text">
            <span className={`cx-recent__title ${r.working ? 'shimmer-text' : ''}`}>{r.title}</span>
            {compact && <span className="cx-recent__sub">{r.working ? `${r.who.filter((_, i) => r.workingIds.includes(r.agentMemberIds[i]!)).join(', ')} answering…` : whoLine(r)}</span>}
          </span>
          {!compact && <span className="cx-recent__who">{whoLine(r)}</span>}
          <span className="cx-recent__age">{age(r.lastAt)}</span>
        </button>
      ))}
    </div>
  )
}
