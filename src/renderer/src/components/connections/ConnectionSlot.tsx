/**
 * CONNECTIONS.md §4.1: every place a service could go shows it the same way. Connected (in any form: a key, a sign-in,
 * an account, Principia's connector) it says so at once, with what uses it and what it unlocks here ("See sessions",
 * "Ask about your data"); not connected, one "Connect PostHog" that opens the shared connect sheet. It reads the one
 * per-company status (state/connections), so connecting anywhere flips every slot on screen within one event.
 *
 * Variants: `row` (one line: checklist, playbooks, knowledge, desks), `inline` (a block inside another card: dashboards),
 * `chip` (dense lists: an agent's tools).
 */
import { serviceById, type Purpose, type ServiceStatus } from '@shared/services'
import type { Id } from '@shared/types'
import { Button } from '../ui'
import { openConnect, useConnection, useConnections } from '../../state/connections'
import { serviceActions, stateTone, usedByLine, viaWords, type ServiceAction } from '../../lib/serviceActions'
import { startSession } from '../../state/store'
import { ServiceRoundel } from './ConnectSheet'
import '../../styles/connections.css'

export type SlotVariant = 'row' | 'inline' | 'chip'

/** Runs a slot action: the company browser for a link, a new chat (in the department when there is one) for a question. */
export function runServiceAction(a: ServiceAction, o: { companyId: Id; departmentId?: Id | null; service: string }): void {
  if (a.id === 'sessions' && a.url) {
    void import('../../state/browser').then(({ openBrowser }) => openBrowser({ companyId: o.companyId, url: a.url! }))
    return
  }
  if (a.id === 'ask' && a.prompt) void startSession({ repoId: null, forceNew: true, companyId: o.companyId, ...(o.departmentId ? { departmentId: o.departmentId } : {}), initialPrompt: a.prompt, title: `Ask ${o.service}` })
}

export function ConnectionSlot({
  companyId,
  service,
  purpose,
  variant = 'row',
  departmentId,
  label,
  actions = true,
  connectLabel,
  bare = false
}: {
  companyId: Id
  service: string
  /** what this place needs it for: the slot is "connected" only when the connection serves it */
  purpose?: Purpose
  variant?: SlotVariant
  /** where "Ask about it" chats start */
  departmentId?: Id | null
  /** a line under the name when not connected ("Numbers for the Marketing dashboard") */
  label?: string
  actions?: boolean
  connectLabel?: string
  /** chip: the state only, next to a label that already names the service */
  bare?: boolean
}): React.JSX.Element | null {
  const s = serviceById(service)
  const { status, ok } = useConnection(companyId, service, purpose)
  if (!s) return null
  if (!status) return variant === 'chip' ? null : <div className="cx-skel" aria-hidden="true" />
  const tone = ok ? 'ok' : stateTone(status) === 'ok' ? 'needs' : stateTone(status)
  const why = purpose && (status.state === 'connected' || status.state === 'attention') && !ok ? status.purposes[purpose]?.why : undefined
  const fixLabel = purpose && status.purposes[purpose]?.fix === 'key' ? 'Add a key' : purpose && status.purposes[purpose]?.fix === 'signIn' ? `Sign in to ${s.name}` : `Connect ${s.name}`
  const acts = actions && ok ? serviceActions(status) : []
  const open = (): void => openConnect(companyId, service, purpose)
  const run = (a: ServiceAction): void => runServiceAction(a, { companyId, departmentId, service: s.name })
  const used = usedByLine(status)

  if (variant === 'chip') {
    return (
      <button type="button" className={`cx-chip ${ok ? '' : 'is-off'}`} title={ok ? `${s.name}: ${status.chip}${used ? `. Used by: ${used}` : ''}` : (why ?? `Connect ${s.name}`)} onClick={open}>
        <ServiceRoundel name={s.name} size={18} />
        {!bare && s.name}
        {ok ? <span className="cx-chip__via">· {viaWords(status)}</span> : <span className="cx-chip__via">· {status.state === 'attention' ? 'needs attention' : 'connect'}</span>}
      </button>
    )
  }

  const line = ok ? lineFor(status, used) : status.state === 'soon' ? `${label ? `${label} ` : ''}Principia can’t connect ${s.name} yet.` : status.state === 'attention' ? (status.forms.find((f) => f.problem)?.problem ?? 'Needs attention.') : status.state === 'waiting' ? 'Waiting for you to finish signing in…' : (why ?? label ?? s.blurb)
  const buttons = (
    <>
      {acts.map((a) => (
        <Button key={a.id} size="sm" onClick={() => run(a)}>
          {a.label}
        </Button>
      ))}
      {!ok && status.state !== 'waiting' && status.state !== 'soon' && (
        <Button size="sm" onClick={open}>
          {status.state === 'attention' ? 'Fix' : why ? fixLabel : (connectLabel ?? `Connect ${s.name}`)}
        </Button>
      )}
      {ok && !acts.length && (
        <Button size="sm" variant="ghost" onClick={open}>
          Manage
        </Button>
      )}
    </>
  )

  if (variant === 'inline') {
    return (
      <div className="cx-inline" data-service={s.id}>
        <div className="cx-inline__head">
          <span className={`cx-dot cx-dot--${tone}`} />
          {ok ? (
            <span>
              <strong>{s.name} connected</strong> · {viaWords(status)}
            </span>
          ) : (
            <span>{status.state === 'attention' ? `${s.name} needs attention` : status.state === 'waiting' ? `Signing in to ${s.name}…` : why ? `${s.name} is connected, but not for this` : `${s.name} not connected`}</span>
          )}
        </div>
        {why && <p className="cx-inline__why">{why}</p>}
        {(acts.length > 0 || !ok) && <div className="cx-row__acts">{buttons}</div>}
      </div>
    )
  }

  return (
    <div className="cx-row" data-service={s.id}>
      <ServiceRoundel name={s.name} />
      <div className="cx-row__id">
        <span className="cx-row__name">
          {s.name}
          <span className={`s5-chip s5-chip--${tone}`}>{ok ? status.chip : why ? 'Not for this' : status.chip}</span>
        </span>
        <span className={`cx-row__line ${why ? 'is-why' : ''}`} title={line}>
          {line}
        </span>
      </div>
      <div className="cx-row__acts">{buttons}</div>
    </div>
  )
}

