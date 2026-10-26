/**
 * FORUM.md §8: the Forum in the app sidebar (focused mode). A "Forum" section: channels with something new first
 * (bold = unread, accent count = mentions), then DMs with busts; at most 7 rows, the rest live in the Forum view.
 * `useForumBadge` feeds the NAV row's count (mentions + unread DMs).
 */
import { useEffect, useMemo } from 'react'
import { channelLabel } from '@shared/forum'
import { MemberAvatar, useMemberDisplay } from './Avatar'
import { initForumEvents, loadForum, useForum } from '../../state/forum'
import { sortChannels, unreadTotals } from '../../lib/forum'
import { navigate, useStore } from '../../state/store'

export function useForumBadge(companyId: string | null, enabled: boolean): number {
  const channels = useForum((s) => (companyId ? s.byCompany[companyId]?.state?.channels : undefined))
  useEffect(() => {
    if (!companyId || !enabled) return
    initForumEvents()
    void loadForum(companyId)
  }, [companyId, enabled])
  return useMemo(() => (channels ? unreadTotals(channels).mentions : 0), [channels])
}

/** New messages in the company's Forum rooms (agents talking among themselves counts): the sidebar shows Forum then. */
export function useForumUnread(companyId: string | null): number {
  const channels = useForum((s) => (companyId ? s.byCompany[companyId]?.state?.channels : undefined))
  return useMemo(() => (channels ? unreadTotals(channels).unread : 0), [channels])
}

export function ForumSidebarSection({ companyId }: { companyId: string }): React.JSX.Element | null {
  const state = useForum((s) => s.byCompany[companyId]?.state ?? null)
  const view = useStore((s) => s.view)
  const display = useMemberDisplay(state?.members ?? [])
  const rows = useMemo(() => {
    if (!state) return []
    const { channels, dms } = sortChannels(state.channels)
    const joined = channels.filter((c) => c.joined)
    const hot = [...joined, ...dms].filter((c) => c.unread || c.mentions)
    const rest = [...joined.filter((c) => !hot.includes(c)), ...dms.filter((c) => !hot.includes(c)).slice(0, 3)]
    return [...hot, ...rest].slice(0, 7)
  }, [state])
  if (!state) return null
  const names = new Map(state.members.map((m) => [m.id, { name: display(m.id)?.name ?? m.name }]))
  const working = new Set(state.presence.map((p) => p.memberId))
  const current = view.name === 'forum' ? view.channelId : undefined
  return (
    <div className="fm-side-section">
      <div className="sidebar__section">
        <span>Forum</span>
      </div>
      {rows.map((c) => {
        const other = !c.name ? c.memberIds.find((id) => id !== state.me) : undefined
        return (
          <div
            key={c.id}
            className={`side-row side-row--session fm-side-row ${c.unread || c.mentions ? 'is-unread' : ''} ${current === c.id ? 'is-selected' : ''}`}
            role="link"
            tabIndex={0}
            onClick={() => void navigate({ name: 'forum', companyId, channelId: c.id, nonce: Date.now() })}
            onKeyDown={(e) => e.key === 'Enter' && void navigate({ name: 'forum', companyId, channelId: c.id, nonce: Date.now() })}
          >
            <span className="fm-side-row__lead">{other ? <MemberAvatar display={display(other)} size={16} working={working.has(other)} /> : '#'}</span>
            <span className="side-row__label">{c.name ?? channelLabel(c, names, state.me)}</span>
            {(c.mentions > 0 || (!c.name && c.unread > 0)) && <span className="side-row__badge side-row__badge--needs">{c.mentions || c.unread}</span>}
          </div>
        )
      })}
    </div>
  )
}
