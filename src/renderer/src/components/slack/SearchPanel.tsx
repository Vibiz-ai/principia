/** ⌘F search over Principia's local copy (SLACK.md §12.2): filters channel, person, date; grouped by channel. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SlackSearchHit } from '@shared/slack'
import { EmptyState, Loading } from '../ui'
import { channelLabel, snippetParts, tsToIso, tsToMs, userName } from '../../lib/slack'
import { absoluteWithDay, absolute } from '../../lib/time'
import { errorMessage } from '../../lib/hive'
import { slackCall } from '../../lib/slackApi'
import { useSlack } from '../../state/slack'
import { useStore } from '../../state/store'
import { Avatar, UserPicker } from './bits'

const SINCE: { value: string; label: string; days: number | null }[] = [
  { value: 'any', label: 'Any time', days: null },
  { value: '1', label: 'Last 24 hours', days: 1 },
  { value: '7', label: 'Last 7 days', days: 7 },
  { value: '30', label: 'Last 30 days', days: 30 }
]

export function SearchPanel({ initialChannelId, onJump, onClose }: { initialChannelId: string | null; onJump: (hit: SlackSearchHit) => void; onClose: () => void }): React.JSX.Element {
  const channels = useSlack((s) => s.channels)
  const users = useSlack((s) => s.users)
  const backfillDays = useStore((s) => s.settings?.slackBackfillDays ?? 7)
  const [q, setQ] = useState('')
  const [channelId, setChannelId] = useState<string>(initialChannelId ?? '')
  const [userId, setUserId] = useState<string | null>(null)
  const [since, setSince] = useState('any')
  const [hits, setHits] = useState<SlackSearchHit[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])

  useEffect(() => {
    const query = q.trim()
    if (!query) {
      setHits(null)
      return
    }
    setLoading(true)
    const days = SINCE.find((s) => s.value === since)?.days ?? null
    const t = setTimeout(() => {
      slackCall('slack:search', {
        query,
        channelId: channelId || undefined,
        userId: userId ?? undefined,
        after: days ? new Date(Date.now() - days * 86_400_000).toISOString() : undefined,
        limit: 100
      }).then(
        (h) => {
          setHits(h)
          setError(null)
          setLoading(false)
        },
        (e) => {
          setError(errorMessage(e))
          setLoading(false)
        }
      )
    }, 180)
    return () => clearTimeout(t)
  }, [q, channelId, userId, since])

  const grouped = useMemo(() => {
    const m = new Map<string, SlackSearchHit[]>()
    for (const h of hits ?? []) {
      const k = h.message.channelId
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(h)
    }
    return [...m.entries()]
  }, [hits])
  const oldest = useMemo(() => new Date(Date.now() - backfillDays * 86_400_000).toISOString(), [backfillDays])

  return (
    <div className="ssearch">
      <div className="ssearch__bar">
        <input
          ref={input}
          className="input"
          value={q}
          placeholder="Search Slack messages"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') onClose()
            if (e.key === 'Enter' && hits?.[0]) onJump(hits[0])
          }}
          aria-label="Search Slack messages"
        />
        <select className="input input--sm" value={channelId} onChange={(e) => setChannelId(e.target.value)} aria-label="In channel">
          <option value="">All conversations</option>
          {channels
            .filter((c) => c.isMember)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((c) => (
              <option key={c.id} value={c.id}>
                {channelLabel(c, users)}
              </option>
            ))}
        </select>
        <div className="ssearch__who">
          <UserPicker value={userId} onPick={(u) => setUserId(u.id)} placeholder="From anyone" allowBots />
          {userId && (
            <button type="button" className="chip__x" aria-label="Clear person" onClick={() => setUserId(null)}>
              ×
            </button>
          )}
        </div>
        <select className="input input--sm" value={since} onChange={(e) => setSince(e.target.value)} aria-label="Date">
          {SINCE.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <div className="ssearch__results scroll">
        {error ? (
          <div className="text-failed selectable ssearch__msg">{error}</div>
        ) : !q.trim() ? (
          <EmptyState icon="search" text="Search every channel and DM Principia has a copy of. Return opens the first result." />
        ) : loading && !hits ? (
          <Loading />
        ) : hits && hits.length === 0 ? (
          <EmptyState icon="search" text={`Nothing matches “${q.trim()}”.`} />
        ) : (
          grouped.map(([cid, list]) => {
            const ch = channels.find((c) => c.id === cid)
            return (
              <div key={cid} className="ssearch__group">
                <div className="ssearch__chan">{ch ? channelLabel(ch, users) : (list[0]?.channelName ?? cid)}</div>
                {list.map((h) => {
                  const u = h.message.userId ? users[h.message.userId] : undefined
                  return (
                    <button key={`${cid}:${h.message.ts}`} type="button" className="ssearch__hit" onClick={() => onJump(h)}>
                      <Avatar user={u} size={20} fromHive={h.message.fromHive} />
                      <span className="ssearch__hitbody">
                        <span className="ssearch__hitmeta">
                          <b>{h.message.fromHive ? 'hive' : userName(u, h.message.userId)}</b>
                          <span className="text-tertiary" title={absoluteWithDay(tsToIso(h.message.ts)!)}>
                            {absolute(new Date(tsToMs(h.message.ts)))}
                          </span>
                          {h.message.threadTs && h.message.threadTs !== h.message.ts && <span className="text-tertiary">in a thread</span>}
                        </span>
                        <span className="ssearch__snippet">
                          {snippetParts(h.snippet).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )
          })
        )}
      </div>
      <div className="ssearch__foot text-tertiary">Searching Principia’s local copy (since {absolute(oldest).split(' ').slice(0, 2).join(' ')})</div>
    </div>
  )
}
