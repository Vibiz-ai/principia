/**
 * Passport Graph mode (PASSPORT.md §10): every note, ghost and (optionally) tag of one company as a live d3-force
 * simulation drawn on a <canvas>. `GraphCanvas` is the renderer shared with the local graph: batched paths per
 * colour, viewport culling, labels that fade with zoom, hover that highlights the neighbourhood, drag, pan and zoom.
 * Positions persist to mem_layout when the simulation settles, so the picture is the same the next time it opens.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Simulation } from 'd3-force'
import type { VaultGraph } from '@shared/passport'
import { EmptyState, ErrorState, IconButton, Loading } from '../ui'
import {
  applyForces,
  buildModel,
  colorFor,
  createSimulation,
  fitTransform,
  hitTest,
  labelAlpha,
  neighborhood,
  parseGroupQuery,
  positionsOf,
  toWorld,
  zoomAt,
  type Display,
  type Forces,
  type GLink,
  type GNode,
  type GraphGroup,
  type GraphModel,
  type Transform
} from '../../lib/forceGraph'
import { firstLoadFilters, HUGE_VAULT, mergeSections, type TreeNote } from '../../lib/passport'
import { errorMessage, hive, nativeMenu } from '../../lib/hive'
import { loadJson, saveJson } from '../../state/store'
import { DEFAULT_GRAPH_SETTINGS, GraphControls, type GraphSettings } from './GraphControls'


interface Palette {
  bg: string
  dot: string
  edge: string
  accent: string
  accentSoft: string
  ghost: string
  text: string
  textDim: string
}
function readPalette(el: Element): Palette {
  const cs = getComputedStyle(el)
  const v = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback
  return {
    bg: v('--canvas-bg', '#1b1c1f'),
    dot: v('--canvas-dot', 'rgba(255,255,255,0.06)'),
    edge: v('--edge', 'rgba(255,255,255,0.22)'),
    accent: v('--accent', '#6e8cff'),
    accentSoft: v('--accent-soft', 'rgba(110,140,255,0.14)'),
    ghost: v('--border-strong', 'rgba(255,255,255,0.12)'),
    text: v('--text-primary', '#e6e6e9'),
    textDim: v('--text-secondary', '#a1a1a9')
  }
}

export interface GraphCanvasProps {
  model: GraphModel
  forces: Forces
  display: Display
  groups: GraphGroup[]
  /** note id -> vault path, for `path:` groups */
  pathById: ReadonlyMap<string, string>
  selectedId?: string | null
  /** the local graph's centre: always labelled and ringed */
  centerId?: string | null
  /** nodes shown so far ("Animate"); null = all */
  visible?: ReadonlySet<string> | null
  seed?: number
  /** bump to re-fit the view */
  fitNonce?: number
  compact?: boolean
  onOpen: (n: GNode) => void
  onContext?: (n: GNode) => void
  /** the simulation cooled down (or a drag ended): persist positions */
  onSettled?: (nodes: GNode[]) => void
}

