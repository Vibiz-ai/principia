/**
 * AGENT CHAT: Codex in the same chat as Claude. `codex app-server` (JSON-RPC over stdio, verified on codex-cli 0.163.0)
 * streams thread items; this reducer folds its notifications, approval requests and resumed history into the SAME
 * ChatItems and ChatOps as shared/chatReduce.ts, so the renderer draws a Codex agent with the Claude chat's cards:
 *
 * - agentMessage (+ item/agentMessage/delta) -> text; reasoning (+ summary deltas) -> thinking;
 * - commandExecution -> a Bash card (or Read / LS / Grep when Codex parsed it as one look-up, so look-ups group);
 * - fileChange -> one Write or Edit card per file, with its diff as old/new text (so the diff view and counts work);
 * - mcpToolCall -> `mcp__<server>__<tool>` (Principia's own tools read like they do for Claude);
 * - webSearch -> WebSearch; turn/plan/updated -> the TodoWrite plan card;
 * - subAgentActivity started / completed (how codex-cli 0.163 announces a helper; its spawnAgent call never shows)
 *   and the older collabAgentToolCall spawnAgent -> a subagent (Task) card named from the helper's path; the helper
 *   thread's items and approvals nest under it, and its last message is the card's report;
 * - item/commandExecution/requestApproval and item/fileChange/requestApproval -> the Allow / Deny permission card;
 * - turn/completed -> the turn-end line (time, files changed, error).
 * What does not map (permission-profile requests, user-input requests, MCP elicitation) is answered plainly by the
 * session and shown as a notice. Pure.
 */
import type { ChatItem, ChatMeta, ChatOp, ChatSuggestion, ChatToolItem, ChatTurnEndItem, ChatUserItem } from './chat'
import { ChatModel } from './chatReduce'