function lineFor(st: ServiceStatus, used: string): string {
  const unlocked = Object.values(st.purposes).filter((p) => p?.ok).map((p) => p!.label)
  return used ? `Used by: ${used}` : unlocked.length ? `Unlocks: ${unlocked.join(', ')}` : 'Connected'
}

/**
 * Every service this company has connected that reaches its agents, as chips ("Tools this agent can use"), plus one
 * "Connect more" chip.
 */
export function ConnectedServiceChips({ companyId, purpose = 'agentTools', onMore }: { companyId: Id; purpose?: Purpose; onMore?: () => void }): React.JSX.Element | null {
  const list = useConnections(companyId)
  if (!list) return null
  const on = list.filter((st) => st.state === 'connected' && st.purposes[purpose]?.ok)
  // QP-1: a service whose key was turned down stays in the list, marked, with its fix one click away
  const hurt = list.filter((st) => st.state === 'attention')
  return (
    <div className="cx-chips">
      {on.map((st) => (
        <ConnectionSlot key={st.serviceId} companyId={companyId} service={st.serviceId} purpose={purpose} variant="chip" />
      ))}
      {hurt.map((st) => (
        <ConnectionSlot key={st.serviceId} companyId={companyId} service={st.serviceId} variant="chip" />
      ))}
      {!on.length && !hurt.length && <span className="cx-row__line">No services connected yet. Agents still have their built-in tools.</span>}
      {onMore && (
        <button type="button" className="cx-chip is-off" onClick={onMore}>
          + Connect more
        </button>
      )}
    </div>
  )
}

/** A starter question that reads the company's own connection (QP-2: through Principia, never the founder's own server). */
export const starterPrompt = (service: string): string =>
  `Using this company’s ${service} connection through Principia’s tools (principia_list_tools, then principia_call_tool; never another ${service} tool or server): how did the last 7 days go? The main numbers, what changed, anything unusual.`

/**
 * CONNECTIONS.md §4.3 S18: an empty chat names what this company has connected and offers one question per service
 * that answers data questions ("Ask PostHog how last week went"). Nothing when nothing is connected.
 */
export function ChatServiceStarters({ companyId, onAsk }: { companyId: Id; onAsk: (text: string) => void }): React.JSX.Element | null {
  const list = useConnections(companyId)
  const on = (list ?? []).filter((st) => st.state === 'connected' && st.purposes.agentTools?.ok)
  if (!on.length) return null
  const askable = on.filter((st) => st.purposes.askData?.ok).slice(0, 3)
  return (
    <div className="cx-starters">
      <div className="cx-row__line">Connected here: {on.map((st) => st.name).join(', ')}</div>
      {askable.length > 0 && (
        <div className="cx-chips">
          {askable.map((st) => (
            <button key={st.serviceId} type="button" className="cx-chip" onClick={() => onAsk(starterPrompt(st.name))}>
              <ServiceRoundel name={st.name} size={18} />
              Ask {st.name} how last week went
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
