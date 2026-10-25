/**
 * Reading mode (PASSPORT.md §10): the note rendered by `lib/markdown.ts`. Resolved wikilinks are accent chips,
 * ghosts are dashed chips that offer "Create note"; observations show their category pill and who wrote them;
 * block ids are hidden but "Copy block link" puts `[[Title#^id]]` on the clipboard. History starts collapsed.
 */
import { useState } from 'react'
import type { VaultFact } from '@shared/passport'
import type { Provenance } from '@shared/vault/grammar'
import { Icon } from '../Icon'
import { ProviderDot } from '../ui'
import type { AdapterId } from '@shared/types'
import { renderMarkdown, type Block, type Inline, type LinkResolver, type ListItem } from '../../lib/markdown'
import { blockLink } from '../../lib/passport'
import { hive } from '../../lib/hive'
import { navigate, toast } from '../../state/store'
import { DIAGRAM_FENCE } from '@shared/diagram'
import { DiagramBlock } from '../diagrams/DiagramBlock'

export interface ReaderActions {
  openNote: (noteId: string, opts?: { heading?: string | null; block?: string | null }) => void
  createNote: (title: string) => void
  filterTag: (tag: string) => void
  showLine: (line: number) => void
}

const AGENTS = new Set(['claude', 'codex', 'gemini', 'cursor'])

export function NoteReader({
  title,
  text,
  facts,
  resolve,
  highlightRunId,
  actions
}: {
  title: string
  text: string
  /** index facts, for run ids behind provenance tails and pending/unreviewed state */
  facts: VaultFact[]
  resolve: LinkResolver
  /** "what this run wrote": its lines get the accent bar */
  highlightRunId?: string | null
  actions: ReaderActions
}): React.JSX.Element {
  const blocks = renderMarkdown(text, { resolve })
  const factAt = new Map(facts.map((f) => [f.line, f]))
  const ctx: Ctx = { title, actions, factAt, highlightRunId: highlightRunId ?? null }
  return (
    <article className="preader selectable">
      {blocks.length === 0 ? <p className="text-tertiary">This note is empty. Press ⌘E to write.</p> : blocks.map((b, i) => <BlockView key={i} b={b} ctx={ctx} />)}
    </article>
  )
}

interface Ctx {
  title: string
  actions: ReaderActions
  factAt: Map<number, VaultFact>
  highlightRunId: string | null
}

