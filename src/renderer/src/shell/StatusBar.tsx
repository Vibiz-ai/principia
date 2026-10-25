import { navigate, scopeCompanyId, useStore } from '../state/store'
import { RelativeTime } from '../components/ui'

export function StatusBar(): React.JSX.Element {
  const status = useStore((s) => s.status)
  const hint = useStore((s) => s.statusHint)
  // a focused company counts only its own runs and sessions (QA: Beta showed Alpha's 24h and Alpha's running chat)
  const companyId = useStore((s) => scopeCompanyId(s))
  const own = companyId && status?.activeByCompany ? (status.activeByCompany[companyId] ?? { running: 0, queued: 0 }) : null
  const running = own ? own.running : (status?.runningSessions ?? 0) + (status?.runningRuns ?? 0)
  const queued = own ? own.queued : (status?.queuedRuns ?? 0)
  const day = status ? (companyId ? (status.last24hByCompany?.[companyId] ?? (status.last24hByCompany ? { passed: 0, failed: 0 } : status.last24h)) : status.last24h) : null
  return (
    <footer className="statusbar">
      <button type="button" className="statusbar__item" onClick={() => void navigate({ name: 'canvas' })} title="Open Canvas (⌘2)">
        {running > 0 ? (
          <>
            <span className="glyph glyph--running status-dot--running">●</span> {running} running
          </>
        ) : (
          <span className="text-tertiary">Idle</span>
        )}
        {queued > 0 && <span className="text-tertiary"> · {queued} queued</span>}
      </button>
      {status?.nextFire && !status.schedulesPaused && (
        <button type="button" className="statusbar__item" onClick={() => void navigate({ name: 'schedules', selectedId: status.nextFire!.scheduleId })}>
          Next: {status.nextFire.name} <RelativeTime iso={status.nextFire.at} />
        </button>
      )}
      {status?.schedulesPaused && (
        <button type="button" className="statusbar__item text-warning" onClick={() => void navigate({ name: 'schedules' })}>
          ⏸ Schedules paused
        </button>
      )}
      <span className="flex1" />
      {hint && <span className="statusbar__item statusbar__static statusbar__hint">{hint}</span>}
      {day && (day.passed > 0 || day.failed > 0) && (
        <span className="statusbar__item statusbar__static">
          24h: <span className="text-success">{day.passed} ✓</span> <span className={day.failed ? 'text-failed' : ''}>{day.failed} ✕</span>
        </span>
      )}
    </footer>
  )
}
