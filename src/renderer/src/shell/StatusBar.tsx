import { companyName, navigate, openChatsIn, openTaskLive, resumeCompanyAsked, scopeCompanyId, useStore } from '../state/store'
import { useTaskChannels } from '../state/conversations'
import { workingTarget } from '../lib/convWork'
import { useNeeds, useWorking } from '../state/live'
import { RelativeTime } from '../components/ui'
import { statusNext } from '../lib/statusNext'
import { remoteStatusLine } from '@shared/remote'
import { useRemote } from '../state/remote'

/**
 * The status bar (five doors §2.6, A2): scoped to the company you are in, every item clickable. "Working" and "need
 * you" are the one live source's numbers, the same ones the rail, the sidebar and Home show. A paused company says so
 * and offers Resume instead of a next fire.
 */
export function StatusBar(): React.JSX.Element {
  const status = useStore((s) => s.status)
  const hint = useStore((s) => s.statusHint)
  const companyId = useStore((s) => scopeCompanyId(s))
  const multi = useStore((s) => s.companies.length >= 2)
  const paused = useStore((s) => (companyId ? (s.companies.find((c) => c.id === companyId)?.pausedAt ?? null) : null))
  const workingSlice = useWorking(companyId ?? 'all')
  const working = workingSlice.count
  // CHAT-UI.md §8.6: work that all belongs to one conversation opens that conversation (its tasks are docked there),
  // one task with no conversation opens its task chat, anything else Chats › Live only
  const tasks = useStore((s) => s.tasks)
  const taskChannels = useTaskChannels(companyId)
  const target = workingTarget(workingSlice.items, { tasks, taskChannels })
  const targetCompany = workingSlice.items[0]?.companyId ?? companyId ?? null
  const openWorking = (): void => {
    if (target.kind === 'conv' && targetCompany) openChatsIn(targetCompany, `conv:${target.channelId}`)
    else if (target.kind === 'task') openTaskLive(target.taskId, targetCompany)
    else void navigate({ name: 'chats', filter: 'live' })
  }
  const needs = useNeeds(companyId ?? 'all').count
  const own = companyId && status?.activeByCompany ? (status.activeByCompany[companyId] ?? { running: 0, queued: 0 }) : null
  const queued = own ? own.queued : (status?.queuedRuns ?? 0)
  const day = status ? (companyId ? (status.last24hByCompany?.[companyId] ?? (status.last24hByCompany ? { passed: 0, failed: 0 } : status.last24h)) : status.last24h) : null
  const upcoming = statusNext(status, companyId ?? null)
  const phone = remoteStatusLine(useRemote())
  const next = upcoming?.fire ?? null
  const name = companyId && multi ? companyName(companyId) : null
  // All companies: the next fire names its company ("Next for which client?")
  const nextName = multi && upcoming?.companyId ? companyName(upcoming.companyId) : null
  return (
    <footer className="statusbar">
      {paused && companyId && (
        <button type="button" className="statusbar__item statusbar__paused" onClick={() => void resumeCompanyAsked(companyId)} title={`Resume ${companyName(companyId)}`}>
          <span className="glyph" aria-hidden>‖</span> {name ?? 'Paused'}{name ? ' is paused' : ''} · <span className="statusbar__action">Resume</span>
        </button>
      )}
      <button type="button" className="statusbar__item" onClick={openWorking} title={target.kind === 'conv' ? 'Open the conversation it is for' : target.kind === 'task' ? 'Watch it work' : 'Open Chats › Live (⇧⌘A)'}>
        {working > 0 ? (
          <>
            <span className="glyph glyph--running status-dot--running">●</span> {working} working
          </>
        ) : (
          <span className="text-tertiary">{paused ? 'Nothing working' : 'Idle'}</span>
        )}
        {queued > 0 && <span className="text-tertiary"> · {queued} queued</span>}
      </button>
      {needs > 0 && (
        <button type="button" className="statusbar__item statusbar__needs" onClick={() => void navigate({ name: 'home' })} title="Open Home › Needs you (⌘J jumps to the oldest)">
          <span className="glyph" aria-hidden>◆</span> {needs} need{needs === 1 ? 's' : ''} you
        </button>
      )}
      {next && !status?.schedulesPaused && !paused && (
        <button type="button" className="statusbar__item" onClick={() => void navigate({ name: 'schedules', selectedId: next.scheduleId })}>
          Next{nextName ? ` for ${nextName}` : ''}: {next.name} <RelativeTime iso={next.at} />
        </button>
      )}
      {status?.schedulesPaused && (
        <button type="button" className="statusbar__item text-tertiary" onClick={() => void navigate({ name: 'schedules' })}>
          ‖ Schedules paused in every company
        </button>
      )}
      <span className="flex1" />
      {phone && (
        <button type="button" className="statusbar__item statusbar__phone" onClick={() => void navigate({ name: 'settings', section: 'phone', nonce: Date.now() })} title="Settings › App › Phone">
          <span className="glyph text-success" aria-hidden>■</span> {phone}
        </button>
      )}
      {hint && <span className="statusbar__item statusbar__static statusbar__hint">{hint}</span>}
      {day && (day.passed > 0 || day.failed > 0) && (
        <span className="statusbar__item statusbar__static">
          24h: <span className="text-success">{day.passed} ✓</span> <span className={day.failed ? 'text-failed' : ''}>{day.failed} ✕</span>
        </span>
      )}
    </footer>
  )
}
