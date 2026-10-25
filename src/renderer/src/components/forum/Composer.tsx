/**
 * FORUM.md §8: the composer. `@` members and departments (agents with their bust, working ones first), `#` channels,
 * a leading `/` for commands. Enter sends, ⇧Enter is a newline, ↑ in an empty composer edits your last message,
 * Tab/Enter picks a suggestion, Esc closes the list.
 */
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { ForumChannel } from '@shared/forum'
import { Icon } from '../Icon'
import { MemberAvatar } from './Avatar'
import { useForumCtx } from './context'
import { activeTrigger, suggest, type Suggestion } from '../../lib/forum'
import { useStore } from '../../state/store'

export interface ComposerHandle {
  focus(): void
  setText(t: string): void
}

export const Composer = forwardRef<ComposerHandle, {
  channel: ForumChannel
  placeholder: string
  onSend: (text: string) => Promise<boolean>
  onEditLast?: () => void
  compact?: boolean
  footer?: React.ReactNode
}>(function Composer({ channel, placeholder, onSend, onEditLast, compact = false, footer }, ref) {
  const ctx = useForumCtx()
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [sel, setSel] = useState(0)
  const [closed, setClosed] = useState(false)
  const [sending, setSending] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  const departments = useStore((s) => s.departments)
  const companyAgents = useStore((s) => s.companyAgents)
  useImperativeHandle(ref, () => ({
    focus: () => ta.current?.focus(),
    setText: (t: string) => {
      setText(t)
      requestAnimationFrame(() => {
        ta.current?.focus()
        ta.current?.setSelectionRange(t.length, t.length)
        setCaret(t.length)
      })
    }
  }))

  const trig = closed ? null : activeTrigger(text, caret)
  const list: Suggestion[] = useMemo(() => {
    if (!trig) return []
    const deps = departments
      .filter((d) => d.companyId === ctx.companyId && !d.archivedAt)
      .map((d) => ({ key: d.key, name: d.name, agents: companyAgents.filter((a) => a.departmentId === d.id && !a.archivedAt).length }))
    const members = ctx.members.map((m) => ({ ...m, name: ctx.display(m.id)?.name ?? m.name, role2: m.kind === 'agent' ? [ctx.display(m.id)?.role, ctx.display(m.id)?.department].filter(Boolean).join(' · ') : undefined, working: ctx.working.has(m.id) }))
    return suggest(trig.trigger, trig.query, { members, departments: deps, channels: ctx.channels, me: ctx.me?.id ?? '' })
  }, [trig?.trigger, trig?.query, ctx.members, ctx.channels, departments, companyAgents, ctx.working]) // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (s: Suggestion) => {
    if (!trig) return
    const next = text.slice(0, trig.start) + s.insert + text.slice(caret)
    const pos = trig.start + s.insert.length
    setText(next)
    setSel(0)
    requestAnimationFrame(() => {
      ta.current?.focus()
      ta.current?.setSelectionRange(pos, pos)
      setCaret(pos)
    })
  }

  const send = async () => {
    const t = text.trim()
    if (!t || sending) return
    setSending(true)
    const ok = await onSend(t)
    setSending(false)
    if (ok) {
      setText('')
      setCaret(0)
    }
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (list.length) {
      if (e.key === 'ArrowDown') return (e.preventDefault(), setSel((i) => (i + 1) % list.length))
      if (e.key === 'ArrowUp') return (e.preventDefault(), setSel((i) => (i - 1 + list.length) % list.length))
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) return (e.preventDefault(), pick(list[Math.min(sel, list.length - 1)]))
      if (e.key === 'Escape') return (e.preventDefault(), e.stopPropagation(), setClosed(true))
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    } else if (e.key === 'ArrowUp' && !text && onEditLast) {
      e.preventDefault()
      onEditLast()
    }
  }

  const archived = !!channel.archivedAt
  return (
    <div className={`fm-composer ${compact ? 'is-compact' : ''}`}>
      {list.length > 0 && (
        <div className="fm-suggest" role="listbox" aria-label="Suggestions">
          {(['agent', 'human', 'guest', 'department', 'broadcast', 'channel', 'command'] as const).map((kind) => {
            const items = list.filter((s) => s.kind === kind)
            if (!items.length) return null
            const heading = { agent: 'Agents', human: 'People', guest: 'Guests', department: 'Departments', broadcast: 'Channel', channel: 'Channels', command: 'Commands' }[kind]
            return (
              <div key={kind}>
                <div className="fm-suggest__heading">{heading}</div>
                {items.map((s) => {
                  const i = list.indexOf(s)
                  return (
                    <div key={s.key} role="option" aria-selected={i === sel} className={`fm-suggest__row ${i === sel ? 'is-selected' : ''}`} onMouseDown={(e) => (e.preventDefault(), pick(s))} onMouseEnter={() => setSel(i)}>
                      {s.memberId ? <MemberAvatar display={ctx.display(s.memberId)} size={18} working={s.working} /> : <span className="fm-suggest__glyph">{kind === 'department' ? '#' : kind === 'command' ? '/' : kind === 'channel' ? '#' : '@'}</span>}
                      <span className="fm-suggest__label">{s.label}</span>
                      {s.memberId && <span className="fm-suggest__handle">@{ctx.display(s.memberId)?.handle}</span>}
                      <span className="fm-suggest__detail">
                        {s.detail}
                        {s.working ? ' · working' : ''}
                      </span>
                    </div>
                  )
                })}
              </div>
            )
          })}
          <div className="fm-suggest__foot">↑↓ navigate · ↵ insert · esc close</div>
        </div>
      )}
      <textarea
        ref={ta}
        className="fm-composer__input"
        rows={1}
        value={text}
        disabled={archived}
        placeholder={archived ? 'This channel is archived' : placeholder}
        aria-label={placeholder}
        onChange={(e) => {
          setText(e.target.value)
          setCaret(e.target.selectionStart ?? e.target.value.length)
          setClosed(false)
          setSel(0)
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKey}
        style={{ height: Math.min(200, Math.max(compact ? 38 : 44, 20 * Math.min(text.split('\n').length, 9) + 22)) }}
      />
      <div className="fm-composer__bar">
        <button className="fm-composer__tool" title="Mention someone" onClick={() => ctx && ta.current && (setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}@`), setClosed(false), ta.current.focus())}>
          @
        </button>
        {!compact && (
          <button className="fm-composer__tool" title="Commands" onClick={() => (setText('/'), setCaret(1), setClosed(false), ta.current?.focus())}>
            /
          </button>
        )}
        <span className="fm-composer__hint">{footer ?? (compact ? '' : '/invite · /ask · /propose · /task · /visualize')}</span>
        <button className="fm-composer__send" disabled={!text.trim() || sending || archived} onClick={() => void send()} title="Send (↵)" aria-label="Send">
          <Icon name="play" size={12} />
        </button>
      </div>
    </div>
  )
})
