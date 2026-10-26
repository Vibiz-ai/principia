/**
 * BROWSER.md §4: the accessibility tree (CDP Accessibility.getFullAXTree) as compact ref lines, in the shape agents
 * already know from Playwright MCP and agent-browser. Pure: no Electron.
 *
 *   Page: Example Domain
 *   URL: https://example.com/
 *   Interactive (2):
 *   - link "Learn more" [ref=e3]
 *   - textbox "Email" value="ana@" [required] [ref=e4] (in form "Sign up")
 *   Content:
 *   - heading "Example Domain" [level=1] [ref=e1]
 *   - paragraph: This domain is for use in documentation examples…
 *
 * Refs are stable per page: the same element keeps its ref across snapshots until the page navigates (RefMap).
 */

export interface AXValue {
  type?: string
  value?: unknown
}
export interface AXProperty {
  name: string
  value: AXValue
}
export interface AXNode {
  nodeId: string
  ignored?: boolean
  role?: AXValue
  name?: AXValue
  value?: AXValue
  description?: AXValue
  properties?: AXProperty[]
  childIds?: string[]
  parentId?: string
  backendDOMNodeId?: number
  frameId?: string
}

export interface RefTarget {
  backendNodeId: number
  /** the frame the node lives in (null = main frame) */
  frameId: string | null
  role: string
  name: string
}

/** ref ⇄ element, kept per tab and reset when the main frame navigates. */
export class RefMap {
  private byKey = new Map<string, string>()
  private byRef = new Map<string, RefTarget>()
  private next = 1
  reset(): void {
    this.byKey.clear()
    this.byRef.clear()
    this.next = 1
  }
  refFor(t: RefTarget): string {
    const key = `${t.frameId ?? ''}:${t.backendNodeId}`
    let r = this.byKey.get(key)
    if (!r) {
      r = `e${this.next++}`
      this.byKey.set(key, r)
    }
    this.byRef.set(r, t)
    return r
  }
  get(ref: string): RefTarget | null {
    return this.byRef.get(ref.trim().replace(/^\[?ref=/, '').replace(/^@/, '').replace(/\]$/, '')) ?? null
  }
  get size(): number {
    return this.byRef.size
  }
}

/** Leaf controls: one line with a ref, children not walked (their text is the name). */
export const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab',
  'treeitem',
  'combobox',
  'ListBoxOption',
  'MenuListOption',
  'PopUpButton',
  'ToggleButton',
  'DisclosureTriangle',
  'textarea'
])
/** Interactive containers: a line, then their children. */
const INTERACTIVE_CONTAINERS = new Set(['listbox', 'menu', 'menubar', 'tablist', 'radiogroup', 'tree', 'grid', 'treegrid'])
/** Wrappers: no line; their children go up one level. */
const WRAPPERS = new Set([
  'generic',
  'none',
  'presentation',
  'RootWebArea',
  'WebArea',
  'Section',
  'div',
  'group',
  'LayoutTable',
  'LayoutTableRow',
  'LayoutTableCell',
  'strong',
  'emphasis',
  'code',
  'mark',
  'time',
  'abbr',
  'superscript',
  'subscript',
  'Ruby',
  'Abbr',
  'Pre',
  'insertion',
  'deletion',
  'sectionheader',
  'sectionfooter',
  'Canvas',
  'Unknown'
])
const SKIP = new Set(['LineBreak', 'InlineTextBox', 'ListMarker', 'Inline'])
/** Text containers: one line holding their text when nothing interactive is inside. */
const TEXT_CONTAINERS = new Set(['paragraph', 'listitem', 'cell', 'gridcell', 'columnheader', 'rowheader', 'blockquote', 'caption', 'term', 'definition', 'LabelText', 'label', 'legend', 'note', 'Legend', 'DescriptionListTerm', 'DescriptionListDetail', 'figcaption', 'tooltip'])
/** Structure worth a line ("navigation", "dialog "Sign in""). */
const LANDMARKS = new Set(['navigation', 'main', 'banner', 'contentinfo', 'complementary', 'region', 'form', 'search', 'article', 'dialog', 'alertdialog', 'alert', 'status', 'table', 'row', 'list', 'figure', 'toolbar', 'log', 'marquee', 'timer', 'feed', 'application', 'document', 'DescriptionList', 'math', 'separator', 'progressbar', 'meter', 'scrollbar', 'Details', 'summary'])
/** Context named in the Interactive list ("(in form "Sign up")"). */
const CONTEXT_ROLES = new Set(['row', 'listitem', 'form', 'dialog', 'alertdialog', 'region', 'navigation', 'article', 'search', 'table', 'menu', 'listbox', 'tablist', 'banner', 'contentinfo', 'complementary'])
/** Content elements that also get a ref (screenshots, scrolling to them). */
const REF_CONTENT = new Set(['heading', 'img', 'image', 'Iframe', 'IframePresentational', 'dialog', 'alertdialog', 'figure', 'table', 'video', 'audio'])

export interface ChildFrame {
  frameId: string
  url: string
  nodes?: AXNode[]
  /** why its content is not in the snapshot (another process, blocked) */
  error?: string
}

