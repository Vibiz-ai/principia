/**
 * How a company logo sits in the round coin (VOICE.md §5.6 line art on dark). Measured once per image on a 32 px
 * canvas:
 * - `fill`: the image paints its own ground (mostly opaque) — it fills the inner disc, cropped round;
 * - `plain`: transparent and light enough to read on the dark rail — drawn as it is, inset;
 * - `backed`: transparent and dark (a black wordmark on nothing) — inset on a light disc so it stays legible.
 */
import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import type { Id } from '@shared/types'

export type LogoFit = 'fill' | 'plain' | 'backed'

/** RGBA pixels -> fit. Pure (tested); `rgba` is the canvas ImageData. */
export function logoFit(rgba: ArrayLike<number>): LogoFit {
  let opaque = 0
  let visible = 0
  let lum = 0
  const n = Math.floor(rgba.length / 4)
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3]! / 255
    if (a > 0.9) opaque++
    if (a < 0.12) continue
    visible++
    const [r, g, b] = [rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!].map((v) => v / 255) as [number, number, number]
    lum += (0.2126 * r + 0.7152 * g + 0.0722 * b) * a
  }
  if (!n || !visible) return 'backed'
  if (opaque / n > 0.86) return 'fill'
  return lum / visible < 0.42 ? 'backed' : 'plain'
}

const cache = new Map<string, LogoFit>()
const pending = new Map<string, Promise<LogoFit>>()
function measure(url: string): Promise<LogoFit> {
  const hit = cache.get(url)
  if (hit) return Promise.resolve(hit)
  let p = pending.get(url)
  if (p) return p
  p = new Promise<LogoFit>((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const c = document.createElement('canvas')
        c.width = c.height = 32
        const ctx = c.getContext('2d', { willReadFrequently: true })
        if (!ctx) return resolve('backed')
        // contain, like the coin draws it, so a wide wordmark's empty margins count as transparent
        const w = img.naturalWidth || 32
        const h = img.naturalHeight || 32
        const k = 32 / Math.max(w, h)
        ctx.drawImage(img, (32 - w * k) / 2, (32 - h * k) / 2, w * k, h * k)
        resolve(logoFit(ctx.getImageData(0, 0, 32, 32).data))
      } catch {
        resolve('backed')
      }
    }
    img.onerror = () => resolve('backed')
    img.src = url
  }).then((fit) => {
    cache.set(url, fit)
    pending.delete(url)
    return fit
  })
  pending.set(url, p)
  return p
}

/** The fit of a logo data URL (null while measuring, or for no logo). */
export function useLogoFit(url: string | null | undefined): LogoFit | null {
  const [fit, setFit] = useState<LogoFit | null>(() => (url ? (cache.get(url) ?? null) : null))
  useEffect(() => {
    if (!url) return setFit(null)
    let live = true
    const hit = cache.get(url)
    if (hit) setFit(hit)
    else void measure(url).then((f) => live && setFit(f))
    return () => {
      live = false
    }
  }, [url])
  return fit
}

/** A company's logo data URL from the store (null = the initial). */
export function useCompanyLogoUrl(companyId: Id | null | undefined): string | null {
  return useStore((s) => (companyId ? (s.companyLogos[companyId]?.dataUrl ?? null) : null))
}
