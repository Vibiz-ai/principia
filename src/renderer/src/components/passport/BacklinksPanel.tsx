/**
 * Backlinks, unlinked mentions and outgoing links (PASSPORT.md §10 right column). Linked mentions are grouped by the
 * relation's inverse label ("decided_by Ana"), with the linking line as context. An unlinked mention's "Link" is a
 * direct user op (`linkMention`): the human is acting, so nothing goes through the Inbox.
 */
import { useEffect, useState } from 'react'
import type { BacklinkGroup, UnlinkedMention, VaultLink, VaultOp } from '@shared/passport'
import { Icon } from '../Icon'
import { errorMessage, hive } from '../../lib/hive'
import { inlineText, parseInline } from '../../lib/markdown'

/** A linking line as plain text: no bullet, block id or brackets (`[[Acme]]` reads as Acme). */
const plain = (line: string): string => inlineText(parseInline(line.replace(/^\s*[-*+]\s+/, '').replace(/\s\^[A-Za-z0-9-]+\s*$/, '')))

export function BacklinksPanel({
  companyId,
  noteId,
  title,
  outgoing,
  reloadKey,
  readOnly,
  onOpen,
  onOpenLine,
  onCreate,
  onOps
}: {
  companyId: string
  noteId: string
  title: string
  outgoing: VaultLink[]
  reloadKey: number
  readOnly?: boolean
  onOpen: (noteId: string) => void
  /** open a linking note at the line */
  onOpenLine: (noteId: string, line: number) => void
  onCreate: (title: string) => void
  onOps: (ops: VaultOp[]) => Promise<boolean>
}): React.JSX.Element {
  const [groups, setGroups] = useState<BacklinkGroup[] | null>(null)
  const [unlinked, setUnlinked] = useState<UnlinkedMention[] | null>(null)
  const [showUnlinked, setShowUnlinked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    hive.memory.links({ op: 'backlinks', companyId, noteId }).then(
      (g) => {
        if (!live) return
        setGroups(g)
        setError(null)
      },
      (e) => live && setError(errorMessage(e))
    )
    return () => {
      live = false
    }
  }, [companyId, noteId, reloadKey])

  // unlinked mentions scan files: only when the section is open
  useEffect(() => {
    if (!showUnlinked) return
    let live = true
    hive.memory.links({ op: 'unlinked', companyId, noteId, limit: 100 }).then(
      (u) => live && setUnlinked(u),
      () => live && setUnlinked([])
    )
    return () => {
      live = false
    }
  }, [companyId, noteId, reloadKey, showUnlinked])

  const link = async (m: UnlinkedMention): Promise<void> => {
    const key = `${m.noteId}:${m.line}:${m.span.start}`
    setBusy(key)
    const ok = await onOps([{ op: 'linkMention', note: m.noteId, line: m.line, span: m.span, target: title }])
    setBusy(null)
    if (ok) setUnlinked((u) => (u ? u.filter((x) => x !== m) : u))
  }

  const total = groups?.reduce((s, g) => s + g.items.length, 0) ?? 0
  const outs = dedupeOutgoing(outgoing)

  return (
    <div className="pback">
      <div className="pside__title">
        Linked mentions <span className="pside__count">{groups ? total : '…'}</span>
      </div>
      {error && <div className="pside__empty text-secondary">{error}</div>}
      {groups && total === 0 && <div className="pside__empty">No notes link here yet.</div>}
      {groups?.map((g) => (
        <div key={g.rel} className="pback__group">
          <div className="pback__label">{g.label.replace(/_/g, ' ')}</div>
          {g.items.map((it, i) => (
            <button key={`${it.fromNote}:${it.line}:${i}`} type="button" className="pback__item" onClick={() => onOpenLine(it.fromNote, it.line)}>
              <span className="pback__from">{it.fromTitle}</span>
              {it.context && <span className="pback__ctx">{plain(it.context)}</span>}
            </button>
          ))}
        </div>
      ))}

      <button type="button" className="pside__title pside__title--btn" onClick={() => setShowUnlinked(!showUnlinked)}>
        <Icon name={showUnlinked ? 'chevronDown' : 'chevronRight'} size={12} /> Unlinked mentions
        {unlinked && showUnlinked && <span className="pside__count">{unlinked.length}</span>}
      </button>
      {showUnlinked && unlinked === null && <div className="pside__empty">Looking…</div>}
      {showUnlinked && unlinked?.length === 0 && <div className="pside__empty">No unlinked mentions of “{title}”.</div>}
      {showUnlinked &&
        unlinked?.map((m) => {
          const key = `${m.noteId}:${m.line}:${m.span.start}`
          return (
            <div key={key} className="pback__item pback__item--unlinked">
              <button type="button" className="pback__from" onClick={() => onOpenLine(m.noteId, m.line)}>
                {m.title}
              </button>
              <span className="pback__ctx">
                {m.text.slice(Math.max(0, m.span.start - 60), m.span.start)}
                <mark>{m.text.slice(m.span.start, m.span.end)}</mark>
                {m.text.slice(m.span.end, m.span.end + 60)}
              </span>
              {!readOnly && (
                <button type="button" className="pback__link" disabled={busy === key} onClick={() => void link(m)} title={`Turn “${m.matched}” into [[${title}]]`}>
                  Link
                </button>
              )}
            </div>
          )
        })}

      <div className="pside__title">
        Outgoing links <span className="pside__count">{outs.length}</span>
      </div>
      {outs.length === 0 && <div className="pside__empty">This note links nowhere yet.</div>}
      {outs.map((l) => (
        <button
          key={`${l.toNote ?? 'g'}:${l.toText}`}
          type="button"
          className={`pback__out ${l.toNote ? '' : 'is-ghost'}`}
          onClick={() => (l.toNote ? onOpen(l.toNote) : onCreate(l.toText))}
          title={l.toNote ? l.toTitle ?? l.toText : l.ambiguous ? `Ambiguous: ${l.candidates.join(', ')}` : `“${l.toText}” has no note yet. Click to create it.`}
        >
          <span className="pback__rel">{l.rel === 'links_to' ? '' : l.rel.replace(/_/g, ' ')}</span>
          <span className="pback__to">{l.toTitle ?? l.toText}</span>
          {!l.toNote && <span className="pback__ghost">{l.ambiguous ? 'ambiguous' : 'ghost'}</span>}
        </button>
      ))}
    </div>
  )
}

/** One row per target and relation (a note linked from three lines shows once). */
function dedupeOutgoing(links: VaultLink[]): VaultLink[] {
  const seen = new Set<string>()
  const out: VaultLink[] = []
  for (const l of links) {
    const k = `${l.rel}:${l.toNote ?? `ghost:${l.toText.toLowerCase()}`}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(l)
  }
  return out.sort((a, b) => Number(!a.toNote) - Number(!b.toNote) || (a.toTitle ?? a.toText).localeCompare(b.toTitle ?? b.toText))
}
