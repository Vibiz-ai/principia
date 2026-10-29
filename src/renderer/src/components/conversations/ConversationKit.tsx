/**
 * CHAT-UI.md §7: where you talk, who answers, where it goes.
 * - TeamComposer: "New conversation…" with **To: Principia picks ▾** (Everyone on the team, Talk to one person, or
 *   outside the team: Claude directly, Claude in <repository>) and a line under it that says, before you send, who
 *   will answer (lib/conversations.ts routeTeam, the same rules Principia uses). Typing @ opens a picker of the team
 *   with each role. Send starts a conversation (state/conversations.ts) and the caller opens it in Chats; a person you
 *   already talk to privately gets the message in that same private conversation (one thread per person).
 * - ConversationThread: one conversation: title (Principia names it from the first message and answer; click to
 *   rename, and your name is kept), who is in it (and "Private" when it is just you and them), Principia's handoff
 *   line, "Principia is reading your request…" while it picks, every message, a new-specialist card when nobody on
 *   the team fits (HireCard), "Marcus is working…" while an answer is on its way, and a reply box where @name (or
 *   @all) adds someone.
 * - RecentConversations: the last few conversations with who is in each, a shimmer while someone answers in it.
 * - CHAT-UI.md §8: a task that stops for you asks here, as its filer's message (with Connect buttons for the services
 *   it names and its options); you answer in the reply box ("Replying to VO-15's question" after the card's Answer).
 * - CHAT-UI.md §8.5: while a task filed here is queued, working or needs you, its live card is docked right above the
 *   reply box (TaskDock) and its card in the history is a one-line reference; the message list scrolls above the dock.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { ForumMessage } from '@shared/forum'
import type { Id } from '@shared/types'
import type { TaskCardState } from '@shared/taskCard'
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
import { loadDraft, privateWith, replyInConversation, renameConversation, saveDraft, startConversation, useConversationMessages, useConversations, useTaskChannels, whoLine } from '../../state/conversations'
import { byWork, workLine, workOf, workRank } from '../../lib/convWork'
import { useIsCode } from '../desk/Desk'
import { navigate, startSession, toast, useStore } from '../../state/store'
import { hive } from '../../lib/hive'
import { dropMentions, useFileDrop, usePendingAttachments, withMentions } from '../../lib/dropFiles'
import { TASK_ASK_REPLY_EVENT, TaskCard, TaskCardRef, TaskDock, useDockPrefs, useDockView, useStripItems, WorkingStrip, type TaskAskReply } from './TaskCard'
import { ConnectionSlot } from '../connections/ConnectionSlot'
import { cardsOfMessages, connectToolsIn, isOpenTaskQuestion, questionText } from '../../lib/taskCardView'
import { HireCard } from './HireCard'
import '../../styles/conversations.css'

/**
 * A box that only carries text takes dropped or pasted files as @path mentions (images too: the agent opens them).
 * `current` reads the box's text at drop time; `set` writes it back with the mentions added.
 */
export async function addDroppedFiles(files: FileList | File[], current: () => string, set: (t: string) => void): Promise<void> {
  const { mentions, skipped } = await dropMentions(files, {
    pathFor: (f) => hive.pathForFile?.(f) ?? '',
    saveImage: async (data, type) => (await hive.sessions.saveImage({ data, type })).path
  })
  if (mentions.length) set(withMentions(current(), mentions))
  if (skipped.length) toast(`Couldn't attach ${skipped.join(', ')}: drop a file from Finder, or a PNG, JPEG, GIF or WebP image.`, 'error')
}

/** What a drop does, over the box (or the New conversation page) while files are dragged over it. */
export function DropHint(): React.JSX.Element {
  return (
    <div className="cx-drop" data-chatux="drop-hint" aria-hidden>
      <Icon name="plus" size={16} />
      <span>Drop to attach: images and files go in by their path, so whoever answers can open them</span>
    </div>
  )
}

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

