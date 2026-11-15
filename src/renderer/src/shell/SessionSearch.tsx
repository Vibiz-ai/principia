/**
 * Search inside your Claude sessions (⇧⌘F, and the Search field at the top of the sidebar): type words, see every
 * session where you or Claude said them, newest first, with the line around the match. Enter opens it: the live
 * Principia pane when one is running that session, else it resumes it here (`claude --resume`). ⌘K is still the
 * command palette; the last row opens it.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { SessionHit } from '@shared/authoring'
import { Icon } from '../components/Icon'
import { Kbd } from '../components/ui'
import { hive, errorMessage } from '../lib/hive'
import { age } from '../lib/time'
import { tildify } from '../lib/format'
import { resumeHistory } from '../state/history'
import { focusSession, getState, openPalette } from '../state/store'

export const SESSION_SEARCH_EVENT = 'principia:sessionSearch'
export const openSessionSearch = (): void => void window.dispatchEvent(new Event(SESSION_SEARCH_EVENT))

/** Bold every word of the query in the snippet. */
function Marked({ text, words }: { text: string; words: string[] }): ReactElement {
  if (!words.length) return <>{text}</>
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  return (
    <>
      {text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>))}
    </>
  )
}

export function openHit(h: SessionHit): void {
  const live = getState().sessions.find((s) => s.agentSessionId === h.id && s.status === 'running')
  if (live) focusSession(live.id)
  else void resumeHistory(h.id)
}

export function SessionSearch(): ReactElement | null {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SessionHit[]>([])
  const [state, setState] = useState<{ busy: boolean; scanned: number; truncated: boolean; error: string | null }>({ busy: false, scanned: 0, truncated: false, error: null })
  const [sel, setSel] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const seq = useRef(0)

  useEffect(() => {
    const show = (): void => setOpen(true)
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey && e.shiftKey && !e.altKey && e.code === 'KeyF') {
        e.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener(SESSION_SEARCH_EVENT, show)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener(SESSION_SEARCH_EVENT, show)
      window.removeEventListener('keydown', onKey)
    }
  }, [])
  useEffect(() => {
    if (open) setTimeout(() => input.current?.select(), 0)
  }, [open])

  // debounced: one search 220 ms after the last key, and only the newest answer is shown
  useEffect(() => {
    if (!open) return
    const query = q.trim()
    if (query.length < 2) {
      setHits([])
      setState({ busy: false, scanned: 0, truncated: false, error: null })
      return
    }
    const n = ++seq.current
    setState((s) => ({ ...s, busy: true, error: null }))
    const t = setTimeout(() => {
      hive.history.search({ query, limit: 40 }).then(
        (r) => {
          if (n !== seq.current) return
          setHits(r.hits)
          setSel(0)
          setState({ busy: false, scanned: r.scanned, truncated: r.truncated, error: null })
        },
        (e) => n === seq.current && setState({ busy: false, scanned: 0, truncated: false, error: errorMessage(e) })
      )
    }, 220)
    return () => clearTimeout(t)
  }, [q, open])

  if (!open) return null
  const close = (): void => setOpen(false)
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length >= 2)
  const choose = (h: SessionHit): void => {
    close()
    openHit(h)
  }
  const toPalette = (): void => {
    close()
    openPalette('all')
  }
  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') return close()
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((i) => Math.min(i + 1, hits.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (sel < hits.length) choose(hits[sel]!)
      else toPalette()
    }
  }

  return (
    <div className="palette-layer" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette sess-search" role="dialog" aria-label="Search your sessions">
        <div className="palette__input">
          <Icon name="search" size={16} />
          <input ref={input} value={q} placeholder="Search everything you and Claude said…" spellCheck={false} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} aria-label="Search your sessions" />
          {state.busy && <span className="sess-search__busy">Searching…</span>}
        </div>
        <div className="palette__list sess-search__list">
          {q.trim().length < 2 ? (
            <div className="palette__empty">Words from any Claude session: a file, an error, a decision, a name.</div>
          ) : state.error ? (
            <div className="palette__empty cl-error">{state.error}</div>
          ) : !hits.length && !state.busy ? (
            <div className="palette__empty">Nothing in your sessions says that.</div>
          ) : (
            hits.map((h, i) => (
              <button type="button" key={h.id} className={`sess-hit ${i === sel ? 'is-sel' : ''}`} onMouseMove={() => setSel(i)} onClick={() => choose(h)}>
                <span className="sess-hit__l1">
                  <span className="sess-hit__title">{h.title}</span>
                  <span className="sess-hit__meta">
                    {h.cwd ? `${tildify(h.cwd).split('/').pop()} · ` : ''}
                    {age(h.at)}
                  </span>
                </span>
                <span className="sess-hit__snip">
                  <span className="sess-hit__who">{h.role === 'you' ? 'You' : 'Claude'}</span>
                  <Marked text={h.snippet} words={words} />
                  {h.matches > 1 && <span className="sess-hit__more"> +{h.matches - 1}</span>}
                </span>
              </button>
            ))
          )}
        </div>
        <button type="button" className={`palette__ask ${sel === hits.length && q.trim() ? 'is-sel' : ''}`} onMouseMove={() => setSel(hits.length)} onClick={toPalette}>
          <Icon name="grid" size={14} />
          <span className="palette__label">Pages, agents and commands</span>
          <Kbd>⌘K</Kbd>
        </button>
        {state.truncated && <div className="sess-search__foot">Searched the newest {state.scanned} sessions.</div>}
      </div>
    </div>
  )
}
