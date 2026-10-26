/**
 * REMOTE.md: Phone's state on the Mac (Settings › App › Phone and the status bar). Main is the truth: one load, then
 * every remote:changed event. Off until the user turns it on (every launch starts off).
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { RemoteState } from '@shared/remote'
import { hive } from '../lib/hive'

let cur: RemoteState | null = null
const subs = new Set<() => void>()
let wired = false
function set(s: RemoteState): void {
  cur = s
  for (const f of subs) f()
}
function wire(): void {
  if (wired) return
  wired = true
  try {
    hive.on('remote:changed', set)
  } catch {
    /* a preload without the event: Phone stays off */
  }
  hive.remote.state().then(set, () => undefined)
}
export function useRemote(): RemoteState | null {
  useEffect(wire, [])
  return useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => cur
  )
}
export function setRemote(s: RemoteState): void {
  set(s)
}
