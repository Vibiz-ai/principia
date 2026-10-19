/** Pure helpers for the workflow builder. No DOM, no IPC (unit-tested). */
import type {
  AgentNode,
  AgentProfile,
  CheckNode,
  NodeType,
  RoomNode,
  NotifyNode,
  ShellNode,
  ValidationError,
  WaitNode,
  WorkflowDraft,
  WorkflowInput,
  WorkflowNode
} from '@shared/types'
import { defaultMemoryMode, memoryProblem } from './memory'
import { inputValueErrors, isBooleanValue } from '@shared/inputs'

export const NODE_GLYPH: Record<NodeType, string> = { agent: '◆', room: '⇄', check: '✓?', shell: '$', wait: '⏱', notify: '✉' }
export const NODE_LABEL: Record<NodeType, string> = { agent: 'Agent', room: 'Room', check: 'Check', shell: 'Shell', wait: 'Wait', notify: 'Notify' }
/** Template tokens that are not node references (AUTHORING.md §4). */
const BUILTIN_REFS = new Set(['ARTIFACTS_DIR', 'WORKTREE_DIR', 'WORKTREE_BRANCH'])
const WORKTREE_REFS = new Set(['WORKTREE_DIR', 'WORKTREE_BRANCH'])

const SLUG = /^[a-z][a-z0-9_-]*$/
const INPUT_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/

export function slugify(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
  return out || 'step'
}

export function uniqueId(base: string, taken: Iterable<string>): string {
  const set = new Set(taken)
  const b = slugify(base)
  if (!set.has(b)) return b
  for (let i = 2; ; i++) if (!set.has(`${b}${i}`)) return `${b}${i}`
}

/** Node ids referenced as {{id.output}} / {{id.transcript}} in a node's template fields. */
export function referencedNodes(n: WorkflowNode): string[] {
  const out = new Set<string>()
  for (const f of templateFields(n)) {
    for (const ref of templateRefs(f)) {
      const [head, tail] = ref.split('.', 2)
      if (head && head !== 'inputs' && !BUILTIN_REFS.has(head) && (tail === 'output' || tail === 'transcript')) out.add(head)
    }
  }
  return [...out]
}

/**
 * Effective dependencies (CONTRACT E2): after ∪ template-referenced nodes ∪ (check: target).
 * A check's `after` defaults to [target] and may also name nodes downstream of the target (its loop body, e.g. a wait).
 */
export function depsOf(n: WorkflowNode): string[] {
  const base = n.type === 'check' ? [...(n.target ? [n.target] : []), ...n.after] : n.after
  const refs = referencedNodes(n).filter((r) => r !== n.id)
  return [...new Set([...base, ...refs])].filter((x) => x !== n.id)
}

/** Dependencies the editor's After row cannot remove: template refs ({{x.output}}) and a check's target. */
export function implicitDeps(n: WorkflowNode): { id: string; why: string }[] {
  const out = new Map<string, string>()
  if (n.type === 'check' && n.target && !n.after.includes(n.target)) out.set(n.target, `checks ${n.target}`)
  for (const r of referencedNodes(n)) if (r !== n.id && !n.after.includes(r) && !out.has(r)) out.set(r, `uses {{${r}.output}}`)
  return [...out].map(([id, why]) => ({ id, why }))
}

/** All transitive descendants of `id` (nodes that depend on it). */
export function descendants(nodes: WorkflowNode[], id: string): Set<string> {
  const out = new Set<string>()
  let grew = true
  while (grew) {
    grew = false
    for (const n of nodes) {
      if (out.has(n.id) || n.id === id) continue
      if (depsOf(n).some((d) => d === id || out.has(d))) {
        out.add(n.id)
        grew = true
      }
    }
  }
  return out
}

