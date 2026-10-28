/**
 * CHAT-UI.md §8: a task a chat session filed (company_file_task, or task_create for the chat's own work) reports back
 * into that chat when it comes back: in review, done or failed. The card in the chat (its tool call, drawn as the live
 * task card) already moves with the task; this is the line under it that says the result, as a notice in the chat.
 * Once per task and run. Pure apart from the deps: tested without Electron.
 */
import { isFinishedCard, taskAskKey, taskAskSay, taskCardResult, taskCardState, taskResultLine, waitsForAnswer } from '../../shared/taskCard'
import { TRACK_PREFIX } from '../../shared/company'

/** The session a chat-filed task came from: externalId `<sessionId>:<call>` or `track:<sessionId>:<call>`. */
export function sessionOfTask(t: { source?: string; externalId?: string | null }): string | null {
  if (t.source !== 'agent' || !t.externalId) return null
  const raw = t.externalId.startsWith(TRACK_PREFIX) ? t.externalId.slice(TRACK_PREFIX.length) : t.externalId
  const i = raw.indexOf(':')
  return i > 0 ? raw.slice(0, i) : null
}

export interface ChatTaskNotesDeps {
  /** the id names a chat session (not a run: a task run's subtasks report through their parent) */
  isSession(id: string): boolean
  /** a notice in that chat; false when the chat is not open (the card shows the result when it opens) */
  note(sessionId: string, text: string): boolean
}

type NoteTask = { id: string; identifier: string; status: string; source?: string; externalId?: string | null; blockReason?: string | null; runId?: string | null; ask?: { prompt: string; options?: string[]; answer?: string } | null; report?: { summary?: string } | null; doneNote?: string | null; work?: { pr?: { url: string } | null } | null }

export class ChatTaskNotes {
  private readonly sent = new Set<string>()
  constructor(private readonly d: ChatTaskNotesDeps) {}

  private remember(key: string): void {
    this.sent.add(key)
    if (this.sent.size > 2000) for (const k of [...this.sent].slice(0, 1000)) this.sent.delete(k)
  }

  /** CompanyStore.onTaskWrite. Never throws. Returns the line it posted, if any. */
  onTaskWrite(t: NoteTask): string | null {
    try {
      const sid = sessionOfTask(t)
      if (!sid || !this.d.isSession(sid)) return null
      // CHAT-UI.md §8: a task that stops for you says its whole question here, once per ask (the card keeps one line)
      if (t.ask && waitsForAnswer(t)) {
        const key = `${t.id}:ask:${taskAskKey(t.id, t.runId, t.ask.prompt)}`
        if (this.sent.has(key)) return null
        const text = taskAskSay({ identifier: t.identifier, prompt: t.ask.prompt, options: t.ask.options ?? null, summary: t.report?.summary ?? null, where: `Answer it with Answer on the ${t.identifier} card.` })
        if (!this.d.note(sid, text)) return null
        this.remember(key)
        return text
      }
      const state = taskCardState({ status: t.status, blockReason: t.blockReason ?? null })
      if (!isFinishedCard(state)) return null
      // once per run, like the conversation's result post: review then approve is one line, not two
      const key = `${t.id}:${t.runId ?? ''}`
      if (this.sent.has(key)) return null
      const text = taskResultLine({ identifier: t.identifier, state, result: taskCardResult(t), prUrl: t.work?.pr?.url ?? null }, t.status === 'canceled')
      if (!this.d.note(sid, text)) return null
      this.remember(key)
      return text
    } catch {
      return null
    }
  }
}

