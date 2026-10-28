/**
 * Chats › Claude lists one row per conversation with Claude or Codex, not one per process. Restart, Hand off and
 * "Open as session" each make a new session row that continues the same agent conversation (the old, exited row
 * stays), so the same "VO-15 · Check why…" chat was listed twice. Rows are one per board task, else one per agent-side
 * conversation id, else one per session; the running one wins, else the newest. Pure (sessionRows.test.ts).
 */
import type { Session } from '@shared/types'

type Row = Pick<Session, 'id' | 'status' | 'startedAt' | 'agentSessionId'> & Partial<Pick<Session, 'taskId'>>

/** The conversation a session continues: its board task, else its agent-side conversation, else itself. */
export function sessionThreadKey(s: Row): string {
  return s.taskId ? `task:${s.taskId}` : s.agentSessionId ? `agent:${s.agentSessionId}` : `id:${s.id}`
}

/** One session per conversation (see the module doc), in the input order of the kept ones. */
export function dedupeSessions<T extends Row>(sessions: readonly T[]): T[] {
  const best = new Map<string, T>()
  for (const s of sessions) {
    const k = sessionThreadKey(s)
    const cur = best.get(k)
    if (!cur || Number(s.status === 'running') - Number(cur.status === 'running') > 0 || (s.status === cur.status && s.startedAt > cur.startedAt)) best.set(k, s)
  }
  const keep = new Set(best.values())
  return sessions.filter((s) => keep.has(s))
}