/** All transitive ancestors of `id` (excluding itself). */
export function ancestors(nodes: WorkflowNode[], id: string): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out = new Set<string>()
  const stack = [...(byId.get(id) ? depsOf(byId.get(id)!) : [])]
  while (stack.length) {
    const cur = stack.pop()!
    if (out.has(cur)) continue
    out.add(cur)
    const n = byId.get(cur)
    if (n) stack.push(...depsOf(n))
  }
  out.delete(id)
  return out
}

/** Would adding `dep` to `id`'s after list create a cycle? */
export function wouldCycle(nodes: WorkflowNode[], id: string, dep: string): boolean {
  if (id === dep) return true
  return ancestors(nodes, dep).has(id)
}

/** Returns node ids in a topological order, or null when there is a cycle. */
export function topoOrder(nodes: WorkflowNode[]): string[] | null {
  const ids = new Set(nodes.map((n) => n.id))
  const indeg = new Map<string, number>()
  const out = new Map<string, string[]>()
  for (const n of nodes) {
    indeg.set(n.id, 0)
    out.set(n.id, [])
  }
  for (const n of nodes) {
    for (const d of depsOf(n)) {
      if (!ids.has(d)) continue
      indeg.set(n.id, (indeg.get(n.id) ?? 0) + 1)
      out.get(d)!.push(n.id)
    }
  }
  const q = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id)
  const order: string[] = []
  while (q.length) {
    const id = q.shift()!
    order.push(id)
    for (const nx of out.get(id) ?? []) {
      indeg.set(nx, indeg.get(nx)! - 1)
      if (indeg.get(nx) === 0) q.push(nx)
    }
  }
  return order.length === nodes.length ? order : null
}

const TEMPLATE_RE = /\{\{\s*([^}]+?)\s*\}\}/g

export function templateRefs(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(TEMPLATE_RE)) out.push(m[1]!)
  return out
}

export function templateFields(n: WorkflowNode): string[] {
  switch (n.type) {
    case 'agent':
      return [n.prompt, n.cwd ?? '']
    case 'room':
      return [n.topic, n.cwd ?? '']
    case 'check':
      return [n.criteria, n.command ?? '', n.cwd ?? '']
    case 'shell':
      return [n.command, n.cwd ?? '']
    case 'wait':
      return [n.command, n.cwd ?? '']
    case 'notify':
      return [n.title, n.message]
  }
}

/** Command fields executed by $SHELL (shell, wait, command checks): PO4 forbids agent output in these. */
export function commandFields(n: WorkflowNode): string[] {
  if (n.type === 'shell' || n.type === 'wait') return [n.command]
  if (n.type === 'check' && n.command) return [n.command]
  return []
}

/** Is `id` isolated, or does it run after an isolated node (so {{WORKTREE_DIR}} exists)? */
export function worktreeReady(d: WorkflowDraft, id: string): boolean {
  const n = d.nodes.find((x) => x.id === id)
  if (n?.isolate === 'worktree') return true
  const anc = ancestors(d.nodes, id)
  return d.nodes.some((x) => anc.has(x.id) && x.isolate === 'worktree')
}

/**
 * Template tokens a node may use: inputs, outputs of nodes that would not create a cycle (upstream first),
 * ARTIFACTS_DIR. Referencing a node makes it an implicit dependency (CONTRACT E2).
 */
export function templateSuggestions(draft: WorkflowDraft, nodeId: string): string[] {
  const out = draft.inputs.map((i) => `inputs.${i.name}`)
  const anc = ancestors(draft.nodes, nodeId)
  const desc = descendants(draft.nodes, nodeId)
  const ordered = [...draft.nodes.filter((n) => anc.has(n.id)), ...draft.nodes.filter((n) => !anc.has(n.id) && !desc.has(n.id) && n.id !== nodeId)]
  for (const n of ordered) {
    out.push(`${n.id}.output`)
    if (n.type === 'room') out.push(`${n.id}.transcript`)
  }
  out.push('ARTIFACTS_DIR')
  if (draft.worktree?.repo && worktreeReady(draft, nodeId)) out.push('WORKTREE_DIR', 'WORKTREE_BRANCH')
  return out
}

