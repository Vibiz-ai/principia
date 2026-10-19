/** Mono auto-growing textarea with `{{` autocomplete and tinted template tokens (overlay technique). */
import { useLayoutEffect, useRef, useState } from 'react'
import { insertTemplate, openTemplateAt } from '../lib/workflow'

export function TemplateTextArea({
  value,
  onChange,
  suggestions,
  placeholder,
  minRows = 3,
  singleLine = false
}: {
  value: string
  onChange: (v: string) => void
  suggestions: string[]
  placeholder?: string
  minRows?: number
  singleLine?: boolean
}): React.JSX.Element {
  const ta = useRef<HTMLTextAreaElement>(null)
  const back = useRef<HTMLDivElement>(null)
  const [ac, setAc] = useState<{ query: string; sel: number } | null>(null)
  const matches = ac ? suggestions.filter((s) => s.toLowerCase().includes(ac.query.toLowerCase())) : []

  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])

  const refreshAc = (text: string, caret: number): void => {
    const o = openTemplateAt(text, caret)
    setAc(o ? { query: o.query, sel: 0 } : null)
  }

  const pick = (token: string): void => {
    const el = ta.current
    if (!el) return
    const r = insertTemplate(value, el.selectionStart, token)
    onChange(r.text)
    setAc(null)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(r.caret, r.caret)
    })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (ac && matches.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const d = e.key === 'ArrowDown' ? 1 : -1
        setAc({ ...ac, sel: (ac.sel + d + matches.length) % matches.length })
        return
      }
      if ((e.key === 'Enter' && !e.metaKey) || e.key === 'Tab') {
        e.preventDefault()
        pick(matches[ac.sel]!)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setAc(null)
        return
      }
    }
    if (singleLine && e.key === 'Enter' && !e.metaKey) e.preventDefault()
  }

  return (
    <div className="tpl">
      <div className="tpl__back mono" ref={back} aria-hidden>
        {highlight(value)}
        {'​'}
      </div>
      <textarea
        ref={ta}
        className="tpl__input mono"
        rows={singleLine ? 1 : minRows}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => {
          const v = singleLine ? e.target.value.replace(/\n/g, ' ') : e.target.value
          onChange(v)
          refreshAc(v, e.target.selectionStart)
        }}
        onKeyDown={onKeyDown}
        onClick={(e) => refreshAc(value, e.currentTarget.selectionStart)}
        onBlur={() => setTimeout(() => setAc(null), 120)}
        onScroll={(e) => {
          if (back.current) back.current.scrollTop = e.currentTarget.scrollTop
        }}
      />
      {ac && matches.length > 0 && (
        <div className="tpl__ac">
          {matches.slice(0, 12).map((m, i) => (
            <div
              key={m}
              className={`tpl__ac-item mono ${i === ac.sel ? 'is-sel' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(m)
              }}
            >
              {m}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function highlight(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const re = /\{\{[^}]*\}\}/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(
      <mark key={m.index} className="tpl__tok">
        {m[0]}
      </mark>
    )
    last = m.index + m[0].length
  }
  out.push(text.slice(last))
  return out
}
