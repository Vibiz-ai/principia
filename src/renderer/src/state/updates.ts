/**
 * RELEASING.md §4: the renderer side of app updates. One quiet toast per ready version ("Update ready - restart to
 * install", with Restart); Settings › About shows the version, the state and Check for updates. Restart is main's
 * decision: it refuses while agents work and says why.
 */
import { useSyncExternalStore } from 'react'
import { DOWNLOAD_PAGE_URL, shouldAnnounce, type UpdateState } from '@shared/updates'
import { hive } from '../lib/hive'
import { attempt, toast } from './store'

let current: UpdateState | null = null
let announced: string | null = null
const listeners = new Set<() => void>()

function apply(s: UpdateState): void {
  current = s
  for (const l of listeners) l()
  if (shouldAnnounce(s, announced)) {
    announced = s.next
    if (s.phase === 'available')
      toast('A new version is out: download it from useprincipia.com', 'info', { action: { label: 'Download', run: () => void hive.app.openExternal({ url: DOWNLOAD_PAGE_URL }).catch(() => undefined) } })
    else toast('Update ready - restart to install', 'info', { action: { label: 'Restart', run: () => void restartForUpdate() } })
  }
}

let wired = false
export function wireUpdateEvents(): void {
  if (wired) return
  wired = true
  hive.on('updates:changed', apply)
  void hive.updates.state().then(apply, () => undefined)
}

export function useUpdates(): UpdateState | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current
  )
}

export async function checkForUpdates(): Promise<void> {
  const s = await attempt(() => hive.updates.check(), 'Updates')
  if (s) apply(s)
}

export async function restartForUpdate(): Promise<void> {
  const r = await attempt(() => hive.updates.restart(), 'Restart')
  if (r && !r.restarting) toast(r.reason)
}
