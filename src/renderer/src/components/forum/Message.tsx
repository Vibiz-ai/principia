/**
 * FORUM.md §8: one message row. Plain text (grouped by author), asks (an amber status tessera: the Needs-you meaning),
 * proposals (the double-rule frame with corner lozenges, VOICE.md §5.2) and system lines. Inline tokens open what they
 * name; hover actions: react, reply in thread, make task, copy ref, edit/delete own.
 */
import { Fragment, useState } from 'react'
import type { ForumMessage, ForumRef } from '@shared/forum'
import { Icon } from '../Icon'
import { MemberAvatar } from './Avatar'
import { useForumCtx } from './context'
import { QUICK_REACTIONS, timeLabel, tokenize } from '../../lib/forum'
import { hive } from '../../lib/hive'
import { useStore } from '../../state/store'

export function RichText({ text, from }: { text: string; from?: ForumMessage }): React.JSX.Element {
  const ctx = useForumCtx()
  const meHandle = ctx.me?.handle
  return (
    <>
      {tokenize(text).map((t, i) => {
        switch (t.t) {
          case 'text':
            return <Fragment key={i}>{t.v}</Fragment>
          case 'br':
            return <br key={i} />
          case 'code':
            return <code key={i} className="fm-code">{t.v}</code>
          case 'bold':
            return <strong key={i}>{t.v}</strong>
          case 'url':
            return (
              <a key={i} className="fm-link" href={t.v} onClick={(e) => (e.preventDefault(), void hive.app.openExternal({ url: t.v }))}>
                {t.v.replace(/^https?:\/\//, '')}
              </a>
            )
          case 'mention': {
            const m = ctx.byHandle(t.handle)
            const dep = !m && ctx.channels.find((c) => c.system === 'department' && c.name === t.handle)
            if (!m && !dep && t.handle !== 'here' && t.handle !== 'channel') return <Fragment key={i}>{t.v}</Fragment>
            const mine = t.handle === meHandle || t.handle === 'here' || t.handle === 'channel'
            const label = m ? `@${ctx.display(m.id)?.name ?? m.handle}` : t.v
            return (
              <span key={i} className={`fm-mention ${mine ? 'is-me' : ''}`} title={m ? `@${m.handle}` : dep ? `Everyone in ${dep.name}` : 'Everyone here'} onClick={() => dep && ctx.openChannel(dep.id)}>
                {label}
              </span>
            )
          }
          case 'channel': {
            const c = ctx.channels.find((x) => x.name === t.name)
            if (!c) return <Fragment key={i}>{t.v}</Fragment>
            return (
              <span key={i} className="fm-mention fm-mention--channel" onClick={() => ctx.openChannel(c.id)}>
                {t.v}
              </span>
            )
          }
          case 'task':
            return (
              <span key={i} className="fm-inline-ref" onClick={() => from && ctx.openRef({ kind: 'task', id: t.v, label: t.v }, from)}>
                {t.v}
              </span>
            )
          case 'note':
            return (
              <span key={i} className="fm-inline-ref" onClick={() => from && ctx.openRef({ kind: 'note', id: t.title, label: t.v }, from)}>
                {t.v}
              </span>
            )
          case 'msgref':
            return (
              <span key={i} className="fm-inline-ref fm-inline-ref--msg" onClick={() => from && ctx.openRef({ kind: 'message', id: t.v, label: t.v }, from)}>
                {t.v}
              </span>
            )
        }
      })}
    </>
  )
}

const REF_ICON: Record<ForumRef['kind'], string> = { task: 'tasks', note: 'passport', artifact: 'artifacts', run: 'play', url: 'link', message: 'reply' }

function RefChips({ m }: { m: ForumMessage }): React.JSX.Element | null {
  const ctx = useForumCtx()
  // inline tokens already show tasks, notes and urls; chips list what the text does not carry
  const chips = m.refs.filter((r) => r.kind === 'artifact' || r.kind === 'run' || !m.text.includes(r.kind === 'note' ? r.label : r.id))
  if (!chips.length) return null
  return (
    <div className="fm-refs">
      {chips.map((r) => (
        <button key={`${r.kind}:${r.id}`} className="fm-ref" onClick={() => ctx.openRef(r, m)} title={r.id}>
          <Icon name={REF_ICON[r.kind]} size={12} />
          <span>{r.label}</span>
        </button>
      ))}
    </div>
  )
}

function Reactions({ m }: { m: ForumMessage }): React.JSX.Element | null {
  const ctx = useForumCtx()
  const entries = Object.entries(m.reactions)
  if (!entries.length) return null
  return (
    <div className="fm-reactions">
      {entries.map(([emoji, who]) => (
        <button
          key={emoji}
          className={`fm-reaction ${ctx.me && who.includes(ctx.me.id) ? 'is-mine' : ''}`}
          onClick={() => ctx.react(m, emoji)}
          title={who.map((id) => ctx.display(id)?.name ?? 'someone').join(', ')}
        >
          <span>{emoji}</span>
          <span className="fm-reaction__n">{who.length}</span>
        </button>
      ))}
    </div>
  )
}

function ThreadSummary({ m }: { m: ForumMessage }): React.JSX.Element | null {
  const ctx = useForumCtx()
  if (!m.replyCount) return null
  return (
    <button className="fm-thread-sum" onClick={() => ctx.openThread(m)}>
      <span className="fm-thread-sum__faces">
        {m.repliers.slice(-3).map((id) => (
          <MemberAvatar key={id} display={ctx.display(id)} size={18} />
        ))}
      </span>
      <span className="fm-thread-sum__count">
        {m.replyCount} {m.replyCount === 1 ? 'reply' : 'replies'}
      </span>
      {m.lastReplyAt && <span className="fm-thread-sum__last">Last reply {timeLabel(m.lastReplyAt)}</span>}
    </button>
  )
}

function Actions({ m, inThread }: { m: ForumMessage; inThread: boolean }): React.JSX.Element {
  const ctx = useForumCtx()
  const mine = ctx.me?.id === m.authorId
  return (
    <div className="fm-actions" role="toolbar" aria-label="Message actions">
      {QUICK_REACTIONS.slice(0, 3).map((e) => (
        <button key={e} className="fm-actions__btn" title={`React ${e}`} onClick={() => ctx.react(m, e)}>
          {e}
        </button>
      ))}
      {!inThread && (
        <button className="fm-actions__btn" title="Reply in thread" onClick={() => ctx.openThread(m)}>
          <Icon name="reply" size={14} />
        </button>
      )}
      <button className="fm-actions__btn fm-actions__btn--label" title="Make a board task from this message" onClick={() => ctx.toTask(m)}>
        <Icon name="tasks" size={14} />
        <span>Make task</span>
      </button>
      <button className="fm-actions__btn" title={`Copy ref ${m.ref} (agents quote it)`} onClick={() => ctx.copyRef(m)}>
        <Icon name="link" size={14} />
      </button>
      {mine && m.kind === 'text' && (
        <button className="fm-actions__btn" title="Edit" onClick={() => ctx.edit(m)}>
          <Icon name="edit" size={14} />
        </button>
      )}
      {(mine || ctx.me?.role === 'owner') && (
        <button className="fm-actions__btn" title="Delete" onClick={() => ctx.remove(m)}>
          <Icon name="trash" size={14} />
        </button>
      )}
    </div>
  )
}

export function AskCard({ m }: { m: ForumMessage }): React.JSX.Element | null {
  const ctx = useForumCtx()
  const [busy, setBusy] = useState(false)
  const ask = m.ask
  if (!ask) return null
  const canAnswer = ask.status === 'open' && !!ctx.me && (ctx.me.role === 'owner' || ctx.me.role === 'admin' || ask.to.includes(ctx.me.id))
  const author = ctx.display(m.authorId)
  // AGENT-COLLAB.md §5: an agent asking agents is their conversation, not a Needs-you card
  const agentToAgent = author?.kind === 'agent' && ask.to.length > 0 && ask.to.every((id) => ctx.display(id)?.kind === 'agent')
  const targets = ask.to.map((id) => ctx.display(id)).filter((d): d is NonNullable<typeof d> => !!d)
  const go = async (a: string) => {
    setBusy(true)
    await ctx.answer(m, a)
    setBusy(false)
  }
  return (
    <div className={`fm-ask ${ask.status === 'open' ? 'is-open' : 'is-answered'} ${agentToAgent ? 'fm-ask--agents' : ''}`}>
      <div className="fm-ask__kicker">
        <span className={`fm-tessera ${ask.status === 'open' ? (agentToAgent ? 'fm-tessera--working' : 'fm-tessera--needs') : 'fm-tessera--ok'}`} aria-hidden />
        {agentToAgent ? (
          <span className="fm-ask__route" title="One agent asked another; the asked agent was woken to answer in this thread">
            Agent ask · {author?.name}
            {author?.role ? ` (${author.role})` : ''} → {targets.map((t) => `${t.name}${t.role ? ` (${t.role})` : ''}`).join(', ')}
            {ask.status === 'open' ? ' · answering' : ' · answered'}
          </span>
        ) : (
          <span>{ask.status === 'open' ? 'Needs you · ask' : 'Answered'}</span>
        )}
        {ask.taskId && <span className="fm-ask__park">{ask.status === 'open' ? 'parks its task until answered' : 'its task resumed'}</span>}
      </div>
      <div className="fm-ask__q">
        <RichText text={m.text.replace(/^(@[a-z0-9._-]+\s+)+/i, '')} from={m} />
      </div>
      {ask.status === 'open' ? (
        canAnswer && (
          <div className="fm-ask__opts">
            {(ask.options ?? []).map((o, i) => (
              <button key={o} className={`btn btn--sm ${i === 0 ? 'btn--primary' : ''}`} disabled={busy} onClick={() => void go(o)}>
                {o}
              </button>
            ))}
            <button className="btn btn--sm btn--ghost" onClick={() => ctx.openThread(m)}>
              Answer in thread…
            </button>
          </div>
        )
      ) : (
        <div className="fm-ask__answer">
          <Icon name="check" size={12} />
          <span>
            {ctx.display(ask.answeredBy ?? '')?.name ?? 'Someone'}: <RichText text={ask.answer ?? ''} />
          </span>
        </div>
      )}
      <div className="fm-ask__foot">
        Asked {ask.to.map((id) => `@${ctx.display(id)?.handle ?? '?'}`).join(', ')}
        {ask.status === 'open' && author?.kind === 'agent' ? (agentToAgent ? ` · ${targets.map((t) => t.name).join(', ')} was woken to answer; you can answer too` : ` · ${author.name} resumes with your answer`) : ''}
      </div>
    </div>
  )
}

function Lozenges(): React.JSX.Element {
  return (
    <>
      <span className="fm-loz fm-loz--tl" aria-hidden />
      <span className="fm-loz fm-loz--tr" aria-hidden />
      <span className="fm-loz fm-loz--bl" aria-hidden />
      <span className="fm-loz fm-loz--br" aria-hidden />
    </>
  )
}

export function ProposalCard({ m }: { m: ForumMessage }): React.JSX.Element | null {
  const ctx = useForumCtx()
  const departments = useStore((s) => s.departments)
  const p = m.proposal
  if (!p) return null
  const canDecide = p.status === 'open' && (ctx.me?.role === 'owner' || ctx.me?.role === 'admin')
  const author = ctx.display(m.authorId)
  const title = p.kind === 'department' ? p.department?.name : p.agent?.role
  const depName = p.agent?.departmentKey ? (departments.find((d) => d.companyId === ctx.companyId && d.key === p.agent!.departmentKey)?.name ?? p.agent.departmentKey) : null
  const rows: [string, string][] =
    p.kind === 'department'
      ? [['Does', p.department?.does || '—'], ['Does not', p.department?.doesNot || '—']]
      : [['Instructions', p.agent?.instructions || '—'], ['Capabilities', p.agent?.capabilities || '—']]
  return (
    <div className={`fm-proposal is-${p.status}`}>
      <Lozenges />
      <div className="fm-proposal__kicker">Proposal · {p.kind === 'department' ? 'new department' : 'new agent'}</div>
      <div className="fm-proposal__title">{title}</div>
      <div className="fm-proposal__meta">
        {p.kind === 'agent' && depName ? `${depName} · ` : ''}proposed by {author?.name ?? 'someone'}
        {p.kind === 'agent' ? ' · persona assigned on approval' : ''}
      </div>
      <div className="fm-proposal__why">{p.reason}</div>
      <dl className="fm-proposal__rows">
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </Fragment>
        ))}
      </dl>
      {p.error && <div className="fm-proposal__error">{p.error}</div>}
      {p.status === 'open' ? (
        canDecide ? (
          <div className="fm-proposal__actions">
            <button className="btn btn--sm btn--primary" onClick={() => ctx.decide(m, 'approve')}>
              Approve…
            </button>
            <button className="btn btn--sm" onClick={() => ctx.decide(m, 'reject')}>
              Reject
            </button>
            <span className="fm-proposal__hint">{p.kind === 'agent' ? 'Opens the hire sheet: profile, department' : 'Opens the sheet: name and charter'}</span>
          </div>
        ) : (
          <div className="fm-proposal__hint">Waiting for the owner or an admin</div>
        )
      ) : (
        <div className="fm-proposal__decided">
          <svg className="rm-la fm-proposal__seal" width="22" height="22" viewBox="0 0 64 64" aria-hidden>
            <circle cx="32" cy="32" r="29.5" style={{ stroke: 'var(--rm-ln-1)' }} />
            <circle cx="32" cy="32" r="25.8" style={{ stroke: 'var(--rm-ln-3)' }} />
            {p.status === 'approved' ? <path d="M21 33 l7 7 l15 -17" style={{ stroke: 'var(--rm-ln-1)' }} /> : <path d="M23 23 L41 41 M41 23 L23 41" style={{ stroke: 'var(--rm-ln-1)' }} />}
          </svg>
          <span>
            {p.status === 'approved' ? 'Approved' : 'Rejected'} by {ctx.display(p.decidedBy ?? '')?.name ?? 'someone'}
            {p.note ? `: ${p.note}` : ''}
          </span>
        </div>
      )}
    </div>
  )
}

