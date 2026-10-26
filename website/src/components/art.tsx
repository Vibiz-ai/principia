import React from 'react'

/** A Roman engraving served at 800, 1600 and 2400 px so phones fetch small files and 2x screens stay sharp. */
export const artSrc = (name: string, w = 1600) => `/art/${name}-${w}.webp`
export const artSet = (name: string) => [800, 1600, 2400].map(w => `${artSrc(name, w)} ${w}w`).join(', ')

type Props = { name: string; alt: string; sizes?: string; className?: string; priority?: boolean }
export function Art({ name, alt, sizes = '(max-width: 640px) 100vw, 1120px', className, priority }: Props) {
  return <img className={className} src={artSrc(name)} srcSet={artSet(name)} sizes={sizes} alt={alt} width={1600} height={893}
    loading={priority ? 'eager' : 'lazy'} fetchPriority={priority ? 'high' : undefined} decoding="async"/>
}

/** Warm the browser cache for images that only appear on a click, once the page has settled. */
export function usePrefetchArt(names: string[], sizes = '(max-width: 640px) 100vw, 640px') {
  React.useEffect(() => {
    const run = () => names.forEach(n => { const i = new Image(); i.sizes = sizes; i.srcset = artSet(n); i.src = artSrc(n) })
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number }
    const t = w.requestIdleCallback ? w.requestIdleCallback(run) : window.setTimeout(run, 1500)
    return () => { if (!w.requestIdleCallback) window.clearTimeout(t) }
  }, [])
}
