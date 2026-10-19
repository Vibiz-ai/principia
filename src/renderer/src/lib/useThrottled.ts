import { useCallback, useEffect, useRef } from 'react'

/** Coalesce bursts of events into one call (trailing), e.g. refetch after many run:step events. */
export function useCoalesced(fn: () => void, ms = 250): () => void {
  const ref = useRef(fn)
  ref.current = fn
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  return useCallback(() => {
    if (timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      ref.current()
    }, ms)
  }, [ms])
}
