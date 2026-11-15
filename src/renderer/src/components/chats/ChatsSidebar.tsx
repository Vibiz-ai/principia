/**
 * Chats switches the sidebar (founder: "too much info" for a second list column): pressing Chats (⌘4) turns the left
 * sidebar itself into the conversations list, same width, same place. Its top keeps you oriented (CHAT-UI.md §7: the
 * synthetic users lost their menu here): "‹ Menu" returns to the menu (also Esc while the list has focus, and ⌘[), and
 * Home, Team and Board stay one click away. Below: New conversation (the same button as the menu's), search (titles,
 * who is in them, what they are about), Everything / Live only, then one list of chats, newest activity first
 * (CHAT-UI.md §9); quiet ones fold under "N older". Right-click › Close takes a chat off the list (PR-59); "N closed" at the bottom keeps them one click
 * away.
 *
 * Orca-simple: Search (inside every Claude session, ⇧⌘F) leads; chats in a project are grouped under it, newest
 * project first, and the project you're working in is a card, so the focus is obvious at a glance.
 */
import { useEffect, useRef, useState } from 'react'
import type { ChatsFilter } from '../../state/store'
import { Icon } from '../Icon'
import { IconButton, Kbd, useTick } from '../ui'
import { CompanyTagged, useScope } from '../CompanyChip'
import { closeChat, navigate, openNewChat, useStore } from '../../state/store'
import { isOlder, lastActivity, OLDER_DAYS } from '../../lib/closedChats'
import { rowKeyOfLive } from '../../lib/liveRow'
import { useTaskChannels } from '../../state/conversations'
import { pausedChatsLine } from '../../state/desk'
import { PRIMARY, viewFor } from '../../lib/nav'
import { CHATS_FILTERS, ChatRow, filterRows, lastChat, rowRank, splitClosed, useChatRows, type ChatRowModel } from './ChatList'
import { openSessionSearch } from '../../shell/SessionSearch'

/** The project (repository) a chat runs in, or null for a chat with no folder. */
export function projectOf(r: ChatRowModel): string | null {
  if (r.kind === 'session') return r.session.repoId ?? null
  if (r.kind === 'agent') return r.chat?.repoId ?? null
  return null
}

/**
 * Rows in list order, with each project's chats pulled together where its newest chat is. Pure.
 * Returns loose rows and project groups interleaved, so the newest work stays on top either way.
 */
export function groupByProject(rows: readonly ChatRowModel[]): ({ kind: 'row'; row: ChatRowModel } | { kind: 'project'; repoId: string; rows: ChatRowModel[] })[] {
  const out: ({ kind: 'row'; row: ChatRowModel } | { kind: 'project'; repoId: string; rows: ChatRowModel[] })[] = []
  const groups = new Map<string, ChatRowModel[]>()
  for (const r of rows) {
    const p = projectOf(r)
    if (!p) {
      out.push({ kind: 'row', row: r })
      continue
    }
    const g = groups.get(p)
    if (g) g.push(r)
    else {
      const list = [r]
      groups.set(p, list)
      out.push({ kind: 'project', repoId: p, rows: list })
    }
  }
  return out
}

