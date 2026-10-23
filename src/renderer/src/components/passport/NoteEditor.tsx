/**
 * Source mode (PASSPORT.md §10, ⌘E): a plain textarea over a tinted copy of the text (the TemplateTextArea overlay
 * technique), tinted by the shared grammar's `highlightNote`, so the editor colours exactly what the indexer reads.
 * `[[` opens title / alias / ghost suggestions and `#` opens tags. Saving (800 ms idle, blur) is the parent's job.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { VaultGhost, VaultTagCount } from '@shared/passport'
import { highlightNote, type HighlightKind } from '@shared/vault/parse'
import { applyCompletion, completionContext, linkCompletions, tagCompletions, type CompletionContext, type CompletionItem, type TreeNote } from '../../lib/passport'
import { WikilinkPopover } from './WikilinkPopover'

/** Later wins where tokens overlap (a link inside a heading is a link). */
const PRIORITY: HighlightKind[] = ['frontmatter', 'heading', 'history', 'category', 'rel', 'prov', 'block', 'tag', 'link', 'embed', 'code']

export function NoteEditor({
  text,
  onChange,
  onBlur,
  tree,
  ghosts,
  tags,
  reveal,
  readOnly
}: {
  text: string
  onChange: (text: string) => void
  onBlur: () => void
  tree: TreeNote[]
  ghosts: VaultGhost[]
  tags: VaultTagCount[]
  /** "Show in file": select this 0-based line and scroll to it (n bumps re-apply) */
  reveal?: { line: number; n: number } | null
  readOnly?: boolean
}): React.JSX.Element {
  const inner = useRef<HTMLDivElement>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  const back = useRef<HTMLDivElement>(null)
  const [ac, setAc] = useState<{ ctx: CompletionContext; sel: number } | null>(null)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const [revealAt, setRevealAt] = useState<number | null>(null)

  const items = useMemo<CompletionItem[]>(() => {
    if (!ac) return []
    return ac.ctx.kind === 'link' ? linkCompletions(ac.ctx.query, tree, ghosts) : tagCompletions(ac.ctx.query, tags)
  }, [ac?.ctx.kind, ac?.ctx.query, tree, ghosts, tags])

  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  // popover anchor: the marker span rendered at the query start in the tinted copy
  useLayoutEffect(() => {
    if (!ac) return setAt(null)
    const mark = back.current?.querySelector<HTMLElement>('[data-caret]')
    const box = inner.current
    if (!mark || !box) return
    const m = mark.getBoundingClientRect()
    const b = box.getBoundingClientRect()
    setAt({ left: Math.min(m.left - b.left, Math.max(0, b.width - 340)), top: m.bottom - b.top + 4 })
  }, [ac, text])

  // "Show in file"
  useEffect(() => {
    if (!reveal) return
    const el = ta.current
    if (!el) return
    const lines = text.split('\n')
    let off = 0
    for (let i = 0; i < reveal.line && i < lines.length; i++) off += lines[i]!.length + 1
    const end = off + (lines[reveal.line]?.length ?? 0)
    el.focus()
    el.setSelectionRange(off, end)
    setRevealAt(off)
  }, [reveal?.n])
  useLayoutEffect(() => {
    if (revealAt === null) return
    back.current?.querySelector<HTMLElement>('[data-caret]')?.scrollIntoView({ block: 'center' })
    setRevealAt(null)
  }, [revealAt])

  const refresh = (value: string, caret: number): void => {
    const ctx = completionContext(value, caret)
    setAc(ctx ? { ctx, sel: 0 } : null)
  }

  const pick = (item: CompletionItem): void => {
    const el = ta.current
    if (!el || !ac) return
    const r = applyCompletion(text, el.selectionStart, ac.ctx, item)
    onChange(r.text)
    setAc(null)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(r.caret, r.caret)
    })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (ac && items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const d = e.key === 'ArrowDown' ? 1 : -1
        setAc({ ...ac, sel: (ac.sel + d + items.length) % items.length })
        return
      }
      if ((e.key === 'Enter' && !e.metaKey && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault()
        pick(items[Math.min(ac.sel, items.length - 1)]!)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setAc(null)
        return
      }
    }
    // typing `[[` auto-closes, like Obsidian
    if (e.key === '[' && !e.metaKey && !e.altKey) {
      const el = e.currentTarget
      const s = el.selectionStart
      if (s === el.selectionEnd && text[s - 1] === '[' && text.slice(s, s + 2) !== ']]') {
        e.preventDefault()
        const next = `${text.slice(0, s)}[]]${text.slice(s)}`
        onChange(next)
        requestAnimationFrame(() => {
          el.setSelectionRange(s + 1, s + 1)
          refresh(next, s + 1)
        })
      }
    }
  }

  const caretMark = ac ? ac.ctx.start : revealAt
  return (
    <div className="pedit">
      <div className="pedit__inner" ref={inner}>
        <div className="pedit__back mono" ref={back} aria-hidden>
          {tint(text, caretMark)}
          {'​'}
        </div>
        <textarea
          ref={ta}
          className="pedit__input mono"
          value={text}
          readOnly={readOnly}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Note source"
          onChange={(e) => {
            onChange(e.target.value)
            refresh(e.target.value, e.target.selectionStart)
          }}
          onKeyDown={onKeyDown}
          onClick={(e) => refresh(text, e.currentTarget.selectionStart)}
          onBlur={() => {
            setTimeout(() => setAc(null), 120)
            onBlur()
          }}
        />
        {ac && at && <WikilinkPopover items={items} selected={Math.min(ac.sel, items.length - 1)} at={at} onPick={pick} onHover={(i) => setAc({ ...ac, sel: i })} />}
      </div>
    </div>
  )
}

/** The tinted copy: one run per highlight kind; an empty marker span at `caret` anchors the popover. */
function tint(text: string, caret: number | null): React.ReactNode[] {
  const tokens = highlightNote(text)
  const lines = text.split('\n')
  const kinds: (HighlightKind | null)[][] = lines.map((l) => new Array<HighlightKind | null>(l.replace(/\r$/, '').length).fill(null))
  const sorted = [...tokens].sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind))
  for (const t of sorted) {
    const row = kinds[t.line]
    if (!row) continue
    for (let i = t.start; i < t.end && i < row.length; i++) row[i] = t.kind
  }
  const out: React.ReactNode[] = []
  let offset = 0
  lines.forEach((line, li) => {
    const row = kinds[li]!
    let i = 0
    while (i <= line.length) {
      if (caret !== null && offset + i === caret) out.push(<span key={`c${li}`} data-caret />)
      if (i === line.length) break
      const k = row[i] ?? null
      let j = i + 1
      while (j < line.length && (row[j] ?? null) === k && !(caret !== null && offset + j === caret)) j++
      const s = line.slice(i, j)
      out.push(k ? <span key={`${li}:${i}`} className={`ptok ptok--${k}`}>{s}</span> : s)
      i = j
    }
    if (li < lines.length - 1) out.push('\n')
    offset += line.length + 1
  })
  return out
}
