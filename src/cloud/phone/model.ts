/**
 * The phone app's view models (REMOTE.md RA3). Pure: no DOM, no fetch. The chat replica applies the desktop's own
 * ChatOps with the desktop's ChatModel, and the chat lines come from the desktop's buildBlocks and toolLine, so a tool
 * reads the same plain words on the phone as in the Mac's chat pane.
 */
import type { ChatItem, ChatOp, ChatSnapshot, ChatToolItem } from '../../shared/chat'
import { ChatModel } from '../../shared/chatReduce'
import { buildBlocks, duration, type ChatBlock } from '../../shared/chatView'
import { groupSummary, permissionTitle, toolLine } from '../../shared/toolVerbs'
import type { PhoneChatRef, PhoneRoomMember, PhoneSession } from '../../shared/remote'

// ---------- routes ----------

/** tasks: the board (read only), reached from Now; not one of the four tabs at the bottom */
export type Tab = 'now' | 'needs' | 'chats' | 'room' | 'tasks'
export interface Route {
  companyId: string | null
  tab: Tab
  open: PhoneChatRef | null
  /** the board: one task open (`#/c/co_1/tasks/ta_2`) */
  task?: string
}
const TABS: readonly Tab[] = ['now', 'needs', 'chats', 'room', 'tasks']

