/** Small Slack building blocks: avatar, status pill, resolver, user and channel pickers. */
import { useMemo, useState } from 'react'
import type { SlackChannel, SlackUser } from '@shared/slack'
import { channelLabel, initials, statusPill, userName } from '../../lib/slack'
import { hive } from '../../lib/hive'
import { noteSlackUsers, useSlack } from '../../state/slack'
import { navigate } from '../../state/store'
import { useTick } from '../ui'
import type { MrkdwnResolve } from './Mrkdwn'

export function Avatar({ user, size = 28, fromHive = false }: { user: SlackUser | null | undefined; size?: number; fromHive?: boolean }): React.JSX.Element {
  const [broken, setBroken] = useState(false)
  const name = fromHive ? 'hive' : userName(user)
  // CSP allows https://*.slack-edge.com only; anything else falls back to initials
  const url = user?.avatarUrl && /^https:\/\/[a-z0-9.-]+\.slack-edge\.com\//i.test(user.avatarUrl) && !broken ? user.avatarUrl : null
  return (
    <span className={`savatar ${fromHive ? 'savatar--hive' : ''}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }} aria-hidden>
      {url ? <img src={url} alt="" width={size} height={size} onError={() => setBroken(true)} draggable={false} /> : fromHive ? '⬡' : initials(name)}
    </span>
  )
}

export function SlackStatusPill(): React.JSX.Element {
  useTick(1000)
  const status = useSlack((s) => s.status)
  const p = statusPill(status)
  return (
    <span className={`pill pill--${p.tone} spill`} title={status?.error ?? undefined}>
      {p.tone === 'running' || p.tone === 'warning' ? <span className="glyph glyph--running status-dot--running">●</span> : null} {p.text}
    </span>
  )
}

/** Resolver for <Mrkdwn>: names from the local mirror, clicks navigate inside Hive. */
export function useResolve(): MrkdwnResolve {
  const users = useSlack((s) => s.users)
  const channels = useSlack((s) => s.channels)
  return useMemo(
    () => ({
      user: (id) => {
        if (users[id]) return userName(users[id])
        noteSlackUsers([id])
        return null
      },
      channel: (id) => channels.find((c) => c.id === id)?.name ?? null,
      onChannel: (id) => void navigate({ name: 'slack', channelId: id, nonce: Date.now() }),
      onLink: (url) => void hive.app.openExternal({ url }).catch(() => undefined)
    }),
    [users, channels]
  )
}

/** Searchable people list (alerts target, "From people" filter). */
export function UserPicker({ value, onPick, placeholder = 'Search people…', exclude = [], allowBots = false }: { value: string | null; onPick: (u: SlackUser) => void; placeholder?: string; exclude?: string[]; allowBots?: boolean }): React.JSX.Element {
  const users = useSlack((s) => s.users)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/^@/, '')
    return Object.values(users)
      .filter((u) => !u.deleted && (allowBots || !u.isBot) && !exclude.includes(u.id))
      .filter((u) => !needle || [u.name, u.realName, u.displayName].some((x) => x?.toLowerCase().includes(needle)))
      .sort((a, b) => userName(a).localeCompare(userName(b)))
      .slice(0, 50)
  }, [users, q, exclude, allowBots])
  const cur = value ? users[value] : undefined
  return (
    <div className="spicker">
      <input
        className="input input--sm"
        value={open ? q : cur ? userName(cur) : q}
        placeholder={cur ? userName(cur) : placeholder}
        onFocus={() => {
          setOpen(true)
          setQ('')
        }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && list[0]) {
            onPick(list[0])
            setOpen(false)
            ;(e.target as HTMLInputElement).blur()
          }
          if (e.key === 'Escape') (e.target as HTMLInputElement).blur()
        }}
        aria-label={placeholder}
      />
      {open && (
        <div className="spicker__menu" role="listbox">
          {list.length === 0 ? (
            <div className="spicker__empty text-tertiary">{Object.keys(users).length ? 'No one matches.' : 'No people synced yet.'}</div>
          ) : (
            list.map((u) => (
              <div
                key={u.id}
                role="option"
                aria-selected={u.id === value}
                className={`spicker__row ${u.id === value ? 'is-selected' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  onPick(u)
                  setOpen(false)
                }}
              >
                <Avatar user={u} size={18} />
                <span>{userName(u)}</span>
                {u.realName && u.realName !== userName(u) && <span className="text-tertiary">{u.realName}</span>}
                <span className="text-tertiary">@{u.name}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

/** Multi channel picker (members selectable; others disabled with "Invite @hive"). `allowDm` adds "DMs with @hive". */
export function ChannelMultiPicker({ value, onChange, allowDm = false, membersOnly = true, botName = 'hive' }: { value: string[]; onChange: (v: string[]) => void; allowDm?: boolean; membersOnly?: boolean; botName?: string }): React.JSX.Element {
  const channels = useSlack((s) => s.channels)
  const users = useSlack((s) => s.users)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const pickable = useMemo(
    () =>
      channels
        .filter((c) => (c.kind === 'channel' || c.kind === 'private') && !c.isArchived)
        .filter((c) => !q.trim() || c.name.toLowerCase().includes(q.trim().toLowerCase().replace(/^#/, '')))
        .sort((a, b) => Number(b.isMember) - Number(a.isMember) || a.name.localeCompare(b.name))
        .slice(0, 60),
    [channels, q]
  )
  const label = (id: string): string => (id === 'dm' ? `DMs with @${botName}` : channelLabel(channels.find((c) => c.id === id), users) || id)
  const toggle = (id: string): void => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  return (
    <div className="spicker">
      <div className="chips">
        {value.map((id) => (
          <span key={id} className="chip">
            {id === 'dm' ? label(id) : channels.some((c) => c.id === id) ? label(id) : <span className="text-failed" title="Not in Hive’s channel list">{id}</span>}
            <button type="button" className="chip__x" aria-label={`Remove ${label(id)}`} onClick={() => toggle(id)}>
              ×
            </button>
          </span>
        ))}
        {allowDm && !value.includes('dm') && (
          <button type="button" className="chip chip--add" onClick={() => toggle('dm')}>
            + DMs with @{botName}
          </button>
        )}
        <input
          className="input input--sm spicker__inline"
          value={q}
          placeholder={value.length ? 'Add channel…' : 'Pick channels…'}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') (e.target as HTMLInputElement).blur()
          }}
          aria-label="Pick channels"
        />
      </div>
      {open && (
        <div className="spicker__menu" role="listbox">
          {pickable.length === 0 && <div className="spicker__empty text-tertiary">{channels.length ? 'No channel matches.' : 'No channels synced yet.'}</div>}
          {pickable.map((c: SlackChannel) => {
            const disabled = membersOnly && !c.isMember
            return (
              <div
                key={c.id}
                role="option"
                aria-selected={value.includes(c.id)}
                aria-disabled={disabled}
                className={`spicker__row ${value.includes(c.id) ? 'is-selected' : ''} ${disabled ? 'is-disabled' : ''}`}
                title={disabled ? `@${botName} isn’t in ${channelLabel(c)}. Join it on the Slack page${c.kind === 'private' ? ', or /invite @' + botName + ' in Slack' : ''}.` : undefined}
                onMouseDown={(e) => {
                  e.preventDefault()
                  if (!disabled) toggle(c.id)
                }}
              >
                <span className="spicker__check">{value.includes(c.id) ? '✓' : ''}</span>
                <span>{channelLabel(c)}</span>
                {disabled && <span className="text-tertiary">{c.kind === 'private' ? `/invite @${botName}` : 'not joined'}</span>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Single channel select for the notify node. */
export function ChannelSelect({ value, onChange }: { value: string | null; onChange: (id: string) => void }): React.JSX.Element {
  const channels = useSlack((s) => s.channels)
  const list = channels.filter((c) => (c.kind === 'channel' || c.kind === 'private') && !c.isArchived).sort((a, b) => Number(b.isMember) - Number(a.isMember) || a.name.localeCompare(b.name))
  const known = !value || list.some((c) => c.id === value)
  return (
    <select className="input input--sm" value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-label="Slack channel">
      <option value="" disabled>
        {list.length ? 'Pick a channel…' : 'No channels synced yet'}
      </option>
      {!known && value && <option value={value}>{value} (unknown)</option>}
      {list.map((c) => (
        <option key={c.id} value={c.id} disabled={!c.isMember}>
          {channelLabel(c)}
          {c.isMember ? '' : ' (join it first)'}
        </option>
      ))}
    </select>
  )
}
