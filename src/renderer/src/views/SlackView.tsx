/**
 * Slack page (SLACK.md §12.2): conversations | timeline | thread. ⌘F searches Principia's local copy. The header carries the
 * Pause auto-replies kill switch (PO-S3e). Everything reads the local mirror; main keeps it fresh.
 * COMPANY.md §3: the connected workspace belongs to one company (Personal after the upgrade). The header's company
 * button re-homes it; a focused company that doesn't own it sees where it lives instead of its messages.
 */
import { useEffect, useMemo, useState } from 'react'
import type { SlackSearchHit, SlackTrigger } from '@shared/slack'
import { Button, EmptyState, Loading, Switch, Toolbar } from '../components/ui'
import { ChannelList, type LeftSel } from '../components/slack/ChannelList'
import { Timeline, MessageItem } from '../components/slack/Timeline'
import { ThreadPane } from '../components/slack/ThreadPane'
import { SearchPanel } from '../components/slack/SearchPanel'
import { SlackStatusPill } from '../components/slack/bits'
import { channelLabel, cmpTs } from '../lib/slack'
import { confirmNative, errorMessage, hive, useHiveEvent } from '../lib/hive'
import { CompanyChip, pickCompany, useScope } from '../components/CompanyChip'
import type { Id } from '@shared/types'
import { onSlackEvent, slackCall } from '../lib/slackApi'
import { isSetUp, loadSlack, openSlackDraft, refreshChannels, setAutoPaused, usePendingSlackDrafts, useSlack } from '../state/slack'
import { attempt, companyName, enterCompany, navigate, toast, useStore } from '../state/store'

