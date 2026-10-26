/**
 * A principia:// link in text an agent wrote (chat, desk, Board report and activity, Needs you, Forum, Knowledge): a
 * white line-art button in plain words ("Connect Instagram"). A link we would not open (unknown, or for a company this
 * Principia does not have) stays plain text, so it never looks like a working button.
 */
import { parseDeepLink } from '@shared/deepLink'
import { deepLinkLabel } from '../lib/deepLinkNav'
import { followLink } from '../lib/inAppLink'
import { useStore } from '../state/store'

/** Whether a principia:// link opens something here (known link; its company, when it names one, is in this Principia). */
export function useLinkOpens(href: string): boolean {
  const companies = useStore((s) => s.companies)
  const l = parseDeepLink(href)
  if (!l) return false
  return !l.companyId || !companies.length || companies.some((c) => c.id === l.companyId)
}

/** The click of an in-app link: the window's capture listener may already have opened it (one open per click). */
export function onLinkClick(href: string) {
  return (e: React.MouseEvent): void => {
    const handled = e.nativeEvent.defaultPrevented
    e.preventDefault()
    e.stopPropagation()
    if (!handled) followLink(href)
  }
}

export function DeepLinkButton({ href, children }: { href: string; children?: React.ReactNode }): React.JSX.Element {
  const words = deepLinkLabel(href)
  const opens = useLinkOpens(href)
  if (!words || !opens) return <span>{href}</span>
  return (
    <a className="dl-link" href={href} role="button" title={href} onClick={onLinkClick(href)}>
      {children ?? words}
      <span className="dl-link__arrow" aria-hidden>
        →
      </span>
    </a>
  )
}

const LINK_IN_TEXT = /principia:\/\/[^\s<>()[\]"'`]+/gi
const TRAIL = /[.,;:!?]+$/

/** Splits text into plain runs and principia:// links (trailing punctuation stays text). */
export function splitDeepLinks(text: string): { t: 'text' | 'link'; v: string }[] {
  const out: { t: 'text' | 'link'; v: string }[] = []
  let last = 0
  for (const m of text.matchAll(LINK_IN_TEXT)) {
    const raw = m[0]
    const url = raw.replace(TRAIL, '')
    const at = m.index ?? 0
    if (at > last) out.push({ t: 'text', v: text.slice(last, at) })
    out.push({ t: 'link', v: url })
    last = at + url.length
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) })
  return out
}

/** Plain words for every principia:// link in a one-line preview ("…connect Instagram: Connect Instagram"). */
export function plainLinks(text: string): string {
  return splitDeepLinks(text)
    .map((p) => (p.t === 'link' ? (deepLinkLabel(p.v) ?? p.v) : p.v))
    .join('')
}

/** Text with its principia:// links as buttons (newlines kept by the caller's white-space). */
export function TextWithLinks({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {splitDeepLinks(text).map((p, i) => (p.t === 'link' ? <DeepLinkButton key={i} href={p.v} /> : <span key={i}>{p.v}</span>))}
    </>
  )
}