/** Instant local validation (main's workflows:validate is authoritative; this mirrors SPEC §7.3). */
export function localValidate(d: WorkflowDraft): ValidationError[] {
  const errs: ValidationError[] = []
  if (!d.name.trim()) errs.push({ path: 'name', message: 'Name is required' })
  const inputNames = new Set<string>()
  for (const i of d.inputs) {
    if (!INPUT_NAME.test(i.name)) errs.push({ path: 'inputs', message: `Input "${i.name}" must be letters, digits or _` })
    if (i.type === 'boolean' && i.default !== undefined && i.default !== '' && !isBooleanValue(i.default)) errs.push({ path: 'inputs', message: `Input "${i.name}" is a checkbox: its default must be true or false` })
    if (inputNames.has(i.name)) errs.push({ path: 'inputs', message: `Input "${i.name}" is declared twice` })
    inputNames.add(i.name)
  }
  if (d.nodes.length === 0) errs.push({ path: 'nodes', message: 'Add at least one step' })
  const ids = new Set<string>()
  for (const n of d.nodes) {
    if (!SLUG.test(n.id)) errs.push({ path: n.id, message: `Step id "${n.id}" must be lowercase letters, digits, - or _` })
    if (ids.has(n.id)) errs.push({ path: n.id, message: `Step id "${n.id}" is used twice` })
    ids.add(n.id)
  }
  const byId = new Map(d.nodes.map((n) => [n.id, n]))
  for (const n of d.nodes) {
    for (const a of depsOf(n)) {
      if (!byId.has(a)) errs.push({ path: n.id, message: `Step "${n.id}" runs after unknown step "${a}"` })
    }
    if (n.type === 'agent') {
      if (!n.profileId) errs.push({ path: n.id, message: `Step "${n.id}": pick an agent` })
      if (!n.prompt.trim()) errs.push({ path: n.id, message: `Step "${n.id}": prompt is empty` })
    }
    if (n.type === 'shell' && !n.command.trim()) errs.push({ path: n.id, message: `Step "${n.id}": command is empty` })
    if (n.type === 'wait') {
      if (!n.command.trim()) errs.push({ path: n.id, message: `Wait "${n.id}": command is empty` })
      if (n.until === 'match') {
        const pat = n.pattern ?? ''
        if (!pat.trim()) errs.push({ path: n.id, message: `Wait "${n.id}": add the pattern to wait for` })
        else if (pat.length > 500) errs.push({ path: n.id, message: `Wait "${n.id}": pattern is longer than 500 characters` })
        else if (pat.includes('{{')) errs.push({ path: n.id, message: `Wait "${n.id}": the pattern is not templated; remove {{…}}` })
        else {
          try {
            new RegExp(pat, 'm')
          } catch {
            errs.push({ path: n.id, message: `Wait "${n.id}": pattern is not a valid regular expression` })
          }
        }
      }
      if (!Number.isInteger(n.intervalSec) || n.intervalSec < 5 || n.intervalSec > 3600) errs.push({ path: n.id, message: `Wait "${n.id}": check every 5–3600 seconds` })
      if (n.timeoutMin < 1 || n.timeoutMin > 1440) errs.push({ path: n.id, message: `Wait "${n.id}": give up after 1–1440 minutes` })
    }
    if (n.type === 'notify') {
      if (!n.message.trim()) errs.push({ path: n.id, message: `Notify "${n.id}": message is empty` })
      if (n.title.length > 200) errs.push({ path: n.id, message: `Notify "${n.id}": title is longer than 200 characters` })
      if (n.isolate === 'worktree') errs.push({ path: n.id, message: `Notify "${n.id}" cannot run in a worktree` })
    }
    if (n.isolate === 'worktree' && n.type !== 'notify') {
      if (!d.worktree?.repo) errs.push({ path: n.id, message: `Step "${n.id}": isolate needs a workflow worktree repo` })
      else if (n.cwd && n.cwd !== d.worktree.repo) errs.push({ path: n.id, message: `Step "${n.id}" runs in the worktree; set its folder to the worktree repo or leave it empty` })
    }
    const memErr = memoryProblem(n)
    if (memErr) errs.push({ path: n.id, message: memErr })
    if (n.type === 'room') {
      if (n.participants.length < 2) errs.push({ path: n.id, message: `Room "${n.id}" needs at least 2 participants` })
      const labels = new Set<string>()
      for (const p of n.participants) {
        if (!p.label.trim()) errs.push({ path: n.id, message: `Room "${n.id}": every participant needs a label` })
        if (labels.has(p.label)) errs.push({ path: n.id, message: `Room "${n.id}": label "${p.label}" is used twice` })
        labels.add(p.label)
        if (!p.profileId) errs.push({ path: n.id, message: `Room "${n.id}": pick an agent for ${p.label || 'each participant'}` })
      }
      if (!n.topic.trim()) errs.push({ path: n.id, message: `Room "${n.id}": topic is empty` })
      if (n.rounds < 1 || n.rounds > 10) errs.push({ path: n.id, message: `Room "${n.id}": rounds must be 1–10` })
    }
    if (n.type === 'check') {
      const t = byId.get(n.target)
      if (!n.target || !t) errs.push({ path: n.id, message: `Check "${n.id}": pick the step it checks` })
      else if (t.type !== 'agent') errs.push({ path: n.id, message: `Check "${n.id}" must check an agent step` })
      if (!n.profileId && !n.command?.trim()) errs.push({ path: n.id, message: `Check "${n.id}": pick a reviewer agent or a command` })
      if (n.maxRetries < 0 || n.maxRetries > 5) errs.push({ path: n.id, message: `Check "${n.id}": retries must be 0–5` })
    }
    if (n.type === 'check' && n.target && byId.has(n.target)) {
      // after may name the target and nodes downstream of it (the loop body); anything else is an error
      const below = descendants(d.nodes, n.target)
      for (const a of n.after) if (a !== n.target && byId.has(a) && (!below.has(a) || a === n.id)) errs.push({ path: n.id, message: `Check "${n.id}" may only run after "${n.target}" or steps that run after it (its loop body); "${a}" is not` })
    }
    for (const field of templateFields(n)) {
      for (const ref of templateRefs(field)) {
        if (ref === 'ARTIFACTS_DIR') continue
        if (WORKTREE_REFS.has(ref)) {
          if (!d.worktree?.repo || !worktreeReady(d, n.id)) errs.push({ path: n.id, message: `Step "${n.id}": {{${ref}}} is used before the worktree exists; isolate this step or one before it` })
          continue
        }
        const [head, tail] = ref.split('.', 2) as [string, string | undefined]
        if (head === 'inputs') {
          if (!tail || !inputNames.has(tail)) errs.push({ path: n.id, message: `Step "${n.id}": {{${ref}}} references unknown input "${tail ?? ''}"` })
          continue
        }
        const src = byId.get(head)
        if (!src) {
          errs.push({ path: n.id, message: `Step "${n.id}": {{${ref}}} references unknown step "${head}"` })
          continue
        }
        if (head === n.id) {
          errs.push({ path: n.id, message: `Step "${n.id}": {{${ref}}} references itself` })
        } else if (tail !== 'output' && !(tail === 'transcript' && src.type === 'room')) {
          errs.push({ path: n.id, message: `Step "${n.id}": {{${ref}}} — use .output${src.type === 'room' ? ' or .transcript' : ''}` })
        }
      }
    }
  }
  if (d.worktree) {
    const r = d.worktree.repo?.trim() ?? ''
    const m = /^\{\{inputs\.([a-zA-Z_][a-zA-Z0-9_]*)\}\}$/.exec(r)
    if (!r) errs.push({ path: 'worktree', message: 'Worktree: pick the repository to branch from' })
    else if (m) {
      const inp = d.inputs.find((i) => i.name === m[1])
      if (!inp || inp.type !== 'repo') errs.push({ path: 'worktree', message: `Worktree: {{inputs.${m[1]}}} must be a Repository input` })
    } else if (r.includes('{{')) errs.push({ path: 'worktree', message: 'Worktree: use a repository or a {{inputs.X}} repository input' })
  }
  if (d.nodes.length && !topoOrder(d.nodes)) {
    const cyc = d.nodes.find((n) => depsOf(n).some((a) => a === n.id || ancestors(d.nodes, a).has(n.id)))
    errs.push({ path: cyc?.id ?? 'nodes', message: `Step "${cyc?.id ?? '?'}" is part of a cycle` })
  }
  return errs
}

