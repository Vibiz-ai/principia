/**
 * CHAT-UI.md §4.3: the friendly line a tool card shows ("Reading plans.ts", "Ran the tests"), the read-only tools that
 * group into one summary line, and the line-diff of an edit. Pure; shared by main tests and the renderer.
 */
import type { ChatToolItem } from './chat'

export type ToolIcon = 'file' | 'search' | 'edit' | 'terminal' | 'globe' | 'agents' | 'spark' | 'list' | 'memory' | 'tasks' | 'code'
export interface ToolLine {
  /** "Reading" while it runs, "Read" once done */
  verb: string
  /** file name, pattern, command (mono in the card) */
  target: string
  icon: ToolIcon
  /** small grey text on the right: "+12 −3", "42 lines", "exit 1" */
  meta: string | null
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const s = (v: unknown): string => (typeof v === 'string' ? v : '')
export const baseName = (p: string): string => {
  const t = p.replace(/\/+$/, '')
  const i = t.lastIndexOf('/')
  return i >= 0 ? t.slice(i + 1) || t : t
}
const firstLine = (t: string): string => (t.split('\n').find((l) => l.trim()) ?? '').trim()
const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t)
const host = (u: string): string => {
  try {
    return new URL(u).host || u
  } catch {
    return u
  }
}

/** Tools that only look: consecutive ones fold into one "Read 3 files, searched 1 pattern" line. */
const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'BashOutput', 'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'NotebookRead'])
export function isReadOnlyTool(name: string): boolean {
  if (READ_ONLY.has(name)) return true
  // hivemem reads (search, recall, get): memory lookups are read-only
  return /^mcp__hivemem__(?:.*(?:search|recall|get|list|read|query|brief))/.test(name)
}

/** Tools drawn by their own card, never as a tool card (TodoCard, QuestionCard, PlanCard). */
export const SPECIAL_TOOLS = new Set(['TodoWrite', 'AskUserQuestion', 'ExitPlanMode'])
export const isSubagentTool = (name: string): boolean => name === 'Task' || name === 'Agent'

const BASH_PATTERNS: [RegExp, string, string][] = [
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bvitest\b|\bjest\b|\bpytest\b|\bgo test\b|\bcargo test\b/, 'Running the tests', 'Ran the tests'],
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci)\b|\bpip3? install\b|\bbrew install\b/, 'Installing packages', 'Installed packages'],
  [/\bgit\s+commit\b/, 'Committing', 'Committed'],
  [/\bgit\s+push\b/, 'Pushing', 'Pushed'],
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|\btsc\b/, 'Building', 'Built'],
  [/\bgit\s+(?:status|diff|log|show)\b/, 'Checking git', 'Checked git']
]

const HIVE_TOOLS: Record<string, [string, string]> = {
  task_create: ['Filing a task', 'Filed a task'],
  company_file_task: ['Filing a task', 'Filed a task'],
  task_update: ['Updating a task', 'Updated a task'],
  task_comment: ['Commenting on a task', 'Commented on a task'],
  slack_reply: ['Drafting a Slack reply', 'Drafted a Slack reply'],
  new_company: ['Proposing a new company', 'Proposed a new company']
}

function linesOf(t: string): number {
  return t ? t.replace(/\n$/, '').split('\n').length : 0
}

/** What a tool that never ran says it did not do: "Didn't create notes.txt", "Didn't run a command". */
const NOT_DONE: Record<string, [string, string]> = {
  Read: ["Didn't read", 'reading'],
  NotebookRead: ["Didn't read", 'reading'],
  Edit: ["Didn't edit", 'editing'],
  MultiEdit: ["Didn't edit", 'editing'],
  NotebookEdit: ["Didn't edit", 'editing'],
  Write: ["Didn't create", 'creating'],
  Bash: ["Didn't run", 'running'],
  WebFetch: ["Didn't open", 'opening'],
  WebSearch: ["Didn't search the web for", 'searching the web for'],
  Grep: ["Didn't search for", 'searching for'],
  Glob: ["Didn't look for files", 'looking for files'],
  LS: ["Didn't list", 'listing']
}

