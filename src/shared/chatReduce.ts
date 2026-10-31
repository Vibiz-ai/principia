/**
 * CHAT-UI.md §3.2: the ONE reducer from claude stream-json lines (and transcript records, same shapes) to ChatItems.
 * Main runs it for live processes and for transcript replay; the renderer only applies the ChatOps it emits. Pure.
 */
import type { ChatItem, ChatOp, ChatPermissionItem, ChatQuestionSpec, ChatSuggestion, ChatToolItem, ChatTurnEndItem, ChatUserItem, ChatMeta } from './chat'
import { fileChange } from './toolVerbs'

const RESULT_MAX = 20_000

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Items plus an id index; applies ChatOps. Main and the renderer both hold one. */
export class ChatModel {
  items: ChatItem[] = []
  private index = new Map<string, number>()

  get(id: string): ChatItem | undefined {
    const i = this.index.get(id)
    return i === undefined ? undefined : this.items[i]
  }
  has(id: string): boolean {
    return this.index.has(id)
  }
  private reindex(): void {
    this.index.clear()
    this.items.forEach((it, i) => this.index.set(it.id, i))
  }
  /** Applies item ops (state/meta/mode/queue ops are ignored here). Returns false when the op did not fit. */
  apply(op: ChatOp): boolean {
    switch (op.op) {
      case 'reset':
        this.items = op.items.slice()
        this.reindex()
        return true
      case 'add':
        if (this.index.has(op.item.id)) return false
        this.index.set(op.item.id, this.items.length)
        this.items.push(op.item)
        return true
      case 'patch': {
        const i = this.index.get(op.id)
        if (i === undefined) return false
        this.items[i] = { ...this.items[i]!, ...op.set } as ChatItem
        return true
      }
      case 'append': {
        const i = this.index.get(op.id)
        if (i === undefined) return false
        const cur = this.items[i] as unknown as Record<string, unknown>
        this.items[i] = { ...cur, [op.field]: `${typeof cur[op.field] === 'string' ? cur[op.field] : ''}${op.text}` } as unknown as ChatItem
        return true
      }
      case 'remove': {
        if (!this.index.has(op.id)) return false
        this.items = this.items.filter((x) => x.id !== op.id)
        this.reindex()
        return true
      }
      default:
        return true
    }
  }
}