// ---------- mutations (return new drafts) ----------

function replaceRefs(text: string, from: string, to: string): string {
  return text.replace(TEMPLATE_RE, (whole, inner: string) => {
    const [head, ...rest] = inner.split('.')
    return head === from ? `{{${[to, ...rest].join('.')}}}` : whole
  })
}

/** Rename a node id and every reference to it (after, check target, templates). */
export function renameNode(d: WorkflowDraft, from: string, to: string): WorkflowDraft {
  if (from === to) return d
  const nodes = d.nodes.map((n): WorkflowNode => {
    const base = { ...n, id: n.id === from ? to : n.id, after: n.after.map((a) => (a === from ? to : a)) }
    switch (base.type) {
      case 'agent':
        return { ...base, prompt: replaceRefs(base.prompt, from, to), cwd: base.cwd && replaceRefs(base.cwd, from, to) }
      case 'room':
        return { ...base, topic: replaceRefs(base.topic, from, to) }
      case 'check':
        return { ...base, target: base.target === from ? to : base.target, criteria: replaceRefs(base.criteria, from, to) }
      case 'shell':
        return { ...base, command: replaceRefs(base.command, from, to) }
      case 'wait':
        return { ...base, command: replaceRefs(base.command, from, to), cwd: base.cwd && replaceRefs(base.cwd, from, to) }
      case 'notify':
        return { ...base, title: replaceRefs(base.title, from, to), message: replaceRefs(base.message, from, to) }
    }
  })
  return { ...d, nodes }
}

