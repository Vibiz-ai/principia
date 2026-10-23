/**
 * The only template syntax (SPEC 7.3): {{inputs.X}}, {{nodeId.output}}, {{nodeId.transcript}}, {{ARTIFACTS_DIR}},
 * and (AUTHORING.md §4) {{WORKTREE_DIR}}, {{WORKTREE_BRANCH}}, and (SLACK.md §9.2) {{trigger.*}} ('' outside Slack runs).
 */
import type { WorkflowNode } from '../../shared/types'

export type TemplateRef =
  | { kind: 'input'; name: string; raw: string }
  | { kind: 'node'; nodeId: string; field: 'output' | 'transcript'; raw: string }
  | { kind: 'artifacts'; raw: string }
  | { kind: 'worktree'; field: 'dir' | 'branch'; raw: string }
  | { kind: 'trigger'; field: TriggerField; raw: string }
  | { kind: 'invalid'; raw: string }

/** SLACK.md §9.2: the `{{trigger.*}}` namespace of a Slack-triggered run (`images`: §9.6, local paths one per line). */
export const TRIGGER_FIELDS = ['text', 'thread', 'channel', 'channel_id', 'ts', 'thread_ts', 'user', 'user_id', 'permalink', 'images'] as const
export type TriggerField = (typeof TRIGGER_FIELDS)[number]
export type TriggerVars = Record<TriggerField, string>
const TRIGGER_RE = new RegExp(`^trigger\\.(${TRIGGER_FIELDS.join('|')})$`)

const RE = /\{\{\s*([^{}]*?)\s*\}\}/g

export function parseRefs(text: string | null | undefined): TemplateRef[] {
  if (!text) return []
  const out: TemplateRef[] = []
  for (const m of text.matchAll(RE)) {
    const raw = m[0]
    const expr = m[1]
    if (expr === 'ARTIFACTS_DIR') out.push({ kind: 'artifacts', raw })
    else if (expr === 'WORKTREE_DIR') out.push({ kind: 'worktree', field: 'dir', raw })
    else if (expr === 'WORKTREE_BRANCH') out.push({ kind: 'worktree', field: 'branch', raw })
    else if (/^inputs\.[a-zA-Z_][a-zA-Z0-9_]*$/.test(expr)) out.push({ kind: 'input', name: expr.slice(7), raw })
    else if (TRIGGER_RE.test(expr)) out.push({ kind: 'trigger', field: expr.slice(8) as TriggerField, raw })
    else {
      const nm = expr.match(/^([a-z][a-z0-9_-]*)\.(output|transcript)$/)
      if (nm) out.push({ kind: 'node', nodeId: nm[1], field: nm[2] as 'output' | 'transcript', raw })
      else out.push({ kind: 'invalid', raw })
    }
  }
  return out
}

export interface RenderScope {
  inputs: Record<string, string>
  nodeOutput(id: string): string | null
  nodeTranscript(id: string): string | null
  artifactsDir: string
  /** The run's worktree once created (AUTHORING.md §6); '' is rendered before that. */
  worktree?: () => { dir: string; branch: string } | null
  /** SLACK.md §9.2: the Slack trigger values of this run; absent / null = every {{trigger.*}} renders ''. */
  trigger?: () => TriggerVars | null
}

export function render(text: string, scope: RenderScope): string {
  return text.replace(RE, (raw, expr: string) => {
    const [ref] = parseRefs(`{{${expr}}}`)
    if (!ref) return raw
    switch (ref.kind) {
      case 'artifacts':
        return scope.artifactsDir
      case 'worktree': {
        const w = scope.worktree?.() ?? null
        return w ? (ref.field === 'dir' ? w.dir : w.branch) : ''
      }
      case 'input':
        return scope.inputs[ref.name] ?? ''
      case 'trigger':
        return scope.trigger?.()?.[ref.field] ?? ''
      case 'node':
        return (ref.field === 'output' ? scope.nodeOutput(ref.nodeId) : scope.nodeTranscript(ref.nodeId)) ?? ''
      default:
        return raw
    }
  })
}

/** Fields whose rendered text is executed by a shell (PO3, PO4): shell/wait commands and command checks. */
export const isCommandField = (n: WorkflowNode, field: string): boolean =>
  field === 'command' && (n.type === 'shell' || n.type === 'wait' || n.type === 'check')

/** Every templated text field of a node (cwd included). notify ignores cwd (always null). */
export function nodeTexts(n: WorkflowNode): { field: string; text: string }[] {
  const t: { field: string; text: string }[] = []
  if (n.cwd && n.type !== 'notify') t.push({ field: 'cwd', text: n.cwd })
  switch (n.type) {
    case 'agent':
      t.push({ field: 'prompt', text: n.prompt })
      break
    case 'room':
      t.push({ field: 'topic', text: n.topic })
      break
    case 'check':
      t.push({ field: 'criteria', text: n.criteria })
      if (n.command) t.push({ field: 'command', text: n.command })
      break
    case 'shell':
      t.push({ field: 'command', text: n.command })
      break
    case 'wait':
      t.push({ field: 'command', text: n.command })
      break
    case 'notify':
      t.push({ field: 'title', text: n.title })
      t.push({ field: 'message', text: n.message })
      break
  }
  return t
}

/** Node ids this node reads output/transcript from. */
export function referencedNodes(n: WorkflowNode): string[] {
  const s = new Set<string>()
  for (const { text } of nodeTexts(n)) for (const r of parseRefs(text)) if (r.kind === 'node') s.add(r.nodeId)
  return [...s]
}
