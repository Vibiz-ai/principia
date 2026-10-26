/**
 * Cloud asks and passport proposals (docs/CLOUD.md §3 steps 8-9, §13.1). One inbox: the same rows appear in the Cloud
 * pane's Needs you card and in Home's Needs you (marked with the cloud line), answerable inline in both. Agent text
 * is rendered as text (React escapes it), never as HTML.
 */
import { mixedListLabel } from '@shared/spend'
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { CloudAsk, PassportProposal } from '@shared/cloud'
import { Button } from '../ui'
import { agentParts, askAnswer, openAsks } from '../../lib/cloud'
import { errorMessage } from '../../lib/hive'
import { navigate, toast, useStore } from '../../state/store'
import { answerAsk, decideProposal, ensureCloud, useCloud } from '../../state/cloud'
import { AskBust, CloudMark } from './bits'

const clock = (iso: string): string => {
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : ''
}

export function AskRow({ ask, companyName, mark, mixed }: { ask: CloudAsk; companyName: string; mark?: boolean; /** pm-review B6: a list that mixes companies */ mixed?: boolean }): ReactElement {
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const who = agentParts(ask.agentName)
  const companies = useStore((s) => s.companies)
  const others = useMemo(() => companies.filter((c) => !c.archivedAt).map((c) => c.name), [companies])
  const send = async (input: { option?: string; text?: string }): Promise<void> => {
    const p = askAnswer(ask, input)
    if (!p) return
    setBusy(true)
    try {
      await answerAsk(p.id, p.answer)
      setText('')
      setOpen(false)
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="cl-ask">
      <AskBust agentName={ask.agentName} />
      <div className="cl-ask__body">
        <div className="cl-who">
          <b>{who.name}</b>
          {who.role && <> · {who.role}</>}
          <span className="cl-co">
            {companyName} · cloud run{ask.createdAt ? ` · ${clock(ask.createdAt)}` : ''}
          </span>
          {mark && <CloudMark size={13} title="From your cloud" className="cl-ask__mark" />}
        </div>
        <p className="cl-ask__q selectable">{ask.question}</p>
        <div className="cl-opts">
          {ask.options.map((o) => (
            <button key={o} type="button" className="cl-opt" disabled={busy} onClick={() => void send({ option: o })}>
              {mixed ? mixedListLabel(o, companyName, { prompt: ask.question, others }) : o}
            </button>
          ))}
          <button type="button" className="cl-opt cl-opt--ghost" disabled={busy} onClick={() => setOpen(!open)}>
            Answer in thread
          </button>
        </div>
        {open && (
          <form
            className="cl-answer"
            onSubmit={(e) => {
              e.preventDefault()
              void send({ text })
            }}
          >
            <input className="input input--sm" autoFocus placeholder="Write an answer…" value={text} maxLength={8000} onChange={(e) => setText(e.target.value)} />
            <Button size="sm" variant="primary" disabled={busy || !text.trim()} onClick={() => void send({ text })}>
              Send
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}

export function ProposalRow({ companyId, companyName, proposals, mark }: { companyId: string; companyName: string; proposals: PassportProposal[]; mark?: boolean }): ReactElement | null {
  const [busy, setBusy] = useState(false)
  if (!proposals.length) return null
  const n = proposals.length
  const all = async (): Promise<void> => {
    setBusy(true)
    try {
      for (const p of proposals) await decideProposal(companyId, p.id, 'accept')
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="cl-ask">
      <span className="cl-ring" aria-hidden="true" />
      <div className="cl-ask__body">
        <div className="cl-who">
          <b>{companyName} Knowledge</b>
          <span className="cl-co">from cloud agents</span>
          {mark && <CloudMark size={13} title="From your cloud" className="cl-ask__mark" />}
        </div>
        <p className="cl-ask__q">
          {n} new {n === 1 ? 'fact' : 'facts'}: {proposals[0].summary}
          {n > 1 ? ` and ${n - 1} more.` : '.'}
        </p>
        <div className="cl-opts">
          <button type="button" className="cl-opt" disabled={busy} onClick={() => void navigate({ name: 'passport', mode: 'inbox', nonce: Date.now() })}>
            Review
          </button>
          <button type="button" className="cl-opt cl-opt--ghost" disabled={busy} onClick={() => void all()}>
            Accept all
          </button>
        </div>
      </div>
    </div>
  )
}

/** The rows of both surfaces: open asks oldest first, then a proposal row per company with new facts. */
function useNeedsRows(companyId?: string) {
  const asks = useCloud((s) => s.asks)
  const proposals = useCloud((s) => s.proposals)
  const companies = useStore((s) => s.companies)
  const cloudCompanies = useCloud((s) => s.summary?.companies)
  const nameOf = (id: string): string => companies.find((c) => c.id === id)?.name ?? cloudCompanies?.find((c) => c.id === id)?.name ?? 'Company'
  const open = openAsks(asks).filter((a) => !companyId || a.companyId === companyId)
  const props = Object.entries(proposals).filter(([cid, list]) => list.length && (!companyId || cid === companyId))
  return { open, props, nameOf }
}

export function NeedsYouCard(): ReactElement {
  const { open, props, nameOf } = useNeedsRows()
  const n = open.length + props.length
  return (
    <section className="cl-card">
      <div className="cl-ctitle">
        Needs you{n > 0 && <span className="cl-count">{n}</span>}
        <span className="cl-hint">also on Home</span>
      </div>
      {n === 0 ? (
        <p className="cl-empty">Nothing needs you. Agents are working.</p>
      ) : (
        <>
          {open.map((a) => (
            <AskRow key={a.id} ask={a} companyName={nameOf(a.companyId)} mixed />
          ))}
          {props.map(([cid, list]) => (
            <ProposalRow key={cid} companyId={cid} companyName={nameOf(cid)} proposals={list} />
          ))}
        </>
      )}
    </section>
  )
}

/** How many rows CloudNeedsYou shows (0 when this Mac is not linked): Home counts them with its own. */
export function useCloudNeedsCount(companyId?: string): number {
  useEffect(() => ensureCloud(), [])
  const linked = useCloud((s) => !!s.state?.linked)
  const { open, props } = useNeedsRows(companyId)
  return linked ? open.length + props.length : 0
}

/**
 * Home's Needs you (CLOUD.md §0.1 "One inbox"): renders nothing when this Mac is not linked or nothing needs you.
 * `companyId` limits it to the focused company.
 */
export function CloudNeedsYou({ companyId }: { companyId?: string }): ReactElement | null {
  useEffect(() => ensureCloud(), [])
  const linked = useCloud((s) => !!s.state?.linked)
  const { open, props, nameOf } = useNeedsRows(companyId)
  if (!linked || open.length + props.length === 0) return null
  return (
    <section className="cl-home" aria-label="Needs you from your cloud">
      <div className="cl-home__title">
        <CloudMark size={14} /> From your cloud
      </div>
      {open.map((a) => (
        <AskRow key={a.id} ask={a} companyName={nameOf(a.companyId)} mark mixed={!companyId} />
      ))}
      {props.map(([cid, list]) => (
        <ProposalRow key={cid} companyId={cid} companyName={nameOf(cid)} proposals={list} mark />
      ))}
    </section>
  )
}
