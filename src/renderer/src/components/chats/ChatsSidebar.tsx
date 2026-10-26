/**
 * Chats switches the sidebar (founder: "too much info" for a second list column): pressing Chats (⌘4) turns the left
 * sidebar itself into the conversations list, same width, same place. At its top "‹ Back" returns to the menu (also
 * Esc while the list has focus, and ⌘[); the chat stays open in the main area until you go somewhere else. Below it:
 * New chat, search, the Live / All / Agents / Direct filters, then every conversation like a list of bots.
 */
import { useEffect, useRef, useState } from 'react'
import type { ChatsFilter } from '../../state/store'
import { Icon } from '../Icon'
import { IconButton, useTick } from '../ui'
import { CompanyTagged, useScope } from '../CompanyChip'
import { navigate, openNewChat, useStore } from '../../state/store'
import { pausedChatsLine } from '../../state/desk'
import { CHATS_FILTERS, ChatRow, filterRows, lastChat, useChatRows } from './ChatList'

export function ChatsSidebar({ onBack }: { onBack: () => void }): React.JSX.Element {
  useTick()
  const view = useStore((s) => s.view)
  const { scope, company, chips } = useScope()
  const filter: ChatsFilter = (view.name === 'chats' && view.filter) || 'all'
  const rows = useChatRows(scope)
  const [query, setQuery] = useState('')
  const shown = filterRows(rows, filter, query)
  const picked = view.name === 'chats' ? view.chat : undefined
  // the open conversation: the one picked, else the one ChatsView opened (the last one, else the first row)
  const remembered = lastChat(scope)
  const cur = (picked && rows.find((r) => r.key === picked)?.key) || (remembered && rows.find((r) => r.key === remembered)?.key) || rows[0]?.key || null
  const counts = { live: rows.filter((r) => r.live).length, all: rows.length }
  const paused = useStore((s) => (scope ? !!s.companies.find((c) => c.id === scope)?.pausedAt : false))
  const listRef = useRef<HTMLDivElement>(null)
  const go = (f: ChatsFilter, c?: string | null): void => void navigate({ name: 'chats', filter: f, ...(c ? { chat: c } : {}) })
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
          <span>Back</span>
        </button>
        <span className="side-chats__title">Chats</span>
        <span className="flex1" />
        <IconButton icon="plus" label={company ? `New chat in ${company.name} (⌥⌘N)` : 'New chat (⌥⌘N)'} onClick={() => openNewChat(scope)} />
      </div>
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
        {CHATS_FILTERS.map((f) => (
          <button key={f.value} type="button" role="tab" aria-selected={filter === f.value} className={`side-chats__filter ${filter === f.value ? 'is-on' : ''}`} onClick={() => go(f.value, picked)}>
            {f.label}
            {f.value === 'live' && counts.live > 0 && <span className="side-chats__n">{counts.live}</span>}
          </button>
        ))}
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
                : filter === 'direct'
                  ? `No direct chats in ${where} yet. + starts one; it stays inside ${company?.name ?? 'its company'}.`
                  : filter === 'agents'
                    ? `No agent conversations in ${where} yet.`
                    : company
                      ? `No chats in ${company.name} yet. They are saved here, inside ${company.name}, and nowhere else.`
                      : 'No chats yet. Ask Claude or Codex anything.'}
          </div>
        )}
        {shown.map((r) => (
          <CompanyTagged key={r.key} companyId={r.companyId} chips={chips}>
            <ChatRow row={r} selected={cur === r.key} onPick={() => go(filter, r.key)} />
          </CompanyTagged>
        ))}
      </div>
    </div>
  )
}
