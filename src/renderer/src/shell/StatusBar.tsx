import { navigate, useStore } from '../state/store'
import { RelativeTime } from '../components/ui'

export function StatusBar(): React.JSX.Element {
  const status = useStore((s) => s.status)
  const running = (status?.runningSessions ?? 0) + (status?.runningRuns ?? 0)
  const queued = status?.queuedRuns ?? 0
  const hint = useStore((s) => s.statusHint)
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
      {status && (status.last24h.passed > 0 || status.last24h.failed > 0) && (
        <span className="statusbar__item statusbar__static">
          24h: <span className="text-success">{status.last24h.passed} ✓</span> <span className={status.last24h.failed ? 'text-failed' : ''}>{status.last24h.failed} ✕</span>
        </span>
      )}
    </footer>
  )
}
