/** Left column (SLACK.md §12.2): filter, Mentions, DMs, Channels, Not joined (Join / Join all / "/invite"). */
import { useMemo, useState } from 'react'
import type { SlackChannel } from '@shared/slack'
import { Icon } from '../Icon'
import { channelLabel, channelSections, joinablePublic, tsToIso } from '../../lib/slack'
import { relative } from '../../lib/time'
import { slackCall } from '../../lib/slackApi'
import { refreshChannels, useSlack } from '../../state/slack'
import { attempt, toast } from '../../state/store'
import { useTick } from '../ui'
import { Avatar } from './bits'
import { JoinAllRow } from './SetupGuide'

export type LeftSel = { kind: 'channel'; id: string } | { kind: 'mentions' } | null

export function ChannelList({ sel, onSelect }: { sel: LeftSel; onSelect: (s: LeftSel) => void }): React.JSX.Element {
  useTick()
  const channels = useSlack((s) => s.channels)
  const users = useSlack((s) => s.users)
  const bot = useSlack((s) => s.status?.workspace?.botName ?? 'hive')
  const [q, setQ] = useState('')
  const [showNotJoined, setShowNotJoined] = useState(false)
  const sec = useMemo(() => channelSections(channels, q), [channels, q])
  const joinable = joinablePublic(channels)

  const row = (c: SlackChannel): React.JSX.Element => {
    const active = sel?.kind === 'channel' && sel.id === c.id
    const dmUser = c.kind === 'dm' && c.dmUserId ? users[c.dmUserId] : undefined
    return (
      <div
        key={c.id}
        className={`side-row schan ${active ? 'is-selected' : ''} ${c.unread ? 'is-unread' : ''} ${c.isMember ? '' : 'is-dim'}`}
        role="link"
        tabIndex={0}
        onClick={() => onSelect({ kind: 'channel', id: c.id })}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect({ kind: 'channel', id: c.id })}
        title={c.topic ?? channelLabel(c, users)}
      >
        {c.kind === 'dm' ? <Avatar user={dmUser} size={16} /> : <span className="schan__glyph">{c.kind === 'private' ? <Icon name="lock" size={12} /> : '#'}</span>}
        <span className="side-row__label">{c.kind === 'dm' || c.kind === 'group_dm' ? channelLabel(c, users) : c.name}</span>
        {c.isMember ? (
          <>
            {c.sync === 'running' || c.sync === 'pending' ? <span className="schan__sync" title="Syncing history" /> : null}
            {c.unread && <span className="schan__dot" aria-label="Unread" />}
            {c.lastMessageTs && <span className="side-row__meta">{relative(tsToIso(c.lastMessageTs))}</span>}
          </>
        ) : c.kind === 'channel' ? (
          <JoinButton channel={c} />
        ) : (
          <span className="side-row__meta" title="Private channels need an invite in Slack">
            /invite @{bot}
          </span>
        )}
      </div>
    )
  }
  return (
    <nav className="schans">
      <div className="schans__filter">
        <input className="input input--sm" value={q} placeholder="Jump to…" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQ('')} aria-label="Filter conversations" />
      </div>
      <div className="schans__list scroll">
        <div className={`side-row ${sel?.kind === 'mentions' ? 'is-selected' : ''}`} role="link" tabIndex={0} onClick={() => onSelect({ kind: 'mentions' })} onKeyDown={(e) => e.key === 'Enter' && onSelect({ kind: 'mentions' })}>
          <span className="schan__glyph">@</span>
          <span className="side-row__label">Mentions</span>
        </div>
        {sec.dms.length > 0 && <div className="schans__section">Direct messages</div>}
        {sec.dms.map(row)}
        <div className="schans__section">Channels</div>
        {sec.channels.length === 0 && <div className="schans__empty text-tertiary">{channels.length ? `@${bot} isn’t in any channel yet.` : 'No channels yet.'}</div>}
        {sec.channels.map(row)}
        {sec.notJoined.length > 0 && (
          <>
            <button type="button" className="schans__section schans__section--btn" onClick={() => setShowNotJoined(!showNotJoined)} aria-expanded={showNotJoined || !!q}>
              <Icon name={showNotJoined || q ? 'chevronDown' : 'chevronRight'} size={10} /> Not joined · {sec.notJoined.length}
            </button>
            {(showNotJoined || !!q) && (
              <>
                {joinable.length > 1 && (
                  <div className="schans__joinall">
                    <JoinAllRow count={joinable.length} compact />
                  </div>
                )}
                {sec.notJoined.map(row)}
              </>
            )}
          </>
        )}
      </div>
    </nav>
  )
}

function JoinButton({ channel }: { channel: SlackChannel }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      className="btn btn--secondary btn--sm schan__join"
      disabled={busy}
      onClick={async (e) => {
        e.stopPropagation()
        setBusy(true)
        const r = await attempt(() => slackCall('slack:join', { channelId: channel.id }), `Join #${channel.name}`)
        setBusy(false)
        if (r) toast(`Joined #${channel.name}. Syncing its history…`)
        void refreshChannels()
      }}
    >
      <span>{busy ? 'Joining…' : 'Join'}</span>
    </button>
  )
}