export function TeamComposer({
  companyId,
  onStarted,
  autoFocus = false,
  initialTo,
  variant = 'home',
  dropRef
}: {
  companyId: Id
  onStarted: (conversationId: Id) => void
  autoFocus?: boolean
  initialTo?: To
  variant?: 'home' | 'pane'
  /** the page around it (New conversation) takes files dropped anywhere on it and hands them in through this */
  dropRef?: React.MutableRefObject<((files: FileList | File[]) => void) | null>
}): React.JSX.Element {
  const agents = useDeskAgents(companyId)
  const allRepos = useStore((s) => s.repos)
  const repos = useMemo(() => reposOf(allRepos, companyId), [allRepos, companyId])
  const convs = useConversations(companyId)
  const draftKey = `new:${companyId}`
  const [text, setTextRaw] = useState(() => loadDraft(draftKey))
  // the latest text, for a Send that waited for an attachment (the render with it may not have happened yet)
  const latest = useRef(text)
  const setText = (t: string): void => {
    latest.current = t
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
  const attaching = usePendingAttachments()
  const attach = (files: FileList | File[]): void => {
    if (busy) return
    void attaching.track(addDroppedFiles(files, () => latest.current, setText)).then(() => ref.current?.focus())
  }
  if (dropRef) dropRef.current = attach
  // with a dropRef the page around takes the drop (and shows where it goes); else this box does
  const drop = useFileDrop(attach, !!dropRef || busy)
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
    if (!text.trim() || busy) return
    setBusy(true)
    try {
      // a screenshot pasted just before Send is still being saved: wait, so its @path goes with the message
      await attaching.settled()
      const t = latest.current.trim()
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
        className={`cx-composer__box ${drop.dragging ? 'is-dropping' : ''}`}
        {...drop.handlers}
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
          aria-label="New task"
          aria-autocomplete="list"
          aria-expanded={mentions.open}
          placeholder={agents.length ? (to.kind === 'agent' && picked ? `Message ${picked.name}…` : to.kind === 'everyone' ? 'Tell everyone…' : 'New task… say what you need') : 'Ask Claude anything…'}
          onChange={(e) => {
            setText(e.target.value)
            mentions.update(e.target.value, e.target.selectionStart)
          }}
          onClick={(e) => mentions.update(e.currentTarget.value, e.currentTarget.selectionStart)}
          onPaste={(e) => {
            // a copied screenshot or file pastes in as an @path; plain text pastes as usual
            if (!e.clipboardData.files.length) return
            e.preventDefault()
            attach(e.clipboardData.files)
          }}
          onKeyDown={(e) => {
            if (mentions.onKeyDown(e)) return
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
        />
        {drop.dragging && <DropHint />}
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
  // CHAT-UI.md §8: the reply answers a task's question (the card's Answer, the question's Reply)
  const [replyTo, setReplyTo] = useState<{ messageId: string; identifier: string } | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  // the list follows new messages while you are at its end (also when the dock above the composer grows or shrinks)
  const atEnd = useRef(true)
  const input = useRef<HTMLTextAreaElement>(null)
  const me = state?.me ?? null
  const agentMembers = (channel?.memberIds ?? []).filter((id) => display(id)?.kind === 'agent')
  // working IN this conversation (a run answering here), never because the same agent works somewhere else
  const busyMembers = new Set((state?.presence ?? []).filter((p) => p.state !== 'idle' && p.channelId === channelId).map((p) => p.memberId))
  useEffect(() => {
    setViewing({ companyId, channelId })
    return () => setViewing(null)
  }, [companyId, channelId])
  // CHAT-UI.md §8.6: what came back while you were away (a task's result, its question) is where the view opens, under a
  // "New" line; opening the conversation marks it read
  const readUpTo = useRef<number | null>(null)
  if (readUpTo.current === null && channel) readUpTo.current = channel.unread > 0 ? channel.lastReadSeq : -1
  const firstNew = readUpTo.current !== null && readUpTo.current >= 0 ? (msgs.find((m) => !m.threadId && m.seq > readUpTo.current! && m.authorId !== me && m.kind !== 'system') ?? null) : null
  const jumped = useRef(false)
  useEffect(() => {
    if (channel?.unread) void markRead(companyId, channelId)
  }, [companyId, channelId, channel?.unread])
  useEffect(() => {
    if (!jumped.current && firstNew && body.current) {
      jumped.current = true
      body.current.querySelector(`[data-msg-id="${firstNew.id}"]`)?.scrollIntoView({ block: 'center' })
      return
    }
    bottom.current?.scrollIntoView({ block: 'end' })
    atEnd.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgs.length])
  useEffect(() => {
    const el = body.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (atEnd.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // CHAT-UI.md §8.5: the tasks filed here that are still open sit in the dock above the composer
  const cards = useMemo(() => cardsOfMessages(msgs), [msgs])
  const cardItems = useStripItems(cards)
  // a card closed with × leaves the dock: its history card is the full card again
  const dockPrefs = useDockPrefs(channelId)
  const { shown: dockShown } = useDockView(cardItems, cards, dockPrefs)
  const docked = useMemo(() => new Map(dockShown.map((t) => [t.taskId, t.state])), [dockShown])
  useEffect(() => {
    input.current?.focus()
    setReplyTo(null)
  }, [channelId])
  useEffect(() => {
    const on = (e: Event): void => {
      const r = (e as CustomEvent<TaskAskReply>).detail
      if (!r || r.channelId !== channelId) return
      setReplyTo({ messageId: r.messageId, identifier: r.identifier })
      input.current?.focus()
    }
    window.addEventListener(TASK_ASK_REPLY_EVENT, on)
    return () => window.removeEventListener(TASK_ASK_REPLY_EVENT, on)
  }, [channelId])
  // the question was answered (here, on the board, on the phone): the reply is an ordinary message again
  const replyOpen = !!replyTo && msgs.some((m) => m.id === replyTo.messageId && isOpenTaskQuestion(m))
  useEffect(() => {
    if (replyTo && !replyOpen) setReplyTo(null)
  }, [replyTo, replyOpen])
  const pending = usePending(msgs, agentMembers, busyMembers, (id) => display(id)?.kind === 'human')
  const said = mentionedAll(text, agents)
  const inIt = (a: DeskAgent): boolean => agentMembers.some((id) => state?.members.find((m) => m.id === id)?.agentId === a.id)
  const adds = (said.everyone ? agents.filter((a) => !a.paused) : said.found).filter((a) => !inIt(a))
  const send = async (): Promise<void> => {
    if (busy || !text.trim()) return
    setBusy(true)
    const ok = await replyInConversation(companyId, channelId, text, agents, replyOpen ? replyTo!.messageId : null)
    setBusy(false)
    if (ok) {
      setText('')
      setReplyTo(null)
    }
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
      <WorkingStrip cards={cards} dock />
      <div
        className="cx-thread__body scroll"
        ref={body}
        onScroll={(e) => {
          const el = e.currentTarget
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {channel?.purpose && (
          <div className="cx-handoff" data-chatux="handoff">
            <span className="cx-handoff__mark" aria-hidden>
              ◆
            </span>
            <span>{channel.purpose}</span>
          </div>
        )}
        {msgs.map((m, i) =>
          m.kind === 'proposal' && m.proposal?.kind === 'agent' ? (
            <HireCard key={m.id} m={m} companyId={companyId} display={display} />
          ) : (
            <Fragment key={m.id}>
            {firstNew?.id === m.id && (
              <div className="cx-new" data-chatux="thread-new" role="separator">
                <span>New</span>
              </div>
            )}
            <MessageBubble
              m={m}
              mine={m.authorId === me}
              head={startsGroup(msgs, i)}
              docked={m.task ? (docked.get(m.task.taskId) ?? null) : null}
              display={display}
              onReply={(id, identifier) => {
                setReplyTo({ messageId: id, identifier })
                input.current?.focus()
              }}
            />
            </Fragment>
          )
        )}
        {channel?.picking && (
          <div className="cx-pending" data-chatux="thread-picking">
            <span className="cx-handoff__mark" aria-hidden>
              ◆
            </span>
            <span className="shimmer-text">Principia is reading your request to bring in the right people…</span>
          </div>
        )}
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
      <TaskDock items={cardItems} cards={cards} companyId={companyId} channelId={channelId} prefs={dockPrefs} />
      <form
        className="cx-thread__reply"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        {replyOpen && (
          <div className="cx-replyto" data-chatux="thread-replyto">
            <Icon name="chat" size={11} />
            <span>Replying to {replyTo!.identifier}&rsquo;s question</span>
            <button type="button" className="cx-replyto__x" aria-label="Not a reply to the question" onClick={() => setReplyTo(null)}>
              ×
            </button>
          </div>
        )}
        <textarea
          ref={input}
          className="cx-composer__input"
          data-chatux="thread-input"
          rows={1}
          value={text}
          disabled={busy}
          maxLength={8000}
          placeholder={replyOpen ? `Your answer for ${replyTo!.identifier}…` : row?.private ? `Message ${whoNames[0]?.name ?? ''}… (@someone brings them in)` : 'Reply, or @someone to add them…'}
          aria-label="Reply"
          aria-autocomplete="list"
          aria-expanded={mentions.open}
          onChange={(e) => {
            setText(e.target.value)
            mentions.update(e.target.value, e.target.selectionStart)
          }}
          onKeyDown={(e) => {
            if (mentions.onKeyDown(e)) return
            if (e.key === 'Escape' && replyOpen && !text) {
              e.preventDefault()
              setReplyTo(null)
              return
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
        />
        {mentions.menu}
        <div className="cx-composer__foot">
          <span className="cx-routeline cx-routeline--static" data-chatux="thread-route">
            {adds.length ? `→ Adds ${names(adds)} to this conversation` : said.found.length ? `→ ${names(said.found)} answers here` : `→ ${names(whoNames)} ${whoNames.length === 1 ? 'answers' : 'answer'} here`}
            {!adds.length && ' · work they start reports back here'}
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

/**
 * A message opens a new group (its author's name and time over it) after someone else's message or a system line,
 * and always for a task's question: "Got it, back on VO-15." and the next question from the same agent read as two
 * messages, not one paragraph.
 */
export function startsGroup(msgs: readonly Pick<ForumMessage, 'authorId' | 'kind' | 'ask'>[], i: number): boolean {
  const m = msgs[i]!
  const prev = msgs[i - 1]
  return !prev || prev.authorId !== m.authorId || prev.kind === 'system' || (m.kind === 'ask' && !!m.ask?.taskId)
}

export function MessageBubble({ m, mine, head, display, onReply, docked = null }: { m: ForumMessage; mine: boolean; head: boolean; display: ReturnType<typeof useMemberDisplay>; onReply?: (messageId: string, identifier: string) => void; docked?: TaskCardState | null }): React.JSX.Element {
  // CHAT-UI.md §8: a task started here is a live card, not a grey line; while it is docked, a one-line reference (§8.5)
  if (m.kind === 'system' && m.task) return docked ? <TaskCardRef card={m.task} state={docked} /> : <TaskCard m={m} />
  if (m.kind === 'system')
    return (
      <div className="cx-handoff cx-handoff--small" data-chatux="thread-msg" data-kind="system" data-msg-id={m.id}>
        <span className="cx-handoff__mark" aria-hidden>
          ◆
        </span>
        <span>{m.text.replace(/#chat-[a-z0-9-]+/g, 'this conversation')}</span>
      </div>
    )
  const d = display(m.authorId)
  const question = m.kind === 'ask' && !!m.ask?.taskId
  return (
    <Bubble mine={mine} head={head} face={<MemberAvatar display={d} size={26} />} who={d?.name ?? ''} role={d?.role ?? null} at={m.createdAt} className={question ? 'is-question' : ''} data={{ 'data-chatux': 'thread-msg', 'data-author': d?.name ?? '', 'data-msg-id': m.id, ...(question ? { 'data-question': m.ask!.status } : {}) }} after={question ? <TaskQuestionActions m={m} onReply={onReply} /> : null}>
      <MarkdownLite text={question ? questionText(m.text, m.ask?.options) : m.text} />
    </Bubble>
  )
}

/**
 * One chat bubble (CHAT-UI.md §7): the face and "Name role · 2m" on the first of a group, yours on the right. The
 * conversation's messages and the task chat's (§8.4) are both drawn with it.
 */
export function Bubble({ mine, head, face, who, role, at, className = '', data, after, children }: { mine: boolean; head: boolean; face?: React.ReactNode; who: string; role?: string | null; at?: string | null; className?: string; data?: Record<string, string>; after?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className={`cx-msg ${mine ? 'is-mine' : ''} ${head ? 'is-head' : ''} ${className}`} {...data}>
      <div className="cx-msg__face">{head && !mine && face}</div>
      <div className="cx-msg__body">
        {head && (
          <div className="cx-msg__who">
            {mine ? 'You' : who}
            {!mine && role && <span className="cx-msg__role">{role}</span>}
            {at && <span className="cx-msg__time">{age(at)}</span>}
          </div>
        )}
        <div className="cx-msg__bubble selectable">{children}</div>
        {after}
      </div>
    </div>
  )
}

/**
 * Under a task's question: Connect for each service it names (the one connection UI, CONNECTIONS.md §4.1), its options
 * as quick answers, and Reply (the composer answers it). Gone once it is answered.
 */
function TaskQuestionActions({ m, onReply }: { m: ForumMessage; onReply?: (messageId: string, identifier: string) => void }): React.JSX.Element | null {
  const tools = useMemo(() => connectToolsIn(m.text), [m.text])
  const known = useStore((s) => s.tasks.find((t) => t.id === m.ask?.taskId)?.identifier ?? null)
  const identifier = known ?? /^([A-Z][A-Z0-9]{0,9}-\d+)\b/.exec(m.text)?.[1] ?? 'the task'
  const [busy, setBusy] = useState(false)
  const options = m.ask?.options ?? []
  if (!isOpenTaskQuestion(m)) {
    // answered: the options stay as a record of what was picked (the bubble no longer lists them in its text)
    if (!options.length || m.ask?.status !== 'answered') return null
    const picked = (m.ask?.answer ?? '').trim().toLowerCase()
    return (
      <div className="cx-question" data-chatux="task-question" data-answered="">
        <div className="cx-question__actions">
          {options.map((o) => (
            <span key={o} className={`cx-question__opt ${picked && o.trim().toLowerCase() === picked ? 'is-picked' : ''}`} data-chatux="task-question-option-done">
              {o}
            </span>
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className="cx-question" data-chatux="task-question">
      {tools.map((tool) => (
        <ConnectionSlot key={tool} companyId={m.companyId} service={tool} variant="row" actions={false} />
      ))}
      <div className="cx-question__actions">
        {options.map((o) => (
          <Button
            key={o}
            size="sm"
            disabled={busy}
            data-chatux="task-question-option"
            onClick={() => {
              setBusy(true)
              void replyInConversation(m.companyId, m.channelId, o, [], m.id).finally(() => setBusy(false))
            }}
          >
            {o}
          </Button>
        ))}
        {onReply && (
          <button type="button" className="link-btn" data-chatux="task-question-reply" onClick={() => onReply(m.id, identifier)}>
            Reply
          </button>
        )}
      </div>
    </div>
  )
}

// ---------- recents ----------

export function RecentConversations({ companyId, limit = 5, onOpen, selected, compact = false, empty }: { companyId: Id; limit?: number; onOpen: (id: Id) => void; selected?: Id | null; compact?: boolean; empty?: string }): React.JSX.Element | null {
  const all = useConversations(companyId)
  const tasks = useStore((s) => s.tasks)
  const taskChannels = useTaskChannels(companyId)
  const code = useIsCode(companyId)
  // CHAT-UI.md §8.6: the conversation whose tasks need you or are at work comes first, so the eye goes there
  const rows = useMemo(() => byWork(all.map((r) => {
    const work = workOf(r.id, tasks, taskChannels, r.unreadTasks)
    return { r, work, rank: Math.max(workRank(work, r.working), r.unread > 0 ? 1 : 0), at: r.lastAt }
  })).slice(0, limit), [all, tasks, taskChannels, limit])
  if (!rows.length) return empty ? <div className="cx-recent__empty">{empty}</div> : null
  return (
    <div className={`cx-recent ${compact ? 'cx-recent--compact' : ''}`} data-chatux="recent">
      {rows.map(({ r, work }) => {
        const open = selected === r.id
        const line = workLine(open ? { ...work, unread: [] } : work, { code })
        const live = r.working || work.working.length > 0
        const needs = work.needs.length > 0
        const unread = !open && (r.unread > 0 || work.unread.length > 0)
        const sub = line ?? (r.working ? `${r.who.filter((_, i) => r.workingIds.includes(r.agentMemberIds[i]!)).join(', ')} answering…` : whoLine(r))
        return (
          <button key={r.id} type="button" className={`cx-recent__row ${live ? 'is-shimmering' : ''} ${open ? 'is-selected' : ''} ${unread || needs ? 'is-unread' : ''}`} data-chatux="recent-row" data-title={r.title} data-work={line ?? undefined} title={`${r.title}\n${whoLine(r)}${line ? ` · ${line}` : r.working ? ' · answering…' : ''}`} onClick={() => onOpen(r.id)}>
            <span className={`cx-recent__dot ${needs ? 'is-needs' : live ? 'is-working' : unread ? 'is-unread' : ''}`} aria-hidden />
            <span className="cx-recent__text">
              <span className={`cx-recent__title ${live ? 'shimmer-text' : ''}`}>{r.title}</span>
              {compact && <span className={`cx-recent__sub ${needs ? 'is-needs' : ''}`}>{sub}</span>}
            </span>
            {!compact && <span className={`cx-recent__who ${line ? 'is-work' : ''}`}>{line ?? whoLine(r)}</span>}
            <span className="cx-recent__age">{age(r.lastAt)}</span>
          </button>
        )
      })}
    </div>
  )
}