export function SlackView({ channelId, threadTs, search, nonce }: { channelId?: string; threadTs?: string; search?: boolean; nonce?: number }): React.JSX.Element {
  const available = useSlack((s) => s.available)
  const status = useSlack((s) => s.status)
  const channels = useSlack((s) => s.channels)
  const users = useSlack((s) => s.users)
  const [sel, setSel] = useState<LeftSel>(channelId ? { kind: 'channel', id: channelId } : null)
  const [thread, setThread] = useState<string | null>(threadTs ?? null)
  const [highlight, setHighlight] = useState<string | null>(null)
  const [searching, setSearching] = useState(!!search)
  const { scope, multi, companies } = useScope()
  // undefined = not loaded (or a main without slack:company); null = no workspace connected
  const [home, setHome] = useState<{ teamId: string; companyId: Id } | null | undefined>(undefined)
  // a focused company waits for the answer instead of flashing a workspace another company owns
  const [homeReady, setHomeReady] = useState(false)
  const loadHome = (): void =>
    void hive.slack.company().then(
      (h) => (setHome(h), setHomeReady(true)),
      () => (setHome(undefined), setHomeReady(true))
    )
  useEffect(loadHome, [status?.workspace?.teamId])
  useHiveEvent('data:changed', ({ domain }) => domain === 'company' && loadHome())
  const rehome = async (to?: Id): Promise<void> => {
    const target = to ?? (await pickCompany(companies, { title: 'This Slack workspace belongs to…', exclude: home?.companyId }))
    if (!target || target === home?.companyId) return
    const ok = await confirmNative({
      message: `Move the Slack workspace to ${companyName(target)}?`,
      detail: `Alerts and agent drafts follow it. Slack triggers whose workflow belongs to another company stop firing until you move the workflow too.`,
      confirmLabel: 'Move'
    }).catch(() => false)
    if (!ok) return
    const r = await attempt(() => hive.slack.setCompany({ companyId: target }), 'Move Slack workspace')
    if (!r) return
    setHome(r)
    toast(`Slack now belongs to ${companyName(r.companyId)}`)
  }

  useEffect(() => {
    if (available === null) void loadSlack()
    else if (available) void refreshChannels()
  }, [available])
  // navigation from outside (notification, draft card, search jump, ⌘⇧L)
  useEffect(() => {
    if (channelId) setSel({ kind: 'channel', id: channelId })
    setThread(threadTs ?? null)
    if (search) setSearching(true)
  }, [channelId, threadTs, search, nonce])
  // default selection: the most recent DM/channel the bot is in
  useEffect(() => {
    if (sel || !channels.length) return
    const first = channels.filter((c) => c.isMember && !c.isArchived).sort((a, b) => cmpTs(b.lastMessageTs, a.lastMessageTs))[0]
    if (first) setSel({ kind: 'channel', id: first.id })
  }, [channels, sel])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey && !e.shiftKey && !e.altKey && e.code === 'KeyF') {
        e.preventDefault()
        setSearching(true)
      } else if (e.key === 'Escape' && !document.querySelector('.sheet-layer') && !(e.target as HTMLElement).closest('input, textarea, select')) {
        if (searching) setSearching(false)
        else if (thread) setThread(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [searching, thread])

  const channel = sel?.kind === 'channel' ? channels.find((c) => c.id === sel.id) : undefined
  const select = (s: LeftSel): void => {
    setSel(s)
    setThread(null)
    setHighlight(null)
    setSearching(false)
  }
  const jump = (h: SlackSearchHit): void => {
    const m = h.message
    setSel({ kind: 'channel', id: m.channelId })
    setSearching(false)
    const inThread = m.threadTs && m.threadTs !== m.ts
    setHighlight(inThread ? m.threadTs : m.ts)
    setThread(inThread ? m.threadTs : m.replyCount > 0 ? m.ts : null)
  }

  if (available === false)
    return (
      <div className="view">
        <Toolbar title="Slack" />
        <EmptyState icon="chat" text="Slack isn’t available in this build yet." />
      </div>
    )
  if (available === null || !status)
    return (
      <div className="view">
        <Toolbar title="Slack" />
        <Loading />
      </div>
    )
  if (!isSetUp(status))
    return (
      <div className="view">
        <Toolbar title="Slack" />
        <EmptyState icon="chat" text="Connect a Slack workspace to read its channels here, let agents draft replies, and get your alerts as Slack DMs. Takes about 5 minutes.">
          <Button variant="primary" onClick={() => void navigate({ name: 'settings', section: 'connections' })}>
            Connect Slack…
          </Button>
        </EmptyState>
      </div>
    )

  if (multi && scope && !homeReady)
    return (
      <div className="view">
        <Toolbar title="Slack" />
        <Loading />
      </div>
    )
  const elsewhere = multi && scope && home && home.companyId !== scope ? home.companyId : null
  const companyButton = multi && home ? (
    <button type="button" className="slack-company no-drag" onClick={() => void rehome()} title="Which company this Slack workspace belongs to. Click to move it.">
      <CompanyChip companyId={home.companyId} always />
      <span className="text-tertiary">▾</span>
    </button>
  ) : null
  if (elsewhere)
    return (
      <div className="view">
        <Toolbar title="Slack" sub={<SlackStatusPill />}>
          {companyButton}
        </Toolbar>
        <EmptyState icon="slack" text={`The connected Slack workspace belongs to ${companyName(elsewhere)}. Its channels, drafts and triggers live there.`}>
          <Button variant="primary" onClick={() => void enterCompany(elsewhere, { view: { name: 'slack' } })}>
            Open in {companyName(elsewhere)}
          </Button>
          <Button onClick={() => void rehome(scope)}>Move it to {companyName(scope)}</Button>
        </EmptyState>
      </div>
    )

  return (
    <div className="view">
      <Toolbar title="Slack" sub={<SlackStatusPill />}>
        {companyButton}
        <DraftsWaiting />
        <AutoPauseSwitch />
        <Button size="sm" variant="ghost" icon="search" kbd="⌘F" onClick={() => setSearching(true)}>
          Search
        </Button>
        <Button size="sm" variant="ghost" icon="settings" onClick={() => void navigate({ name: 'settings', section: 'connections' })} title="Settings › Connections">
          Connection
        </Button>
      </Toolbar>
      {status.state === 'error' && status.error && <div className="banner banner--failed banner--bar selectable">{status.error}</div>}
      <div className={`slack ${thread && !searching ? 'has-thread' : ''}`}>
        <ChannelList sel={sel} onSelect={select} />
        <section className="slack__center">
          {searching ? (
            <SearchPanel initialChannelId={null} onJump={jump} onClose={() => setSearching(false)} />
          ) : sel?.kind === 'mentions' ? (
            <Mentions onOpen={(cid, ts, th) => (setSel({ kind: 'channel', id: cid }), setHighlight(th ?? ts), setThread(th ?? ts))} />
          ) : channel ? (
            <>
              <div className="slack__chanhead">
                <span className="slack__channame">{channelLabel(channel, users)}</span>
                {channel.topic && <span className="text-tertiary slack__topic">{channel.topic}</span>}
              </div>
              {channel.isMember ? (
                <Timeline key={channel.id} channel={channel} openThreadTs={thread} highlightTs={highlight} onOpenThread={(ts) => setThread(ts)} />
              ) : (
                <EmptyState icon="chat" text={channel.kind === 'private' ? `Principia can’t read ${channelLabel(channel)} yet. In Slack, type /invite @${status.workspace?.botName ?? 'hive'} there.` : `Principia isn’t in ${channelLabel(channel)} yet. Use Join in the list to read it here.`} />
              )}
            </>
          ) : (
            <EmptyState icon="chat" text={channels.length ? 'Pick a conversation.' : 'No conversations yet. DM @hive in Slack, or join channels from the list.'} />
          )}
        </section>
        {thread && channel && !searching && <ThreadPane key={`${channel.id}:${thread}`} channelId={channel.id} threadTs={thread} onClose={() => setThread(null)} />}
      </div>
    </div>
  )
}

