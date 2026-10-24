/**
 * AGENT-COLLAB.md §5: the Forum's Agent talk panel. Every conversation in which one agent woke another: who asked
 * whom, why, how deep the chain went, what the reply runs cost, and every wake the guards refused. The limits are
 * edited here too (Settings → agentCollab), so the owner sees and sets the budget in one place.
 */
import { useCallback, useEffect, useState } from 'react'
import { AGENT_COLLAB_RANGES, DEFAULT_AGENT_COLLAB, type AgentCollabSettings, type CollabState, type CollabThread, type CollabWake } from '@shared/collab'
import { hive, useHiveEvent } from '../../lib/hive'
import { navigate, updateSettings } from '../../state/store'
import { Icon } from '../Icon'
import { Loading } from '../ui'
import { useForumCtx } from './context'

const usd = (v: number | null, est: boolean) => (v == null ? null : `${est ? '~' : ''}$${v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2)}`)
const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}
const REFUSAL_LABEL: Record<string, string> = {
  off: 'collaboration off',
  self: 'self',
  not_agent: 'not an agent',
  cannot_answer: 'seat cannot answer',
  cycle: 'loop prevented',
  hops: 'hop limit',
  thread_cap: 'thread limit',
  target_cap: 'agent busy limit',
  asker_cap: 'asker limit',
  company_cap: 'daily limit',
  start_failed: 'could not start'
}
const FIELDS: { key: Exclude<keyof AgentCollabSettings, 'enabled'>; label: string; hint: string }[] = [
  { key: 'maxHops', label: 'Hops per chain', hint: 'A asks B = 1, B asks C = 2' },
  { key: 'perThread', label: 'Wakes per thread', hint: '' },
  { key: 'perAgentPerHour', label: 'Times an agent can be asked / hour', hint: '' },
  { key: 'perAskerPerHour', label: 'Asks an agent can send / hour', hint: '' },
  { key: 'perCompanyPerDay', label: 'Wakes per company / 24 h', hint: '' },
  { key: 'waitDefaultS', label: 'Asker waits (s)', hint: 'for the reply inside its run' }
]

export function AgentTalkPanel({ companyId, onClose }: { companyId: string; onClose: () => void }): React.JSX.Element {
  const ctx = useForumCtx()
  const [st, setSt] = useState<CollabState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const load = useCallback(() => {
    hive.forum.collab({ companyId }).then(
      (s) => (setSt(s), setError(null)),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e))
    )
  }, [companyId])
  useEffect(() => load(), [load])
  // live: any new message may be part of an agent conversation (debounced)
  const [tick, setTick] = useState(0)
  useHiveEvent('forum:event', (e) => {
    if (e.companyId === companyId && e.kind === 'message') setTick((t) => t + 1)
  })
  useEffect(() => {
    if (!tick) return
    const t = setTimeout(load, 400)
    return () => clearTimeout(t)
  }, [tick, load])
  const name = (id: string) => ctx.display(id)?.name ?? 'someone'
  const role = (id: string) => {
    const d = ctx.display(id)
    return d?.kind === 'agent' ? [d.role, d.department].filter(Boolean).join(', ') : ''
  }
  const save = async (patch: Partial<AgentCollabSettings>) => {
    await updateSettings({ agentCollab: patch })
    load()
  }
  return (
    <aside className="fm-side fm-agents" aria-label="Agent talk">
      <header className="fm-side__head">
        <span className="fm-side__title">Agent talk</span>
        <span className="fm-side__sub">{st ? `${st.usage.wakesToday} of ${st.usage.capPerDay} wakes in 24 h${st.usage.refusedToday ? ` · ${st.usage.refusedToday} refused` : ''}` : ''}</span>
        <button className="fm-icon-btn" onClick={onClose} aria-label="Close agent talk">
          <Icon name="close" size={14} />
        </button>
      </header>
      <div className="fm-side__body">
        {error && <div className="fm-side__empty">{error}</div>}
        {!st && !error && <Loading />}
        {st && (
          <>
            <div className="fm-agents__limits">
              <div className="fm-agents__limits-line">
                <span className={`fm-tessera ${st.settings.enabled ? 'fm-tessera--ok' : 'fm-tessera--line'}`} aria-hidden />
                <span>
                  {st.settings.enabled ? 'Agents can ask agents' : 'Agents cannot wake agents'} · {st.settings.maxHops} hops · {st.settings.perThread}/thread · {st.settings.perAgentPerHour}/agent/h · {st.settings.perCompanyPerDay}/day
                </span>
                <button className="btn btn--sm btn--ghost" onClick={() => setEditing((x) => !x)}>
                  {editing ? 'Done' : 'Limits'}
                </button>
              </div>
              {editing && <LimitsEditor settings={st.settings} onSave={save} />}
            </div>
            {st.threads.length === 0 && (
              <div className="fm-side__empty">
                No agent conversations yet. When an agent asks another (forum_ask_agent, or an @mention in its post), the thread shows here with who asked whom, why and what it cost.
              </div>
            )}
            {st.threads.map((t) => (
              <ThreadCard key={t.threadMessageId || t.wakes[0].id} t={t} name={name} role={role} onOpen={() => openThread(ctx, t)} />
            ))}
          </>
        )}
      </div>
    </aside>
  )
}