/** Remove a node; drop it from every after list; checks targeting it lose their target. */
export function removeNode(d: WorkflowDraft, id: string): WorkflowDraft {
  return {
    ...d,
    nodes: d.nodes
      .filter((n) => n.id !== id)
      .map((n): WorkflowNode => {
        const after = n.after.filter((a) => a !== id)
        if (n.type === 'check' && n.target === id) return { ...n, target: '', after: [] }
        return { ...n, after }
      })
  }
}

export function moveNode(d: WorkflowDraft, id: string, delta: -1 | 1): WorkflowDraft {
  const i = d.nodes.findIndex((n) => n.id === id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= d.nodes.length) return d
  const nodes = [...d.nodes]
  ;[nodes[i], nodes[j]] = [nodes[j]!, nodes[i]!]
  return { ...d, nodes }
}

export function updateNode(d: WorkflowDraft, id: string, patch: Partial<WorkflowNode>): WorkflowDraft {
  return {
    ...d,
    nodes: d.nodes.map((n) => {
      if (n.id !== id) return n
      const next = { ...n, ...patch } as WorkflowNode
      // a new target resets the loop body to [target]; otherwise a check keeps its after (e.g. a wait in the loop body)
      if (next.type === 'check' && (('target' in patch && n.type === 'check' && patch.target !== n.target) || !next.after.length))
        next.after = next.target ? [next.target] : []
      return next
    })
  }
}

/** Default profile for an adapter: the seeded default (name = adapter label) or the first of that adapter. */
export function defaultProfileFor(profiles: AgentProfile[], adapter: string): AgentProfile | undefined {
  return profiles.find((p) => p.adapter === adapter) ?? profiles.find((p) => p.adapter !== 'shell')
}

