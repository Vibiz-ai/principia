/**
 * A tiny view layer for the console (docs/CLOUD.md §11: "no HTML rendering of agent text"). Render functions build
 * plain `VNode` objects; `mount` turns them into DOM with createElement, setAttribute and createTextNode only. There is
 * no innerHTML anywhere, and a string child is always a text node, so `<script>` in agent text stays text.
 */
export type Child = VNode | string | number | null | undefined | false
export interface VNode {
  tag: string
  attrs: Record<string, string>
  on: Record<string, (e: Event) => void>
  children: (VNode | string)[]
  /** svg elements are created in the SVG namespace */
  svg?: boolean
}

const SVG_TAGS = new Set(['svg', 'path', 'circle', 'rect', 'g', 'title'])
/** Attributes that could load or run something are refused; event handlers go through `on`. */
const BLOCKED = /^(on|srcdoc$|innerhtml$|outerhtml$)/i

export function h(tag: string, props: Record<string, unknown> | null = null, ...children: (Child | Child[])[]): VNode {
  const attrs: Record<string, string> = {}
  const on: Record<string, (e: Event) => void> = {}
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'on' && typeof v === 'object') Object.assign(on, v)
    else if (!BLOCKED.test(k)) attrs[k] = v === true ? '' : String(v)
  }
  const flat: (VNode | string)[] = []
  const add = (c: Child | Child[]): void => {
    if (Array.isArray(c)) return c.forEach(add)
    if (c === null || c === undefined || c === false) return
    flat.push(typeof c === 'number' ? String(c) : c)
  }
  children.forEach(add)
  return { tag, attrs, on, children: flat, ...(SVG_TAGS.has(tag) ? { svg: true } : {}) }
}

/** The DOM calls mount needs (a real document, or a fake in tests). */
export interface DocLike {
  createElement(tag: string): ElLike
  createElementNS(ns: string, tag: string): ElLike
  createTextNode(text: string): unknown
}
export interface ElLike {
  setAttribute(k: string, v: string): void
  appendChild(c: unknown): unknown
  addEventListener(type: string, fn: (e: Event) => void): void
}

const SVG_NS = 'http://www.w3.org/2000/svg'
export function mount(v: VNode | string, doc: DocLike): unknown {
  if (typeof v === 'string') return doc.createTextNode(v)
  const el = v.svg ? doc.createElementNS(SVG_NS, v.tag) : doc.createElement(v.tag)
  for (const [k, val] of Object.entries(v.attrs)) el.setAttribute(k, val)
  for (const [type, fn] of Object.entries(v.on)) el.addEventListener(type, fn)
  for (const c of v.children) el.appendChild(mount(c, doc))
  return el
}

/** All text in a tree, for tests. */
export function textOf(v: VNode | string): string {
  return typeof v === 'string' ? v : v.children.map(textOf).join('')
}
/** Every node matching a predicate, for tests. */
export function findAll(v: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof v === 'string') return []
  return [...(pred(v) ? [v] : []), ...v.children.flatMap((c) => findAll(c, pred))]
}
