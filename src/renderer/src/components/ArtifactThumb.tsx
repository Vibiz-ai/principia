/**
 * Artifact thumbnail. Images/video/pdf: Quick Look bitmap from main (artifacts:thumbnail).
 * Text-like kinds (markdown, html, code): the app's own dark text tile with the first lines, because the
 * Quick Look bitmap of a text page is a near-blank white square at tile size. Renderer never loads files itself.
 */
import { useEffect, useRef, useState } from 'react'
import type { Artifact } from '@shared/types'
import { hive } from '../lib/hive'

const cache = new Map<string, string>()
const inflight = new Map<string, Promise<string | null>>()
const textCache = new Map<string, string>()
const textInflight = new Map<string, Promise<string | null>>()
const KIND_LABEL: Record<string, string> = { image: 'IMG', video: '▶', audio: '♪', html: '<html>', markdown: '# md', pdf: 'PDF', code: '{ }', other: 'FILE' }
const TEXT_KINDS = new Set(['markdown', 'html', 'code'])

export function isTextKind(a: Pick<Artifact, 'kind'>): boolean {
  return TEXT_KINDS.has(a.kind)
}

function once<T>(map: Map<string, Promise<T | null>>, done: Map<string, T>, key: string, load: () => Promise<T>): Promise<T | null> {
  const hit = done.get(key)
  if (hit !== undefined) return Promise.resolve(hit)
  let p = map.get(key)
  if (!p) {
    p = load().then(
      (v) => {
        done.set(key, v)
        map.delete(key)
        return v
      },
      () => {
        map.delete(key)
        return null
      }
    )
    map.set(key, p)
  }
  return p
}

const fetchThumb = (id: string, size: number): Promise<string | null> =>
  once(inflight, cache, `${id}:${size}`, () => hive.artifacts.thumbnail({ id, size }).then((r) => r.dataUrl))
const fetchText = (id: string): Promise<string | null> => once(textInflight, textCache, id, () => hive.artifacts.peek({ id, bytes: 2048 }).then((r) => r.text))

/** Readable preview lines: html → visible text (title/headings first), markdown/code → leading lines. */
export function previewLines(kind: string, text: string, max = 8): { heading: string | null; lines: string[] } {
  if (kind === 'html') {
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1]?.trim() || /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(text)?.[1]?.replace(/<[^>]+>/g, '').trim() || null
    const body = text
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|h\d|li|tr|section|header)>/gi, '\n')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
    const lines = body
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter((l) => l && l !== title)
    return { heading: title, lines: lines.slice(0, max) }
  }
  const all = text.replace(/\r/g, '').split('\n')
  if (kind === 'markdown') {
    const hi = all.findIndex((l) => /^#{1,6}\s/.test(l))
    const heading = hi >= 0 ? all[hi]!.replace(/^#+\s*/, '').trim() : null
    const rest = all.filter((_, i) => i !== hi).map((l) => l.trimEnd())
    while (rest.length && !rest[0]!.trim()) rest.shift()
    return { heading, lines: rest.slice(0, max) }
  }
  const lines = all.map((l) => l.replace(/\t/g, '  ').trimEnd())
  while (lines.length && !lines[0]!.trim()) lines.shift()
  return { heading: null, lines: lines.slice(0, max) }
}

function ext(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase().slice(0, 5) : KIND_LABEL.other!
}

function useVisible(ref: React.RefObject<HTMLDivElement | null>, skip: boolean, onVisible: () => () => void): void {
  useEffect(() => {
    if (skip) return
    const el = ref.current
    if (!el) return
    let cleanup: (() => void) | null = null
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      io.disconnect()
      cleanup = onVisible()
    })
    io.observe(el)
    return () => {
      io.disconnect()
      cleanup?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skip])
}

export function ArtifactThumb({ artifact, size = 320, className, compact }: { artifact: Artifact; size?: number; className?: string; compact?: boolean }): React.JSX.Element {
  return isTextKind(artifact) ? (
    <TextThumb artifact={artifact} className={className} compact={compact} />
  ) : (
    <BitmapThumb artifact={artifact} size={size} className={className} />
  )
}

function BitmapThumb({ artifact, size, className }: { artifact: Artifact; size: number; className?: string }): React.JSX.Element {
  const key = `${artifact.id}:${size}`
  const [url, setUrl] = useState<string | null>(cache.get(key) ?? null)
  const [failed, setFailed] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useVisible(ref, !!url, () => {
    let alive = true
    void fetchThumb(artifact.id, size).then((u) => {
      if (!alive) return
      if (u) setUrl(u)
      else setFailed(true)
    })
    return () => {
      alive = false
    }
  })
  return (
    <div ref={ref} className={`thumb thumb--${artifact.kind} ${className ?? ''}`}>
      {url ? <img src={url} alt="" draggable={false} /> : <span className="thumb__kind">{failed ? KIND_LABEL[artifact.kind] : ''}</span>}
    </div>
  )
}

function TextThumb({ artifact, className, compact }: { artifact: Artifact; className?: string; compact?: boolean }): React.JSX.Element {
  const [text, setText] = useState<string | null>(textCache.get(artifact.id) ?? null)
  const ref = useRef<HTMLDivElement>(null)
  useVisible(ref, text !== null, () => {
    let alive = true
    void fetchText(artifact.id).then((t) => alive && setText(t ?? ''))
    return () => {
      alive = false
    }
  })
  const { heading, lines } = text ? previewLines(artifact.kind, text, compact ? 3 : 9) : { heading: null, lines: [] }
  return (
    <div ref={ref} className={`thumb thumb--text thumb--${artifact.kind} ${compact ? 'thumb--compact' : ''} ${className ?? ''}`}>
      <span className="thumb__badge">{ext(artifact.name)}</span>
      <div className="thumb__text">
        <div className="thumb__heading">{heading || artifact.name}</div>
        {!compact && lines.map((l, i) => <div key={i} className="thumb__line">{l || ' '}</div>)}
      </div>
    </div>
  )
}

export function dropThumb(id: string): void {
  for (const k of [...cache.keys()]) if (k.startsWith(`${id}:`)) cache.delete(k)
  textCache.delete(id)
}