/**
 * Create a new node. Its `after` defaults to the previous card; a check targets the previous agent.
 * Agent and room steps start with memory on Read & write (within the repo; global stays user-written), reviewer
 * checks on Read, so memory works without hunting for a per-step switch; existing steps keep whatever they had.
 */
export function createNode(d: WorkflowDraft, type: NodeType, defaultProfileId: string | null, secondProfileId?: string | null): WorkflowNode {
  const n = createNodeBase(d, type, defaultProfileId, secondProfileId)
  const memory = defaultMemoryMode(n)
  return memory ? { ...n, memory } : n
}

function createNodeBase(d: WorkflowDraft, type: NodeType, defaultProfileId: string | null, secondProfileId?: string | null): WorkflowNode {
  const taken = d.nodes.map((n) => n.id)
  const prev = d.nodes[d.nodes.length - 1]
  const after = prev ? [prev.id] : []
  const base = { after, cwd: d.inputs.some((i) => i.name === 'repo') ? '{{inputs.repo}}' : null, timeoutMin: 30 }
  switch (type) {
    case 'agent': {
      const id = uniqueId(d.nodes.length ? 'agent' : 'build', taken)
      const n: AgentNode = { ...base, id, type, label: id, profileId: defaultProfileId ?? '', prompt: '' }
      return n
    }
    case 'room': {
      const id = uniqueId('room', taken)
      const n: RoomNode = {
        ...base,
        id,
        type,
        label: id,
        participants: [
          { profileId: defaultProfileId ?? '', label: 'Builder' },
          { profileId: secondProfileId ?? defaultProfileId ?? '', label: 'Skeptic' }
        ],
        topic: '',
        rounds: 3,
        final: 'summary'
      }
      return n
    }
    case 'check': {
      const id = uniqueId('review', taken)
      const target = [...d.nodes].reverse().find((n) => n.type === 'agent')?.id ?? ''
      const n: CheckNode = {
        ...base,
        id,
        type,
        label: id,
        after: target ? [target] : [],
        profileId: secondProfileId ?? defaultProfileId,
        command: null,
        target,
        criteria: '',
        maxRetries: 3
      }
      return n
    }
    case 'shell': {
      const id = uniqueId('shell', taken)
      const n: ShellNode = { ...base, id, type, label: id, command: '' }
      return n
    }
    case 'wait': {
      const id = uniqueId('wait', taken)
      const n: WaitNode = { ...base, id, type, label: id, timeoutMin: 60, command: '', until: 'exit0', pattern: null, intervalSec: 60, onTimeout: 'fail' }
      return n
    }
    case 'notify': {
      const id = uniqueId('notify', taken)
      // SLACK.md §10: new notify nodes are Mac-only until the user picks Slack
      const n: NotifyNode = { ...base, cwd: null, id, type, label: id, timeoutMin: 1, title: d.name, message: '', slack: null }
      return n
    }
  }
}

export function duplicateNode(d: WorkflowDraft, id: string): WorkflowDraft {
  const i = d.nodes.findIndex((n) => n.id === id)
  if (i < 0) return d
  const src = d.nodes[i]!
  const nid = uniqueId(src.id, d.nodes.map((n) => n.id))
  const copy = { ...structuredClone(src), id: nid, label: nid } as WorkflowNode
  const nodes = [...d.nodes]
  nodes.splice(i + 1, 0, copy)
  return { ...d, nodes }
}

/** "agent → check ↺3", "room (2 · 3 rounds)" for the workflows list. */
export function shapeSummary(d: WorkflowDraft): string {
  const order = topoOrder(d.nodes) ?? d.nodes.map((n) => n.id)
  const byId = new Map(d.nodes.map((n) => [n.id, n]))
  return order
    .map((id) => {
      const n = byId.get(id)!
      if (n.type === 'check') return `${n.command ? 'command check' : 'check'} ↺${n.maxRetries}`
      if (n.type === 'room') return `room (${n.participants.length} · ${n.rounds} rounds)`
      if (n.type === 'shell' && n.lang && n.lang !== 'sh') return n.lang
      return n.type
    })
    .join(' → ')
}

