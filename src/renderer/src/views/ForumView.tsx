/**
 * The Forum (FORUM.md §8): the company's chat for agents and people. Left: channels, proposals, direct messages.
 * Middle: the conversation, grouped by author, with asks and proposal cards inline. Right: a thread or search results.
 * One Forum per company: All mode asks which one. Lives behind the board switch (companies + departments).
 */
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AgentTalkPanel } from '../components/forum/AgentTalk'
import type { ForumChannel, ForumMember, ForumMessage, ForumRef } from '@shared/forum'
import { channelLabel } from '@shared/forum'
import { EmptyState, Loading } from '../components/ui'
import { Icon } from '../components/Icon'
import { MemberAvatar, useMemberDisplay } from '../components/forum/Avatar'
import { ForumContext, type ForumCtx } from '../components/forum/context'
import { MessageRow } from '../components/forum/Message'
import { Composer, type ComposerHandle } from '../components/forum/Composer'
import { DecideSheet, EditSheet, InviteSheet, NewChannelSheet, ProposeSheet } from '../components/forum/Sheets'
import { ForumMosaic } from '../components/forum/ForumMosaic'
import { groupMessages, parseSlash, presenceLine, sortChannels } from '../lib/forum'
import { forumVisualizeAsk } from '@shared/diagram'
import { confirmNative, hive, nativeMenu } from '../lib/hive'
import { initForumEvents, loadChannel, loadForum, loadThread, markRead, post, setViewing, useForum } from '../state/forum'
import { activeCompany, attempt, departmentsOn, enterCompany, navigate, openBoard, toast, useStore } from '../state/store'
import '../styles/forum.css'
import '../styles/agentTalk.css'

const EMPTY: ForumMessage[] = []

