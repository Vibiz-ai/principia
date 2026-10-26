import React, { useEffect, useRef } from 'react'
import { Art } from './art'

const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Drift an element against the scroll: writes --plx (-1..1, how far the box is from the viewport centre)
 * so CSS can translate the image inside it. Does nothing when the visitor prefers reduced motion.
 */
export function useParallax<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || reduced()) return
    let frame = 0, visible = false
    const update = () => {
      frame = 0
      const r = el.getBoundingClientRect(), vh = window.innerHeight
      const p = (r.top + r.height / 2 - vh / 2) / (vh / 2 + r.height / 2)
      el.style.setProperty('--plx', Math.max(-1, Math.min(1, p)).toFixed(4))
    }
    const onScroll = () => { if (visible && !frame) frame = requestAnimationFrame(update) }
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) onScroll() }, { rootMargin: '120px 0px' })
    io.observe(el)
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => { io.disconnect(); window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); if (frame) cancelAnimationFrame(frame) }
  }, [])
  return ref
}

/** Reveal once: adds `.lit` the first time the element enters the viewport. */
function useLit<T extends HTMLElement>(ref: React.RefObject<T | null>) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (reduced()) { el.classList.add('lit'); return }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { el.classList.add('lit'); io.disconnect() } }, { threshold: .12 })
    io.observe(el)
    return () => io.disconnect()
  }, [ref])
}

type Motto = { latin: string; english: string }
type PlateProps = {
  name: string; alt: string; motto?: Motto; className?: string
  /** CSS object-position, so cropped phone views keep the subject. */
  focus?: string
  /** Put the motto over the top of the plate (for plates partly covered by a panel). */
  mottoOnTop?: boolean
}

/** A tonal engraving that bleeds past the column, fades into the page and drifts slowly as you scroll. */
export function Plate({ name, alt, motto, className = '', focus = '50% 50%', mottoOnTop }: PlateProps) {
  const ref = useParallax<HTMLElement>()
  useLit(ref)
  const caption = motto && <figcaption className={`motto ${mottoOnTop ? 'motto-top' : ''}`}>
    <span className="motto-latin rule" lang="la">{motto.latin}</span>
    <span className="motto-english">{motto.english}</span>
  </figcaption>
  return <figure ref={ref} className={`tonal-plate ${className}`}>
    <div className="tonal-frame">
      <Art set="tonal" name={name} alt={alt} sizes="(max-width: 640px) 150vw, min(1320px, 100vw)" style={{ objectPosition: focus }}/>
    </div>
    {caption}
  </figure>
}