export function ChatsSidebar({ onBack }: { onBack: () => void }): React.JSX.Element {
  useTick()
  const view = useStore((s) => s.view)
  const { scope, company, chips } = useScope()
  const filter: ChatsFilter = (view.name === 'chats' && view.filter) || 'all'
  const rows = useChatRows(scope)
  const tasks = useStore((s) => s.tasks)
  const [query, setQuery] = useState('')
  const [showClosed, setShowClosed] = useState(false)
  const [showOlder, setShowOlder] = useState(false)
  const closedChats = useStore((s) => s.closedChats)
  const picked = view.name === 'chats' ? view.chat : undefined
  // PR-59: closed chats are off the list; a search and Live only still reach them (it would be wrong to say nothing is live)
  const split = splitClosed(rows, closedChats, picked)
  const searching = !!query.trim()
  const shown = filterRows(searching || filter === 'live' ? rows : split.open, filter, query)
  // the open conversation: the one picked, else the one ChatsView opened (the last one, else the first row)
  const remembered = lastChat(scope)
  // CHAT-UI.md §7: a company opens Chats on "New conversation" until you pick one (chat=new…); All companies keeps the last
  const pane = (!!scope && !picked) || !!picked?.startsWith('new')
  // a task's chat keeps its parent conversation (or its own task row) selected (CHAT-UI.md §8.6)
  const taskChannels = useTaskChannels(scope)
  const liveOwner = rowKeyOfLive(picked, tasks, taskChannels)
  const cur = pane ? null : liveOwner || (picked && rows.find((r) => r.key === picked)?.key) || (remembered && split.open.find((r) => r.key === remembered)?.key) || split.open[0]?.key || null
  // founder: "too much noise". Tasks live on the Board (here only under Live only, in a search, or open), and a quiet
  // chat with nothing for OLDER_DAYS folds under "Older" until something new happens in it
  const listed = shown.filter((r) => r.kind !== 'task' || filter === 'live' || searching || r.key === cur)
  const fold = !searching && filter !== 'live'
  const older = fold ? listed.filter((r) => r.key !== cur && isOlder(r, rowRank(r))) : []
  const recent = older.length ? listed.filter((r) => !older.includes(r)) : listed
  const counts = { live: rows.filter((r) => r.live).length, all: rows.length }
  const paused = useStore((s) => (scope ? !!s.companies.find((c) => c.id === scope)?.pausedAt : false))
  const listRef = useRef<HTMLDivElement>(null)
  const go = (f: ChatsFilter, c?: string | null): void => void navigate({ name: 'chats', filter: f, ...(c ? { chat: c } : {}) })
  // closing the open chat moves off it: New task in a company, the first open chat in All companies (opening the next
  // row by itself would read it for you)
  const close = (r: ChatRowModel): void => {
    closeChat(r.key, { at: lastActivity(r), rank: rowRank(r) })
    if (cur === r.key) go(filter)
  }
  const row = (r: ChatRowModel): React.JSX.Element => (
    <CompanyTagged key={r.key} companyId={r.companyId} chips={chips}>
      <ChatRow row={r} selected={cur === r.key} onPick={(key) => go(filter, key ?? r.key)} onClose={() => close(r)} />
    </CompanyTagged>
  )
  // ⌘[ goes back to the menu from anywhere while the list is up; Esc does when the focus is in the list
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      const inList = !!(e.target as HTMLElement | null)?.closest?.('.side-chats')
      if ((e.metaKey && !e.ctrlKey && !e.altKey && e.code === 'BracketLeft') || (e.key === 'Escape' && inList && !(e.target as HTMLElement).matches('input'))) {
        e.preventDefault()
        onBack()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onBack])
  const where = company?.name ?? 'any company'
  const repos = useStore((s) => s.repos)
  const project = (g: { repoId: string; rows: ChatRowModel[] }): React.JSX.Element => {
    const focus = g.rows.some((r) => r.key === cur)
    const live = g.rows.filter((r) => r.live).length
    const name = repos.find((x) => x.id === g.repoId)?.name ?? 'Project'
    return (
      <div key={`p:${g.repoId}`} role="group" aria-label={name} className={`side-proj side-proj--chats ${focus ? 'is-focus' : ''}`}>
        <div className="side-proj__head">
          <Icon name="folder" size={13} />
          <span className="side-proj__name">{name}</span>
          <span className="side-proj__n">{live > 0 ? `${live} working` : `${g.rows.length} ${g.rows.length === 1 ? 'chat' : 'chats'}`}</span>
        </div>
        {g.rows.map(row)}
      </div>
    )
  }
  const list = (rs: ChatRowModel[]): React.JSX.Element[] => (searching ? rs.map(row) : groupByProject(rs).map((e) => (e.kind === 'row' ? row(e.row) : project(e))))
  return (
    <div className="side-chats" aria-label="Chats">
      <div className="side-chats__head">
        <button type="button" className="side-chats__back" onClick={onBack} title="Back to the menu (⌘[)" aria-label="Back to the menu">
          <Icon name="chevronLeft" size={14} />
          <span>Menu</span>
        </button>
        <span className="flex1" />
        <nav className="side-chats__doors" aria-label="Go to">
          {PRIMARY.filter((d) => d.key !== 'chats' && d.key !== 'knowledge').map((d) => (
            <IconButton key={d.key} icon={d.icon} label={`${d.label} (${d.kbd})`} onClick={() => void navigate(viewFor(d.key))} />
          ))}
        </nav>
      </div>
      <button type="button" className="side-search side-search--top" onClick={openSessionSearch} title="Search everything you and Claude said in your sessions (⇧⌘F)">
        <Icon name="search" size={14} />
        <span className="side-search__text">Search</span>
        <Kbd>⇧⌘F</Kbd>
      </button>
      <button type="button" className="cx-side-new" data-chatux="new-conversation" aria-current={pane ? 'page' : undefined} onClick={() => openNewChat(scope)} title={company ? `New chat in ${company.name} (⌥⌘N)` : 'New chat (⌥⌘N)'}>
        <Icon name="edit" size={14} />
        <span>New chat</span>
        <Kbd>⌥⌘N</Kbd>
      </button>
      <label className="side-chats__search">
        <Icon name="search" size={13} />
        <input
          className="side-chats__input"
          placeholder="Filter chats"
          value={query}
          aria-label="Filter chats"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              if (query) setQuery('')
              else listRef.current?.querySelector<HTMLElement>('.chats5-row')?.focus()
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              listRef.current?.querySelector<HTMLElement>('.chats5-row')?.focus()
            }
          }}
        />
      </label>
      <div className="side-chats__filters" role="tablist" aria-label="Show">
        {CHATS_FILTERS.map((f) => {
          const on = f.value === 'live' ? filter === 'live' : filter !== 'live'
          return (
            <button key={f.value} type="button" role="tab" aria-selected={on} className={`side-chats__filter ${on ? 'is-on' : ''}`} onClick={() => go(f.value, picked)}>
              {f.label}
              {f.value === 'live' && counts.live > 0 && <span className="side-chats__n">{counts.live}</span>}
            </button>
          )
        })}
      </div>
      {paused && scope && <div className="chats5-paused">{pausedChatsLine(scope)}</div>}
      <div
        className="side-chats__rows"
        role="listbox"
        aria-label="Conversations"
        ref={listRef}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
          const items = [...(listRef.current?.querySelectorAll<HTMLElement>('.chats5-row') ?? [])]
          const i = items.indexOf(document.activeElement as HTMLElement)
          const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
          if (next) {
            e.preventDefault()
            next.focus()
          }
        }}
      >
        {shown.length === 0 && (
          <div className="side-chats__empty">
            {query
              ? `No chat matches “${query}”.`
              : filter === 'live'
                ? `Nothing is live in ${where} right now. Every conversation is under All.`
                : split.closed.length
                  ? 'All clear: every chat here is closed. They come back when something new happens.'
                  : company
                  ? `No conversations in ${company.name} yet. New task starts one; it stays inside ${company.name}.`
                  : 'No chats yet. Ask Claude or Codex anything.'}
          </div>
        )}
        {list(recent)}
        {older.length > 0 && (
          <div role="group" aria-label="Older" data-group="older">
            <button type="button" className="side-chats__more" data-chatux="older-more" aria-expanded={showOlder} title={`Nothing new in ${OLDER_DAYS} days`} onClick={() => setShowOlder((x) => !x)}>
              {showOlder ? 'Hide older' : `${older.length} older`}
            </button>
            {showOlder && list(older)}
          </div>
        )}
        {!searching && filter !== 'live' && split.closed.length > 0 && (
          <div role="group" aria-label="Closed" data-group="closed">
            <button type="button" className="side-chats__more" data-chatux="closed-more" aria-expanded={showClosed} onClick={() => setShowClosed((x) => !x)}>
              {showClosed ? 'Hide closed' : `${split.closed.length} closed`}
            </button>
            {showClosed && split.closed.map(row)}
          </div>
        )}
      </div>
    </div>
  )
}