export function GraphCanvas(p: GraphCanvasProps): React.JSX.Element {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const sim = useRef<Simulation<GNode, GLink> | null>(null)
  const view = useRef<Transform>({ k: 1, x: 0, y: 0 })
  const size = useRef({ w: 0, h: 0, dpr: 1 })
  const hover = useRef<string | null>(null)
  const drag = useRef<{ node: GNode | null; sx: number; sy: number; moved: boolean; tx: number; ty: number } | null>(null)
  const dirty = useRef(true)
  const fitted = useRef(false)
  /** a fresh layout keeps re-fitting while it unfolds, until the user pans or zooms */
  const autoFit = useRef(false)
  const palette = useRef<Palette | null>(null)
  const props = useRef(p)
  props.current = p
  const [cursor, setCursor] = useState<'default' | 'grab' | 'grabbing'>('default')

  // colour per node, batched draw lists: recomputed when the model or the groups change, never per frame
  const groupQs = useMemo(() => p.groups.map((g) => ({ q: parseGroupQuery(g.query), color: g.color })), [p.groups])
  const colors = useMemo(() => {
    const m = new Map<string, string>()
    for (const n of p.model.nodes) m.set(n.id, colorFor(n, groupQs, p.pathById.get(n.id)))
    return m
  }, [p.model, groupQs, p.pathById])
  const colorsRef = useRef(colors)
  colorsRef.current = colors

  // node radius follows the size slider without rebuilding the model
  useEffect(() => {
    for (const n of p.model.nodes) n.r = (3 + Math.sqrt(Math.max(0, n.inDegree)) * 1.6) * p.display.nodeSize
    dirty.current = true
  }, [p.model, p.display.nodeSize])

  useEffect(() => {
    const s = createSimulation(p.model, props.current.forces, { seed: p.seed })
    sim.current = s
    // a live reload keeps the nodes where they were, so it keeps the view too; a new picture is fitted
    if (p.model.savedShare < 0.5) {
      fitted.current = false
      autoFit.current = true
    }
    dirty.current = true
    return () => {
      s.stop()
      sim.current = null
    }
  }, [p.model, p.seed])

  useEffect(() => {
    const s = sim.current
    if (!s) return
    applyForces(s, p.model, p.forces)
    if (s.alpha() < 0.3) s.alpha(0.3)
    dirty.current = true
  }, [p.forces])

  useEffect(() => {
    dirty.current = true
  }, [p.display, colors, p.selectedId, p.visible, p.centerId])

  const fit = useCallback(() => {
    const { w, h } = size.current
    const nodes = props.current.model.nodes
    view.current = fitTransform(nodes, w, h, props.current.compact ? 16 : 48)
    dirty.current = true
  }, [])
  useEffect(() => {
    if (p.fitNonce) fit()
  }, [p.fitNonce, fit])

  // size + DPR
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      size.current = { w: r.width, h: r.height, dpr }
      const c = canvas.current
      if (c) {
        c.width = Math.max(1, Math.round(r.width * dpr))
        c.height = Math.max(1, Math.round(r.height * dpr))
      }
      if (!fitted.current && r.width > 0) {
        fit()
        fitted.current = true
      }
      dirty.current = true
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [fit])

  // frame loop: tick while hot, draw when something changed
  useEffect(() => {
    let raf = 0
    let wasHot = false
    let ticks = 0
    const frame = (): void => {
      raf = requestAnimationFrame(frame)
      const s = sim.current
      const hot = !!s && s.alpha() >= s.alphaMin()
      if (s && hot) {
        s.tick()
        ticks++
        dirty.current = true
        if (size.current.w > 0 && (!fitted.current || (autoFit.current && ticks % 8 === 0))) {
          fit()
          fitted.current = true
        }
      }
      if (wasHot && !hot) {
        autoFit.current = false
        props.current.onSettled?.(props.current.model.nodes)
      }
      wasHot = hot
      if (dirty.current) {
        dirty.current = false
        draw()
      }
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
    // draw reads everything through refs
  }, [fit])

  function draw(): void {
    const c = canvas.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    const pal = (palette.current ??= readPalette(c))
    const { w, h, dpr } = size.current
    const t = view.current
    const { model, display, selectedId, centerId, visible } = props.current
    const colorMap = colorsRef.current
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = pal.bg
    ctx.fillRect(0, 0, w, h)

    // dot grid (screen space, follows pan/zoom)
    const step = 24 * t.k
    if (step >= 8) {
      ctx.fillStyle = pal.dot
      const ox = ((t.x % step) + step) % step
      const oy = ((t.y % step) + step) % step
      for (let x = ox; x < w; x += step) for (let y = oy; y < h; y += step) ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5)
    }

    ctx.setTransform(dpr * t.k, 0, 0, dpr * t.k, dpr * t.x, dpr * t.y)
    const [vx0, vy0] = toWorld(t, -40, -40)
    const [vx1, vy1] = toWorld(t, w + 40, h + 40)
    const inView = (n: GNode): boolean => n.x >= vx0 - n.r && n.x <= vx1 + n.r && n.y >= vy0 - n.r && n.y <= vy1 + n.r
    const shown = (n: GNode): boolean => !visible || visible.has(n.id)
    const focus = neighborhood(model, hover.current ?? null)
    const lw = (display.linkThickness * 1) / Math.max(0.35, t.k)

    // edges: one path for the plain ones, one for the highlighted neighbourhood
    ctx.lineWidth = lw
    ctx.strokeStyle = pal.edge
    ctx.globalAlpha = focus ? 0.12 : 1
    ctx.beginPath()
    const hi: GLink[] = []
    for (const l of model.links) {
      const a = l.source
      const b = l.target
      if (!shown(a) || !shown(b)) continue
      if ((a.x < vx0 && b.x < vx0) || (a.x > vx1 && b.x > vx1) || (a.y < vy0 && b.y < vy0) || (a.y > vy1 && b.y > vy1)) continue
      if (focus && (a.id === hover.current || b.id === hover.current)) {
        hi.push(l)
        continue
      }
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
    }
    ctx.stroke()
    ctx.globalAlpha = 1
    if (hi.length) {
      ctx.strokeStyle = pal.accent
      ctx.lineWidth = lw * 1.6
      ctx.beginPath()
      for (const l of hi) {
        ctx.moveTo(l.source.x, l.source.y)
        ctx.lineTo(l.target.x, l.target.y)
      }
      ctx.stroke()
    }
    if (display.arrows && t.k > 0.45) {
      ctx.fillStyle = pal.edge
      ctx.beginPath()
      for (const l of model.links) {
        const a = l.source
        const b = l.target
        if (!shown(a) || !shown(b) || !inView(b)) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const d = Math.hypot(dx, dy) || 1
        const ux = dx / d
        const uy = dy / d
        const tipX = b.x - ux * (b.r + 1)
        const tipY = b.y - uy * (b.r + 1)
        const s = 4 * Math.max(1, display.linkThickness)
        ctx.moveTo(tipX, tipY)
        ctx.lineTo(tipX - ux * s - uy * s * 0.55, tipY - uy * s + ux * s * 0.55)
        ctx.lineTo(tipX - ux * s + uy * s * 0.55, tipY - uy * s - ux * s * 0.55)
        ctx.closePath()
      }
      ctx.fill()
    }

    // nodes, batched by colour; faded ones first so the neighbourhood draws on top
    const batches = new Map<string, GNode[]>()
    const ghosts: GNode[] = []
    const faded: GNode[] = []
    for (const n of model.nodes) {
      if (!shown(n) || !inView(n)) continue
      if (focus && !focus.has(n.id)) {
        faded.push(n)
        continue
      }
      if (n.ghost) ghosts.push(n)
      else {
        const col = colorMap.get(n.id) || '#8b8d96'
        const list = batches.get(col)
        if (list) list.push(n)
        else batches.set(col, [n])
      }
    }
    if (faded.length) {
      ctx.globalAlpha = 0.15
      ctx.fillStyle = pal.textDim
      ctx.beginPath()
      for (const n of faded) {
        ctx.moveTo(n.x + n.r, n.y)
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
      }
      ctx.fill()
      ctx.globalAlpha = 1
    }
    for (const [col, list] of batches) {
      ctx.fillStyle = col
      ctx.beginPath()
      for (const n of list) {
        ctx.moveTo(n.x + n.r, n.y)
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
      }
      ctx.fill()
    }
    if (ghosts.length) {
      // ghosts: hollow, dashed --border-strong outline
      ctx.fillStyle = pal.bg
      ctx.strokeStyle = pal.textDim
      ctx.globalAlpha = 0.7
      ctx.lineWidth = 1 / Math.max(0.5, t.k)
      ctx.setLineDash([2.5 / Math.max(0.5, t.k), 2 / Math.max(0.5, t.k)])
      ctx.beginPath()
      for (const n of ghosts) {
        ctx.moveTo(n.x + n.r, n.y)
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
      }
      ctx.fill()
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
    }
    // selection / centre ring
    for (const id of [selectedId, centerId, hover.current]) {
      const n = id ? model.byId.get(id) : undefined
      if (!n || !shown(n)) continue
      ctx.fillStyle = pal.accentSoft
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.r + 5 / Math.max(0.5, t.k), 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = pal.accent
      ctx.lineWidth = 1.5 / Math.max(0.5, t.k)
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.r + 1.5 / Math.max(0.5, t.k), 0, Math.PI * 2)
      ctx.stroke()
    }

    // labels: screen-space text, fading with zoom; the focus neighbourhood and the selection always show
    const a = labelAlpha(t.k, display.textFade)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.font = `${props.current.compact ? 10 : 11}px ${getComputedStyle(c).fontFamily || 'sans-serif'}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    const always = new Set<string>([selectedId, centerId].filter((x): x is string => !!x))
    if (focus) for (const id of focus) always.add(id)
    let budget = props.current.compact ? 120 : 600
    for (const n of model.nodes) {
      if (!shown(n) || !inView(n)) continue
      const pinned = always.has(n.id)
      const alpha = pinned ? 1 : focus ? 0 : a
      if (alpha <= 0.02) continue
      if (!pinned && --budget < 0) continue
      const sx = n.x * t.k + t.x
      const sy = (n.y + n.r) * t.k + t.y + 3
      ctx.globalAlpha = alpha
      ctx.fillStyle = n.ghost ? pal.textDim : pal.text
      const label = n.title.length > 40 ? `${n.title.slice(0, 38)}…` : n.title
      ctx.fillText(label, sx, sy)
    }
    ctx.globalAlpha = 1
  }

  // ---- interaction ----
  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = canvas.current!.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }
  const nodeAt = (sx: number, sy: number): GNode | null => {
    const [wx, wy] = toWorld(view.current, sx, sy)
    const { model, visible } = props.current
    const n = hitTest(model.nodes, wx, wy, 4 / view.current.k)
    return n && (!visible || visible.has(n.id)) ? n : null
  }
  const onMouseDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return
    autoFit.current = false
    const [sx, sy] = local(e)
    const node = nodeAt(sx, sy)
    drag.current = { node, sx, sy, moved: false, tx: view.current.x, ty: view.current.y }
    setCursor('grabbing')
  }
  const onMouseMove = (e: React.MouseEvent): void => {
    const [sx, sy] = local(e)
    const d = drag.current
    if (d) {
      if (!d.moved && Math.hypot(sx - d.sx, sy - d.sy) < 3) return
      d.moved = true
      if (d.node) {
        const [wx, wy] = toWorld(view.current, sx, sy)
        d.node.fx = wx
        d.node.fy = wy
        const s = sim.current
        if (s) {
          s.alphaTarget(0.25)
          if (s.alpha() < 0.25) s.alpha(0.25)
        }
      } else {
        view.current = { ...view.current, x: d.tx + (sx - d.sx), y: d.ty + (sy - d.sy) }
      }
      dirty.current = true
      return
    }
    const n = nodeAt(sx, sy)
    const id = n?.id ?? null
    if (id !== hover.current) {
      hover.current = id
      dirty.current = true
      setCursor(id ? 'grab' : 'default')
    }
  }
  const endDrag = (): void => {
    const d = drag.current
    drag.current = null
    setCursor(hover.current ? 'grab' : 'default')
    if (!d) return
    if (d.node && d.moved) {
      d.node.fx = null
      d.node.fy = null
      sim.current?.alphaTarget(0)
      props.current.onSettled?.(props.current.model.nodes)
    }
  }
  const onMouseUp = (e: React.MouseEvent): void => {
    const d = drag.current
    endDrag()
    if (d && !d.moved && d.node && e.button === 0) props.current.onOpen(d.node)
  }
  // native, non-passive: the wheel zooms the graph instead of scrolling the column around it
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      autoFit.current = false
      const [sx, sy] = local(e)
      // pinch (ctrl+wheel) and the mouse wheel zoom, like Obsidian; a trackpad two-finger swipe pans
      if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 0.5 && e.deltaMode === 0 && Math.abs(e.deltaY) < 40) {
        view.current = { ...view.current, x: view.current.x - e.deltaX, y: view.current.y - e.deltaY }
      } else {
        view.current = zoomAt(view.current, sx, sy, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)))
      }
      dirty.current = true
    }
    c.addEventListener('wheel', onWheel, { passive: false })
    return () => c.removeEventListener('wheel', onWheel)
  }, [])
  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    const [sx, sy] = local(e)
    const n = nodeAt(sx, sy)
    if (n) props.current.onContext?.(n)
  }

  return (
    <div className={`pgraph ${p.compact ? 'pgraph--compact' : ''}`} ref={wrap}>
      <canvas
        ref={canvas}
        className="pgraph__canvas"
        style={{ cursor }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={() => {
          endDrag()
          if (hover.current) {
            hover.current = null
            dirty.current = true
          }
        }}
        onDoubleClick={(e) => {
          if (!nodeAt(...local(e))) fit()
        }}
        onContextMenu={onContextMenu}
      />
    </div>
  )
}

// ---------- Graph mode ----------
const settingsKey = (companyId: string): string => `hive.passport.graph.${companyId}`

/** Saved settings over the defaults, section by section, so settings saved by an older build never miss a field. */
function loadSettings(companyId: string): GraphSettings {
  const s = mergeSections(DEFAULT_GRAPH_SETTINGS, loadJson<unknown>(settingsKey(companyId), null))
  // a group without a query or colour would break colouring for every node
  return { ...s, groups: s.groups.filter((g) => !!g && typeof g.query === 'string' && typeof g.color === 'string') }
}

export function GlobalGraph({
  companyId,
  tree,
  reloadKey,
  selectedId,
  onOpen,
  onCreateGhost,
  onLocalGraph,
  onOpenInObsidian,
  onArchive
}: {
  companyId: string
  tree: TreeNote[]
  reloadKey: number
  selectedId: string | null
  onOpen: (noteId: string) => void
  onCreateGhost: (title: string) => void
  onLocalGraph: (noteId: string) => void
  onOpenInObsidian: (noteId: string) => void
  onArchive: (noteId: string) => void
}): React.JSX.Element {
  const [settings, setSettings] = useState<GraphSettings>(() => loadSettings(companyId))
  /** no saved settings yet: the first load of a huge vault may still switch ghosts and orphans off (§10) */
  const [unsaved] = useState(() => loadJson<unknown>(settingsKey(companyId), null) === null)
  const fresh = useRef(unsaved)
  const [drawer, setDrawer] = useState(() => loadJson<boolean>('hive.passport.graph.drawer', false))
  const [graph, setGraph] = useState<VaultGraph | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fitNonce, setFitNonce] = useState(0)
  const [retry, setRetry] = useState(0)
  const [visible, setVisible] = useState<Set<string> | null>(null)
  const model = useRef<GraphModel | null>(null)
  const lastSaved = useRef<string>('')

  useEffect(() => saveJson(settingsKey(companyId), settings), [companyId, settings])
  useEffect(() => saveJson('hive.passport.graph.drawer', drawer), [drawer])

  // server-side filters (search is debounced)
  const filtersKey = JSON.stringify(settings.filters)
  useEffect(() => {
    let live = true
    const t = setTimeout(
      () => {
        hive.memory.graph({ op: 'global', companyId, filters: settings.filters }).then(
          (g) => {
            if (!live) return
            if (fresh.current) {
              fresh.current = false
              const first = firstLoadFilters(g.total, settings.filters)
              if (first) {
                // above 5k nodes ghosts and orphans start hidden; the refetch with those filters replaces this graph
                setSettings((s) => ({ ...s, filters: first }))
                return
              }
            }
            setGraph(g)
            setError(null)
          },
          (e) => live && setError(errorMessage(e))
        )
      },
      graph ? 250 : 0
    )
    return () => {
      live = false
      clearTimeout(t)
    }
    // graph only decides the debounce
  }, [companyId, filtersKey, reloadKey, retry])

  // a reload keeps where nodes are now, so live updates never make the picture jump
  const built = useMemo(() => {
    if (!graph) return null
    const saved = new Map<string, { x: number; y: number }>()
    for (const n of model.current?.nodes ?? []) saved.set(n.id, { x: n.x, y: n.y })
    return buildModel(graph, { sizeMul: settings.display.nodeSize, saved })
    // node size is applied in place by GraphCanvas
  }, [graph])
  model.current = built

  const pathById = useMemo(() => new Map(tree.map((t) => [t.id, t.path])), [tree])

  const save = useCallback(
    (nodes: GNode[]) => {
      // the layout op takes at most 10k rows (ipcSchemas); a bigger graph keeps the first 10k rather than none
      const positions = positionsOf(nodes).slice(0, 10_000)
      const key = JSON.stringify(positions)
      if (!positions.length || key === lastSaved.current) return
      lastSaved.current = key
      void hive.memory.graph({ op: 'layout', companyId, positions }).catch(() => undefined)
    },
    [companyId]
  )
  // leaving the view mid-simulation still remembers the picture
  useEffect(
    () => () => {
      if (model.current) save(model.current.nodes)
    },
    [save]
  )

  // "Animate": reveal notes oldest first over ~6 s (ghosts and tags appear with their first linking note)
  const animate = (): void => {
    if (visible) return setVisible(null)
    const m = model.current
    if (!m) return
    const date = new Map(tree.map((t) => [t.id, t.modified ?? '']))
    const order = m.nodes.filter((n) => !n.ghost && !n.tag).sort((a, b) => (date.get(a.id) ?? '').localeCompare(date.get(b.id) ?? '') || a.title.localeCompare(b.title))
    const shown = new Set<string>()
    setVisible(new Set())
    const per = Math.max(1, Math.ceil(order.length / 120))
    let i = 0
    const step = (): void => {
      if (!model.current || model.current !== m) return
      for (let k = 0; k < per && i < order.length; k++, i++) {
        const n = order[i]!
        shown.add(n.id)
        for (const nb of m.neighbors.get(n.id) ?? []) {
          const x = m.byId.get(nb)
          if (x && (x.ghost || x.tag)) shown.add(nb)
        }
      }
      setVisible(new Set(shown))
      if (i < order.length) animTimer.current = setTimeout(step, 50)
      else animTimer.current = setTimeout(() => setVisible(null), 800)
    }
    step()
  }
  const animTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (animTimer.current && clearTimeout(animTimer.current)), [])
  useEffect(() => {
    if (!visible && animTimer.current) clearTimeout(animTimer.current)
  }, [visible])

  const context = async (n: GNode): Promise<void> => {
    if (n.tag) return
    const id = await nativeMenu(
      n.ghost
        ? [{ id: 'create', label: `Create “${n.title}”` }]
        : [
            { id: 'open', label: 'Open' },
            { id: 'local', label: 'Local Graph' },
            { id: 'obsidian', label: 'Open in Obsidian' },
            { type: 'separator' },
            { id: 'archive', label: 'Archive' }
          ]
    )
    if (id === 'create') onCreateGhost(n.title)
    else if (id === 'open') onOpen(n.id)
    else if (id === 'local') onLocalGraph(n.id)
    else if (id === 'obsidian') onOpenInObsidian(n.id)
    else if (id === 'archive') onArchive(n.id)
  }

  const huge = (graph?.total ?? 0) > HUGE_VAULT
  const notes = built?.nodes.filter((n) => !n.ghost && !n.tag).length ?? 0
  const ghosts = built?.nodes.filter((n) => n.ghost).length ?? 0

  return (
    <div className="pgmode">
      <div className="pgmode__stage">
        {error && !graph ? (
          <ErrorState error={`Couldn’t load the graph: ${error}`} onRetry={() => setRetry((n) => n + 1)} />
        ) : !built ? (
          <Loading label="Loading graph…" />
        ) : built.nodes.length === 0 ? (
          <EmptyState icon="memory" text={settings.filters.search ? 'No notes match these filters.' : 'No notes yet. Notes and the links between them show up here.'} />
        ) : (
          <GraphCanvas
            model={built}
            forces={settings.forces}
            display={settings.display}
            groups={settings.groups}
            pathById={pathById}
            selectedId={selectedId}
            visible={visible}
            fitNonce={fitNonce}
            onOpen={(n) => (n.ghost ? onCreateGhost(n.title) : n.tag ? undefined : onOpen(n.id))}
            onContext={(n) => void context(n)}
            onSettled={save}
          />
        )}
        <div className="pgmode__hud">
          <span className="pgmode__stats">
            {notes} notes · {ghosts} ghosts{graph?.truncated ? ` · showing ${built?.nodes.length ?? 0} of ${graph.total}` : ''}
          </span>
          <IconButton icon="grid" label="Fit to view" onClick={() => setFitNonce((n) => n + 1)} />
          <IconButton icon="settings" label="Graph settings" className={drawer ? 'is-on' : ''} onClick={() => setDrawer(!drawer)} />
        </div>
      </div>
      {drawer && <GraphControls settings={settings} onChange={setSettings} onClose={() => setDrawer(false)} animating={!!visible} onAnimate={animate} huge={huge} />}
    </div>
  )
}
