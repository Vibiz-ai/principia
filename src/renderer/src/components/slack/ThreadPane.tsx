/**
 * Right pane (SLACK.md §12.2-§12.4): parent + replies, live; Ask an agent about this thread, Open in Slack, Copy link;
 * pending drafts for the thread inline at the bottom. No compose box in v1 (by design).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SlackThread } from '@shared/slack'
import { Button, ErrorState, IconButton, Loading, RelativeTime } from '../ui'
import { channelPhrase, groupMessages, mergeMessages } from '../../lib/slack'
import { errorMessage, hive, nativeMenu } from '../../lib/hive'
import { onSlackEvent, slackCall } from '../../lib/slackApi'
import { useSlack } from '../../state/slack'
import { attempt, focusSession, refreshSessions, toast, toastError, useStore } from '../../state/store'
import { MessageGroupView } from './Timeline'
import { SlackDraftCard } from './SlackDraftCard'

export function ThreadPane({ channelId, threadTs, onClose }: { channelId: string; threadTs: string; onClose: () => void }): React.JSX.Element {
  const [thread, setThread] = useState<SlackThread | null>(null)
  const [error, setError] = useState<string | null>(null)
  const users = useSlack((s) => s.users)
  const drafts = useSlack((s) => s.drafts)
  const scroller = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    setError(null)
    slackCall('slack:thread', { channelId, threadTs }).then(setThread, (e) => setError(errorMessage(e)))
  }, [channelId, threadTs])
  useEffect(() => {
    setThread(null)
    load()
  }, [load])
  useEffect(
    () =>
      onSlackEvent('slack:messages', ({ channelId: c, messages }) => {
        if (c !== channelId) return
        const mine = messages.filter((m) => m.ts === threadTs || m.threadTs === threadTs)
        if (!mine.length) return
        setThread((t) => {
          if (!t) return t
          const parent = mine.find((m) => m.ts === threadTs) ?? t.parent
          const replies = mergeMessages(
            t.replies,
            mine.filter((m) => m.ts !== threadTs)
          )
          return { ...t, parent, replies }
        })
        requestAnimationFrame(() => {
          const el = scroller.current
          if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight
        })
      }),
    [channelId, threadTs]
  )

  // drafts: the live slice (events) wins over the snapshot the thread came with
  const threadDrafts = useMemo(() => {
    const m = new Map((thread?.drafts ?? []).map((d) => [d.id, d]))
    for (const d of Object.values(drafts)) if (d.channelId === channelId && (d.threadTs ?? null) === (thread?.channel.kind === 'dm' ? d.threadTs : threadTs)) m.set(d.id, d)
    return [...m.values()].filter((d) => d.status === 'pending' || d.status === 'failed' || d.status === 'sending').sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
  }, [thread?.drafts, thread?.channel.kind, drafts, channelId, threadTs])

  const groups = useMemo(() => (thread ? groupMessages([...(thread.parent ? [thread.parent] : []), ...thread.replies]) : []), [thread])
  return (
    <aside className="sthread">
      <header className="sthread__head">
        <div className="sthread__title">
          <span>Thread</span>
          {thread && <span className="text-tertiary">{channelPhrase(thread.channel, users)}</span>}
        </div>
        <span className="flex1" />
        <IconButton icon="close" label="Close thread (Esc)" onClick={onClose} />
      </header>
      <ThreadActions channelId={channelId} threadTs={threadTs} />
      {error ? (
        <ErrorState error={error} onRetry={load} />
      ) : !thread ? (
        <Loading />
      ) : (
        <div className="sthread__body scroll" ref={scroller}>
          {groups.map((g, i) => (
            <div key={g.key}>
              <MessageGroupView group={g} inThread />
              {i === 0 && thread.replies.length > 0 && (
                <div className="sthread__sep">
                  <span>
                    {thread.replies.length} repl{thread.replies.length === 1 ? 'y' : 'ies'}
                  </span>
                </div>
              )}
            </div>
          ))}
          {threadDrafts.length > 0 && (
            <div className="sthread__drafts">
              {threadDrafts.map((d) => (
                <SlackDraftCard key={d.id} draft={d} inThread compact hotkeys={threadDrafts.length === 1} />
              ))}
            </div>
          )}
          <div className="sthread__foot text-tertiary">
            {thread.fetchedAt ? (
              <>
                Updated <RelativeTime iso={thread.fetchedAt} />
              </>
            ) : (
              'From Principia’s local copy'
            )}{' '}
            · Reply in Slack, or let an agent draft one.
          </div>
        </div>
      )}
    </aside>
  )
}

function ThreadActions({ channelId, threadTs }: { channelId: string; threadTs: string }): React.JSX.Element {
  const providers = useStore((s) => s.providers)
  const repos = useStore((s) => s.repos)
  const size = useStore((s) => s.lastTermSize)
  const claude = providers.find((p) => p.id === 'claude')
  const [busy, setBusy] = useState(false)
  const ask = async (): Promise<void> => {
    let repoId: string | null = null
    if (repos.length) {
      const pick = await nativeMenu([{ id: '__chat', label: 'Chat (no repository)' }, { type: 'separator' }, ...repos.filter((r) => r.exists).map((r) => ({ id: r.id, label: r.name }))])
      if (!pick) return
      repoId = pick === '__chat' ? null : pick
    }
    setBusy(true)
    try {
      const sess = await slackCall('slack:askAgent', { channelId, threadTs, repoId, cols: size.cols, rows: size.rows })
      await refreshSessions().catch(() => undefined)
      focusSession(sess.id)
    } catch (e) {
      if ((e as { code?: string }).code === 'adapter_unavailable') toast(`Claude isn’t installed. ${claude?.installHint ?? ''}`, 'error')
      else toastError(e, 'Ask an agent')
    } finally {
      setBusy(false)
    }
  }
  const permalink = async (): Promise<string | null> => (await attempt(() => slackCall('slack:permalink', { channelId, ts: threadTs }), 'Link'))?.url ?? null
  return (
    <div className="sthread__actions">
      <Button size="sm" variant="primary" icon="agents" disabled={busy || (claude ? !claude.available : false)} title={claude && !claude.available ? `Claude isn’t installed. ${claude.installHint}` : 'Opens a Claude session with this thread as context and the Slack tools'} onClick={() => void ask()}>
        {busy ? 'Starting…' : 'Ask an agent about this thread'}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        icon="external"
        onClick={async () => {
          const url = await permalink()
          if (url) void attempt(() => hive.app.openExternal({ url }))
        }}
      >
        Open in Slack
      </Button>
      <Button
        size="sm"
        variant="ghost"
        icon="link"
        onClick={async () => {
          const url = await permalink()
          if (!url) return
          await attempt(() => hive.clipboard.writeText({ text: url }))
          toast('Link copied')
        }}
      >
        Copy link
      </Button>
    </div>
  )
}
