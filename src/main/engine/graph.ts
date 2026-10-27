/**
 * Workflow graph helpers. Effective dependencies = `after` ∪ templated node refs ∪ (check: target).
 * The check loop-back is implicit, never an edge.
 */
import type { CheckNode, WorkflowNode } from '../../shared/types'
import { referencedNodes } from './templates'

export type DepMap = Map<string, Set<string>>

export function effectiveDeps(nodes: WorkflowNode[]): DepMap {
  const ids = new Set(nodes.map((n) => n.id))
  const m: DepMap = new Map()
  for (const n of nodes) {
    const d = new Set<string>()
    for (const a of n.after ?? []) if (ids.has(a) && a !== n.id) d.add(a)
    for (const r of referencedNodes(n)) if (ids.has(r) && r !== n.id) d.add(r)
    if (n.type === 'check' && ids.has(n.target) && n.target !== n.id) d.add(n.target)
    m.set(n.id, d)
  }
  return m
}

/** Kahn topological order; returns null + the ids stuck in a cycle when there is one. */
export function topoOrder(deps: DepMap): { order: string[]; cycle: string[] | null } {
  const indeg = new Map<string, number>()
  const children = new Map<string, string[]>()
  for (const [id, ds] of deps) {
    indeg.set(id, ds.size)
    for (const d of ds) children.set(d, [...(children.get(d) ?? []), id])
  }
  const q = [...deps.keys()].filter((id) => indeg.get(id) === 0)
  const order: string[] = []
  while (q.length) {
    const id = q.shift()!
    order.push(id)
    for (const c of children.get(id) ?? []) {
      indeg.set(c, indeg.get(c)! - 1)
      if (indeg.get(c) === 0) q.push(c)
    }
  }
  if (order.length === deps.size) return { order, cycle: null }
  return { order, cycle: [...deps.keys()].filter((id) => !order.includes(id)) }
}

export function descendants(deps: DepMap, id: string): Set<string> {
  const children = new Map<string, string[]>()
  for (const [n, ds] of deps) for (const d of ds) children.set(d, [...(children.get(d) ?? []), n])
  const out = new Set<string>()
  const stack = [id]
  while (stack.length) for (const c of children.get(stack.pop()!) ?? []) if (!out.has(c)) { out.add(c); stack.push(c) }
  return out
}

export function ancestors(deps: DepMap, id: string): Set<string> {
  const out = new Set<string>()
  const stack = [id]
  while (stack.length) for (const d of deps.get(stack.pop()!) ?? []) if (!out.has(d)) { out.add(d); stack.push(d) }
  return out
}

/** SPEC A4: target + every node on a path target -> check (check itself excluded). */
export function loopBody(deps: DepMap, check: CheckNode): Set<string> {
  const body = new Set<string>([check.target])
  const down = descendants(deps, check.target)
  for (const a of ancestors(deps, check.id)) if (down.has(a)) body.add(a)
  return body
}
