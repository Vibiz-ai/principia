/**
 * PR-59 (founder: "right click and close, I want the sidebar clean"): a chat closed from the Chats sidebar only leaves
 * the list, per viewer. Nothing stops or is deleted: it comes back by itself when something new happens in it, the
 * way the task dock's × does (useDockPrefs). Search, Live only and the "N closed" line still reach it.
 */

/** What a row looked like when it was closed: its last activity and where it sorted (rowRank). */
export interface ClosedMark {
  at: string
  rank: number
}
export type ClosedChats = Readonly<Record<string, ClosedMark>>

/** The most closed chats kept, newest activity first; the oldest are long gone from the list anyway. */
const CLOSED_LIMIT = 500

/** A chat's last activity. `turnAt`: a session's `at` only moves when it starts or ends, not when a turn finishes in it. */
export function lastActivity(row: { at: string; turnAt?: string }): string {
  return row.turnAt && row.turnAt > row.at ? row.turnAt : row.at
}

/** Closed until it has newer activity, or sorts higher than it did (it needs you now, went live, has news). */
export function isClosed(row: { key: string; at: string; turnAt?: string }, rank: number, closed: ClosedChats): boolean {
  const mark = closed[row.key]
  return !!mark && lastActivity(row) <= mark.at && rank <= mark.rank
}

/** The closed map with one more chat, trimmed to CLOSED_LIMIT. */
export function withClosed(closed: ClosedChats, key: string, mark: ClosedMark): ClosedChats {
  const all = { ...closed, [key]: mark }
  const keys = Object.keys(all).sort((a, b) => (all[a]!.at < all[b]!.at ? -1 : 1))
  for (const k of keys.slice(0, Math.max(0, keys.length - CLOSED_LIMIT))) delete all[k]
  return all
}

/** The closed map without one chat. */
export function withoutClosed(closed: ClosedChats, key: string): ClosedChats {
  const { [key]: _gone, ...rest } = closed
  return rest
}