export interface SnapshotInput {
  title: string
  url: string
  nodes: AXNode[]
  /** iframe element backendNodeId → that frame's tree */
  frames?: Map<number, ChildFrame>
  refs: RefMap
  full?: boolean
}
export interface SnapshotOut {
  text: string
  interactive: number
  lines: number
}

const str = (v: AXValue | undefined): string => (v && v.value !== undefined && v.value !== null ? String(v.value) : '')
const clean = (s: string): string => s.replace(/\s+/g, ' ').trim()
const q = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function prop(n: AXNode, name: string): unknown {
  return n.properties?.find((p) => p.name === name)?.value?.value
}

function flags(n: AXNode, role: string): string {
  const out: string[] = []
  const level = prop(n, 'level')
  if (role === 'heading' && level !== undefined) out.push(`[level=${level}]`)
  const checked = prop(n, 'checked')
  if (checked === 'true' || checked === true) out.push('[checked]')
  else if (checked === 'mixed') out.push('[checked=mixed]')
  const pressed = prop(n, 'pressed')
  if (pressed === 'true' || pressed === true) out.push('[pressed]')
  if (prop(n, 'selected') === true) out.push('[selected]')
  const expanded = prop(n, 'expanded')
  if (expanded !== undefined) out.push(`[expanded=${expanded}]`)
  if (prop(n, 'disabled') === true) out.push('[disabled]')
  if (prop(n, 'required') === true) out.push('[required]')
  if (prop(n, 'readonly') === true) out.push('[readonly]')
  if (prop(n, 'focused') === true) out.push('[focused]')
  if (prop(n, 'invalid') && prop(n, 'invalid') !== 'false') out.push('[invalid]')
  return out.join(' ')
}

function roleOf(n: AXNode): string {
  const r = str(n.role)
  if (r === 'image') return 'img'
  if (r === 'StaticText') return 'text'
  return r || 'generic'
}

interface Ctx {
  byId: Map<string, AXNode>
  frameId: string | null
  frames: Map<number, ChildFrame>
  refs: RefMap
  full: boolean
  interactive: string[]
  content: string[]
  textMax: number
  maxLines: number
  seenFrames: Set<string>
}

/** Text of a subtree (StaticText names), for text containers. */
function textOf(c: Ctx, n: AXNode, depth = 0): string {
  if (depth > 30) return ''
  const role = roleOf(n)
  if (role === 'text') return clean(str(n.name))
  if (SKIP.has(role)) return ''
  const parts: string[] = []
  for (const id of n.childIds ?? []) {
    const ch = c.byId.get(id)
    if (ch) {
      const t = textOf(c, ch, depth + 1)
      if (t) parts.push(t)
    }
  }
  return clean(parts.join(' '))
}

/** Whether the subtree holds anything that becomes its own line (a control, an image, a heading). */
function hasStructure(c: Ctx, n: AXNode, depth = 0): boolean {
  if (depth > 30) return false
  for (const id of n.childIds ?? []) {
    const ch = c.byId.get(id)
    if (!ch) continue
    const role = roleOf(ch)
    if (!ch.ignored && (INTERACTIVE_ROLES.has(role) || INTERACTIVE_CONTAINERS.has(role) || REF_CONTENT.has(role) || role === 'list')) return true
    if (hasStructure(c, ch, depth + 1)) return true
  }
  return false
}

function pushContent(c: Ctx, depth: number, line: string): void {
  if (c.content.length >= c.maxLines) return
  c.content.push(`${'  '.repeat(Math.min(depth, 8))}- ${line}`)
}

function refOf(c: Ctx, n: AXNode, role: string, name: string): string | null {
  if (typeof n.backendDOMNodeId !== 'number') return null
  return c.refs.refFor({ backendNodeId: n.backendDOMNodeId, frameId: c.frameId, role, name })
}