function BlockView({ b, ctx }: { b: Block; ctx: Ctx }): React.JSX.Element {
  switch (b.t) {
    case 'heading': {
      const H = `h${Math.min(6, b.level)}` as 'h1'
      return (
        <H className={`preader__h preader__h${b.level}`} data-line={b.line}>
          <Inlines c={b.c} ctx={ctx} />
          {b.blockId && <BlockLinkButton ctx={ctx} blockId={b.blockId} />}
        </H>
      )
    }
    case 'para':
      return (
        <p className="preader__p" data-line={b.line}>
          <Inlines c={b.c} ctx={ctx} />
          {b.blockId && <BlockLinkButton ctx={ctx} blockId={b.blockId} />}
        </p>
      )
    case 'code':
      // DIAGRAMS.md: a ```principia-graph fence is drawn, every other fence stays code
      if (b.lang === DIAGRAM_FENCE) return <div data-line={b.line}><DiagramBlock source={b.text} /></div>
      return (
        <pre className="preader__code mono" data-line={b.line}>
          <code>{b.text}</code>
        </pre>
      )
    case 'hr':
      return <hr className="preader__hr" />
    case 'quote':
      return (
        <blockquote className="preader__quote">
          {b.c.map((x, i) => (
            <BlockView key={i} b={x} ctx={ctx} />
          ))}
        </blockquote>
      )
    case 'table':
      return (
        <div className="preader__table-wrap">
          <table className="preader__table">
            <thead>
              <tr>
                {b.head.map((c, i) => (
                  <th key={i} style={{ textAlign: b.align[i] ?? undefined }}>
                    <Inlines c={c} ctx={ctx} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, i) => (
                    <td key={i} style={{ textAlign: b.align[i] ?? undefined }}>
                      <Inlines c={c} ctx={ctx} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'list':
      return <ListView items={b.items} ctx={ctx} />
    case 'history':
      return <HistoryView items={b.items} ctx={ctx} />
  }
}

function ListView({ items, ctx }: { items: ListItem[]; ctx: Ctx }): React.JSX.Element {
  const ordered = items[0]?.ordered
  const L = ordered ? 'ol' : 'ul'
  return (
    <L className="preader__list">
      {items.map((it) => (
        <ItemView key={it.line} it={it} ctx={ctx} />
      ))}
    </L>
  )
}

function ItemView({ it, ctx }: { it: ListItem; ctx: Ctx }): React.JSX.Element {
  const fact = ctx.factAt.get(it.line)
  const prov = it.obs?.prov ?? it.rel?.prov ?? it.history?.prov ?? null
  const mine = !!ctx.highlightRunId && fact?.runId === ctx.highlightRunId
  return (
    <li
      data-line={it.line}
      className={`preader__li ${it.task !== null ? 'preader__li--task' : ''} ${it.obs || it.rel ? 'preader__li--fact' : ''} ${mine ? 'is-run' : ''} ${fact?.status === 'pending' ? 'is-pending' : ''}`}
      style={it.depth ? { marginLeft: it.depth * 18 } : undefined}
    >
      {it.task !== null && <input type="checkbox" checked={it.task} readOnly tabIndex={-1} aria-label={it.task ? 'Done' : 'To do'} />}
      {it.obs && <span className={`ppill ppill--${fact?.kind ?? 'other'}`}>{it.obs.category}</span>}
      {it.rel && <span className="ppill ppill--rel">{it.rel.rel.replace(/_/g, ' ')}</span>}
      {it.history && <span className="ppill ppill--history">{it.history.state}</span>}
      <span className="preader__li-text">
        <Inlines c={it.c} ctx={ctx} />
        {it.history?.reason && <span className="text-tertiary"> — {it.history.reason}</span>}
      </span>
      {(prov || fact) && <ProvChip prov={prov} fact={fact} />}
      {fact?.status === 'pending' && (
        <span className="ppill ppill--warn" title="Contested: waiting in the Inbox">
          pending
        </span>
      )}
      <span className="preader__li-actions">
        {it.blockId && <BlockLinkButton ctx={ctx} blockId={it.blockId} />}
        <button type="button" className="preader__mini" title="Show in file" onClick={() => ctx.actions.showLine(it.line)}>
          <Icon name="edit" size={12} />
        </button>
      </span>
    </li>
  )
}

function HistoryView({ items, ctx }: { items: ListItem[]; ctx: Ctx }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <section className="preader__history">
      <button type="button" className="preader__history-btn" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} /> History <span className="text-tertiary">{items.length}</span>
      </button>
      {open && (
        <ul className="preader__list preader__list--history">
          {items.map((it) => (
            <ItemView key={it.line} it={it} ctx={ctx} />
          ))}
        </ul>
      )}
    </section>
  )
}

/** Who wrote a line: actor, the run (a link) or session, and the date. The index's fact wins over the raw tail. */
function ProvChip({ prov, fact }: { prov: Provenance | null; fact: VaultFact | undefined }): React.JSX.Element {
  const actor = fact?.actor ?? prov?.actor ?? 'user'
  const runId = fact?.runId ?? null
  const date = fact?.date ?? prov?.date ?? null
  const base = actor.split(' ')[0]!
  return (
    <span className="pprov">
      {AGENTS.has(base) ? <ProviderDot adapter={base as AdapterId} /> : null}
      <span>{actor === 'user' ? 'you' : actor}</span>
      {runId ? (
        <button type="button" className="pprov__link" onClick={() => void navigate({ name: 'run', runId })} title="Open the run that wrote this">
          run
        </button>
      ) : prov?.runId ? (
        <span>run#{prov.runId}</span>
      ) : prov?.sessionId || fact?.sessionId ? (
        <span>session</span>
      ) : null}
      {date && <span className="text-tertiary">{date}</span>}
    </span>
  )
}

function BlockLinkButton({ ctx, blockId }: { ctx: Ctx; blockId: string }): React.JSX.Element {
  return (
    <button
      type="button"
      className="preader__mini"
      title="Copy block link"
      onClick={() => {
        void navigator.clipboard.writeText(blockLink(ctx.title, blockId)).then(
          () => toast('Block link copied'),
          () => toast('Couldn’t copy the block link', 'error')
        )
      }}
    >
      <Icon name="link" size={12} />
    </button>
  )
}

function Inlines({ c, ctx }: { c: Inline[]; ctx: Ctx }): React.JSX.Element {
  return (
    <>
      {c.map((n, i) => (
        <InlineView key={i} n={n} ctx={ctx} />
      ))}
    </>
  )
}

function InlineView({ n, ctx }: { n: Inline; ctx: Ctx }): React.JSX.Element {
  switch (n.t) {
    case 'text':
      return <>{n.v}</>
    case 'br':
      return <br />
    case 'strong':
      return (
        <strong>
          <Inlines c={n.c} ctx={ctx} />
        </strong>
      )
    case 'em':
      return (
        <em>
          <Inlines c={n.c} ctx={ctx} />
        </em>
      )
    case 'del':
      return (
        <del>
          <Inlines c={n.c} ctx={ctx} />
        </del>
      )
    case 'code':
      return <code className="preader__ic mono">{n.v}</code>
    case 'tag':
      return (
        <button type="button" className="ptag" onClick={() => ctx.actions.filterTag(n.tag)} title={`Notes tagged #${n.tag}`}>
          #{n.tag}
        </button>
      )
    case 'url':
      return (
        <a
          className="preader__url"
          href={n.href}
          onClick={(e) => {
            // web links open in the browser; never navigate the app window
            e.preventDefault()
            if (/^https?:/i.test(n.href)) void hive.app.openExternal({ url: n.href }).catch(() => toast('Couldn’t open the link', 'error'))
          }}
        >
          <Inlines c={n.c} ctx={ctx} />
        </a>
      )
    case 'wikilink':
      if (n.resolved) {
        const r = n.resolved
        return (
          <button type="button" className={`plink ${n.embed ? 'plink--embed' : ''}`} title={r.title} onClick={() => ctx.actions.openNote(r.noteId, { heading: n.heading, block: n.block })}>
            {n.label}
          </button>
        )
      }
      if (!n.target) return <span className="plink plink--self">{n.label}</span>
      return (
        <button type="button" className="plink plink--ghost" title={`“${n.target}” has no note yet. Click to create it.`} onClick={() => ctx.actions.createNote(n.target)}>
          {n.label}
          <span className="plink__create">Create note</span>
        </button>
      )
  }
}