/**
 * The card line for a tool. `done` = finished (ok, error, denied, interrupted). A denied tool never reads like it
 * happened ("Didn't edit hello.txt", no +/- count); a stopped one says it stopped ("Stopped before creating notes.txt").
 */
export function toolLine(t: Pick<ChatToolItem, 'name' | 'input' | 'status' | 'resultText'>): ToolLine {
  const l = doneLine(t)
  if (t.status !== 'denied' && t.status !== 'interrupted') return l
  const nd = NOT_DONE[t.name]
  if (t.name === 'Bash') return { ...l, verb: t.status === 'denied' ? "Didn't run" : 'Stopped', meta: null }
  if (nd) return { ...l, verb: t.status === 'denied' ? nd[0] : `Stopped before ${nd[1]}`, meta: null }
  return { ...l, verb: t.status === 'denied' ? "Didn't use" : 'Stopped', meta: null }
}

function doneLine(t: Pick<ChatToolItem, 'name' | 'input' | 'status' | 'resultText'>): ToolLine {
  const done = t.status !== 'pending' && t.status !== 'running'
  const i = obj(t.input)
  const v = (run: string, past: string): string => (done ? past : run)
  const name = t.name
  switch (name) {
    case 'Read':
      return { verb: v('Reading', 'Read'), target: baseName(s(i.file_path)), icon: 'file', meta: null }
    case 'NotebookRead':
      return { verb: v('Reading', 'Read'), target: baseName(s(i.notebook_path)), icon: 'file', meta: null }
    case 'Grep':
      return { verb: v('Searching for', 'Searched for'), target: clip(`“${s(i.pattern)}”`, 60), icon: 'search', meta: null }
    case 'Glob':
      return { verb: v('Finding files', 'Found files'), target: clip(s(i.pattern), 60), icon: 'search', meta: null }
    case 'LS':
      return { verb: v('Listing', 'Listed'), target: baseName(s(i.path)), icon: 'search', meta: null }
    case 'Edit':
    case 'MultiEdit': {
      const d = diffCounts(i)
      return { verb: v('Editing', 'Edited'), target: baseName(s(i.file_path)), icon: 'edit', meta: d.add || d.del ? `+${d.add} −${d.del}` : null }
    }
    case 'Write':
      return { verb: v('Creating', 'Created'), target: baseName(s(i.file_path)), icon: 'edit', meta: s(i.content) ? `${linesOf(s(i.content))} line${linesOf(s(i.content)) === 1 ? '' : 's'}` : null }
    case 'NotebookEdit':
      return { verb: v('Editing', 'Edited'), target: baseName(s(i.notebook_path)), icon: 'edit', meta: null }
    case 'Bash': {
      const cmd = s(i.command)
      const known = BASH_PATTERNS.find(([re]) => re.test(cmd))
      const desc = s(i.description).trim()
      const verb = known ? v(known[1], known[2]) : desc ? desc : v('Running a command', 'Ran a command')
      const exit = done && t.status === 'error' ? 'failed' : null
      return { verb, target: clip(firstLine(cmd), 80), icon: 'terminal', meta: exit }
    }
    case 'BashOutput':
    case 'KillShell':
      return { verb: v('Checking a background command', 'Checked a background command'), target: '', icon: 'terminal', meta: null }
    case 'WebSearch':
      return { verb: v('Searching the web for', 'Searched the web for'), target: clip(`“${s(i.query)}”`, 60), icon: 'globe', meta: null }
    case 'WebFetch':
      return { verb: v('Reading', 'Read'), target: host(s(i.url)), icon: 'globe', meta: null }
    case 'Task':
    case 'Agent': {
      const who = s(i.subagent_type) || 'helper'
      return { verb: v(`Asking the ${who} agent`, `Asked the ${who} agent`), target: clip(s(i.description), 80), icon: 'agents', meta: null }
    }
    case 'Skill':
      return { verb: v(`Using the ${s(i.skill) || s(i.command) || 'a'} skill`, `Used the ${s(i.skill) || s(i.command) || 'a'} skill`), target: '', icon: 'spark', meta: null }
    case 'TodoWrite':
      return { verb: v('Updating the plan', 'Updated the plan'), target: '', icon: 'list', meta: null }
    case 'ToolSearch':
      return { verb: v('Looking up tools', 'Looked up tools'), target: '', icon: 'search', meta: null }
  }
  if (name.startsWith('mcp__')) {
    const [, server = '', tool = ''] = name.split('__')
    if (server === 'hivemem') {
      const write = /write|save|remember|add|update|forget|delete/.test(tool)
      const q = s(i.query) || s(i.q) || s(i.name)
      return write
        ? { verb: v('Saving to memory', 'Saved to memory'), target: '', icon: 'memory', meta: null }
        : { verb: v('Checking memory', 'Checked memory'), target: q ? clip(`“${q}”`, 60) : '', icon: 'memory', meta: null }
    }
    if (server === 'hive') {
      const m = HIVE_TOOLS[tool]
      return { verb: m ? v(m[0], m[1]) : v('Using Principia', 'Used Principia'), target: m ? clip(s(i.title), 60) : tool.replace(/_/g, ' '), icon: 'tasks', meta: null }
    }
    return { verb: v('Using', 'Used'), target: `${server}.${tool}`, icon: 'code', meta: null }
  }
  return { verb: v('Using', 'Used'), target: name, icon: 'code', meta: null }
}