/** `#/c/co_1/chats/session/se_2` -> route. Anything else reads as Now of the first company. */
export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p)
    } catch {
      return ''
    }
  })
  if (parts[0] !== 'c' || !parts[1]) return { companyId: null, tab: 'now', open: null }
  const tab = (TABS as readonly string[]).includes(parts[2] ?? '') ? (parts[2] as Tab) : 'now'
  const kind = parts[3]
  const open: PhoneChatRef | null = tab === 'chats' && (kind === 'session' || kind === 'agent') && parts[4] ? { kind, id: parts[4] } : null
  return { companyId: parts[1], tab, open, ...(tab === 'tasks' && parts[3] ? { task: parts[3] } : {}) }
}
export function routeHash(r: Route): string {
  if (!r.companyId) return '#/'
  const base = `#/c/${encodeURIComponent(r.companyId)}/${r.tab}`
  if (r.tab === 'tasks' && r.task) return `${base}/${encodeURIComponent(r.task)}`
  return r.open && r.tab === 'chats' ? `${base}/${r.open.kind}/${encodeURIComponent(r.open.id)}` : base
}
/** `#pair=<code>` (the pairing link), or null. */
export function pairCode(hash: string): string | null {
  const m = /(?:^#|&)pair=([0-9a-f]{32})(?:&|$)/.exec(hash)
  return m ? m[1]! : null
}

// ---------- words ----------

/** "now", "4m", "2h", "3d" */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ''
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (!Number.isFinite(s)) return ''
  if (s < 45) return 'now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}
/** "2 working · 1 needs you", "Paused", "Quiet right now" */
export function headline(o: { working: number; needs: number; paused: boolean }): string {
  if (o.paused) return o.needs ? `Paused · ${o.needs} need${o.needs === 1 ? 's' : ''} you` : 'Paused'
  const parts = [o.working ? `${o.working} working` : '', o.needs ? `${o.needs} need${o.needs === 1 ? 's' : ''} you` : ''].filter(Boolean)
  return parts.join(' · ') || 'Quiet right now'
}
/** A name for this phone from its browser ("iPhone", "Android phone"). */
export function deviceName(ua: string): string {
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android phone'
  if (/Macintosh/.test(ua)) return 'Mac browser'
  return 'Phone'
}

// ---------- chat replica ----------

/** One chat, kept in step with the Mac: a snapshot, then numbered ops; a gap means take a fresh snapshot. */
export class ChatReplica {
  readonly model = new ChatModel()
  snap: ChatSnapshot
  constructor(s: ChatSnapshot) {
    this.snap = s
    this.model.apply({ op: 'reset', items: s.items })
  }
  get items(): ChatItem[] {
    return this.model.items
  }
  /** 'ok' applied, 'old' already had it, 'gap' a batch was missed (refetch) */
  apply(seq: number, ops: ChatOp[]): 'ok' | 'old' | 'gap' {
    if (seq <= this.snap.seq) return 'old'
    if (seq !== this.snap.seq + 1) return 'gap'
    let v = { ...this.snap, seq }
    for (const op of ops) {
      if (op.op === 'state') v = { ...v, turn: op.turn, ...(op.activity !== undefined ? { activity: op.activity } : {}), ...(op.turnStartedAt !== undefined ? { turnStartedAt: op.turnStartedAt } : {}), ...(op.note !== undefined ? { note: op.note } : {}) }
      else if (op.op === 'mode') v = { ...v, mode: op.mode }
      else if (op.op === 'queue') v = { ...v, queue: op.queue }
      else if (op.op === 'meta') v = { ...v, meta: { ...v.meta, ...op.meta } }
      else this.model.apply(op)
    }
    this.snap = { ...v, items: this.model.items }
    return 'ok'
  }
  /** working, starting or waiting on you: Stop is offered and new messages queue */
  get busy(): boolean {
    return this.snap.turn === 'working' || this.snap.turn === 'starting' || this.snap.turn === 'needs'
  }
}

/** What one chat row on the phone shows. */
export type ChatLine =
  | { t: 'me'; id: string; text: string; queued: boolean }
  | { t: 'say'; id: string; text: string; streaming: boolean }
  /** text: what it does in words; code: the file, pattern or command it works on (its own line, monospace) */
  | { t: 'tool'; id: string; text: string; code: string; status: 'run' | 'ok' | 'err'; sub: number }
  | { t: 'plan'; id: string; done: number; total: number; items: { text: string; done: boolean; now: boolean }[] }
  | { t: 'thinking'; id: string }
  | { t: 'permission'; id: string; requestId: string; title: string; detail: string | null; open: boolean; outcome: string | null }
  | { t: 'question'; id: string; requestId: string; questions: { question: string; options: string[]; multi: boolean }[]; open: boolean; answers: Record<string, string> | null }
  | { t: 'planCard'; id: string; requestId: string; plan: string; open: boolean; outcome: string | null }
  | { t: 'notice'; id: string; tone: 'info' | 'warn' | 'error'; text: string }
  | { t: 'end'; id: string; text: string }

const toolStatus = (t: ChatToolItem): 'run' | 'ok' | 'err' => (t.status === 'pending' || t.status === 'running' ? 'run' : t.status === 'ok' ? 'ok' : 'err')
const lineOf = (t: ChatToolItem): { text: string; code: string } => {
  const l = toolLine(t)
  return { text: [l.verb, l.meta ? `· ${l.meta}` : ''].filter(Boolean).join(' '), code: l.target }
}
function countTools(blocks: ChatBlock[]): number {
  return blocks.reduce((n, b) => n + (b.t === 'tool' ? 1 + countTools(b.children) : b.t === 'group' ? b.tools.length : 0), 0)
}

/** Dividers the Mac adds when a chat is rebuilt from its transcript (a hand-back from the terminal, a resume). */
export const REPLAY_NOTICES: ReadonlySet<string> = new Set(['From the terminal', 'Back from the terminal', 'Resumed this conversation'])

/** The chat as phone rows: the desktop's blocks, flattened; subagent work is one line with its count. */
export function chatLines(items: readonly ChatItem[]): ChatLine[] {
  const out: ChatLine[] = []
  for (const b of buildBlocks(items)) {
    if (b.t === 'group') out.push({ t: 'tool', id: b.id, text: groupSummary(b.tools), code: '', status: b.tools.some((x) => x.status === 'pending' || x.status === 'running') ? 'run' : 'ok', sub: 0 })
    else if (b.t === 'tool') out.push({ t: 'tool', id: b.item.id, ...lineOf(b.item), status: toolStatus(b.item), sub: countTools(b.children) })
    else if (b.t === 'todo') {
      if (!b.latest) continue
      const todos = (Array.isArray((b.item.input as { todos?: unknown }).todos) ? (b.item.input as { todos: { content?: string; status?: string; activeForm?: string }[] }).todos : []).map((x) => ({ text: (x.status === 'in_progress' ? x.activeForm : x.content) ?? x.content ?? '', done: x.status === 'completed', now: x.status === 'in_progress' }))
      out.push({ t: 'plan', id: b.item.id, done: todos.filter((x) => x.done).length, total: todos.length, items: todos })
    } else {
      const it = b.item
      switch (it.kind) {
        case 'user':
          out.push({ t: 'me', id: it.id, text: it.text || (it.images ? `${it.images} image${it.images === 1 ? '' : 's'}` : ''), queued: it.state === 'queued' })
          break
        case 'text':
          if (it.md.trim() || it.streaming) out.push({ t: 'say', id: it.id, text: it.md, streaming: it.streaming })
          break
        case 'thinking':
          if (it.streaming) out.push({ t: 'thinking', id: it.id })
          break
        case 'permission':
          out.push({ t: 'permission', id: it.id, requestId: it.requestId, title: permissionTitle(it.tool, it.input), detail: it.description ?? commandOf(it.input), open: it.state === 'open', outcome: it.outcome ?? (it.state === 'allowed' ? 'Allowed' : it.state === 'denied' ? 'Denied' : it.state === 'expired' ? 'Expired' : null) })
          break
        case 'question':
          out.push({ t: 'question', id: it.id, requestId: it.requestId, questions: it.questions.map((q) => ({ question: q.question, options: q.options.map((o) => o.label), multi: q.multiSelect })), open: it.state === 'open', answers: it.answers })
          break
        case 'plan':
          out.push({ t: 'planCard', id: it.id, requestId: it.requestId, plan: it.plan, open: it.state === 'open', outcome: it.state === 'approved' ? 'Plan approved' : it.state === 'rejected' ? 'Kept planning' : it.state === 'expired' ? 'Expired' : null })
          break
        case 'notice':
          // the Mac's replay dividers ("From the terminal") mean nothing on the phone
          if (REPLAY_NOTICES.has(it.text)) break
          out.push({ t: 'notice', id: it.id, tone: it.tone, text: it.text })
          break
        case 'turnEnd': {
          const files = it.files.length ? ` · ${it.files.length} file${it.files.length === 1 ? '' : 's'} changed` : ''
          out.push({ t: 'end', id: it.id, text: it.error ? `Stopped: ${it.error}` : `Done${it.ms ? ` in ${duration(it.ms)}` : ''}${files}` })
          break
        }
      }
    }
  }
  return out
}
function commandOf(input: Record<string, unknown>): string | null {
  const c = typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? input.file_path : typeof input.url === 'string' ? input.url : null
  return c ? (c.length > 300 ? `${c.slice(0, 299)}…` : c) : null
}

// ---------- @mentions ----------

/** The @word being typed at the caret: its start and what follows the @. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const m = /(^|\s)@([a-z0-9._-]{0,32})$/i.exec(before)
  if (!m) return null
  return { start: caret - m[2]!.length - 1, query: m[2]!.toLowerCase() }
}
/** Members whose handle or name starts with the query, agents first, at most five. */
export function mentionMatches(members: readonly PhoneRoomMember[], query: string, me: string | null): PhoneRoomMember[] {
  const q = query.toLowerCase()
  return members
    .filter((m) => m.id !== me && (m.handle.startsWith(q) || m.name.toLowerCase().startsWith(q) || m.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q))))
    .sort((a, b) => Number(b.kind === 'agent') - Number(a.kind === 'agent') || a.handle.localeCompare(b.handle))
    .slice(0, 5)
}
/** Replaces the @word at `start..caret` with `@handle `. */
export function insertMention(text: string, start: number, caret: number, handle: string): { text: string; caret: number } {
  const ins = `@${handle} `
  return { text: text.slice(0, start) + ins + text.slice(caret), caret: start + ins.length }
}

