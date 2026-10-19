import { Notification } from 'electron'
import type { Run, Settings } from '../shared/types'

const live = new Set<Notification>()

export function notify(opts: { title: string; body: string; sound: boolean; onClick?: () => void }): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title: opts.title, body: opts.body, silent: !opts.sound })
  live.add(n)
  n.on('click', () => {
    live.delete(n)
    opts.onClick?.()
  })
  n.on('close', () => live.delete(n))
  n.show()
  // keep a reference until macOS is done with it (GC'd notifications lose their click handler)
  setTimeout(() => live.delete(n), 10 * 60_000)
}

/** CONTRACT §5.2 notification policy for a run that just ended. */
export function shouldNotifyRun(run: Run, s: Settings): boolean {
  // AUTHORING.md §5: a run that stopped with HIVE_STOP had nothing to do; never notify (no spam by construction)
  if (run.outcome === 'nothing_to_do') return false
  if (run.status === 'failed') return s.notifyOnFailure
  if (run.status === 'passed') {
    if (s.notifyOnSuccess === 'always') return true
    if (s.notifyOnSuccess === 'scheduled') return !!run.scheduleId
  }
  return false
}
