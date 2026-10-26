import React from 'react'

/**
 * Roman engravings served at 800, 1600 and 2400 px so phones fetch small files and 2x screens stay sharp.
 * `line` is the white line-art set (1600x893); `tonal` is the fully shaded silver-on-black plate set (16:9).
 */
export type ArtSet = 'line' | 'tonal'
const dir = (set: ArtSet) => (set === 'tonal' ? '/art/tonal' : '/art')
const dims = { line: [1600, 893], tonal: [1600, 900] } as const
export const artSrc = (name: string, w = 1600, set: ArtSet = 'line') => `${dir(set)}/${name}-${w}.webp`
export const artSet = (name: string, set: ArtSet = 'line') => [800, 1600, 2400].map(w => `${artSrc(name, w, set)} ${w}w`).join(', ')

type Props = { name: string; alt: string; sizes?: string; className?: string; priority?: boolean; set?: ArtSet; style?: React.CSSProperties }
export function Art({ name, alt, sizes = '(max-width: 640px) 100vw, 1120px', className, priority, set = 'line', style }: Props) {
  const [w, h] = dims[set]
  return <img className={className} style={style} src={artSrc(name, 1600, set)} srcSet={artSet(name, set)} sizes={sizes} alt={alt} width={w} height={h}
    loading={priority ? 'eager' : 'lazy'} fetchPriority={priority ? 'high' : undefined} decoding="async"/>
}

/** Warm the browser cache for images that only appear on a click, once the page has settled. */
export function usePrefetchArt(names: string[], sizes = '(max-width: 640px) 100vw, 640px', set: ArtSet = 'line') {
  React.useEffect(() => {
    const run = () => names.forEach(n => { const i = new Image(); i.sizes = sizes; i.srcset = artSet(n, set); i.src = artSrc(n, 1600, set) })
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number }
    const t = w.requestIdleCallback ? w.requestIdleCallback(run) : window.setTimeout(run, 1500)
    return () => { if (!w.requestIdleCallback) window.clearTimeout(t) }
  }, [])
}