// ---------- the team room ----------

/** A new message in place: a thread reply goes after its root's last reply; anything else at the end. */
export function placeMessage<T extends { id: string; threadId: string | null }>(list: readonly T[], m: T): T[] {
  if (list.some((x) => x.id === m.id)) return [...list]
  if (!m.threadId) return [...list, m]
  let at = -1
  list.forEach((x, i) => {
    if (x.id === m.threadId || x.threadId === m.threadId) at = i
  })
  return at < 0 ? [...list, m] : [...list.slice(0, at + 1), m, ...list.slice(at + 1)]
}

/**
 * A { t: 'chat' } message for the open conversation: its ops go into the replica. A terminal opened before its
 * transcript existed has no replica, and the Mac's empty ops there say "read it again" (its transcript appeared, it
 * ended, it asks something).
 */
export function chatMessageAction(o: { openId: string | null; session: PhoneSession | null; hasReplica: boolean }, sessionId: string): 'apply' | 'reload' | 'ignore' {
  if (o.openId !== sessionId) return 'ignore'
  if (o.hasReplica) return 'apply'
  return o.session?.ref.id === sessionId && o.session.terminal ? 'reload' : 'ignore'
}

/**
 * The composer of a terminal on the Mac: none once it ended, or for a shell (nothing to type into); otherwise the box
 * stays, and while it cannot take a message (it asks something, shows a choice) the reason is the placeholder and
 * Send is off.
 */
export function terminalComposer(t: NonNullable<PhoneSession['terminal']>, name: string): { placeholder: string; held: boolean } | null {
  if (t.ended) return null
  if (t.canType || t.canReply) return { placeholder: `Message ${name}`, held: false }
  return t.held ? { placeholder: t.held, held: true } : null
}
