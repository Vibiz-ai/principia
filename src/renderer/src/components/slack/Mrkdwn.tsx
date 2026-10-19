/**
 * Safe mrkdwn rendering (SLACK.md §12.2): lib/slack parses into a token tree and this maps it to React nodes.
 * Never dangerouslySetInnerHTML; every string is a text node. Links open via app:openExternal (https only).
 */
import type { ReactNode } from 'react'
import { parseMrkdwn, type MBlock, type MInline } from '../../lib/slack'

export interface MrkdwnResolve {
  user?: (id: string) => string | null
  channel?: (id: string) => string | null
  onUser?: (id: string) => void
  onChannel?: (id: string) => void
  onLink?: (url: string) => void
}

function inline(nodes: MInline[], r: MrkdwnResolve, key = ''): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`
    switch (n.t) {
      case 'text':
        return n.v
      case 'br':
        return <br key={k} />
      case 'b':
        return <strong key={k}>{inline(n.c, r, `${k}.`)}</strong>
      case 'i':
        return <em key={k}>{inline(n.c, r, `${k}.`)}</em>
      case 's':
        return <s key={k}>{inline(n.c, r, `${k}.`)}</s>
      case 'code':
        return (
          <code key={k} className="mk-code">
            {n.v}
          </code>
        )
      case 'link':
        return (
          <a
            key={k}
            className="mk-link"
            href={n.url}
            title={n.url}
            onClick={(e) => {
              e.preventDefault()
              r.onLink?.(n.url)
            }}
          >
            {n.label}
          </a>
        )
      case 'user': {
        const name = n.label ?? r.user?.(n.id) ?? n.id
        return (
          <span key={k} className="mk-mention" role={r.onUser ? 'button' : undefined} onClick={r.onUser ? () => r.onUser!(n.id) : undefined}>
            @{name}
          </span>
        )
      }
      case 'channel': {
        const name = n.label ?? r.channel?.(n.id) ?? n.id
        return (
          <span key={k} className="mk-channel" role={r.onChannel ? 'button' : undefined} onClick={r.onChannel ? () => r.onChannel!(n.id) : undefined}>
            #{name}
          </span>
        )
      }
      case 'broadcast':
        return (
          <span key={k} className="mk-mention mk-mention--broadcast">
            {n.v}
          </span>
        )
    }
  })
}

function block(b: MBlock, i: number, r: MrkdwnResolve): ReactNode {
  if (b.t === 'pre')
    return (
      <pre key={i} className="mk-pre selectable">
        {b.v}
      </pre>
    )
  if (b.t === 'quote')
    return (
      <blockquote key={i} className="mk-quote">
        {inline(b.c, r, `${i}.`)}
      </blockquote>
    )
  return (
    <div key={i} className="mk-p">
      {inline(b.c, r, `${i}.`)}
    </div>
  )
}

export function Mrkdwn({ text, resolve = {}, className }: { text: string; resolve?: MrkdwnResolve; className?: string }): React.JSX.Element {
  return <div className={`mk selectable ${className ?? ''}`}>{parseMrkdwn(text).map((b, i) => block(b, i, resolve))}</div>
}
