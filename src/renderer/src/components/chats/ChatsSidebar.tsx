/**
 * Chats switches the sidebar (founder: "too much info" for a second list column): pressing Chats (⌘4) turns the left
 * sidebar itself into the conversations list, same width, same place. Its top keeps you oriented (CHAT-UI.md §7: the
 * synthetic users lost their menu here): "‹ Menu" returns to the menu (also Esc while the list has focus, and ⌘[), and
 * Home, Team and Board stay one click away. Below: New conversation (the same button as the menu's), search (titles,
 * who is in them, what they are about), Everything / Live only, then the conversations in groups: With the team,
 * One-on-one, Agent sessions, Claude, Working. Right-click › Close takes a chat off the list (PR-59); "N closed" at the
 * bottom keeps them one click away.
 */
import { useEffect, useRef, useState } from 'react'
import type { ChatsFilter } from '../../state/store'
import { Icon } from '../Icon'
import { IconButton, Kbd, useTick } from '../ui'
import { CompanyTagged, useScope } from '../CompanyChip'
import { closeChat, navigate, openNewChat, useStore } from '../../state/store'
import { rowKeyOfLive } from '../../lib/liveRow'
import { useTaskChannels } from '../../state/conversations'
import { pausedChatsLine } from '../../state/desk'
import { PRIMARY, viewFor } from '../../lib/nav'
import { CHATS_FILTERS, ChatRow, filterRows, groupRows, lastChat, rowRank, splitClosed, useChatRows, visibleRows, type ChatGroup, type ChatRowModel } from './ChatList'

export function ChatsSidebar({ onBack }: { onBack: () => void }): React.JSX.Element {
  useTick()
  const view = useStore((s) => s.view)
  const { scope, company, chips } = useScope()
  const filter: ChatsFilter = (view.name === 'chats' && view.filter) || 'all'
  const rows = useChatRows(scope)
  const tasks = useStore((s) => s.tasks)
  const [query, setQuery] = useState('')
  // PR-47: each group shows its first few rows until you ask for the rest (a search always shows every match)
  const [expanded, setExpanded] = useState<Partial<Record<ChatGroup, boolean>>>({})
  const [showClosed, setShowClosed] = useState(false)
  const closedChats = useStore((s) => s.closedChats)
  const picked = view.name === 'chats' ? view.chat : undefined
  // PR-59: closed chats are off the list; a search and Live only still reach them (it would be wrong to say nothing is live)
  const split = splitClosed(rows, closedChats, picked)
  const searching = !!query.trim()
  const shown = filterRows(searching || filter === 'live' ? rows : split.open, filter, query)
  // the open conversation: the one picked, else the one ChatsView opened (the last one, else the first row)
  const remembered = lastChat(scope)
  // CHAT-UI.md §7: a company opens Chats on "New conversation" until you pick one (chat=new…); All companies keeps the last
  const pane = !!scope && (!picked || picked.startsWith('new'))
  // a task's chat keeps its parent conversation (or its own task row) selected (CHAT-UI.md §8.6)
  const taskChannels = useTaskChannels(scope)
  const liveOwner = rowKeyOfLive(picked, tasks, taskChannels)
  const cur = pane ? null : liveOwner || (picked && rows.find((r) => r.key === picked)?.key) || (remembered && split.open.find((r) => r.key === remembered)?.key) || split.open[0]?.key || null
  const counts = { live: rows.filter((r) => r.live).length, all: rows.length }
  const paused = useStore((s) => (scope ? !!s.companies.find((c) => c.id === scope)?.pausedAt : false))
  const listRef = useRef<HTMLDivElement>(null)
  const go = (f: ChatsFilter, c?: string | null): void => void navigate({ name: 'chats', filter: f, ...(c ? { chat: c } : {}) })
  // closing the open chat moves off it: New task in a company, the first open chat in All companies (opening the next
  // row by itself would read it for you)
  const close = (r: ChatRowModel): void => {
    closeChat(r.key, { at: r.at, rank: rowRank(r) })
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
      <button type="button" className="cx-side-new" data-chatux="new-conversation" aria-current={pane ? 'page' : undefined} onClick={() => openNewChat(scope)} title={company ? `New task in ${company.name} (⌥⌘N)` : 'New chat (⌥⌘N)'}>
        <Icon name="edit" size={14} />
        <span>New task</span>
        <Kbd>⌥⌘N</Kbd>
      </button>
      <label className="side-chats__search">
        <Icon name="search" size={13} />
        <input
          className="side-chats__input"
          placeholder="Search chats"
          value={query}
          aria-label="Search chats"
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
        {groupRows(shown).map((g) => {
          const open = !!expanded[g.group]
          const cut = visibleRows(g.group, g.rows, { expanded: false, selected: cur })
          const vis = open || searching ? { rows: g.rows, hidden: 0 } : cut
          return (
            <div key={g.group} role="group" aria-label={g.label} data-group={g.group}>
              <div className="cx-side-group">{g.label}</div>
              {vis.rows.map(row)}
              {!searching && cut.hidden > 0 && (
                <button type="button" className="side-chats__more" data-chatux="group-more" aria-expanded={open} onClick={() => setExpanded((x) => ({ ...x, [g.group]: !open }))}>
                  {open ? 'Show less' : `Show ${cut.hidden} more`}
                </button>
              )}
            </div>
          )
        })}
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