/** A script: deterministic steps only (shell / python / node, waits, notifications) — no agent, no tokens. */
export function isScript(d: Pick<WorkflowDraft, 'nodes'>): boolean {
  return d.nodes.length > 0 && d.nodes.every((n) => n.type === 'shell' || n.type === 'wait' || n.type === 'notify')
}

/** New Script: one python step that reads its input from the env. */
export function newScriptDraft(): WorkflowDraft {
  return {
    name: 'Untitled script',
    description: '',
    inputs: [{ name: 'query', label: 'Query' }],
    nodes: [
      {
        id: 'script',
        type: 'shell',
        label: 'Script',
        after: [],
        cwd: null,
        timeoutMin: 30,
        lang: 'python',
        command: [
          'import json, os, urllib.request',
          '',
          '# Inputs are env vars (HIVE_INPUT_<NAME>); Hive › Keys are env vars too (e.g. os.environ["APIFY_API_KEY"]).',
          'query = os.environ.get("HIVE_INPUT_QUERY", "")',
          'out_dir = os.environ["ARTIFACTS_DIR"]  # files saved here show up in Artifacts',
          '',
          'print(f"Hello {query}")  # stdout is the step output (later steps read it)',
          ''
        ].join('\n')
      }
    ]
  }
}

export function newDraft(defaultProfileId: string | null): WorkflowDraft {
  const d: WorkflowDraft = {
    name: 'Untitled workflow',
    description: '',
    inputs: [
      { name: 'task', label: 'Task', type: 'multiline' },
      { name: 'repo', label: 'Repository', type: 'repo' }
    ],
    nodes: []
  }
  const first = createNode(d, 'agent', defaultProfileId)
  if (first.type === 'agent') first.prompt = '{{inputs.task}}'
  d.nodes.push(first)
  return d
}

/** Stable comparison for the "edited" dot. */
export function draftKey(d: WorkflowDraft): string {
  return JSON.stringify({ name: d.name, description: d.description, inputs: d.inputs, nodes: d.nodes, worktree: d.worktree ?? null })
}

/** Autocomplete: if the caret sits after an unclosed `{{partial`, return the partial and where it starts. */
export function openTemplateAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const open = before.lastIndexOf('{{')
  if (open < 0) return null
  const between = before.slice(open + 2)
  if (between.includes('}}') || /\s/.test(between)) return null
  return { start: open, query: between }
}

export function insertTemplate(text: string, caret: number, token: string): { text: string; caret: number } {
  const o = openTemplateAt(text, caret)
  const start = o ? o.start : caret
  let end = caret
  if (text.slice(end, end + 2) === '}}') end += 2
  const ins = `{{${token}}}`
  return { text: text.slice(0, start) + ins + text.slice(end), caret: start + ins.length }
}

// ---------- run inputs (typed boolean inputs) ----------

/**
 * Value a run-sheet field starts with. Checkboxes: the last-used value when it is true/false, else the default (kept
 * as-is even when it is not true/false, so the sheet refuses it visibly instead of guessing), else 'false'.
 */
export function initialInputValue(i: WorkflowInput, prev: string | undefined, fallbackRepo: string): string {
  if (i.type === 'boolean') {
    if (prev !== undefined && isBooleanValue(prev)) return prev
    return i.default !== undefined && i.default !== '' ? i.default : 'false'
  }
  return prev ?? i.default ?? (i.type === 'repo' ? fallbackRepo : '')
}

/** Messages for run-sheet values a checkbox input refuses (anything but exactly 'true' / 'false'). */
export function runInputProblems(inputs: WorkflowInput[], values: Record<string, string>): string[] {
  return inputValueErrors(inputs, values).map((e) => e.message)
}