/** "Always allow `git push` here" from a CLI permission suggestion. */
export function suggestionLabel(raw: unknown): string {
  const o = obj(raw)
  const dest = str(o.destination)
  const where = dest === 'session' ? 'for this chat' : 'here'
  if (o.type === 'addRules' || o.type === 'replaceRules') {
    const rule = obj(arr(o.rules)[0])
    const tool = str(rule.toolName) ?? 'this tool'
    const content = (str(rule.ruleContent) ?? '').replace(/:\*$/, '').trim()
    if (!content) return `Always allow ${tool} ${where}`
    if (tool === 'Bash') {
      const words = content.split(/\s+/)
      if (content.length <= 40 && !/['"`]/.test(content)) return `Always allow \`${content}\` ${where}`
      // never cut a command mid-quote ("printf 'hi"): two plain words, else the program's name
      const two = words.slice(0, 2).join(' ')
      if (words.length >= 2 && !/[|&;><'"`$()]/.test(two)) return `Always allow \`${two}\` commands ${where}`
      if (words[0] && /^[\w./-]+$/.test(words[0])) return `Always allow \`${words[0]}\` commands ${where}`
      return `Always allow this command ${where}`
    }
    // "domain:example.com" reads as "example.com"
    const shown = tool === 'WebFetch' ? content.replace(/^domain:/, '') : content
    if (tool === 'WebFetch' && shown.length <= 60) return `Always allow opening \`${shown}\` ${where}`
    return shown.length <= 40 ? `Always allow ${tool} on \`${shown}\` ${where}` : `Always allow ${tool} ${where}`
  }
  if (o.type === 'addDirectories') return dest === 'session' ? 'Allow this folder for this chat' : 'Always allow this folder'
  if (o.type === 'setMode') return str(o.mode) === 'acceptEdits' ? 'Allow all edits for this chat' : `Switch to ${str(o.mode) ?? 'another'} mode`
  return 'Always allow'
}

/** Text of a tool_result / message content (strings, text blocks; images become "[image]"). */
export function contentText(c: unknown): string {
  if (typeof c === 'string') return c
  return arr(c)
    .map((b) => {
      const o = obj(b)
      if (o.type === 'text') return str(o.text) ?? ''
      if (o.type === 'image') return '[image]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function questionsOf(input: Record<string, unknown>): ChatQuestionSpec[] {
  return arr(input.questions)
    .map(obj)
    .map((q) => ({
      question: str(q.question) ?? '',
      header: str(q.header),
      multiSelect: q.multiSelect === true,
      options: arr(q.options).map((x) => {
        const o = obj(x)
        return { label: str(o.label) ?? str(x) ?? '', description: str(o.description) }
      }).filter((o) => o.label)
    }))
    .filter((q) => q.question)
}

const INTERRUPT = /^\[Request interrupted by user/
/** "[Subagent hand-back] … The report follows:\n<report>" -> "<report>" (the frame is for the model, not for people). */
export function handBack(text: string): string {
  if (!/^\s*\[Subagent hand-back\]/.test(text)) return text
  const i = text.indexOf('The report follows:')
  return i < 0 ? text : text.slice(i + 'The report follows:'.length).replace(/^\s*\n/, '')
}
// "Interrupted by the user" is Principia's own deny when Stop closes an open approval (replayed from the transcript)
const DENIED = /doesn't want to proceed|was rejected|permission.*denied|denied in principia|user denied|The user doesn't want|^Interrupted by the user/i

/**
 * Lines in, ops out. One instance per conversation. `now` is injectable for tests. Ops are also applied to `model`.
 */
export class ChatReducer {
  readonly model: ChatModel
  private n = 0
  private msgBlocks = new Map<string, number>()
  private curMsg = new Map<string, string>()
  private streamKey = new Map<string, string>()
  private turnFiles = new Map<string, { path: string; add: number; del: number }>()
  private turnStart: number | null = null
  /** the running turn began with a slash command: the CLI may answer it itself */
  private slashTurn = false
  /** user items sent by Principia waiting for the CLI's replayed copy (--replay-user-messages) */
  private awaitingEcho: { id: string; text: string }[] = []
  private out: ChatOp[] = []
  meta: Partial<ChatMeta> = {}

  constructor(
    private o: { now?: () => number; idPrefix?: string; /** AGENT CHAT: who speaks (the agent's name) */ who?: () => string } = {},
    model?: ChatModel
  ) {
    this.model = model ?? new ChatModel()
  }

  private now(): number {
    return this.o.now ? this.o.now() : Date.now()
  }
  newId(p: string): string {
    return `${this.o.idPrefix ?? ''}${p}${++this.n}`
  }
  private emit(op: ChatOp): void {
    if (this.model.apply(op)) this.out.push(op)
  }
  private add(item: ChatItem): void {
    this.emit({ op: 'add', item })
  }
  private patch(id: string, set: Partial<ChatItem>): void {
    this.emit({ op: 'patch', id, set })
  }
  private take(): ChatOp[] {
    const o = this.out
    this.out = []
    return o
  }

  /** Principia sent (or queued) a user message: the item shows at once, the CLI's echo is matched to it. */
  userSent(text: string, images = 0, state: ChatUserItem['state'] = 'sent', id?: string, thumbs: string[] = []): ChatOp[] {
    const item: ChatUserItem = { id: id ?? this.newId('u'), kind: 'user', parent: null, text, images, state, at: this.now(), ...(thumbs.length ? { thumbs: thumbs.slice(0, 6) } : {}) }
    if (this.model.has(item.id)) this.patch(item.id, state === 'sent' ? { state, text, at: item.at } : { state, text })
    else this.add(item)
    if (state === 'sent') {
      this.slashTurn = /^\/[\w:.-]+/.test(text.trim())
      this.awaitingEcho.push({ id: item.id, text: text.trim() })
      this.turnStart ??= this.now()
    }
    return this.take()
  }

  /** A notice line (stopped, compacted, crashed, resumed). */
  notice(text: string, tone: 'info' | 'warn' | 'error' = 'info', action: 'retry' | 'openTerminal' | null = null): ChatOp[] {
    this.add({ id: this.newId('n'), kind: 'notice', parent: null, tone, text, action })
    return this.take()
  }

  /** The turn is over without a `result` (process gone, interrupted): running tools stop, open asks expire. */
  settle(reason: 'interrupted' | 'expired'): ChatOp[] {
    this.settleItems(reason)
    return this.take()
  }

  /** settle() without taking the ops: they go out with the line that caused it (never dropped). */
  private settleItems(reason: 'interrupted' | 'expired'): void {
    for (const it of this.model.items) {
      if (it.kind === 'tool' && (it.status === 'pending' || it.status === 'running')) this.patch(it.id, { status: 'interrupted' })
      if ((it.kind === 'text' || it.kind === 'thinking') && it.streaming) this.patch(it.id, { streaming: false })
      if (it.kind === 'permission' && it.state === 'open') this.patch(it.id, { state: 'expired' })
      if (it.kind === 'question' && it.state === 'open') this.patch(it.id, { state: 'expired' })
      if (it.kind === 'plan' && it.state === 'open') this.patch(it.id, { state: 'expired' })
    }
    void reason
    this.awaitingEcho = []
    this.turnStart = null
    this.turnFiles.clear()
  }

  /** Main patches an item it decided (permission answered, queued message edited). */
  set(id: string, set: Partial<ChatItem>): ChatOp[] {
    this.patch(id, set)
    return this.take()
  }
  remove(id: string): ChatOp[] {
    this.emit({ op: 'remove', id })
    return this.take()
  }

  /** One stream-json line (live) or one transcript record (replay). */
  line(raw: unknown): ChatOp[] {
    const o = obj(raw)
    const type = str(o.type)
    const parent = str(o.parent_tool_use_id)
    switch (type) {
      case 'stream_event':
        this.streamEvent(obj(o.event), parent, str(o.api_message_id))
        break
      case 'assistant':
        if (o.isSidechain === true) break
        if (obj(o.message).model === '<synthetic>') {
          // a slash command the CLI answered itself (/usage, /context: no model call); anything else is the CLI's own
          // filler after an interrupt ("No response requested.")
          if (this.slashTurn) this.assistant(commandReply(obj(o.message)), parent)
          break
        }
        // it went to the model (a skill): what comes next is not a command's own output
        this.slashTurn = false
        this.assistant(obj(o.message), parent)
        break
      case 'user':
        if (o.isSidechain === true) break
        this.user(o, parent)
        break
      case 'control_request':
        this.controlRequest(o)
        break
      case 'system':
        this.system(o)
        break
      case 'result':
        this.result(o)
        break
      case 'rate_limit_event': {
        const w = obj(obj(obj(o.rate_limit_info).unifiedWindows).five_hour)
        const u = num(w.utilization)
        if (u != null) this.meta = { ...this.meta, planPct: Math.round(u * 100), planResetsAt: num(w.resetsAt) }
        break
      }
      default:
        // older transcript compaction marker
        if (type === 'summary') break
    }
    return this.take()
  }

  private streamEvent(ev: Record<string, unknown>, parent: string | null, apiMsg: string | null): void {
    const pk = parent ?? ''
    const et = str(ev.type)
    if (et === 'message_start') {
      const id = str(obj(ev.message).id)
      if (id) this.curMsg.set(pk, id)
      this.turnStart ??= this.now()
      return
    }
    const mid = apiMsg ?? this.curMsg.get(pk) ?? 'msg'
    const idx = num(ev.index) ?? 0
    const key = `${mid}:${idx}`
    if (et === 'content_block_start') {
      const cb = obj(ev.content_block)
      const ct = str(cb.type)
      if (ct === 'text') this.add({ id: `b:${key}`, kind: 'text', parent, md: str(cb.text) ?? '', streaming: true })
      else if (ct === 'thinking' || ct === 'redacted_thinking')
        this.add({ id: `b:${key}`, kind: 'thinking', parent, text: str(cb.thinking) ?? '', streaming: true, startedAt: this.now(), ms: null })
      else if (ct === 'tool_use' || ct === 'server_tool_use') {
        const tid = str(cb.id) ?? key
        this.addTool(tid, str(cb.name) ?? 'tool', {}, parent, 'pending')
        this.streamKey.set(key, `tool:${tid}`)
        return
      } else return
      this.streamKey.set(key, `b:${key}`)
      return
    }
    const id = this.streamKey.get(key)
    if (!id) return
    if (et === 'content_block_delta') {
      const d = obj(ev.delta)
      const dt = str(d.type)
      if (dt === 'text_delta') this.emit({ op: 'append', id, field: 'md', text: str(d.text) ?? '' })
      else if (dt === 'thinking_delta') this.emit({ op: 'append', id, field: 'text', text: str(d.thinking) ?? '' })
      else if (dt === 'input_json_delta') this.emit({ op: 'append', id, field: 'inputPartial', text: str(d.partial_json) ?? '' })
      return
    }
    if (et === 'content_block_stop') {
      const it = this.model.get(id)
      if (!it) return
      if (it.kind === 'text') this.patch(id, { streaming: false })
      else if (it.kind === 'thinking') this.patch(id, { streaming: false, ms: it.startedAt ? this.now() - it.startedAt : null })
      else if (it.kind === 'tool' && it.status === 'pending') {
        let input: Record<string, unknown> = it.input
        try {
          input = it.inputPartial ? obj(JSON.parse(it.inputPartial)) : it.input
        } catch {
          /* the full assistant message carries it */
        }
        this.patch(id, { input, inputPartial: '', status: 'running' })
      }
      this.streamKey.delete(key)
    }
  }

  private addTool(toolUseId: string, name: string, input: Record<string, unknown>, parent: string | null, status: ChatToolItem['status']): void {
    const item: ChatToolItem = {
      id: `tool:${toolUseId}`,
      kind: 'tool',
      parent,
      toolUseId,
      name,
      input,
      inputPartial: '',
      status,
      resultText: '',
      resultTruncated: false,
      startedAt: this.now(),
      ms: null
    }
    this.add(item)
  }

  private assistant(m: Record<string, unknown>, parent: string | null): void {
    const mid = str(m.id) ?? this.newId('m')
    for (const b of arr(m.content).map(obj)) {
      const k = this.msgBlocks.get(mid) ?? 0
      this.msgBlocks.set(mid, k + 1)
      const id = `b:${mid}:${k}`
      const bt = str(b.type)
      if (bt === 'text') {
        const text = str(b.text) ?? ''
        const cur = this.model.get(id)
        if (cur?.kind === 'text') this.patch(id, { md: text || cur.md, streaming: false })
        else if (text.trim()) this.add({ id: cur ? this.newId('t') : id, kind: 'text', parent, md: text, streaming: false })
      } else if (bt === 'thinking' || bt === 'redacted_thinking') {
        const text = str(b.thinking) ?? ''
        const cur = this.model.get(id)
        if (cur?.kind === 'thinking') this.patch(id, { text: text || cur.text, streaming: false, ms: cur.ms ?? (cur.startedAt ? this.now() - cur.startedAt : null) })
        else this.add({ id: cur ? this.newId('th') : id, kind: 'thinking', parent, text, streaming: false, startedAt: null, ms: null })
      } else if (bt === 'tool_use' || bt === 'server_tool_use') {
        const tid = str(b.id) ?? this.newId('x')
        const input = obj(b.input)
        const cur = this.model.get(`tool:${tid}`)
        if (cur?.kind === 'tool') this.patch(cur.id, { input, inputPartial: '', ...(cur.status === 'pending' ? { status: 'running' as const } : {}) })
        else this.addTool(tid, str(b.name) ?? 'tool', input, parent, 'running')
      }
    }
  }

  private user(o: Record<string, unknown>, parent: string | null): void {
    if (o.isMeta === true || o.isCompactSummary === true) {
      if (o.isCompactSummary === true) this.add({ id: this.newId('n'), kind: 'notice', parent: null, tone: 'info', text: 'Conversation compacted', action: null })
      return
    }
    const m = obj(o.message)
    const content = m.content
    const blocks = Array.isArray(content) ? content.map(obj) : []
    const results = blocks.filter((b) => b.type === 'tool_result')
    if (results.length) {
      for (const r of results) this.toolResult(r, o)
      return
    }
    const text = typeof content === 'string' ? content : blocks.filter((b) => b.type === 'text').map((b) => str(b.text) ?? '').join('\n')
    const images = blocks.filter((b) => b.type === 'image').length
    if (INTERRUPT.test(text.trim())) {
      this.settleItems('interrupted')
      this.add({ id: this.newId('n'), kind: 'notice', parent: null, tone: 'info', text: `Stopped. ${this.o.who?.() || 'Claude'} kept everything up to here.`, action: null })
      return
    }
    const shown = commandText(text)
    if (shown === null) return
    if (parent) return // a subagent's prompt is shown on its card
    const want = shown.trim()
    const i = this.awaitingEcho.findIndex((e) => e.text === want)
    if (i >= 0) {
      const [hit] = this.awaitingEcho.splice(i, 1)
      const cur = this.model.get(hit!.id)
      if (cur?.kind === 'user' && cur.state !== 'sent') this.patch(hit!.id, { state: 'sent' })
      return
    }
    if (!want && !images) return
    this.turnStart ??= this.now()
    const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
    this.add({ id: this.newId('u'), kind: 'user', parent: null, text: shown, images, state: 'sent', at: Number.isFinite(at) ? at : this.now() })
  }

  private toolResult(r: Record<string, unknown>, o: Record<string, unknown>): void {
    const tid = str(r.tool_use_id)
    if (!tid) return
    const id = `tool:${tid}`
    const cur = this.model.get(id)
    if (cur?.kind !== 'tool') return
    // a subagent's report reads as its words, without the CLI's hand-back frame around it
    const full = handBack(contentText(r.content))
    const perm = this.model.items.find((x): x is ChatPermissionItem => x.kind === 'permission' && x.toolUseId === tid)
    const isErr = r.is_error === true
    const status: ChatToolItem['status'] = !isErr
      ? 'ok'
      : INTERRUPT.test(full.trim())
        ? 'interrupted'
        : perm?.state === 'denied' || DENIED.test(full)
          ? 'denied'
          : 'error'
    const truncated = full.length > RESULT_MAX
    this.patch(id, {
      status,
      resultText: truncated ? full.slice(0, RESULT_MAX) : full,
      resultTruncated: truncated,
      ms: cur.startedAt != null && o.isReplay !== true ? this.now() - cur.startedAt : cur.ms
    })
    if (status === 'ok') {
      const ch = fileChange(cur.name, cur.input)
      if (ch) {
        const prev = this.turnFiles.get(ch.path)
        this.turnFiles.set(ch.path, prev ? { path: ch.path, add: prev.add + ch.add, del: prev.del + ch.del } : ch)
      }
    }
  }

  private controlRequest(o: Record<string, unknown>): void {
    const req = obj(o.request)
    const rid = str(o.request_id)
    if (!rid || str(req.subtype) !== 'can_use_tool') return
    const tool = str(req.tool_name) ?? 'tool'
    const input = obj(req.input)
    const toolUseId = str(req.tool_use_id)
    const toolItem = toolUseId ? this.model.get(`tool:${toolUseId}`) : undefined
    const parent = toolItem?.parent ?? null
    if (tool === 'AskUserQuestion') {
      this.add({ id: `q:${rid}`, kind: 'question', parent, requestId: rid, toolUseId, questions: questionsOf(input), input, state: 'open', answers: null })
      return
    }
    if (tool === 'ExitPlanMode') {
      this.add({ id: `p:${rid}`, kind: 'plan', parent, requestId: rid, toolUseId, plan: str(input.plan) ?? '', input, state: 'open' })
      return
    }
    const suggestions: ChatSuggestion[] = arr(req.permission_suggestions).map((raw) => ({ label: suggestionLabel(raw), raw }))
    this.add({
      id: `perm:${rid}`,
      kind: 'permission',
      parent,
      requestId: rid,
      toolUseId,
      tool,
      input,
      description: str(req.description) ?? str(req.decision_reason),
      suggestions,
      blockedPath: str(req.blocked_path),
      state: 'open',
      outcome: null
    })
  }

  private system(o: Record<string, unknown>): void {
    const st = str(o.subtype)
    if (st === 'init') {
      this.meta = { ...this.meta, model: str(o.model) ?? this.meta.model ?? null, permissionMode: str(o.permissionMode) ?? this.meta.permissionMode ?? null }
    } else if (st === 'status') {
      const pm = str(o.permissionMode)
      if (pm) this.meta = { ...this.meta, permissionMode: pm }
    } else if (st === 'compact_boundary') {
      this.add({ id: this.newId('n'), kind: 'notice', parent: null, tone: 'info', text: 'Conversation compacted', action: null })
    }
  }

  private result(o: Record<string, unknown>): void {
    const sub = str(o.subtype) ?? 'success'
    const interrupted = sub === 'error_during_execution'
    for (const it of this.model.items) {
      if (it.kind === 'tool' && (it.status === 'pending' || it.status === 'running') && !it.parent) this.patch(it.id, { status: 'interrupted' })
      if ((it.kind === 'text' || it.kind === 'thinking') && it.streaming) this.patch(it.id, { streaming: false })
    }
    if (!interrupted) {
      const isErr = o.is_error === true || sub.startsWith('error')
      const end: ChatTurnEndItem = {
        id: this.newId('e'),
        kind: 'turnEnd',
        parent: null,
        ms: num(o.duration_ms) ?? (this.turnStart != null ? this.now() - this.turnStart : null),
        files: [...this.turnFiles.values()],
        costUsd: num(o.total_cost_usd),
        error: isErr ? (str(o.result) ?? sub).slice(0, 400) : null
      }
      this.add(end)
    }
    this.turnFiles.clear()
    this.turnStart = null
    this.slashTurn = false
  }
}

/** A command's output as a message, without the CLI's filler. */
function commandReply(m: Record<string, unknown>): Record<string, unknown> {
  return { ...m, content: arr(m.content).filter((b) => !/^No response requested\.?$/.test((str(obj(b).text) ?? '').trim())) }
}

/**
 * What a user record shows: slash commands as "/name args", null for records that are not the user talking (local
 * command output, system reminders, caveats).
 */
export function commandText(text: string): string | null {
  const t = text.trim()
  if (!t.startsWith('<')) return text
  const name = /<command-name>([^<]*)<\/command-name>/.exec(t)?.[1]
  if (name) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(t)?.[1] ?? ''
    return `${name.startsWith('/') ? name : `/${name}`}${args.trim() ? ` ${args.trim()}` : ''}`
  }
  return null
}
