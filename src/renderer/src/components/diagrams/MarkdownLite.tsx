/**
 * A node's `detail` rendered through the in-house lib/markdown.ts (it never injects HTML: raw tags are text, React
 * escapes every string). No vault actions here: wikilinks and tags show as plain chips, links open in the browser.
 */
import { renderMarkdown, type Block, type Inline } from '../../lib/markdown'
import { isDeepLinkUrl } from '@shared/deepLink'
import { DeepLinkButton } from '../DeepLinkButton'
import { followLink } from '../../lib/inAppLink'

export function MarkdownLite({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="dgm-md selectable">
      {renderMarkdown(text).map((b, i) => (
        <BlockLite key={i} b={b} />
      ))}
    </div>
  )
}

function BlockLite({ b }: { b: Block }): React.JSX.Element {
  switch (b.t) {
    case 'heading':
      return (
        <div className={`dgm-md__h dgm-md__h${Math.min(b.level, 3)}`}>
          <Inlines c={b.c} />
        </div>
      )
    case 'para':
      return (
        <p>
          <Inlines c={b.c} />
        </p>
      )
    case 'code':
      return (
        <pre className="mono">
          <code>{b.text}</code>
        </pre>
      )
    case 'hr':
      return <hr />
    case 'quote':
      return (
        <blockquote>
          {b.c.map((x, i) => (
            <BlockLite key={i} b={x} />
          ))}
        </blockquote>
      )
    case 'list':
    case 'history': {
      const L = b.t === 'list' && b.items[0]?.ordered ? 'ol' : 'ul'
      // "1. … #tags 2. …": each item is its own list; it keeps its number instead of restarting at 1
      const start = L === 'ol' && b.items[0]?.num && b.items[0].num > 1 ? b.items[0].num : undefined
      return (
        <L start={start}>
          {b.items.map((it) => (
            <li key={it.line} style={it.depth ? { marginLeft: it.depth * 12 } : undefined}>
              {it.task !== null && <span className="dgm-md__check">{it.task ? '☑' : '☐'} </span>}
              <Inlines c={it.c} />
            </li>
          ))}
        </L>
      )
    }
    case 'table':
      return (
        <table>
          <thead>
            <tr>
              {b.head.map((c, i) => (
                <th key={i}>
                  <Inlines c={c} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {b.rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, i) => (
                  <td key={i}>
                    <Inlines c={c} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )
  }
}

/** A principia:// link an agent handed out: plain words when the agent wrote the bare URL, else its own label. */
function InAppLink({ href, c }: { href: string; c: Inline[] }): React.JSX.Element {
  const bare = c.length === 1 && c[0]!.t === 'text' && c[0]!.v === href
  return <DeepLinkButton href={href}>{bare ? undefined : <Inlines c={c} />}</DeepLinkButton>
}

function Inlines({ c }: { c: Inline[] }): React.JSX.Element {
  return (
    <>
      {c.map((n, i) => {
        switch (n.t) {
          case 'text':
            return <span key={i}>{n.v}</span>
          case 'br':
            return <br key={i} />
          case 'strong':
            return (
              <strong key={i}>
                <Inlines c={n.c} />
              </strong>
            )
          case 'em':
            return (
              <em key={i}>
                <Inlines c={n.c} />
              </em>
            )
          case 'del':
            return (
              <del key={i}>
                <Inlines c={n.c} />
              </del>
            )
          case 'code':
            return <code key={i}>{n.v}</code>
          case 'tag':
            return (
              <span key={i} className="dgm-md__chip">
                #{n.tag}
              </span>
            )
          case 'wikilink':
            return (
              <span key={i} className="dgm-md__chip">
                {n.label}
              </span>
            )
          case 'url':
            if (isDeepLinkUrl(n.href)) return <InAppLink key={i} href={n.href} c={n.c} />
            // a bare web address reads as a source chip with its site ("github.com"), the full address on hover
            if (n.c.length === 1 && n.c[0]!.t === 'text' && n.c[0]!.v === n.href && /^https?:\/\//.test(n.href))
              return (
                <a
                  key={i}
                  className="dgm-md__src"
                  href={n.href}
                  title={n.href}
                  onClick={(e) => {
                    e.preventDefault()
                    followLink(n.href)
                  }}
                >
                  {siteOf(n.href)}
                </a>
              )
            return (
              <a
                key={i}
                href={n.href}
                onClick={(e) => {
                  e.preventDefault()
                  followLink(n.href)
                }}
              >
                <Inlines c={n.c} />
              </a>
            )
        }
      })}
    </>
  )
}

/** "github.com" from "https://www.github.com/x/y" (the address itself when it does not parse). */
export function siteOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, '') || href
  } catch {
    return href
  }
}