/** "Read 3 files, searched 1 pattern" for a run of read-only tools. */
export function groupSummary(tools: Pick<ChatToolItem, 'name' | 'status'>[]): string {
  const running = tools.some((t) => t.status === 'pending' || t.status === 'running')
  const c = (pred: (n: string) => boolean): number => tools.filter((t) => pred(t.name)).length
  const reads = c((n) => n === 'Read' || n === 'NotebookRead')
  const greps = c((n) => n === 'Grep')
  const globs = c((n) => n === 'Glob' || n === 'LS')
  const web = c((n) => n === 'WebSearch')
  const pages = c((n) => n === 'WebFetch')
  const mem = c((n) => n.startsWith('mcp__hivemem__'))
  const lookups = c((n) => n === 'ToolSearch')
  const bg = c((n) => n === 'BashOutput')
  const res = c((n) => n === 'ListMcpResourcesTool' || n === 'ReadMcpResourceTool')
  const other = tools.length - reads - greps - globs - web - pages - mem - lookups - bg - res
  const pl = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
  const parts = [
    reads ? `${running ? 'reading' : 'read'} ${pl(reads, 'file', 'files')}` : '',
    greps ? `${running ? 'searching' : 'searched'} ${pl(greps, 'pattern', 'patterns')}` : '',
    globs ? `${running ? 'listing' : 'listed'} ${pl(globs, 'folder', 'folders')}` : '',
    web ? `${running ? 'searching' : 'searched'} the web${web > 1 ? ` ${web} times` : ''}` : '',
    pages ? `${running ? 'reading' : 'read'} ${pl(pages, 'page', 'pages')}` : '',
    mem ? `${running ? 'checking' : 'checked'} memory` : '',
    lookups ? `${running ? 'looking up' : 'looked up'} tools` : '',
    bg ? `${running ? 'checking' : 'checked'} ${bg === 1 ? 'a running command' : `${bg} running commands`}` : '',
    res ? `${running ? 'reading' : 'read'} ${pl(res, 'connected source', 'connected sources')}` : '',
    other > 0 ? `${running ? 'using' : 'used'} ${pl(other, 'tool', 'tools')}` : ''
  ].filter(Boolean)
  const text = parts.join(', ')
  return text ? text[0]!.toUpperCase() + text.slice(1) : running ? 'Looking around' : 'Looked around'
}

export interface DiffLine {
  t: ' ' | '+' | '-'
  text: string
}

function editPairs(i: Record<string, unknown>): { old: string; next: string }[] {
  if (Array.isArray(i.edits)) return (i.edits as unknown[]).map((e) => ({ old: s(obj(e).old_string), next: s(obj(e).new_string) }))
  if (typeof i.old_string === 'string' || typeof i.new_string === 'string') return [{ old: s(i.old_string), next: s(i.new_string) }]
  return []
}