const RESULT_MAX = 20_000
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** `/bin/zsh -lc 'touch a.txt'` -> `touch a.txt` (what the agent asked to run, not the shell wrapper). */
export function unwrapShell(cmd: string): string {
  const m = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/.exec(cmd.trim())
  if (!m) return cmd
  const body = m[1]!.trim()
  if (body.length >= 2 && ((body.startsWith("'") && body.endsWith("'")) || (body.startsWith('"') && body.endsWith('"')))) return body.slice(1, -1).replace(/'\\''/g, "'")
  return body
}

/** A unified hunk (or a new file's text) as the old and new text the diff view and the counts read. */
export function diffSides(kind: string, diff: string): { old: string; next: string; add: number; del: number } {
  if (kind === 'add') {
    const next = diff
    return { old: '', next, add: next ? next.replace(/\n$/, '').split('\n').length : 0, del: 0 }
  }
  if (kind === 'delete') {
    const old = diff
    return { old, next: '', add: 0, del: old ? old.replace(/\n$/, '').split('\n').length : 0 }
  }
  const old: string[] = []
  const next: string[] = []
  let add = 0
  let del = 0
  for (const l of diff.split('\n')) {
    if (l.startsWith('@@') || l.startsWith('---') || l.startsWith('+++') || l.startsWith('\\')) {
      if (l.startsWith('@@') && (old.length || next.length)) {
        old.push('⋯')
        next.push('⋯')
      }
      continue
    }
    if (l.startsWith('+')) {
      next.push(l.slice(1))
      add++
    } else if (l.startsWith('-')) {
      old.push(l.slice(1))
      del++
    } else if (l.startsWith(' ')) {
      old.push(l.slice(1))
      next.push(l.slice(1))
    }
  }
  return { old: old.join('\n'), next: next.join('\n'), add, del }
}

/** How one Codex command shows: a look-up it parsed (read a file, list, search) or a plain command. */
export function commandTool(item: Record<string, unknown>): { name: string; input: Record<string, unknown> } {
  const command = unwrapShell(str(item.command) ?? '')
  const actions = arr(item.commandActions).map(obj)
  if (actions.length === 1) {
    const a = actions[0]!
    if (a.type === 'read' && str(a.path)) return { name: 'Read', input: { file_path: str(a.path), command } }
    if (a.type === 'listFiles') return { name: 'LS', input: { path: str(a.path) ?? '.', command } }
    if (a.type === 'search') return { name: 'Grep', input: { pattern: str(a.query) ?? command, path: str(a.path), command } }
  }
  return { name: 'Bash', input: { command } }
}

const userText = (content: unknown): string =>
  arr(content)
    .map(obj)
    .map((c) => (c.type === 'text' ? (str(c.text) ?? '') : c.type === 'image' || c.type === 'localImage' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n')

/** `/root/list_files` -> `List files`: a helper's path as a name a person reads. */
export function helperLabel(agentPath: string | null): string {
  const last = (agentPath ?? '').split('/').filter(Boolean).pop() ?? ''
  const words = last.replace(/[_\-.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim().toLowerCase()
  return words && words !== 'root' ? words[0]!.toUpperCase() + words.slice(1) : 'Helper'
}

const toolStatus = (s: string | null, exitCode: number | null = null): ChatToolItem['status'] =>
  s === 'inProgress' ? 'running' : s === 'declined' ? 'denied' : s === 'failed' ? 'error' : s === 'completed' ? (exitCode != null && exitCode !== 0 ? 'error' : 'ok') : 'running'

/** Codex app-server messages in, ChatOps out. One instance per thread (the main thread; subagent threads nest). */
export class CodexReducer {
  readonly model: ChatModel
  private n = 0
  private out: ChatOp[] = []
  /** the conversation's own thread; items of other threads belong to a spawned helper */
  threadId: string | null = null
  /** spawned helper thread -> the subagent card's toolUseId */
  private helpers = new Map<string, string>()
  /** the subagent card's toolUseId -> the helper's name in plain words ("List files") */
  private helperNames = new Map<string, string>()
  private awaitingEcho: string[] = []
  private turnFiles = new Map<string, { path: string; add: number; del: number }>()
  private turnStart: number | null = null
  private planId: string | null = null
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

  userSent(text: string, images = 0, state: ChatUserItem['state'] = 'sent', thumbs: string[] = []): ChatOp[] {
    this.add({ id: this.newId('u'), kind: 'user', parent: null, text, images, state, at: this.now(), ...(thumbs.length ? { thumbs: thumbs.slice(0, 6) } : {}) })
    if (state === 'sent') {
      this.awaitingEcho.push(text.trim())
      this.turnStart ??= this.now()
    }
    return this.take()
  }
  notice(text: string, tone: 'info' | 'warn' | 'error' = 'info', action: 'retry' | 'openTerminal' | null = null): ChatOp[] {
    this.add({ id: this.newId('n'), kind: 'notice', parent: null, tone, text, action })
    return this.take()
  }
  set(id: string, set: Partial<ChatItem>): ChatOp[] {
    this.patch(id, set)
    return this.take()
  }
  /** The turn is over without turn/completed (process gone, interrupt): running cards stop, open asks expire. */
  settle(): ChatOp[] {
    for (const it of this.model.items) {
      if (it.kind === 'tool' && (it.status === 'pending' || it.status === 'running') && it.name !== 'TodoWrite') this.patch(it.id, { status: 'interrupted' })
      if ((it.kind === 'text' || it.kind === 'thinking') && it.streaming) this.patch(it.id, { streaming: false })
      if (it.kind === 'permission' && it.state === 'open') this.patch(it.id, { state: 'expired' })
    }
    this.awaitingEcho = []
    this.turnStart = null
    this.turnFiles.clear()
    this.planId = null
    return this.take()
  }

  /** The helper a nested card belongs to, in plain words ("List files"); null for the conversation's own. */
  helperName(parent: string | null): string | null {
    return parent ? (this.helperNames.get(parent) ?? null) : null
  }

  private parentOf(threadId: string | null): string | null {
    if (!threadId || !this.threadId || threadId === this.threadId) return null
    return this.helpers.get(threadId) ?? null
  }
  /** a notification for another thread that is not one of our helpers: not this conversation */
  private foreign(threadId: string | null): boolean {
    return !!threadId && !!this.threadId && threadId !== this.threadId && !this.helpers.has(threadId)
  }

  /** One server notification ({method, params}). */
  notification(method: string, raw: unknown, replay = false): ChatOp[] {
    const p = obj(raw)
    const threadId = str(p.threadId)
    if (this.foreign(threadId)) return []
    const parent = this.parentOf(threadId)
    switch (method) {
      case 'turn/started':
        if (!parent) this.turnStart ??= this.now()
        break
      case 'item/started':
        this.item(obj(p.item), parent, false, replay)
        break
      case 'item/completed':
        this.item(obj(p.item), parent, true, replay)
        break
      case 'item/agentMessage/delta': {
        const id = `t:${str(p.itemId)}`
        const d = str(p.delta)
        if (d && this.model.has(id)) this.emit({ op: 'append', id, field: 'md', text: d })
        break
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const id = `th:${str(p.itemId)}`
        const d = str(p.delta)
        if (d && this.model.has(id)) this.emit({ op: 'append', id, field: 'text', text: d })
        break
      }
      case 'item/commandExecution/outputDelta': {
        const id = `x:${str(p.itemId)}`
        const cur = this.model.get(id)
        const d = str(p.delta)
        if (d && cur?.kind === 'tool' && cur.resultText.length < RESULT_MAX) this.emit({ op: 'append', id, field: 'resultText', text: d })
        break
      }
      case 'turn/plan/updated':
        this.plan(arr(p.plan), parent)
        break
      case 'thread/compacted':
        this.add({ id: this.newId('n'), kind: 'notice', parent: null, tone: 'info', text: 'Conversation compacted', action: null })
        break
      case 'error': {
        if (p.willRetry === true || parent) break
        const e = obj(p.error)
        this.add({ id: this.newId('n'), kind: 'notice', parent: null, tone: 'error', text: `Codex hit an error: ${(str(e.message) ?? 'unknown').slice(0, 300)}`, action: null })
        break
      }
      case 'thread/tokenUsage/updated': {
        if (parent) break
        const u = obj(p.tokenUsage)
        const last = obj(u.last)
        const win = num(u.modelContextWindow)
        const used = num(last.inputTokens)
        if (win && used != null) this.meta = { ...this.meta, contextPct: Math.min(100, Math.round((used / win) * 100)) }
        break
      }
      case 'account/rateLimits/updated': {
        const r = obj(obj(p.rateLimits).primary)
        const pct = num(r.usedPercent)
        if (pct != null) this.meta = { ...this.meta, planPct: Math.round(pct), planResetsAt: num(r.resetsAt) }
        break
      }
      case 'turn/completed':
        if (!parent) this.turnCompleted(obj(p.turn))
        else if (str(obj(p.turn).status) === 'failed') {
          // a helper whose own turn failed: its card says so (a completed one waits for subAgentActivity completed)
          const card = this.model.get(`x:${parent}`)
          if (card?.kind === 'tool' && card.status === 'running') this.patch(card.id, { status: 'error', resultText: (str(obj(obj(p.turn).error).message) ?? 'The helper stopped with an error').slice(0, 400), ms: card.startedAt != null ? this.now() - card.startedAt : null })
        }
        break
    }
    return this.take()
  }

  private plan(steps: unknown[], parent: string | null): void {
    const todos = steps.map(obj).map((s) => {
      const st = str(s.status)
      return { content: str(s.step) ?? '', activeForm: str(s.step) ?? '', status: st === 'inProgress' ? 'in_progress' : st === 'completed' ? 'completed' : 'pending' }
    })
    const done = todos.every((t) => t.status === 'completed')
    if (this.planId && this.model.has(this.planId)) {
      this.patch(this.planId, { input: { todos }, status: done ? 'ok' : 'running' })
      return
    }
    this.planId = this.newId('plan')
    this.add({ id: this.planId, kind: 'tool', parent, toolUseId: this.planId, name: 'TodoWrite', input: { todos }, inputPartial: '', status: done ? 'ok' : 'running', resultText: '', resultTruncated: false, startedAt: this.now(), ms: null })
  }

  private tool(id: string, toolUseId: string, name: string, input: Record<string, unknown>, parent: string | null, status: ChatToolItem['status'], done: boolean, result: string | null, ms: number | null): void {
    const cur = this.model.get(id)
    const text = result ?? (cur?.kind === 'tool' ? cur.resultText : '')
    const truncated = text.length > RESULT_MAX
    if (cur?.kind === 'tool') {
      this.patch(id, { input, status, resultText: truncated ? text.slice(0, RESULT_MAX) : text, resultTruncated: truncated, ms: done ? (ms ?? (cur.startedAt != null ? this.now() - cur.startedAt : null)) : cur.ms })
      return
    }
    this.add({ id, kind: 'tool', parent, toolUseId, name, input, inputPartial: '', status, resultText: truncated ? text.slice(0, RESULT_MAX) : text, resultTruncated: truncated, startedAt: done ? null : this.now(), ms })
  }

  private item(it: Record<string, unknown>, parent: string | null, done: boolean, replay: boolean): void {
    const type = str(it.type)
    const iid = str(it.id) ?? this.newId('i')
    switch (type) {
      case 'userMessage': {
        if (!done || parent) return
        const text = userText(it.content)
        const i = this.awaitingEcho.indexOf(text.trim())
        if (i >= 0) {
          this.awaitingEcho.splice(i, 1)
          return
        }
        if (text.trim()) this.add({ id: `u:${iid}`, kind: 'user', parent: null, text, images: arr(it.content).filter((c) => obj(c).type !== 'text').length, state: 'sent', ...(replay ? {} : { at: this.now() }) })
        return
      }
      case 'agentMessage': {
        const id = `t:${iid}`
        const text = str(it.text) ?? ''
        if (!this.model.has(id)) {
          if (done && !text.trim()) return
          this.add({ id, kind: 'text', parent, md: text, streaming: !done })
        } else if (done) this.patch(id, { md: text || (this.model.get(id) as { md?: string } | undefined)?.md || '', streaming: false })
        return
      }
      case 'reasoning': {
        const id = `th:${iid}`
        const text = [...arr(it.summary), ...(arr(it.summary).length ? [] : arr(it.content))].filter((x): x is string => typeof x === 'string').join('\n\n')
        if (!this.model.has(id)) {
          if (done && !text.trim()) return
          this.add({ id, kind: 'thinking', parent, text, streaming: !done, startedAt: done ? null : this.now(), ms: null })
        } else if (done) {
          const cur = this.model.get(id)
          const started = cur?.kind === 'thinking' ? cur.startedAt : null
          this.patch(id, { ...(text ? { text } : {}), streaming: false, ms: started != null && !replay ? this.now() - started : null })
        }
        return
      }
      case 'commandExecution': {
        const t = commandTool(it)
        const out = str(it.aggregatedOutput)
        const exit = num(it.exitCode)
        const status = done ? toolStatus(str(it.status), exit) : 'running'
        this.tool(`x:${iid}`, iid, t.name, t.input, parent, status, done, done ? `${out ?? ''}${exit != null && exit !== 0 ? `${out ? '\n' : ''}exit ${exit}` : ''}` : null, num(it.durationMs))
        return
      }
      case 'fileChange': {
        const changes = arr(it.changes).map(obj)
        const status = done ? toolStatus(str(it.status)) : 'running'
        changes.forEach((c, i) => {
          const path = str(c.path) ?? 'file'
          const kind = str(obj(c.kind).type) ?? 'update'
          const d = diffSides(kind, str(c.diff) ?? '')
          const name = kind === 'add' ? 'Write' : 'Edit'
          const input = kind === 'add' ? { file_path: path, content: d.next } : { file_path: path, old_string: d.old, new_string: d.next }
          const tid = i === 0 ? iid : `${iid}:${i}`
          this.tool(`x:${tid}`, tid, name, input, parent, status, done, null, null)
          if (done && status === 'ok' && !parent) {
            const prev = this.turnFiles.get(path)
            this.turnFiles.set(path, prev ? { path, add: prev.add + d.add, del: prev.del + d.del } : { path, add: d.add, del: d.del })
          }
        })
        return
      }
      case 'mcpToolCall': {
        const server = str(it.server) ?? 'mcp'
        const tool = str(it.tool) ?? 'tool'
        const st = str(it.status)
        const err = obj(it.error)
        const result = arr(obj(it.result).content).map(obj).map((c) => (c.type === 'text' ? (str(c.text) ?? '') : '')).filter(Boolean).join('\n')
        const status: ChatToolItem['status'] = !done ? 'running' : st === 'failed' || str(err.message) ? 'error' : 'ok'
        this.tool(`x:${iid}`, iid, `mcp__${server}__${tool}`, obj(it.arguments), parent, status, done, done ? (str(err.message) ?? result) : null, num(it.durationMs))
        return
      }
      case 'dynamicToolCall': {
        const status: ChatToolItem['status'] = !done ? 'running' : it.success === false ? 'error' : 'ok'
        this.tool(`x:${iid}`, iid, str(it.tool) ?? 'tool', obj(it.arguments), parent, status, done, null, num(it.durationMs))
        return
      }
      case 'webSearch': {
        const action = obj(it.action)
        const query = str(it.query) ?? str(action.query) ?? ''
        this.tool(`x:${iid}`, iid, 'WebSearch', { query }, parent, done ? 'ok' : 'running', done, null, null)
        return
      }
      case 'collabAgentToolCall': {
        const tool = str(it.tool)
        for (const t of arr(it.receiverThreadIds)) if (typeof t === 'string' && tool === 'spawnAgent' && !this.helpers.has(t)) this.helpers.set(t, iid)
        if (tool !== 'spawnAgent') return
        const prompt = str(it.prompt) ?? ''
        if (!this.helperNames.has(iid)) this.helperNames.set(iid, prompt.split('\n')[0]?.slice(0, 120) || 'Helper')
        const st = str(it.status)
        const status: ChatToolItem['status'] = !done ? 'running' : st === 'failed' ? 'error' : 'ok'
        const states = Object.values(obj(it.agentsStates)).map(obj)
        const said = states.map((s) => str(s.message) ?? str(s.lastMessage) ?? '').filter(Boolean).join('\n\n')
        this.tool(`x:${iid}`, iid, 'Task', { description: prompt.split('\n')[0]?.slice(0, 120) ?? '', prompt, subagent_type: 'helper' }, parent, status, done, done ? said : null, null)
        return
      }
      case 'subAgentActivity': {
        const thread = str(it.agentThreadId)
        if (!thread) return
        const kind = str(it.kind)
        let tid = this.helpers.get(thread)
        if (!tid) {
          // the card is keyed by the helper's thread: its started and completed items carry different ids
          tid = kind === 'started' ? iid : `sa:${thread}`
          this.helpers.set(thread, tid)
        }
        const name = helperLabel(str(it.agentPath))
        if (!this.helperNames.has(tid)) this.helperNames.set(tid, name)
        const input = { description: this.helperNames.get(tid)!, prompt: '', subagent_type: 'helper', ...(str(it.model) ? { model: str(it.model) } : {}) }
        const cur = this.model.get(`x:${tid}`)
        if (kind === 'completed') {
          const report = [...this.model.items].reverse().find((i) => i.kind === 'text' && i.parent === tid)
          const said = report?.kind === 'text' ? report.md : ''
          const failed = cur?.kind === 'tool' && cur.status === 'error'
          this.tool(`x:${tid}`, tid, 'Task', cur?.kind === 'tool' ? cur.input : input, parent, failed ? 'error' : 'ok', true, failed && !said ? null : said, null)
          return
        }
        if (!cur) this.tool(`x:${tid}`, tid, 'Task', input, parent, 'running', false, null, null)
        return
      }
      case 'contextCompaction':
        if (done) this.add({ id: `n:${iid}`, kind: 'notice', parent: null, tone: 'info', text: 'Conversation compacted', action: null })
        return
      case 'enteredReviewMode':
      case 'exitedReviewMode':
        return
    }
  }

  private turnCompleted(turn: Record<string, unknown>): void {
    const status = str(turn.status)
    for (const it of this.model.items) {
      if (it.kind === 'tool' && (it.status === 'pending' || it.status === 'running') && it.name !== 'TodoWrite') this.patch(it.id, { status: 'interrupted' })
      if ((it.kind === 'text' || it.kind === 'thinking') && it.streaming) this.patch(it.id, { streaming: false })
      if (it.kind === 'permission' && it.state === 'open') this.patch(it.id, { state: 'expired' })
    }
    if (status === 'interrupted') this.add({ id: this.newId('n'), kind: 'notice', parent: null, tone: 'info', text: `Stopped. ${this.o.who?.() || 'Codex'} kept everything up to here.`, action: null })
    else {
      const err = obj(turn.error)
      const end: ChatTurnEndItem = {
        id: this.newId('e'),
        kind: 'turnEnd',
        parent: null,
        ms: num(turn.durationMs) ?? (this.turnStart != null ? this.now() - this.turnStart : null),
        files: [...this.turnFiles.values()],
        costUsd: null,
        error: status === 'failed' ? (str(err.message) ?? 'The turn failed').slice(0, 400) : null
      }
      this.add(end)
    }
    this.turnFiles.clear()
    this.turnStart = null
    this.planId = null
    this.awaitingEcho = []
  }

  /**
   * An approval request (a JSON-RPC request from the server). The permission card answers it; `requestId` is the
   * JSON-RPC id as text. Returns null for requests this chat cannot show (the session answers those itself).
   */
  approval(requestId: string, method: string, raw: unknown): ChatOp[] | null {
    const p = obj(raw)
    if (this.foreign(str(p.threadId))) return null
    const parent = this.parentOf(str(p.threadId))
    const itemId = str(p.itemId)
    const card = itemId ? this.model.get(`x:${itemId}`) : undefined
    // a helper's ask says whose it is: "From the helper “List files”: <its reason>"
    const helper = this.helperName(parent)
    const reason = helper ? `From the helper “${helper}”${str(p.reason) ? `: ${str(p.reason)}` : ''}` : str(p.reason)
    if (method === 'item/commandExecution/requestApproval') {
      const command = unwrapShell(str(p.command) ?? (card?.kind === 'tool' ? String(card.input.command ?? '') : ''))
      const suggestions: ChatSuggestion[] = []
      for (const d of arr(p.availableDecisions)) {
        if (d === 'acceptForSession') suggestions.push({ label: 'Allow commands like this for this chat', raw: 'acceptForSession' })
        const am = obj(obj(d).acceptWithExecpolicyAmendment)
        const rule = arr(am.execpolicy_amendment).filter((x): x is string => typeof x === 'string')
        if (rule.length) {
          const shown = rule.join(' ')
          suggestions.push({ label: shown.length <= 40 && !/[`'"]/.test(shown) ? `Always allow \`${shown}\`` : 'Always allow this command', raw: d })
        }
      }
      this.add({ id: `perm:${requestId}`, kind: 'permission', parent, requestId, toolUseId: itemId, tool: 'Bash', input: { command, ...(str(p.reason) ? { description: str(p.reason) } : {}) }, description: reason, suggestions, blockedPath: null, state: 'open', outcome: null })
      return this.take()
    }
    if (method === 'item/fileChange/requestApproval') {
      const input = card?.kind === 'tool' ? card.input : {}
      const tool = card?.kind === 'tool' ? card.name : 'Edit'
      const grant = str(p.grantRoot)
      this.add({
        id: `perm:${requestId}`,
        kind: 'permission',
        parent,
        requestId,
        toolUseId: itemId,
        tool,
        input,
        description: reason,
        suggestions: [{ label: 'Allow all edits for this chat', raw: 'acceptForSession' }],
        blockedPath: grant,
        state: 'open',
        outcome: null
      })
      return this.take()
    }
    return null
  }

  /** The approval was settled by the server (answered, or its turn ended): a card still open expires. */
  resolved(requestId: string): ChatOp[] {
    const it = this.model.get(`perm:${requestId}`)
    if (it?.kind === 'permission' && it.state === 'open') this.patch(it.id, { state: 'expired' })
    return this.take()
  }

  /** A resumed thread's history (thread/resume's `thread.turns`): every item as a finished card. */
  replay(turns: unknown[]): ChatOp[] {
    // like a replayed Claude transcript: the cards, no turn-end lines
    for (const t of turns.map(obj)) for (const it of arr(t.items)) this.item(obj(it), null, true, true)
    this.settle()
    return this.take()
  }
}
