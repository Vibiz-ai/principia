'use client'

import { useEffect, useRef, type CSSProperties } from 'react'

export interface HalftonePalette {
  background: string
  ink: string
  warm: string
}
export type HalftonePreset = 'night' | 'paper' | 'ember' | 'cobalt'
export interface FooterLink { label: string; href?: string }
export interface FooterColumn { title: string; links: FooterLink[] }
export interface HalftoneWordmarkFooterProps {
  wordmark?: string
  label?: string
  meta?: string
  columns?: FooterColumn[]
  backToTop?: boolean
  preset?: HalftonePreset
  palette?: Partial<HalftonePalette>
  dotGap?: number
  radius?: number
  crop?: number
  grain?: number
  interactive?: boolean
  fontFamily?: string
  fontWeight?: number
  monoFamily?: string
  height?: string
  className?: string
}

export const HWF_PRESETS: Record<HalftonePreset, HalftonePalette> = {
  night: { background: '#0c0c0b', ink: '#e9e4da', warm: '#e9762b' },
  paper: { background: '#efebe3', ink: '#17150f', warm: '#c2361c' },
  ember: { background: '#160a06', ink: '#f2c48c', warm: '#ff5a1f' },
  cobalt: { background: '#0d1b4d', ink: '#dfe7ff', warm: '#ffcd3c' },
}
const clamp = (value: number, min = 0, max = 1): number => Math.max(min, Math.min(max, value))
export function hwfHex(hex: string): [number, number, number] | null {
  let value = hex.trim().replace(/^#/, '')
  if (/^[\da-f]{3}$/i.test(value)) value = value.split('').map(char => char + char).join('')
  if (!/^[\da-f]{6}$/i.test(value)) return null
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)]
}
export function hwfRadius(coverage: number, gap: number): number { return Math.sqrt(clamp(coverage)) * gap * .56 }
export interface HalftoneDot { x: number; y: number; vx: number; vy: number; hx: number; hy: number; r: number }
export function hwfStep(x: number, y: number, vx: number, vy: number, hx: number, hy: number, px: number, py: number, radius: number): [number, number, number, number] {
  if (radius > 0 && Number.isFinite(px) && Number.isFinite(py)) {
    const dx = x - px; const dy = y - py; const distance = Math.hypot(dx, dy)
    if (distance < radius) { const force = (1 - distance / radius) * 2.6; vx += (distance ? dx / distance : 1) * force; vy += (distance ? dy / distance : 0) * force }
  }
  vx = (vx + (hx - x) * .05) * .84
  vy = (vy + (hy - y) * .05) * .84
  return [x + vx, y + vy, vx, vy]
}
export function hwfWarmth(x: number, y: number, hx: number, hy: number, span: number): number { return Math.min(1, Math.hypot(x - hx, y - hy) / span) }
export function hwfFitSize(measured: number, width: number): number { return width / measured * 100 }

const styles = `
.hwf-root{position:relative;isolation:isolate;overflow:hidden;min-width:0;color:var(--hwf-fg);background:var(--hwf-bg)}
.hwf-canvas{position:absolute;inset:0;width:100%;height:100%;z-index:0;pointer-events:none}
.hwf-grain{position:absolute;inset:0;z-index:1;pointer-events:none;mix-blend-mode:soft-light}
.hwf-content{position:relative;z-index:2;padding:clamp(22px,3.4vw,40px) clamp(20px,3.4vw,44px);pointer-events:none}
.hwf-grid{display:grid;grid-template-columns:1.25fr repeat(3,1fr);gap:28px}
.hwf-brand strong{display:block;font-family:var(--hwf-mono);font-size:10.5px;font-weight:400;letter-spacing:.18em;text-transform:uppercase;line-height:1.75}
.hwf-brand p{max-width:260px;margin:14px 0 0;font-family:var(--hwf-mono);font-size:11px;line-height:1.7;opacity:.58;white-space:pre-line}
.hwf-title,.hwf-link,.hwf-back{font-family:var(--hwf-mono);font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;line-height:1.75}
.hwf-title{margin:0;font-weight:400;opacity:.65}
.hwf-links{display:flex;flex-direction:column;align-items:flex-start;gap:0;margin:0;padding:0;list-style:none}
.hwf-link,.hwf-back{color:inherit;text-decoration:none;pointer-events:auto;text-underline-offset:5px;text-decoration-thickness:1px}
.hwf-link:hover,.hwf-link:focus-visible,.hwf-back:hover,.hwf-back:focus-visible{text-decoration:underline;color:var(--hwf-warm)}
.hwf-link:focus-visible,.hwf-back:focus-visible{outline:1px solid currentColor;outline-offset:6px}
.hwf-bottom{display:flex;justify-content:flex-end;border-top:1px solid color-mix(in srgb,var(--hwf-fg) 19%,transparent);margin-top:30px;padding-top:15px}
.hwf-back{display:inline-flex;align-items:center;gap:15px}
.hwf-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:720px){.hwf-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:28px 20px}.hwf-brand{grid-column:1/-1}.hwf-bottom{margin-top:25px}.hwf-brand p{max-width:360px}.hwf-title{margin-bottom:0}}
@media(prefers-reduced-motion:reduce){.hwf-root{scroll-behavior:auto}}
`