/** One edit as lines: the shared head and tail stay as context, the middle is removed then added. */
function diffOne(old: string, next: string, context = 2): DiffLine[] {
  const a = old ? old.split('\n') : []
  const b = next ? next.split('\n') : []
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const out: DiffLine[] = []
  for (const l of a.slice(Math.max(0, head - context), head)) out.push({ t: ' ', text: l })
  for (const l of a.slice(head, a.length - tail)) out.push({ t: '-', text: l })
  for (const l of b.slice(head, b.length - tail)) out.push({ t: '+', text: l })
  for (const l of a.slice(a.length - tail, Math.min(a.length, a.length - tail + context))) out.push({ t: ' ', text: l })
  return out
}

/** Edit / MultiEdit as diff lines; Write as all-added lines (capped). */
export function editDiff(name: string, input: unknown, max = 400): DiffLine[] {
  const i = obj(input)
  if (name === 'Write') return s(i.content).replace(/\n$/, '').split('\n').slice(0, max).map((text) => ({ t: '+' as const, text }))
  const out: DiffLine[] = []
  for (const p of editPairs(i)) {
    if (out.length) out.push({ t: ' ', text: '⋯' })
    out.push(...diffOne(p.old, p.next))
    if (out.length >= max) break
  }
  return out.slice(0, max)
}

export function diffCounts(input: unknown): { add: number; del: number } {
  const i = obj(input)
  let add = 0
  let del = 0
  for (const p of editPairs(i))
    for (const l of diffOne(p.old, p.next, 0)) {
      if (l.t === '+') add++
      if (l.t === '-') del++
    }
  return { add, del }
}

/** Files a finished tool changed (turn-end summary): path, +lines, −lines. */
export function fileChange(name: string, input: unknown): { path: string; add: number; del: number } | null {
  const i = obj(input)
  if (name === 'Edit' || name === 'MultiEdit') {
    const d = diffCounts(i)
    return s(i.file_path) ? { path: s(i.file_path), ...d } : null
  }
  if (name === 'Write') return s(i.file_path) ? { path: s(i.file_path), add: linesOf(s(i.content)), del: 0 } : null
  if (name === 'NotebookEdit') return s(i.notebook_path) ? { path: s(i.notebook_path), add: 0, del: 0 } : null
  return null
}

/** Permission card title: "Claude wants to run a command / edit plans.ts / use Slack". */
export function permissionTitle(tool: string, input: unknown): string {
  const i = obj(input)
  switch (tool) {
    case 'Bash':
      return 'Claude wants to run a command'
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Claude wants to edit ${baseName(s(i.file_path) || s(i.notebook_path)) || 'a file'}`
    case 'Write':
      return `Claude wants to create ${baseName(s(i.file_path)) || 'a file'}`
    case 'Read':
      return `Claude wants to read ${baseName(s(i.file_path)) || 'a file'}`
    case 'WebFetch':
      return `Claude wants to open ${host(s(i.url))}`
    case 'WebSearch':
      return 'Claude wants to search the web'
  }
  if (tool.startsWith('mcp__')) {
    const [, server = '', t = ''] = tool.split('__')
    if (server === 'hive') return `Claude wants to use Principia (${t.replace(/_/g, ' ')})`
    return `Claude wants to use ${server} (${t.replace(/_/g, ' ')})`
  }
  return `Claude wants to use ${tool}`
}

/**
 * A string field of a tool input that is still streaming in as partial JSON (`{"file_path": "…", "content": "# Hi\n…`),
 * decoded as far as it has arrived. null when the field has not started yet. Lets a Write card show the file as it is
 * written instead of raw JSON with \n escapes.
 */
export function partialField(partial: string, field: string): string | null {
  const m = new RegExp(`"${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*"`).exec(partial)
  if (!m) return null
  let out = ''
  for (let i = m.index + m[0].length; i < partial.length; i++) {
    const ch = partial[i]!
    if (ch === '"') return out
    if (ch !== '\\') {
      out += ch
      continue
    }
    const nx = partial[i + 1]
    if (nx === undefined) break
    i++
    if (nx === 'n') out += '\n'
    else if (nx === 't') out += '\t'
    else if (nx === 'r') out += ''
    else if (nx === 'b' || nx === 'f') out += ''
    else if (nx === 'u') {
      const hex = partial.slice(i + 1, i + 5)
      if (hex.length < 4) break
      out += String.fromCharCode(parseInt(hex, 16))
      i += 4
    } else out += nx
  }
  return out
}