export function ForumView({ companyId: wanted, channelId: wantedChannel, threadId: wantedThread, nonce }: { companyId?: string; channelId?: string; threadId?: string; nonce?: number }): React.JSX.Element {
  const active = useStore((s) => activeCompany(s))
  const companies = useStore((s) => s.companies)
  const boardOn = useStore((s) => departmentsOn(s))
  const companyId = wanted ?? (active === 'all' ? null : active)
  useEffect(() => initForumEvents(), [])

  if (!boardOn) {
    return (
      <div className="view fm-view fm-view--empty">
        <EmptyState icon="chat" text="The Forum needs Companies and Departments. Turn them on in Settings → Experimental." />
      </div>
    )
  }
  if (!companyId) {
    return (
      <div className="view fm-view fm-view--empty">
        <div className="fm-pickco">
          <ForumMosaic width={110} />
          <div className="fm-pickco__title">Every company has its own Forum</div>
          <div className="fm-pickco__list">
            {companies.map((c) => (
              <button key={c.id} className="btn" onClick={() => void enterCompany(c.id, { view: { name: 'forum', companyId: c.id } })}>
                {c.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }
  return <CompanyForumView key={companyId} companyId={companyId} wantedChannel={wantedChannel} wantedThread={wantedThread} nonce={nonce} />
}

function CompanyForumView({ companyId, wantedChannel, wantedThread, nonce }: { companyId: string; wantedChannel?: string; wantedThread?: string; nonce?: number }): React.JSX.Element {
  const cf = useForum((s) => s.byCompany[companyId])
  const state = cf?.state ?? null
  const companyName = useStore((s) => s.companies.find((c) => c.id === companyId)?.name ?? '')
  const tasks = useStore((s) => s.tasks)
  const [channelId, setChannelId] = useState<string | null>(wantedChannel ?? null)
  const [threadId, setThreadId] = useState<string | null>(wantedThread ?? null)
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<ForumMessage[] | null>(null)
  const [agentTalk, setAgentTalk] = useState(false)
  const [sheet, setSheet] = useState<null | { kind: 'channel' } | { kind: 'invite' } | { kind: 'decide'; m: ForumMessage } | { kind: 'edit'; m: ForumMessage } | { kind: 'propose'; k: 'department' | 'agent' | null }>(null)
  const [highlight, setHighlight] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const composer = useRef<ComposerHandle>(null)

  useEffect(() => void loadForum(companyId), [companyId])
  useEffect(() => {
    if (wantedChannel) setChannelId(wantedChannel)
    if (wantedThread) {
      setThreadId(wantedThread)
      void loadThread(companyId, wantedThread)
    }
  }, [wantedChannel, wantedThread, nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  const members = state?.members ?? []
  const display = useMemberDisplay(members)
  const me = useMemo(() => members.find((m) => m.id === state?.me) ?? null, [members, state?.me])
  const { channels, dms } = useMemo(() => sortChannels(state?.channels ?? []), [state?.channels])
  const memberMap = useMemo(() => new Map(members.map((m) => [m.id, { name: display(m.id)?.name ?? m.name }])), [members, display])
  const working = useMemo(() => new Set((state?.presence ?? []).filter((p) => p.state !== 'idle').map((p) => p.memberId)), [state?.presence])

  // default channel: the wanted one, else #general
  useEffect(() => {
    if (!state || (channelId && state.channels.some((c) => c.id === channelId))) return
    setChannelId(state.channels.find((c) => c.system === 'general')?.id ?? state.channels[0]?.id ?? null)
  }, [state, channelId])

  const channel = state?.channels.find((c) => c.id === channelId) ?? null
  const page = cf?.pages[channelId ?? '']
  const messages = page?.list ?? EMPTY

  // the unread line stays where it was when the channel opened
  const [readMark, setReadMark] = useState<{ channelId: string; seq: number } | null>(null)
  useEffect(() => {
    if (!channel) return
    if (readMark?.channelId !== channel.id) setReadMark({ channelId: channel.id, seq: channel.lastReadSeq })
    if (!page) void loadChannel(companyId, channel.id)
    setViewing({ companyId, channelId: channel.id })
    if (channel.joined && (channel.unread || channel.mentions)) void markRead(companyId, channel.id)
  }, [channel?.id, channel?.unread, channel?.mentions]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => setViewing(null), [])

  const thread = threadId ? cf?.threads[threadId] : undefined

  const byHandle = useCallback((h: string): ForumMember | null => members.find((m) => m.handle === h) ?? null, [members])
  const openChannel = useCallback((id: string) => {
    setChannelId(id)
    setThreadId(null)
  }, [])

  const openRef = useCallback(
    (ref: ForumRef, from: ForumMessage) => {
      switch (ref.kind) {
        case 'task': {
          const t = tasks.find((x) => x.companyId === companyId && (x.identifier === ref.id || x.id === ref.id))
          if (t) openBoard(companyId, { taskId: t.id })
          else toast(`${ref.id} is not on this company's board`)
          return
        }
        case 'note':
          return void navigate({ name: 'passport', search: ref.id, nonce: Date.now() })
        case 'artifact':
          return void navigate({ name: 'artifacts' })
        case 'run':
          return void navigate({ name: 'run', runId: ref.id })
        case 'url':
          return void hive.app.openExternal({ url: ref.id })
        case 'message': {
          const pool = [...Object.values(cf?.pages ?? {}).flatMap((p) => p.list), ...Object.values(cf?.threads ?? {}).flatMap((t) => [t.root, ...t.replies])]
          const m = pool.find((x) => x.ref === ref.id)
          if (!m) return toast(`${ref.id} is not loaded here; search for it`)
          if (m.threadId) {
            setThreadId(m.threadId)
            void loadThread(companyId, m.threadId)
          } else {
            setChannelId(m.channelId)
            setHighlight(m.id)
            setTimeout(() => document.getElementById(`fm-${m.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60)
          }
          void from
          return
        }
      }
    },
    [tasks, companyId, cf]
  )

  const ctx: ForumCtx = useMemo(
    () => ({
      companyId,
      me,
      members,
      channels: state?.channels ?? [],
      display,
      byHandle,
      working,
      openThread: (m) => {
        const root = m.threadId ?? m.id
        setThreadId(root)
        setResults(null)
        void loadThread(companyId, root)
      },
      openChannel,
      openRef,
      knowsTask: (ident: string) => tasks.some((x) => x.companyId === companyId && x.identifier.toUpperCase() === ident.toUpperCase()),
      react: (m, emoji) => void attempt(() => hive.forum.react({ messageId: m.id, emoji }), 'React'),
      edit: (m) => setSheet({ kind: 'edit', m }),
      remove: (m) =>
        void confirmNative({ message: 'Delete this message?', detail: 'Its replies stay. Agents that already read it keep what they saw.', confirmLabel: 'Delete' }).then(
          (ok) => ok && void attempt(() => hive.forum.edit({ messageId: m.id, text: null }), 'Delete message')
        ),
      toTask: (m) =>
        void attempt(() => hive.forum.toTask({ messageId: m.id }), 'Make task').then((t) => {
          if (t) toast(`Made ${t.identifier}`)
        }),
      answer: async (m, answer) => !!(await attempt(() => hive.forum.answer({ messageId: m.id, answer }), 'Answer')),
      decide: (m, decision) => {
        if (decision === 'approve') return setSheet({ kind: 'decide', m })
        void confirmNative({ message: 'Reject this proposal?', detail: 'The agent sees the rejection in its next brief.', confirmLabel: 'Reject' }).then(
          (ok) => ok && void attempt(() => hive.forum.decide({ messageId: m.id, decision: 'reject' }), 'Reject proposal')
        )
      },
      copyRef: (m) => void hive.clipboard.writeText({ text: m.ref }).then(() => toast(`Copied ${m.ref}`))
    }),
    [companyId, me, members, state?.channels, display, byHandle, working, openChannel, openRef]
  )

  // search: debounced, filters in:#chan from:@who is:ask|proposal
  useEffect(() => {
    const q = search.trim()
    if (!q) return setResults(null)
    const t = setTimeout(() => void hive.forum.search({ companyId, query: q, limit: 40 }).then(setResults, () => setResults([])), 180)
    return () => clearTimeout(t)
  }, [search, companyId])

  // keyboard: ⌘F search, ⌥↑/⌥↓ channels, Esc closes the side panel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const order = [...channels, ...dms]
        const unreadOnly = e.shiftKey ? order.filter((c) => c.unread || c.mentions || c.id === channelId) : order
        const i = unreadOnly.findIndex((c) => c.id === channelId)
        const next = unreadOnly[(i + (e.key === 'ArrowDown' ? 1 : -1) + unreadOnly.length) % unreadOnly.length]
        if (next) {
          e.preventDefault()
          openChannel(next.id)
        }
      } else if (e.key === 'Escape' && !document.querySelector('.sheet-layer')) {
        if (threadId) setThreadId(null)
        else if (results) (setSearch(''), setResults(null))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [channels, dms, channelId, threadId, results, openChannel])

  // ---------- sending (with slash commands) ----------
  const send = async (text: string, threadRoot: string | null): Promise<boolean> => {
    if (!channel) return false
    const cmd = threadRoot ? null : parseSlash(text)
    if (cmd) {
      const ids = (hs: string[]) => hs.map((h) => byHandle(h)?.id).filter((x): x is string => !!x)
      switch (cmd.cmd) {
        case 'invite': {
          const add = ids(cmd.handles)
          if (!add.length) return (toast('Name who to add: /invite @marcus'), false)
          return !!(await attempt(() => hive.forum.membership({ op: 'add', channelId: channel.id, memberIds: add }).then(() => true), 'Invite'))
        }
        case 'ask': {
          const to = ids(cmd.handles)
          if (!to.length || cmd.question.length < 3) return (toast('Usage: /ask @who question [option a|option b]'), false)
          const handles = cmd.handles.map((h) => `@${h}`).join(' ')
          return !!(await attempt(() => post({ companyId, channelId: channel.id, text: `${handles} ${cmd.question}`, ask: { to, ...(cmd.options.length ? { options: cmd.options } : {}) } }), 'Ask'))
        }
        case 'propose':
          setSheet({ kind: 'propose', k: cmd.kind })
          return true
        case 'topic':
          return !!(await attempt(() => hive.forum.updateChannel({ channelId: channel.id, topic: cmd.text }), 'Set topic'))
        case 'leave':
          return !!(await attempt(() => hive.forum.membership({ op: 'leave', channelId: channel.id }).then(() => true), 'Leave'))
        case 'task': {
          if (!cmd.title) return (toast('Usage: /task title'), false)
          const m = await attempt(() => post({ companyId, channelId: channel.id, text: cmd.title }), 'Post')
          if (!m) return false
          ctx.toTask(m)
          return true
        }
        case 'visualize': {
          // DIAGRAMS.md §6: the ask goes out as a normal message, so the agent answers in the thread with a diagram
          const text = forumVisualizeAsk(cmd.handles, cmd.what)
          if (!text) return (toast('Usage: /visualize @agent what to draw'), false)
          return !!(await attempt(() => post({ companyId, channelId: channel.id, text }), 'Visualize'))
        }
        case 'unknown':
          toast(`Unknown command /${cmd.name}`)
          return false
      }
    }
    if (!channel.joined && channel.kind === 'public') await attempt(() => hive.forum.membership({ op: 'join', channelId: channel.id }), 'Join')
    return !!(await attempt(() => post({ companyId, channelId: channel.id, text, threadId: threadRoot }), 'Send'))
  }
  const editLast = () => {
    const mine = [...messages].reverse().find((m) => m.authorId === me?.id && m.kind === 'text' && !m.deletedAt)
    if (mine) setSheet({ kind: 'edit', m: mine })
  }

  if (!state) {
    return <div className="view fm-view fm-view--empty">{cf?.error ? <EmptyState icon="warning" text={cf.error} /> : <Loading label="Opening the Forum…" />}</div>
  }

  const label = channel ? channelLabel(channel, memberMap, state.me) : ''
  const presence = channel ? presenceLine(state.presence, channel, (id) => (id === state.me ? null : (display(id)?.name ?? null))) : ''
  const dmMember = channel && !channel.name ? channel.memberIds.find((id) => id !== state.me) : undefined

  return (
    <ForumContext.Provider value={ctx}>
      <div className={`view fm-view ${threadId || results || agentTalk ? 'has-side' : ''}`}>
        <ForumNav
          companyName={companyName}
          channels={channels}
          dms={dms}
          current={channelId}
          me={me}
          openAsks={state.openAsks}
          openProposals={state.openProposals}
          search={search}
          searchRef={searchRef}
          onSearch={setSearch}
          onOpen={openChannel}
          onNewChannel={() => setSheet({ kind: 'channel' })}
          onInvite={() => setSheet({ kind: 'invite' })}
          agentTalk={agentTalk}
          onAgentTalk={() => (setAgentTalk((x) => !x), setThreadId(null), setSearch(''), setResults(null))}
          onNewDm={async () => {
            const others = members.filter((m) => m.status === 'active' && m.id !== state.me && m.kind !== 'guest')
            const id = await nativeMenu(others.map((m) => ({ id: m.id, label: `${display(m.id)?.name ?? m.name}${m.kind === 'agent' ? ` · ${display(m.id)?.role}` : ''}` })))
            if (!id) return
            const c = await attempt(() => hive.forum.openDm({ companyId, memberIds: [id] }), 'Open message')
            if (c) {
              await loadForum(companyId)
              openChannel(c.id)
            }
          }}
        />
        <section className="fm-main" aria-label={label}>
          {channel ? (
            <>
              <header className="fm-head">
                <div className="fm-head__title">
                  {channel.name ? <span className="fm-head__hash">{channel.kind === 'private' ? <Icon name="lock" size={14} /> : '#'}</span> : <MemberAvatar display={display(dmMember ?? '')} size={20} working={working.has(dmMember ?? '')} />}
                  <span className="fm-head__name">{channel.name ?? label}</span>
                </div>
                <div className="fm-head__topic" title={channel.topic || channel.purpose}>
                  {channel.topic || channel.purpose}
                </div>
                <div className="fm-head__faces" title={`${channel.memberIds.length} members`}>
                  {channel.memberIds.slice(0, 4).map((id) => (
                    <MemberAvatar key={id} display={display(id)} size={20} />
                  ))}
                  <span className="fm-head__count">{channel.memberIds.length}</span>
                </div>
                {!channel.joined && channel.kind === 'public' && (
                  <button className="btn btn--sm" onClick={() => void attempt(() => hive.forum.membership({ op: 'join', channelId: channel.id }), 'Join')}>
                    Join
                  </button>
                )}
              </header>
              <MessageList key={channel.id} channel={channel} messages={messages} hasMore={!!page?.hasMore} loading={!page || page.loading} readMark={readMark?.channelId === channel.id ? readMark.seq : 0} me={state.me} highlight={highlight} onOlder={() => void loadChannel(companyId, channel.id, true)} onSayHello={() => composer.current?.focus()} />
              <div className="fm-compose-wrap">
                <Composer ref={composer} channel={channel} placeholder={`Message ${channel.name ? `#${channel.name}` : label}`} onSend={(t) => send(t, null)} onEditLast={editLast} />
                <div className="fm-presence" aria-live="polite">
                  {presence && (
                    <>
                      <span className="fm-presence__tiles" aria-hidden>
                        <i />
                        <i />
                        <i />
                      </span>
                      <span>{presence}</span>
                    </>
                  )}
                </div>
              </div>
            </>
          ) : (
            <EmptyState icon="chat" text="Pick a channel" />
          )}
        </section>
        {results ? (
          <aside className="fm-side" aria-label="Search results">
            <header className="fm-side__head">
              <span className="fm-side__title">Search</span>
              <span className="fm-side__sub">{results.length} result{results.length === 1 ? '' : 's'}</span>
              <button className="fm-icon-btn" onClick={() => (setSearch(''), setResults(null))} aria-label="Close search">
                <Icon name="close" size={14} />
              </button>
            </header>
            <div className="fm-side__body">
              {results.length === 0 && <div className="fm-side__empty">Nothing matches. Try in:#channel, from:@who, is:ask or is:proposal.</div>}
              {results.map((m) => {
                const c = state.channels.find((x) => x.id === m.channelId)
                return (
                  <div key={m.id} className="fm-hit" onClick={() => (m.threadId ? ctx.openThread(m) : (openChannel(m.channelId), setHighlight(m.id), setTimeout(() => document.getElementById(`fm-${m.id}`)?.scrollIntoView({ block: 'center' }), 120)))}>
                    <div className="fm-hit__where">{c ? channelLabel(c, memberMap, state.me) : ''}</div>
                    <MessageRow m={m} head inThread />
                  </div>
                )
              })}
            </div>
          </aside>
        ) : threadId ? (
          <aside className="fm-side" aria-label="Thread">
            <header className="fm-side__head">
              <span className="fm-side__title">Thread</span>
              <span className="fm-side__sub">{thread ? (state.channels.find((c) => c.id === thread.root.channelId)?.name ? `#${state.channels.find((c) => c.id === thread.root.channelId)!.name}` : '') : ''}</span>
              <button className="fm-icon-btn" onClick={() => setThreadId(null)} aria-label="Close thread">
                <Icon name="close" size={14} />
              </button>
            </header>
            {thread ? (
              <>
                <div className="fm-side__body">
                  <MessageRow m={thread.root} head inThread />
                  <div className="fm-side__count">
                    {thread.replies.length} {thread.replies.length === 1 ? 'reply' : 'replies'}
                  </div>
                  {groupMessages(thread.replies).map((it) => (it.kind === 'msg' ? <MessageRow key={it.key} m={it.message} head={it.head} inThread /> : null))}
                </div>
                <div className="fm-compose-wrap fm-compose-wrap--side">
                  <Composer channel={state.channels.find((c) => c.id === thread.root.channelId) ?? channel!} placeholder={thread.root.kind === 'ask' && thread.root.ask?.status === 'open' ? 'Answer…' : 'Reply…'} onSend={(t) => send(t, thread.root.id)} compact />
                </div>
              </>
            ) : (
              <Loading />
            )}
          </aside>
        ) : agentTalk ? (
          <AgentTalkPanel companyId={companyId} onClose={() => setAgentTalk(false)} />
        ) : null}
        {sheet?.kind === 'channel' && (
          <NewChannelSheet
            companyId={companyId}
            members={members}
            display={display}
            onCancel={() => setSheet(null)}
            onDone={(c) => {
              setSheet(null)
              void loadForum(companyId).then(() => openChannel(c.id))
            }}
          />
        )}
        {sheet?.kind === 'invite' && <InviteSheet companyId={companyId} channels={state.channels} members={members} display={display} onCancel={() => setSheet(null)} />}
        {sheet?.kind === 'decide' && <DecideSheet m={sheet.m} onCancel={() => setSheet(null)} onDone={() => setSheet(null)} />}
        {sheet?.kind === 'edit' && <EditSheet m={sheet.m} onCancel={() => setSheet(null)} onDone={() => setSheet(null)} />}
        {sheet?.kind === 'propose' && channel && <ProposeSheet companyId={companyId} channel={channel} kind={sheet.k} onCancel={() => setSheet(null)} onDone={() => setSheet(null)} />}
      </div>
    </ForumContext.Provider>
  )
}

function MessageList({ channel, messages, hasMore, loading, readMark, me, highlight, onOlder, onSayHello }: { channel: ForumChannel; messages: ForumMessage[]; hasMore: boolean; loading: boolean; readMark: number; me: string; highlight: string | null; onOlder: () => void; onSayHello: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const items = useMemo(() => groupMessages(messages, { lastReadSeq: readMark, me }), [messages, readMark, me])
  // stay at the bottom while the user is there; keep the position when older pages load above
  const prevHeight = useRef(0)
  const prevFirst = useRef<string | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const first = messages[0]?.id ?? null
    if (prevFirst.current && first !== prevFirst.current && el.scrollHeight > prevHeight.current && !stick.current) el.scrollTop += el.scrollHeight - prevHeight.current
    else if (stick.current) el.scrollTop = el.scrollHeight
    prevHeight.current = el.scrollHeight
    prevFirst.current = first
  }, [messages])
  if (!loading && messages.length === 0) {
    return (
      <div className="fm-list fm-list--empty">
        <div className="fm-empty">
          <ForumMosaic width={120} />
          <div className="fm-empty__title">{channel.name ? `This is the very beginning of #${channel.name}.` : 'This is the beginning of your conversation.'}</div>
          {channel.purpose && <div className="fm-empty__sub">{channel.purpose}</div>}
          <button className="btn btn--primary btn--sm" onClick={onSayHello}>
            Say hello to your team
          </button>
        </div>
      </div>
    )
  }
  return (
    <div
      className="fm-list"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        if (el.scrollTop < 80 && hasMore && !loading) onOlder()
      }}
    >
      {hasMore && <div className="fm-list__more">{loading ? 'Loading…' : 'Scroll up for older messages'}</div>}
      {items.map((it) =>
        it.kind === 'day' ? (
          <div key={it.key} className="fm-day">
            <span>{it.label}</span>
          </div>
        ) : it.kind === 'unread' ? (
          <div key={it.key} className="fm-unread-line">
            <span>New</span>
          </div>
        ) : (
          <MessageRow key={it.key} m={it.message} head={it.head} highlight={highlight === it.message.id} />
        )
      )}
    </div>
  )
}

function ForumNav({
  companyName,
  channels,
  dms,
  current,
  me,
  openAsks,
  openProposals,
  search,
  searchRef,
  onSearch,
  onOpen,
  onNewChannel,
  onInvite,
  onNewDm,
  agentTalk,
  onAgentTalk
}: {
  companyName: string
  channels: ForumChannel[]
  dms: ForumChannel[]
  current: string | null
  me: ForumMember | null
  openAsks: number
  openProposals: number
  search: string
  searchRef: React.RefObject<HTMLInputElement | null>
  onSearch: (q: string) => void
  onOpen: (id: string) => void
  onNewChannel: () => void
  onInvite: () => void
  onNewDm: () => void
  agentTalk: boolean
  onAgentTalk: () => void
}): React.JSX.Element {
  const ctx = useContextSafe()
  const departments = useStore((s) => s.departments)
  const row = (c: ForumChannel, labelNode: React.ReactNode, lead: React.ReactNode) => (
    <div
      key={c.id}
      className={`fm-nav__row ${c.id === current ? 'is-selected' : ''} ${c.unread || c.mentions ? 'is-unread' : ''} ${!c.joined ? 'is-unjoined' : ''}`}
      role="link"
      tabIndex={0}
      onClick={() => onOpen(c.id)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen(c.id))}
    >
      <span className="fm-nav__lead">{lead}</span>
      <span className="fm-nav__label">{labelNode}</span>
      {c.mentions > 0 ? <span className="fm-badge fm-badge--mention">{c.mentions}</span> : !c.name && c.unread > 0 ? <span className="fm-badge fm-badge--mention">{c.unread}</span> : null}
    </div>
  )
  const deptColor = (c: ForumChannel) => departments.find((d) => d.id === c.departmentId)?.color ?? null
  const topics = channels.filter((c) => c.system !== 'proposals')
  const proposals = channels.filter((c) => c.system === 'proposals')
  return (
    <nav className="fm-nav" aria-label="Forum channels">
      <div className="fm-nav__brand">
        {/* the view's title (every door has one h1); the wordmark is the same word in capitals */}
        <h1 className="fm-nav__forum">Forum</h1>
        <span className="fm-nav__co">{companyName}</span>
      </div>
      <div className="fm-nav__search">
        <Icon name="search" size={13} />
        <input ref={searchRef} value={search} onChange={(e) => onSearch(e.target.value)} placeholder={`Search ${companyName}`} aria-label="Search the Forum" onKeyDown={(e) => e.key === 'Escape' && onSearch('')} />
        <span className="fm-nav__kbd">⌘F</span>
      </div>
      {(openAsks > 0 || openProposals > 0) && (
        <div className="fm-nav__needs">
          {openAsks > 0 && (
            <button className="fm-chip fm-chip--needs" onClick={() => onSearch('is:ask')}>
              <span className="fm-tessera fm-tessera--needs" aria-hidden />
              {openAsks} ask{openAsks === 1 ? '' : 's'}
            </button>
          )}
          {openProposals > 0 && (
            <button className="fm-chip fm-chip--needs" onClick={() => onSearch('is:proposal')}>
              <span className="fm-tessera fm-tessera--needs" aria-hidden />
              {openProposals} proposal{openProposals === 1 ? '' : 's'}
            </button>
          )}
        </div>
      )}
      <div className="fm-nav__scroll">
        <div className="fm-nav__section">
          <span>Channels</span>
          <button className="fm-icon-btn" title="New channel" aria-label="New channel" onClick={onNewChannel}>
            <Icon name="plus" size={12} />
          </button>
        </div>
        {topics.map((c) =>
          row(
            c,
            c.name,
            c.kind === 'private' ? <Icon name="lock" size={12} /> : c.departmentId ? <span className="fm-nav__dept" style={{ background: deptColor(c) ?? 'var(--text-tertiary)' }} aria-hidden /> : '#'
          )
        )}
        <div
          className={`fm-nav__row ${agentTalk ? 'is-selected' : ''}`}
          role="button"
          tabIndex={0}
          title="Conversations between agents: who asked whom, why, cost, and the limits"
          onClick={onAgentTalk}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onAgentTalk())}
        >
          <span className="fm-nav__lead">
            <Icon name="chat" size={12} />
          </span>
          <span className="fm-nav__label">Agent talk</span>
        </div>
        {proposals.length > 0 && (
          <>
            <div className="fm-nav__section">
              <span>Proposals</span>
            </div>
            {proposals.map((c) => row(c, c.name, '#'))}
          </>
        )}
        <div className="fm-nav__section">
          <span>Direct messages</span>
          <button className="fm-icon-btn" title="New message" aria-label="New message" onClick={onNewDm}>
            <Icon name="plus" size={12} />
          </button>
        </div>
        {dms.map((c) => {
          const others = c.memberIds.filter((id) => id !== me?.id)
          const d = ctx?.display(others[0] ?? '')
          return row(
            c,
            <>
              <span>{others.map((id) => ctx?.display(id)?.name ?? '…').join(', ')}</span>
              {others.length === 1 && d?.kind === 'agent' && <span className="fm-nav__role">{d.role}</span>}
            </>,
            <MemberAvatar display={d ?? null} size={18} working={!!ctx?.working.has(others[0] ?? '')} />
          )
        })}
        <div className="fm-nav__row fm-nav__row--action" role="button" tabIndex={0} onClick={onNewChannel} onKeyDown={(e) => e.key === 'Enter' && onNewChannel()}>
          <span className="fm-nav__lead">
            <Icon name="plus" size={12} />
          </span>
          <span className="fm-nav__label">Add channel</span>
        </div>
        <div className="fm-nav__row fm-nav__row--action" role="button" tabIndex={0} onClick={onInvite} onKeyDown={(e) => e.key === 'Enter' && onInvite()}>
          <span className="fm-nav__lead">
            <Icon name="external" size={12} />
          </span>
          <span className="fm-nav__label">Invite people</span>
        </div>
      </div>
      {me && (
        <div className="fm-nav__me">
          <MemberAvatar display={ctx?.display(me.id) ?? null} size={22} />
          <span className="fm-nav__me-name">{me.name}</span>
          <span className="fm-nav__me-role">{me.role}</span>
        </div>
      )}
    </nav>
  )
}

function useContextSafe(): ForumCtx | null {
  return useContext(ForumContext)
}
