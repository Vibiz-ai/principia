/**
 * Streaming step log. `readable` (default): the normalized transcript (text / → tool / result) from
 * runs:stepLog, then live `run:output` chunks (same format). `raw`: the raw CLI log file (stream-JSON
 * for Claude), refreshed while output arrives. Secrets arrive redacted as ••••NAME.
 */
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Id } from '@shared/types'
import { errorMessage, hive, useHiveEvent } from '../lib/hive'
import { stripLogHeader } from '../lib/format'

/** Live view keeps the last 500 KB; the full log is on disk (Raw / Reveal). */
const MAX = 500_000
/** LogText renders this many lines per memoized block, so a new chunk re-renders only the last block. */
const BLOCK_LINES = 400

export function StepLog({ runId, stepId, live, view = 'readable' }: { runId: Id; stepId: Id; live: boolean; view?: 'readable' | 'raw' }): React.JSX.Element {
  const [text, setText] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const box = useRef<HTMLPreElement>(null)
  const stick = useRef(true)
  const pending = useRef<string[] | null>([])
  const refetch = useRef<ReturnType<typeof setTimeout> | null>(null)
  // live chunks are batched into one state update per frame (a busy step emits many chunks per frame)
  const queued = useRef('')
  const frame = useRef(0)

  useEffect(() => {
    let alive = true
    setText('')
    setLoaded(false)
    setError(null)
    pending.current = []
    hive.runs.stepLog({ runId, stepId, view }).then(
      (r) => {
        if (!alive) return
        // chunks that raced the snapshot are already inside it (same ordered IPC pipe)
        pending.current = null
        setText(view === 'readable' ? stripLogHeader(r.text) : r.text)
        setTruncated(r.truncated)
        setLoaded(true)
      },
      (e) => {
        if (!alive) return
        pending.current = null
        setError(errorMessage(e))
        setLoaded(true)
      }
    )
    return () => {
      alive = false
      if (refetch.current) clearTimeout(refetch.current)
      refetch.current = null
      cancelAnimationFrame(frame.current)
      frame.current = 0
      queued.current = ''
    }
  }, [runId, stepId, view])

  useHiveEvent('run:output', (p) => {
    if (p.runId !== runId || p.stepId !== stepId) return
    if (pending.current) return
    if (view === 'raw') {
      // live chunks are the readable form; for the raw view re-read the file (throttled)
      if (refetch.current) return
      refetch.current = setTimeout(() => {
        refetch.current = null
        hive.runs.stepLog({ runId, stepId, view: 'raw' }).then(
          (r) => {
            setText(r.text)
            setTruncated(r.truncated)
          },
          () => undefined
        )
      }, 1000)
      return
    }
    queued.current += p.chunk
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const chunk = queued.current
      queued.current = ''
      setText((t) => {
        const n = t ? t + chunk : stripLogHeader(chunk)
        if (n.length <= MAX) return n
        // keep whole lines: never start the view on a fragment
        const cut = n.slice(n.length - MAX)
        const nl = cut.indexOf('\n')
        return nl >= 0 ? cut.slice(nl + 1) : cut
      })
    })
  })

  useLayoutEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [text])

  return (
    <pre
      ref={box}
      className="log selectable"
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
    >
      {truncated && <div className="log__note">… earlier output truncated</div>}
      {error && <div className="log__note text-failed">{error}</div>}
      {loaded && !text && !error && <div className="log__note">{live ? 'Waiting for output…' : 'No output.'}</div>}
      <LogText text={text} />
    </pre>
  )
}

/** Highlights VERDICT lines and ••••NAME secret chips. Rendered in memoized blocks: appending re-renders the tail only. */
export function LogText({ text }: { text: string }): React.JSX.Element {
  const lines = text.split('\n')
  const blocks: string[] = []
  for (let i = 0; i < lines.length; i += BLOCK_LINES) blocks.push(lines.slice(i, i + BLOCK_LINES).join('\n') + (i + BLOCK_LINES < lines.length ? '\n' : ''))
  return (
    <>
      {blocks.map((b, i) => (
        <LogBlock key={i} text={b} />
      ))}
    </>
  )
}

const LogBlock = memo(function LogBlock({ text }: { text: string }): React.JSX.Element {
  const lines = text.split('\n')
  return (
    <>
      {lines.map((line, i) => {
        const v = /VERDICT:\s*(PASS|FAIL)/i.exec(line)
        const content = renderChips(line)
        return (
          <span key={i} className={v ? `log__verdict log__verdict--${v[1]!.toUpperCase() === 'PASS' ? 'pass' : 'fail'}` : undefined}>
            {content}
            {i < lines.length - 1 ? '\n' : ''}
          </span>
        )
      })}
    </>
  )
})

function renderChips(line: string): React.ReactNode {
  if (!line.includes('••••')) return line
  const parts = line.split(/(••••[A-Z_][A-Z0-9_]*)/g)
  return parts.map((p, i) => (p.startsWith('••••') ? <span key={i} className="secret-chip">{p}</span> : p))
}