export function MessageRow({ m, head, inThread = false, highlight = false }: { m: ForumMessage; head: boolean; inThread?: boolean; highlight?: boolean }): React.JSX.Element {
  const ctx = useForumCtx()
  const d = ctx.display(m.authorId)
  if (m.kind === 'system') {
    return (
      <div className="fm-system" id={`fm-${m.id}`}>
        <span className="fm-tessera fm-tessera--line" aria-hidden />
        <RichText text={m.text} from={m} />
        <span className="fm-system__time">{timeLabel(m.createdAt)}</span>
      </div>
    )
  }
  const mentionsMe = !!ctx.me && m.mentions.includes(ctx.me.id)
  return (
    <div className={`fm-msg ${head ? 'is-head' : 'is-cont'} ${mentionsMe ? 'is-mention' : ''} ${highlight ? 'is-highlight' : ''}`} id={`fm-${m.id}`}>
      <div className="fm-msg__gutter">{head ? <MemberAvatar display={d} size={32} working={ctx.working.has(m.authorId)} /> : <span className="fm-msg__time-cont">{timeLabel(m.createdAt)}</span>}</div>
      <div className="fm-msg__body">
        {head && (
          <div className="fm-msg__head">
            <span className="fm-msg__name">{d?.name ?? 'Unknown'}</span>
            {d?.kind === 'agent' && d.role && <span className="fm-role">{d.role}</span>}
            {d?.kind === 'guest' && <span className="fm-role fm-role--guest">guest</span>}
            {d?.department && <span className="fm-msg__dep">{d.department}</span>}
            <span className="fm-msg__time" title={new Date(m.createdAt).toLocaleString()}>
              {timeLabel(m.createdAt)}
            </span>
            <span className="fm-msg__ref">{m.ref}</span>
          </div>
        )}
        {m.deletedAt ? (
          <div className="fm-msg__text fm-msg__text--deleted">This message was deleted.</div>
        ) : m.kind === 'ask' ? (
          <AskCard m={m} />
        ) : m.kind === 'proposal' ? (
          <>
            {m.text && (
              <div className="fm-msg__text">
                <RichText text={m.text} from={m} />
              </div>
            )}
            <ProposalCard m={m} />
          </>
        ) : (
          <div className="fm-msg__text">
            <RichText text={m.text} from={m} />
            {m.editedAt && <span className="fm-msg__edited"> (edited)</span>}
          </div>
        )}
        {!m.deletedAt && <RefChips m={m} />}
        <Reactions m={m} />
        {!inThread && <ThreadSummary m={m} />}
      </div>
      {!m.deletedAt && <Actions m={m} inThread={inThread} />}
    </div>
  )
}