function walk(c: Ctx, n: AXNode, depth: number, context: string, guard: number): void {
  if (guard > 200) return
  const kids = (): void => {
    for (const id of n.childIds ?? []) {
      const ch = c.byId.get(id)
      if (ch) walk(c, ch, depth, context, guard + 1)
    }
  }
  if (n.ignored) {
    kids()
    return
  }
  const role = roleOf(n)
  if (SKIP.has(role)) return
  const name = clean(str(n.name))
  if (role === 'text') {
    if (name) pushContent(c, depth, `text: ${c.full ? name : cut(name, c.textMax)}`)
    return
  }
  const fl = flags(n, role)
  if (INTERACTIVE_ROLES.has(role)) {
    const r = refOf(c, n, role, name)
    const value = clean(str(n.value))
    const line = [role, name ? q(cut(name, 120)) : '', value && value !== name ? `value=${q(cut(value, 120))}` : '', fl, r ? `[ref=${r}]` : '']
      .filter(Boolean)
      .join(' ')
    c.interactive.push(`- ${line}${context ? ` (in ${context})` : ''}`)
    return
  }
  const nextContext = CONTEXT_ROLES.has(role) && name ? `${role} ${q(cut(name, 40))}` : context
  const descend = (d: number): void => {
    for (const id of n.childIds ?? []) {
      const ch = c.byId.get(id)
      if (ch) walk(c, ch, d, nextContext, guard + 1)
    }
  }
  if (role === 'Iframe' || role === 'IframePresentational') {
    const r = refOf(c, n, role, name)
    pushContent(c, depth, ['iframe', name ? q(cut(name, 80)) : '', r ? `[ref=${r}]` : ''].filter(Boolean).join(' ') + ':')
    const fr = typeof n.backendDOMNodeId === 'number' ? c.frames.get(n.backendDOMNodeId) : undefined
    if (!fr) {
      pushContent(c, depth + 1, 'note: frame content not loaded')
      return
    }
    if (fr.error || !fr.nodes?.length) {
      pushContent(c, depth + 1, `note: frame ${cut(fr.url, 80)} not readable (${fr.error ?? 'empty'})`)
      return
    }
    if (c.seenFrames.has(fr.frameId)) return
    c.seenFrames.add(fr.frameId)
    walkTree({ ...c, frameId: fr.frameId, byId: new Map(fr.nodes.map((x) => [x.nodeId, x])) }, fr.nodes, depth + 1, `iframe ${q(cut(fr.url, 40))}`)
    return
  }
  if (WRAPPERS.has(role) && !(role === 'group' && name)) {
    kids()
    return
  }
  if (INTERACTIVE_CONTAINERS.has(role)) {
    pushContent(c, depth, [role, name ? q(cut(name, 80)) : '', fl].filter(Boolean).join(' ') + ':')
    descend(depth + 1)
    return
  }
  if (TEXT_CONTAINERS.has(role)) {
    if (!hasStructure(c, n)) {
      const t = textOf(c, n) || name
      if (t) pushContent(c, depth, `${role}: ${c.full ? t : cut(t, c.textMax)}`)
      // controls inside still reach the Interactive list
      descendInteractiveOnly(c, n, nextContext, guard)
      return
    }
    pushContent(c, depth, `${role}:`)
    descend(depth + 1)
    return
  }
  if (REF_CONTENT.has(role) || role === 'heading') {
    const r = refOf(c, n, role, name)
    const text = name || textOf(c, n)
    pushContent(c, depth, [role, text ? q(c.full ? text : cut(text, c.textMax)) : '', fl, r ? `[ref=${r}]` : ''].filter(Boolean).join(' '))
    if (role !== 'heading' && role !== 'img') descend(depth + 1)
    else descendInteractiveOnly(c, n, nextContext, guard)
    return
  }
  if (LANDMARKS.has(role) || role === 'group') {
    const value = clean(str(n.value))
    pushContent(c, depth, [role, name ? q(cut(name, 80)) : '', value ? `value=${q(value)}` : '', fl].filter(Boolean).join(' ') + ':')
    descend(depth + 1)
    return
  }
  // anything else with a name: one line; without: transparent
  if (name && !hasStructure(c, n)) {
    pushContent(c, depth, `${role}: ${c.full ? name : cut(name, c.textMax)}`)
    descendInteractiveOnly(c, n, nextContext, guard)
    return
  }
  kids()
}

/** Controls nested in something printed as one text line (a link inside a paragraph). */
function descendInteractiveOnly(c: Ctx, n: AXNode, context: string, guard: number): void {
  if (guard > 200) return
  for (const id of n.childIds ?? []) {
    const ch = c.byId.get(id)
    if (!ch) continue
    const role = roleOf(ch)
    if (!ch.ignored && INTERACTIVE_ROLES.has(role)) {
      const before = c.content.length
      walk(c, ch, 0, context, guard + 1)
      c.content.length = before
    } else descendInteractiveOnly(c, ch, context, guard + 1)
  }
}

function walkTree(c: Ctx, nodes: AXNode[], depth: number, context: string): void {
  const roots = nodes.filter((n) => !n.parentId || !c.byId.has(n.parentId))
  for (const r of roots) walk(c, r, depth, context, 0)
}

export const SNAPSHOT_INLINE_MAX = 12_000

export function formatSnapshot(input: SnapshotInput): SnapshotOut {
  const c: Ctx = {
    byId: new Map(input.nodes.map((n) => [n.nodeId, n])),
    frameId: null,
    frames: input.frames ?? new Map(),
    refs: input.refs,
    full: input.full === true,
    interactive: [],
    content: [],
    textMax: input.full ? 100_000 : 160,
    maxLines: input.full ? 5000 : 600,
    seenFrames: new Set()
  }
  walkTree(c, input.nodes, 0, '')
  const head = [`Page: ${cut(clean(input.title) || '(untitled)', 200)}`, `URL: ${input.url}`]
  const out = [...head, `Interactive (${c.interactive.length}):`, ...(c.interactive.length ? c.interactive : ['- (none)']), 'Content:', ...(c.content.length ? c.content : ['- (empty)'])]
  if (c.content.length >= c.maxLines) out.push(`- … more content not shown (use browser_snapshot {full: true})`)
  return { text: out.join('\n'), interactive: c.interactive.length, lines: out.length }
}
