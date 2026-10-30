/**
 * The answers agents owe people, on disk (FORUM.md §6.4). The responder's queue and the service's reply runs live in
 * memory, so a quit or a crash would forget a person's message: no answer and no line saying why. A row is written
 * before the run starts and removed once the person has an answer, a line saying why not, or canceled the run; the
 * rows still here at boot are the ones the quit interrupted (ForumResponder.recover). Agent asks have their own table
 * (forum_agent_wakes); only people's messages are here.
 */
import type Database from 'better-sqlite3'

export interface OwedReply {
  messageId: string
  memberId: string
  companyId: string
  /** the run answering it; null = still queued behind another reply of this agent */
  runId: string | null
  /** times a boot already started it again */
  attempts: number
  createdAt: string
}

const marks = (ids: readonly string[]) => ids.map(() => '?').join(',')

export class ReplyJournal {
  constructor(private readonly db: Database.Database) {}

  add(messageIds: readonly string[], memberId: string, companyId: string, at: string): void {
    const ins = this.db.prepare('INSERT OR IGNORE INTO forum_owed_replies (message_id, member_id, company_id, created_at) VALUES (?,?,?,?)')
    this.db.transaction(() => {
      for (const id of messageIds) ins.run(id, memberId, companyId, at)
    })()
  }

  started(messageIds: readonly string[], memberId: string, runId: string): void {
    this.db.prepare(`UPDATE forum_owed_replies SET run_id=? WHERE member_id=? AND message_id IN (${marks(messageIds)})`).run(runId, memberId, ...messageIds)
  }

  /** The run ended and the person knows: its messages are settled. */
  finished(runId: string): void {
    this.db.prepare('DELETE FROM forum_owed_replies WHERE run_id=?').run(runId)
  }

  drop(messageIds: readonly string[], memberId: string): void {
    this.db.prepare(`DELETE FROM forum_owed_replies WHERE member_id=? AND message_id IN (${marks(messageIds)})`).run(memberId, ...messageIds)
  }

  retried(messageIds: readonly string[], memberId: string): void {
    this.db.prepare(`UPDATE forum_owed_replies SET attempts=attempts+1 WHERE member_id=? AND message_id IN (${marks(messageIds)})`).run(memberId, ...messageIds)
  }

  /** Everything owed, oldest message first. Rows of messages that no longer exist go. */
  all(): OwedReply[] {
    this.db.prepare('DELETE FROM forum_owed_replies WHERE message_id NOT IN (SELECT id FROM forum_messages)').run()
    return (
      this.db
        .prepare(
          `SELECT o.message_id, o.member_id, o.company_id, o.run_id, o.attempts, o.created_at FROM forum_owed_replies o
           JOIN forum_messages m ON m.id=o.message_id ORDER BY m.seq`
        )
        .all() as { message_id: string; member_id: string; company_id: string; run_id: string | null; attempts: number; created_at: string }[]
    ).map((r) => ({ messageId: r.message_id, memberId: r.member_id, companyId: r.company_id, runId: r.run_id, attempts: r.attempts, createdAt: r.created_at }))
  }

  /** Did this agent write in the message's thread after it? The answer got out before the quit. */
  replied(messageId: string, memberId: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM forum_messages r JOIN forum_messages m ON m.id=?
         WHERE r.thread_seq=COALESCE(m.thread_seq, m.seq) AND r.author_id=? AND r.seq>m.seq AND r.deleted_at IS NULL LIMIT 1`
      )
      .get(messageId, memberId)
  }
}