/** PO-S3e: one switch; amber while auto triggers exist and it is off. */
function AutoPauseSwitch(): React.JSX.Element {
  const paused = useStore((s) => !!s.settings?.slackAutoPaused)
  const [triggers, setTriggers] = useState<SlackTrigger[]>([])
  useEffect(() => {
    slackCall('slackTriggers:list').then(setTriggers, () => setTriggers([]))
  }, [])
  useEffect(() => onSlackEvent('slackTrigger:updated', (t) => setTriggers((l) => (l.some((x) => x.id === t.id) ? l.map((x) => (x.id === t.id ? t : x)) : [...l, t]))), [])
  const autoLive = triggers.some((t) => t.enabled && t.reply.mode === 'auto')
  return (
    <label className={`slack__pause ${autoLive && !paused ? 'is-armed' : ''} ${paused ? 'is-paused' : ''}`} title={paused ? 'Every auto reply becomes a draft you approve.' : autoLive ? 'Auto-reply triggers are on. Pause turns every auto reply into a draft.' : 'No auto-reply triggers right now.'}>
      <span>{paused ? 'Auto-replies paused' : 'Pause auto-replies'}</span>
      <Switch checked={paused} onChange={(v) => void setAutoPaused(v)} label="Pause auto-replies" />
    </label>
  )
}

function DraftsWaiting(): React.JSX.Element | null {
  const drafts = usePendingSlackDrafts().filter((d) => d.status === 'pending' || d.status === 'failed')
  if (!drafts.length) return null
  return (
    <Button size="sm" className="btn--amber" onClick={() => void openSlackDraft(drafts[0]!.id)} title="Open the oldest draft in its thread">
      ⚑ {drafts.length} draft{drafts.length === 1 ? '' : 's'} waiting
    </Button>
  )
}

/** Messages that mention the bot (last 7 days, from the local copy). */
function Mentions({ onOpen }: { onOpen: (channelId: string, ts: string, threadTs: string | null) => void }): React.JSX.Element {
  const bot = useSlack((s) => s.status?.workspace?.botName ?? 'hive')
  const channels = useSlack((s) => s.channels)
  const users = useSlack((s) => s.users)
  const [hits, setHits] = useState<SlackSearchHit[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    slackCall('slack:search', { query: `@${bot}`, after: new Date(Date.now() - 7 * 86_400_000).toISOString(), limit: 100 }).then(
      (h) => setHits(h.filter((x) => x.message.isMention).sort((a, b) => cmpTs(b.message.ts, a.message.ts))),
      (e) => setError(errorMessage(e))
    )
  }, [bot])
  const byChannel = useMemo(() => new Map(channels.map((c) => [c.id, c])), [channels])
  if (error) return <EmptyState icon="warning" text={error} />
  if (!hits) return <Loading />
  if (!hits.length) return <EmptyState icon="chat" text={`No one mentioned @${bot} in the last 7 days.`} />
  return (
    <div className="stimeline scroll">
      {hits.map((h) => (
        <div key={`${h.message.channelId}:${h.message.ts}`} className="smention" onClick={() => onOpen(h.message.channelId, h.message.ts, h.message.threadTs && h.message.threadTs !== h.message.ts ? h.message.threadTs : null)}>
          <div className="smention__chan text-tertiary">{channelLabel(byChannel.get(h.message.channelId), users) || h.channelName}</div>
          <MessageItem m={h.message} head />
        </div>
      ))}
    </div>
  )
}