function openThread(ctx: ReturnType<typeof useForumCtx>, t: CollabThread): void {
  if (!t.threadMessageId) return
  void hive.forum.thread({ messageId: t.threadMessageId }).then((th) => ctx.openThread(th.root), () => undefined)
}

function ThreadCard({ t, name, role, onOpen }: { t: CollabThread; name: (id: string) => string; role: (id: string) => string; onOpen: () => void }): React.JSX.Element {
  const ctx = useForumCtx()
  const ch = ctx.channels.find((c) => c.id === t.channelId)
  const cost = usd(t.costUsd, t.costEstimated)
  return (
    <div className={`fm-agents__thread ${t.threadMessageId ? '' : 'is-loose'}`} role={t.threadMessageId ? 'button' : undefined} tabIndex={t.threadMessageId ? 0 : undefined} onClick={onOpen} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <div className="fm-agents__meta">
        {ch?.name ? `#${ch.name}` : 'DM'}
        {t.ref ? ` · ${t.ref}` : ''} · {ago(t.lastAt)} · depth {t.maxDepth}
        {cost ? ` · ${cost}` : ''}
      </div>
      {t.threadMessageId && <div className="fm-agents__text">{t.text}</div>}
      {t.wakes.map((w) => (
        <WakeLine key={w.id} w={w} name={name} role={role} />
      ))}
    </div>
  )
}

function WakeLine({ w, name, role }: { w: CollabWake; name: (id: string) => string; role: (id: string) => string }): React.JSX.Element {
  const cost = usd(w.costUsd, w.costEstimated)
  const status = w.status === 'refused' ? REFUSAL_LABEL[w.refusal ?? ''] ?? 'refused' : w.status
  return (
    <div className={`fm-agents__wake is-${w.status}`}>
      <div className="fm-agents__route">
        <span className="fm-agents__hop">{w.depth}</span>
        <span title={role(w.fromMemberId)}>{name(w.fromMemberId)}</span>
        <span className="fm-agents__arrow" aria-hidden>
          →
        </span>
        <span title={role(w.toMemberId)}>{name(w.toMemberId)}</span>
        <span className={`fm-agents__status is-${w.status}`}>{status}</span>
        {w.via === 'mention' && <span className="fm-agents__via">mention</span>}
        {cost && <span className="fm-agents__cost">{cost}</span>}
      </div>
      {w.why && <div className="fm-agents__why">Why: {w.why}</div>}
      {w.status === 'refused' && w.note && <div className="fm-agents__why">{w.note}</div>}
      <div className="fm-agents__runs">
        {w.fromRunId && (
          <button className="fm-agents__run" onClick={(e) => (e.stopPropagation(), void navigate({ name: 'run', runId: w.fromRunId! }))}>
            asker run
          </button>
        )}
        {w.toRunId && (
          <button className="fm-agents__run" onClick={(e) => (e.stopPropagation(), void navigate({ name: 'run', runId: w.toRunId! }))}>
            reply run
          </button>
        )}
      </div>
    </div>
  )
}

function LimitsEditor({ settings, onSave }: { settings: AgentCollabSettings; onSave: (p: Partial<AgentCollabSettings>) => Promise<void> }): React.JSX.Element {
  const [draft, setDraft] = useState<AgentCollabSettings>(settings)
  useEffect(() => setDraft(settings), [settings])
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings)
  return (
    <div className="fm-agents__editor">
      <label className="fm-agents__field fm-agents__field--toggle">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
        <span>Agents can wake other agents</span>
      </label>
      {FIELDS.map((f) => {
        const [lo, hi] = AGENT_COLLAB_RANGES[f.key]
        return (
          <label key={f.key} className="fm-agents__field">
            <span>
              {f.label}
              {f.hint && <em> · {f.hint}</em>}
            </span>
            <input
              type="number"
              min={lo}
              max={hi}
              value={draft[f.key]}
              onChange={(e) => setDraft({ ...draft, [f.key]: Math.min(hi, Math.max(lo, Number(e.target.value) || lo)) })}
            />
          </label>
        )
      })}
      <div className="fm-agents__editor-foot">
        <button className="btn btn--sm btn--ghost" onClick={() => setDraft(DEFAULT_AGENT_COLLAB)}>
          Defaults
        </button>
        <button className="btn btn--sm btn--primary" disabled={!dirty} onClick={() => void onSave({ ...draft, waitMaxS: Math.max(draft.waitMaxS, draft.waitDefaultS) })}>
          Save limits
        </button>
      </div>
    </div>
  )
}