export default function HalftoneWordmarkFooter({
  wordmark = 'principia', label = 'Principia', meta = '', columns = [], backToTop = true,
  preset = 'night', palette, dotGap = 6, radius = 80, crop = .2, grain = .5, interactive = true,
  fontFamily = 'Arial, Helvetica, sans-serif', fontWeight = 800,
  monoFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace', height = '560px', className = '',
}: HalftoneWordmarkFooterProps) {
  const rootRef = useRef<HTMLElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const grainRef = useRef<HTMLDivElement>(null)
  const colors = { ...HWF_PRESETS[preset], ...palette }

  useEffect(() => {
    const root = rootRef.current; const canvas = canvasRef.current
    if (!root || !canvas) return
    const ctx = canvas.getContext('2d'); if (!ctx) return
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let reduced = motion.matches; let visible = true; let disposed = false; let frame = 0
    let width = 0; let canvasHeight = 0; let dots: HalftoneDot[] = []
    let pointer: { x: number; y: number } | null = null
    let rings: { x: number; y: number; born: number }[] = []
    const ink = hwfHex(colors.ink) ?? [233, 228, 218]; const warm = hwfHex(colors.warm) ?? [233, 118, 43]
    const gap = Math.max(3, Number.isFinite(dotGap) ? dotGap : 6)
    const influence = Math.max(0, Number.isFinite(radius) ? radius : 80)
    const draw = () => {
      ctx.clearRect(0, 0, width, canvasHeight)
      for (const dot of dots) {
        const warmth = reduced ? 0 : hwfWarmth(dot.x, dot.y, dot.hx, dot.hy, 28)
        const rgb = ink.map((channel, index) => Math.round(channel + (warm[index] - channel) * warmth))
        ctx.fillStyle = `rgb(${rgb.join(',')})`
        ctx.beginPath(); ctx.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2); ctx.fill()
      }
    }
    const stop = () => { if (frame) cancelAnimationFrame(frame); frame = 0 }
    const tick = (now: number) => {
      frame = 0
      if (disposed || !visible || reduced) return
      rings = rings.filter(ring => now - ring.born < 900)
      let moving = rings.length > 0
      for (const dot of dots) {
        for (const ring of rings) {
          const age = now - ring.born; const dx = dot.x - ring.x; const dy = dot.y - ring.y
          const distance = Math.hypot(dx, dy); const band = Math.max(0, 1 - Math.abs(distance - age * .9) / 26)
          if (band && distance) { const strength = band * 3.2 * (1 - age / 900); dot.vx += dx / distance * strength; dot.vy += dy / distance * strength }
        }
        const previousVx = dot.vx; const previousVy = dot.vy
        const [x, y, vx, vy] = hwfStep(dot.x, dot.y, dot.vx, dot.vy, dot.hx, dot.hy, interactive && pointer ? pointer.x : Number.NaN, interactive && pointer ? pointer.y : Number.NaN, influence)
        Object.assign(dot, { x, y, vx, vy })
        if (Math.abs(dot.vx) + Math.abs(dot.vy) + Math.abs(dot.vx - previousVx) + Math.abs(dot.vy - previousVy) > .025) moving = true
        else if (!pointer && !rings.length) { dot.x = dot.hx; dot.y = dot.hy; dot.vx = 0; dot.vy = 0 }
      }
      draw()
      if (moving) frame = requestAnimationFrame(tick)
    }
    const wake = () => { if (!disposed && visible && !reduced && !frame) frame = requestAnimationFrame(tick) }
    const layout = () => {
      if (disposed) return
      const rect = root.getBoundingClientRect(); width = rect.width; canvasHeight = rect.height
      if (!width || !canvasHeight) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(canvasHeight * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const mask = document.createElement('canvas'); mask.width = Math.ceil(width); mask.height = Math.ceil(canvasHeight)
      const maskCtx = mask.getContext('2d', { willReadFrequently: true }); if (!maskCtx) return
      maskCtx.font = `${fontWeight} 100px ${fontFamily}`
      const fontSize = hwfFitSize(maskCtx.measureText(wordmark).width, width * 1.02)
      if (!Number.isFinite(fontSize) || fontSize <= 0) { dots = []; draw(); return }
      maskCtx.font = `${fontWeight} ${fontSize}px ${fontFamily}`
      maskCtx.textBaseline = 'alphabetic'; maskCtx.textAlign = 'center'; maskCtx.fillStyle = '#fff'
      const cap = maskCtx.measureText('H').actualBoundingBoxAscent || fontSize * .74
      maskCtx.fillText(wordmark, width / 2, canvasHeight + cap * clamp(crop, 0, .8))
      const image = maskCtx.getImageData(0, 0, mask.width, mask.height)
      const next: HalftoneDot[] = []
      for (let y = gap / 2; y < canvasHeight; y += gap) for (let x = gap / 2; x < width; x += gap) {
        let coverage = 0
        for (let sy = -1; sy <= 1; sy++) for (let sx = -1; sx <= 1; sx++) {
          const px = Math.round(x + sx * gap / 3); const py = Math.round(y + sy * gap / 3)
          if (px >= 0 && px < mask.width && py >= 0 && py < mask.height) coverage += image.data[(py * mask.width + px) * 4 + 3] / 255
        }
        coverage /= 9
        if (coverage > .06) next.push({ x, y, hx: x, hy: y, vx: 0, vy: 0, r: hwfRadius(coverage, gap) })
      }
      dots = next; rings = []; draw(); wake()
    }
    const position = (event: PointerEvent) => { const rect = root.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top } }
    const move = (event: PointerEvent) => { if (!interactive || reduced || event.pointerType === 'touch') return; pointer = position(event); wake() }
    const leave = () => { pointer = null; wake() }
    const click = (event: PointerEvent) => { if (!interactive || reduced || (event.target as HTMLElement).closest('a,button')) return; rings.push({ ...position(event), born: performance.now() }); wake() }
    const motionChanged = () => { reduced = motion.matches; pointer = null; rings = []; if (reduced) { stop(); for (const dot of dots) { dot.x = dot.hx; dot.y = dot.hy; dot.vx = 0; dot.vy = 0 }; draw() } else wake() }
    const observer = new ResizeObserver(layout); observer.observe(root)
    const intersection = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? true; if (visible) { draw(); wake() } else stop() }); intersection.observe(root)
    root.addEventListener('pointermove', move); root.addEventListener('pointerleave', leave); root.addEventListener('pointerdown', click)
    motion.addEventListener('change', motionChanged)
    layout()
    void document.fonts?.ready.then(() => { if (!disposed) layout() })
    return () => { disposed = true; stop(); observer.disconnect(); intersection.disconnect(); root.removeEventListener('pointermove', move); root.removeEventListener('pointerleave', leave); root.removeEventListener('pointerdown', click); motion.removeEventListener('change', motionChanged) }
  }, [wordmark, colors.ink, colors.warm, dotGap, radius, crop, interactive, fontFamily, fontWeight])

  useEffect(() => {
    const overlay = grainRef.current; if (!overlay || grain <= 0) return
    const tile = document.createElement('canvas'); tile.width = 256; tile.height = 256
    const ctx = tile.getContext('2d'); if (!ctx) return
    const image = ctx.createImageData(256, 256)
    for (let index = 0; index < image.data.length; index += 4) { const value = Math.floor(Math.random() * 256); image.data[index] = value; image.data[index + 1] = value; image.data[index + 2] = value; image.data[index + 3] = 255 }
    ctx.putImageData(image, 0, 0); overlay.style.backgroundImage = `url(${tile.toDataURL()})`
  }, [grain])

  const css = { '--hwf-bg': colors.background, '--hwf-fg': colors.ink, '--hwf-warm': colors.warm, '--hwf-font': fontFamily, '--hwf-mono': monoFamily, height } as CSSProperties
  return <footer ref={rootRef} className={`hwf-root ${className}`} style={css} aria-label={`${label} footer`}>
    <style>{styles}</style>
    <span className="hwf-sr">{wordmark}</span>
    <canvas ref={canvasRef} className="hwf-canvas" aria-hidden="true" />
    <div ref={grainRef} className="hwf-grain" aria-hidden="true" style={{ opacity: clamp(grain) * .09, backgroundSize: '256px 256px' }} />
    <div className="hwf-content">
      <div className="hwf-grid">
        <div className="hwf-brand"><strong>{label}</strong>{meta && <p>{meta}</p>}</div>
        {columns.map((column, index) => <nav key={`${column.title}-${index}`} aria-label={column.title}><h2 className="hwf-title">{column.title}</h2><ul className="hwf-links">{column.links.map(link => <li key={`${link.label}-${link.href}`}><a className="hwf-link" href={link.href ?? '#'}>{link.label}</a></li>)}</ul></nav>)}
      </div>
      {backToTop && <div className="hwf-bottom"><a className="hwf-back" href="#top" onClick={event => { event.preventDefault(); window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }) }}>Back to top<span aria-hidden="true">↑</span></a></div>}
    </div>
  </footer>
}
