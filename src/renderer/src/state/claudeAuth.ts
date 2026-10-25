/** Five doors E12: the real Claude sign-in (`claude auth status`), shared by AI providers and Spend; main caches it. */
import { useEffect, useState } from 'react'
import type { ClaudeAuthStatus } from '@shared/providerAuth'
import { hive } from '../lib/hive'

let memo: ClaudeAuthStatus | null = null
/**
 * `fresh`: the page that decides on it (onboarding's last step, Settings › AI providers) asks Claude again on arrival
 * instead of reading main's one-minute cache, so a sign-out a moment ago never reads "signed in".
 */
export function useClaudeAuth(opts: { fresh?: boolean } = {}): { auth: ClaudeAuthStatus | null; recheck: () => Promise<void>; checking: boolean } {
  const [auth, setAuth] = useState<ClaudeAuthStatus | null>(opts.fresh ? null : memo)
  const [checking, setChecking] = useState(false)
  const load = async (refresh = false): Promise<void> => {
    setChecking(true)
    try {
      memo = await hive.providers.claudeAuth(refresh ? { refresh } : undefined)
    } catch {
      memo = null
    }
    setAuth(memo)
    setChecking(false)
  }
  useEffect(() => {
    void load(!!opts.fresh)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return { auth, recheck: () => load(true), checking }
}

/** The last Claude check outside React: null before the first one. Actions that start agents read it (E12). */
export function claudeSignedOut(): boolean {
  return memo?.state === 'signedOut' || memo?.state === 'missing'
}
