/**
 * Channel timeline (SLACK.md §12.2): local mirror, newest at the bottom, infinite scroll up, "Load older from Slack"
 * at the end of the local window, grouped by author within 5 min. Live via `slack:messages`.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SlackChannel, SlackMessage, SlackMessagePage } from '@shared/slack'
import { Button, ErrorState, Loading } from '../ui'
import { Icon } from '../Icon'
import { channelLabel, cmpTs, groupMessages, isTopLevel, mergeMessages, tsToIso, tsToMs, userName, type MessageGroup } from '../../lib/slack'
import { clock, dayLabel, absoluteWithDay, bytes } from '../../lib/time'
import { errorMessage, hive } from '../../lib/hive'
import { onSlackEvent, slackCall } from '../../lib/slackApi'
import { useNoteSlackUsers, useSlack } from '../../state/slack'
import { attempt, toast, useStore } from '../../state/store'
import { Mrkdwn } from './Mrkdwn'
import { Avatar, useResolve } from './bits'

const PAGE = 100


export function Timeline({ channel, openThreadTs, highlightTs, onOpenThread }: { channel: SlackChannel; openThreadTs: string | null; highlightTs: string | null; onOpenThread: (ts: string) => void }): React.JSX.Element {
  const [msgs, setMsgs] = useState<SlackMessage[] | null>(null)
  const [page, setPage] = useState<Pick<SlackMessagePage, 'hasMoreLocal' | 'oldestLocalTs' | 'backfillOldestTs'> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [fetchingSlack, setFetchingSlack] = useState(false)
  const backfillDays = useStore((s) => s.settings?.slackBackfillDays ?? 7)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const keepFromBottom = useRef<number | null>(null)
  const extraDays = useRef(0)

  const load = useCallback(() => {
    setMsgs(null)
    setError(null)
    stick.current = true
    // a search jump loads the page that ends at the message (beforeTs is exclusive)
    const beforeTs = highlightTs ? (Number(highlightTs) + 0.000001).toFixed(6) : undefined
    slackCall('slack:messages', { channelId: channel.id, limit: PAGE, beforeTs }).then(
      (p) => {
        setMsgs(p.messages.slice().sort((a, b) => cmpTs(a.ts, b.ts)))
        setPage(p)
        if (highlightTs) stick.current = false
      },
      (e) => setError(errorMessage(e))
    )
  }, [channel.id, highlightTs])
  useEffect(load, [load])

  // live: append/replace top-level messages; replies only bump the parent (main re-sends it)
  useEffect(
    () =>
      onSlackEvent('slack:messages', ({ channelId, messages }) => {
        if (channelId !== channel.id) return
        const top = messages.filter(isTopLevel)
        if (!top.length) return
        const el = scroller.current
        stick.current = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40
        setMsgs((cur) => (cur ? mergeMessages(cur, top) : cur))
      }),
    [channel.id]
  )

  // Hive-local read marker: the newest message once it is on screen
  const newest = msgs?.[msgs.length - 1]?.ts ?? null
  useEffect(() => {
    if (newest && channel.unread && stick.current) void slackCall('slack:markRead', { channelId: channel.id, ts: newest }).catch(() => undefined)
  }, [newest, channel.id, channel.unread])

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !msgs) return
    if (keepFromBottom.current !== null) {
      el.scrollTop = el.scrollHeight - keepFromBottom.current
      keepFromBottom.current = null
    } else if (highlightTs && !stick.current) {
      el.querySelector(`[data-ts="${CSS.escape(highlightTs)}"]`)?.scrollIntoView({ block: 'center' })
    } else if (stick.current) el.scrollTop = el.scrollHeight
  }, [msgs, highlightTs])

  const loadOlder = async (): Promise<void> => {
    if (!msgs?.length || loadingOlder || !page?.hasMoreLocal) return
    setLoadingOlder(true)
    try {
      const p = await slackCall('slack:messages', { channelId: channel.id, beforeTs: msgs[0]!.ts, limit: PAGE })
      const el = scroller.current
      if (el) keepFromBottom.current = el.scrollHeight - el.scrollTop
      setMsgs((cur) => mergeMessages(cur ?? [], p.messages))
      setPage(p)
    } catch (e) {
      toast(`Couldn’t load older messages: ${errorMessage(e)}`, 'error')
    } finally {
      setLoadingOlder(false)
    }
  }
  const loadFromSlack = async (): Promise<void> => {
    setFetchingSlack(true)
    extraDays.current += 30
    const r = await attempt(() => slackCall('slack:backfill', { channelId: channel.id, days: backfillDays + extraDays.current }), 'Load older from Slack')
    setFetchingSlack(false)
    if (r) toast(`Fetching ${backfillDays + extraDays.current} days of ${channelLabel(channel)} from Slack…`)
  }

  const groups = useMemo(() => groupMessages((msgs ?? []).filter(isTopLevel)), [msgs])
  if (error) return <ErrorState error={error} onRetry={load} />
  if (!msgs) return <Loading />
  return (
    <div
      className="stimeline scroll"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        if (el.scrollTop < 120) void loadOlder()
      }}
    >
      <div className="stimeline__top">
        {page?.hasMoreLocal ? (
          loadingOlder ? (
            <Loading label="Loading older…" />
          ) : (
            <span className="text-tertiary">Scroll up for older messages</span>
          )
        ) : (
          <div className="stimeline__start">
            <span className="text-tertiary">
              {msgs.length ? `Start of Hive’s copy of ${channelLabel(channel)}` : `No messages in ${channelLabel(channel)} in the last ${backfillDays} days.`}
              {page?.backfillOldestTs && ` (since ${absoluteWithDay(tsToIso(page.backfillOldestTs)!)})`}
            </span>
            <Button size="sm" variant="ghost" icon="download" disabled={fetchingSlack} onClick={() => void loadFromSlack()}>
              {fetchingSlack ? 'Fetching…' : 'Load older from Slack'}
            </Button>
          </div>
        )}
      </div>
      {groups.map((g, i) => {
        const prev = groups[i - 1]
        const day = dayLabel(tsToIso(g.key)!)
        const showDay = !prev || dayLabel(tsToIso(prev.key)!) !== day
        return (
          <div key={g.key}>
            {showDay && (
              <div className="stimeline__day">
                <span>{day}</span>
              </div>
            )}
            <MessageGroupView group={g} openThreadTs={openThreadTs} highlightTs={highlightTs} onOpenThread={onOpenThread} />
          </div>
        )
      })}
    </div>
  )
}

export function MessageGroupView({ group, openThreadTs, highlightTs, onOpenThread, inThread = false }: { group: MessageGroup; openThreadTs?: string | null; highlightTs?: string | null; onOpenThread?: (ts: string) => void; inThread?: boolean }): React.JSX.Element {
  const users = useSlack((s) => s.users)
  const first = group.messages[0]!
  useNoteSlackUsers([first.userId])
  const user = first.userId ? users[first.userId] : undefined
  if (group.system)
    return (
      <div className="smsg smsg--system" data-ts={first.ts}>
        <span className="smsg__time">{clock(new Date(tsToMs(first.ts)))}</span>
        <span className="text-tertiary">
          {userName(user, first.userId)} {systemText(first)}
        </span>
      </div>
    )
  return (
    <div className="sgroup-msgs">
      {group.messages.map((m, i) => (
        <MessageItem key={m.ts} m={m} head={i === 0} isOpen={openThreadTs === m.ts} highlight={highlightTs === m.ts} onOpenThread={onOpenThread} inThread={inThread} />
      ))}
    </div>
  )
}

function systemText(m: SlackMessage): string {
  switch (m.subtype) {
    case 'channel_join':
    case 'group_join':
      return 'joined'
    case 'channel_leave':
    case 'group_leave':
      return 'left'
    case 'channel_topic':
      return `set the topic: ${m.plain.replace(/^.*?set the channel topic:\s*/, '')}`
    case 'channel_purpose':
      return 'changed the description'
    case 'channel_name':
      return 'renamed the channel'
    default:
      return m.plain || `(${m.subtype})`
  }
}

export function MessageItem({ m, head, isOpen = false, highlight = false, onOpenThread, inThread = false }: { m: SlackMessage; head: boolean; isOpen?: boolean; highlight?: boolean; onOpenThread?: (ts: string) => void; inThread?: boolean }): React.JSX.Element {
  const users = useSlack((s) => s.users)
  const bot = useSlack((s) => s.status?.workspace?.botName ?? 'hive')
  const resolve = useResolve()
  useNoteSlackUsers([m.fromHive ? null : m.userId])
  const user = m.userId ? users[m.userId] : undefined
  const name = m.fromHive ? bot : m.botId && !user ? 'App' : userName(user, m.userId)
  const time = clock(new Date(tsToMs(m.ts)))
  const copyLink = async (): Promise<void> => {
    const r = await attempt(() => slackCall('slack:permalink', { channelId: m.channelId, ts: m.ts }), 'Copy link')
    if (!r) return
    await attempt(() => hive.clipboard.writeText({ text: r.url }))
    toast('Link copied')
  }
  return (
    <div className={`smsg ${head ? 'smsg--head' : ''} ${isOpen ? 'is-open' : ''} ${highlight ? 'is-highlight' : ''} ${m.isMention ? 'is-mention' : ''}`} data-ts={m.ts}>
      <div className="smsg__gutter">{head ? <Avatar user={user} fromHive={m.fromHive} /> : <span className="smsg__time smsg__time--hover">{time}</span>}</div>
      <div className="smsg__body">
        {head && (
          <div className="smsg__meta">
            <span className="smsg__name">{name}</span>
            {m.fromHive && <span className="pill pill--accent smsg__hive">From Hive</span>}
            {(m.botId || user?.isBot) && !m.fromHive && <span className="smsg__app">APP</span>}
            <span className="smsg__time" title={absoluteWithDay(tsToIso(m.ts)!)}>
              {time}
            </span>
          </div>
        )}
        {m.deleted ? (
          <div className="smsg__tomb text-tertiary">Message deleted</div>
        ) : (
          <>
            {m.text && <Mrkdwn text={m.text} resolve={resolve} />}
            {m.editedTs && <span className="smsg__edited text-tertiary"> (edited)</span>}
            {m.subtype === 'thread_broadcast' && !inThread && <div className="smsg__bcast text-tertiary">replied to a thread</div>}
            {m.files.length > 0 && (
              <div className="smsg__files">
                {m.files.map((f, i) => (
                  <span key={i} className="sfile" title={f.mimetype ?? undefined}>
                    <Icon name="file" size={12} /> <span className="sfile__name">{f.name}</span>
                    {f.size !== null && <span className="text-tertiary">{bytes(f.size)}</span>}
                    {f.permalink && /^https:\/\//.test(f.permalink) && (
                      <button type="button" className="link-btn" onClick={() => void attempt(() => hive.app.openExternal({ url: f.permalink! }))}>
                        Open in Slack
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}
            {m.reactions.length > 0 && (
              <div className="smsg__reacts">
                {m.reactions.map((r) => (
                  <span key={r.name} className="sreact" title={`:${r.name}:`}>
                    :{r.name}: <b>{r.count}</b>
                  </span>
                ))}
              </div>
            )}
          </>
        )}
        {!inThread && m.replyCount > 0 && onOpenThread && (
          <button type="button" className="smsg__thread" onClick={() => onOpenThread(m.ts)}>
            <Icon name="chat" size={12} /> {m.replyCount} repl{m.replyCount === 1 ? 'y' : 'ies'}
            {m.latestReply && <span className="text-tertiary"> · last {clock(new Date(tsToMs(m.latestReply)))}</span>}
          </button>
        )}
      </div>
      {!m.deleted && (
        <div className="smsg__hover">
          {!inThread && onOpenThread && (
            <button type="button" className="icon-btn" title="Open thread" aria-label="Open thread" onClick={() => onOpenThread(m.ts)}>
              <Icon name="reply" size={14} />
            </button>
          )}
          <button type="button" className="icon-btn" title="Copy link" aria-label="Copy link" onClick={() => void copyLink()}>
            <Icon name="link" size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
