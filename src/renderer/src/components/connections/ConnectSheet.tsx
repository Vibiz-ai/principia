/**
 * CONNECTIONS.md §4.2: the one connect flow for every surface. A service shows how this company has it (key, sign-in,
 * account, Principia's own connector), what that unlocks and what uses it, and offers the other ways to connect it:
 * "Use the one from Ledgerline" when another company of the founder has it, "Paste a key" (fields from the registry,
 * checked by main, stored encrypted, never shown again) and "Sign in" (browser OAuth, live through connections:changed).
 * The order follows the purpose that opened it: a key first for a dashboard, a sign-in first for agent tools. Once
 * connected here it is connected on every surface of the company, and the founder can let another company use it too
 * ("Also use in…"). Names, states and masked forms only: no key value ever arrives.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { keyAliases, keyForms, mcpForm, serviceById, type AuthForm, type FormEvidence, type Purpose, type ServiceDef, type ServiceKeyField, type ServiceSetting, type ServiceStatus } from '@shared/services'
import type { Id } from '@shared/types'
import { Button, Sheet } from '../ui'
import { Icon } from '../Icon'
import { errorMessage, hive, type RendererHiveError } from '../../lib/hive'
import { closeConnect, useConnection, useConnectRequest } from '../../state/connections'
import { activeCompany, navigate, toast, useStore } from '../../state/store'
import { serviceMonogram, stateTone, unlockedLine, unlocks, usedByLine } from '../../lib/serviceActions'
import '../../styles/connections.css'

type Tab = 'key' | 'signIn' | 'setup'
type KeyFormDef = Extract<AuthForm, { kind: 'key' }>
const SETUP_LABEL: Record<string, string> = { github: 'Use my GitHub login', instagram: 'Add the Instagram account', slack: 'Set up Slack', linear: 'Sync with the Board' }

/** Mounted once in App: the sheet any surface opens with openConnect(). It closes when the founder switches company. */
export function ConnectSheetHost(): React.JSX.Element | null {
  const req = useConnectRequest()
  const active = useStore((s) => activeCompany(s))
  const opened = useRef<{ nonce: number; active: string } | null>(null)
  useEffect(() => {
    if (!req) {
      opened.current = null
      return
    }
    if (opened.current?.nonce !== req.nonce) {
      opened.current = { nonce: req.nonce, active }
      return
    }
    // QP-4: a sheet for one company never stays over another company's screens (a key pasted there would go to the first)
    if (active !== opened.current.active) closeConnect()
  }, [req, active])
  if (!req) return null
  return <ConnectSheet key={req.nonce} companyId={req.companyId} serviceId={req.serviceId} purpose={req.purpose} onClose={closeConnect} />
}

/** The line-art roundel every service wears (white strokes, the service's two letters): the one monogram everywhere. */
export function ServiceRoundel({ name, size = 28 }: { name: string; size?: number }): React.JSX.Element {
  return (
    <span className="cx-roundel" style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 32 32" width={size} height={size}>
        <circle cx="16" cy="16" r="15" className="cx-roundel__outer" />
        <circle cx="16" cy="16" r="12.5" className="cx-roundel__inner" />
      </svg>
      <span className="cx-roundel__text" style={size < 24 ? { fontSize: 7.5 } : undefined}>
        {serviceMonogram(name)}
      </span>
    </span>
  )
}

function tabsFor(s: ServiceDef, purpose?: Purpose): Tab[] {
  const tabs: Tab[] = []
  const mcp = mcpForm(s)
  if (keyForms(s).length) tabs.push('key')
  if (mcp && mcp.auth === 'oauth' && !mcp.setupRequired) tabs.push('signIn')
  if (s.forms.some((f) => f.kind === 'account' || f.kind === 'connector')) tabs.push('setup')
  // the purpose's own preference first (a key for a dashboard, a sign-in for tools), then the registry's order
  const cap = purpose ? s.capabilities.find((c) => c.purpose === purpose) : undefined
  const pref = (cap?.via ?? s.forms.map((f) => f.kind)).map((k): Tab => (k === 'key' ? 'key' : k === 'mcp' ? 'signIn' : 'setup'))
  const rank = (t: Tab): number => {
    const i = pref.indexOf(t)
    return i < 0 ? 9 : i
  }
  return tabs.sort((a, b) => rank(a) - rank(b))
}

/** Every key name this status holds, under its canonical name too (POSTHOG_API_KEY counts as POSTHOG_PERSONAL_API_KEY). */
function heldKeyNames(s: ServiceDef, status: ServiceStatus | null): Set<string> {
  const names = new Set<string>()
  for (const f of status?.forms ?? []) if (f.kind === 'key' && !f.reused) for (const k of f.keyNames ?? []) names.add(k.name)
  for (const field of keyForms(s).flatMap((f) => f.keys)) if (keyAliases(field.name).some((a) => names.has(a))) names.add(field.name)
  return names
}

/** The key forms a purpose can use, the plain ones first and the advanced ones (a secret key) apart. */
function keyFormsFor(s: ServiceDef, purpose?: Purpose): { plain: KeyFormDef[]; advanced: KeyFormDef[] } {
  const all = keyForms(s)
  const fits = purpose && all.some((f) => !f.serves || f.serves.includes(purpose)) ? all.filter((f) => !f.serves || f.serves.includes(purpose)) : all
  return { plain: fits.filter((f) => !f.advanced), advanced: fits.filter((f) => f.advanced) }
}

const formLabel = (f: FormEvidence, s: ServiceDef): string =>
  f.kind === 'key' ? 'Key' : f.kind === 'mcp' ? (f.virtual ? `Agents use ${s.name}’s tools` : f.auth === 'oauth' ? 'Sign-in' : 'MCP connection') : f.kind === 'account' ? 'Account' : 'Principia'

export function ConnectSheet({ companyId, serviceId, purpose, onClose }: { companyId: Id; serviceId: string; purpose?: Purpose; onClose: () => void }): React.JSX.Element | null {
  const s = serviceById(serviceId)
  const { status } = useConnection(companyId, serviceId)
  const company = useStore((st) => st.companies.find((c) => c.id === companyId))
  const allTabs = useMemo(() => (s ? tabsFor(s, purpose) : []), [s, purpose])
  // "Paste a restricted key" from a purpose this connection can't do yet: that key form, on the key tab
  const [want, setWant] = useState<{ purpose: Purpose; key: string } | null>(null)
  const sources = useSources(companyId, serviceId, status)
  // once connected, "Add another way" offers only what the company doesn't have yet (a key form it lacks, a sign-in)
  const held = (t: Tab): boolean => {
    if (!s || !status) return false
    if (t === 'signIn') return status.forms.some((f) => f.kind === 'mcp' && !f.virtual && f.auth === 'oauth' && f.state === 'connected')
    if (t === 'setup') return status.forms.some((f) => (f.kind === 'account' || f.kind === 'connector') && f.state === 'connected')
    const names = heldKeyNames(s, status)
    return keyForms(s).filter((f) => !f.advanced).every((f) => f.keys.filter((k) => k.required).every((k) => names.has(k.name)))
  }
  const attention = status?.state === 'attention'
  // a turned-down key keeps the key tab (to paste a new one)
  const tabs = allTabs.filter((t) => !held(t) || (t === 'key' && attention))
  // a connected service whose missing purposes a key fixes opens on the key tab
  const missingKey = !!status && Object.values(status.purposes).some((p) => p && !p.ok && p.fix === 'key')
  const ordered = status?.state === 'connected' && missingKey && tabs.includes('key') ? ['key' as Tab, ...tabs.filter((t) => t !== 'key')] : tabs
  const [picked, setTab] = useState<Tab | null>(null)
  const tab = want && ordered.includes('key') ? 'key' : picked && ordered.includes(picked) ? picked : (ordered[0] ?? null)
  if (!s) return null
  const companyName = company?.name ?? 'this company'
  const connected = status?.state === 'connected' || status?.state === 'attention' || status?.state === 'waiting'
  const cap = purpose ? s.capabilities.find((c) => c.purpose === purpose) : undefined
  const purposeState = purpose ? status?.purposes[purpose] : undefined
  const title = connected ? s.name : `Connect ${s.name}`
  const keyPurpose = want?.purpose ?? purpose
  return (
    <Sheet
      title={title}
      width={620}
      onCancel={onClose}
      cancelLabel={connected ? 'Done' : 'Cancel'}
      footerLeft={
        tab === 'key' ? (
          <span className="cx-sheet__safe">
            <Icon name="lock" size={11} /> Stored encrypted for {companyName}. Keys are never shown again.
          </span>
        ) : undefined
      }
    >
      <div className="cx-sheet">
        <div className="cx-sheet__head">
          <ServiceRoundel name={s.name} size={40} />
          <div>
            <p className="cx-sheet__blurb">{s.blurb}</p>
            {status && <span className={`s5-chip s5-chip--${stateTone(status)}`}>{status.chip}</span>}
          </div>
        </div>
        {cap && purposeState && !purposeState.ok && purposeState.why && !connected && <p className="cx-sheet__why">{purposeState.why}</p>}
        {status && connected && <Holding status={status} companyId={companyId} companyName={companyName} s={s} onWant={(p, key) => setWant({ purpose: p, key })} />}
        {!connected && <Unlocks status={status} s={s} />}
        {status?.suggested?.length && !connected ? <Suggested status={status} s={s} companyId={companyId} /> : null}
        {s.note && <p className="cx-sheet__p">{s.note}</p>}
        {!connected && sources.length > 0 && <UseFrom sources={sources} s={s} companyId={companyId} companyName={companyName} onDone={onClose} />}
        {ordered.length > 0 && (
          <>
            <div className="cx-sheet__sub">{connected ? (attention ? 'Fix it' : 'Add another way') : sources.length ? 'Or connect its own' : 'How to connect'}</div>
            {ordered.length > 1 && (
              <div className="cx-tabs" role="tablist">
                {ordered.map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    className="cx-tab"
                    aria-selected={tab === t}
                    onClick={() => {
                      setWant(null)
                      setTab(t)
                    }}
                  >
                    {t === 'key' ? 'Paste a key' : t === 'signIn' ? 'Sign in' : s.forms.some((f) => f.kind === 'connector') ? 'Principia’s connector' : 'Account'}
                  </button>
                ))}
              </div>
            )}
            {tab === 'key' && <KeyForm key={want?.key ?? 'any'} s={s} status={status} companyId={companyId} companyName={companyName} purpose={keyPurpose} prefer={want?.key} withSettings={!connected} onDone={onClose} />}
            {tab === 'signIn' && <SignIn s={s} status={status} companyId={companyId} companyName={companyName} onDone={onClose} />}
            {tab === 'setup' && <Setup s={s} companyId={companyId} onDone={onClose} />}
          </>
        )}
        {s.soon && <p className="cx-sheet__p">Coming soon: nothing to connect yet.</p>}
      </div>
    </Sheet>
  )
}

/** CONN-QA-07: the founder's other companies that have this service themselves (main decides; names only). */
function useSources(companyId: Id, serviceId: string, status: ServiceStatus | null): { companyId: Id; name: string }[] {
  const [list, setList] = useState<{ companyId: Id; name: string }[]>([])
  const notConnected = !status || status.state === 'notConnected' || status.state === 'setup'
  useEffect(() => {
    if (!notConnected) {
      setList([])
      return
    }
    let live = true
    hive.connections
      .sources({ companyId, serviceId })
      .then((l) => live && setList(l))
      .catch(() => live && setList([]))
    return () => {
      live = false
    }
  }, [companyId, serviceId, notConnected])
  return list
}

/** "Use the one from Ledgerline": one explicit click, a reference to that company's connection (never a copy). */
function UseFrom({ sources, s, companyId, companyName, onDone }: { sources: { companyId: Id; name: string }[]; s: ServiceDef; companyId: Id; companyName: string; onDone: () => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const use = async (from: { companyId: Id; name: string }): Promise<void> => {
    setBusy(true)
    try {
      const st = await hive.connections.reuse({ companyId, serviceId: s.id, from: from.companyId })
      toast(`${companyName} now uses ${from.name}’s ${s.name}${unlockedLine(st) ? `: ${unlockedLine(st)}` : ''}. Nothing was copied; it stops here if ${from.name} disconnects it.`)
      onDone()
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="cx-usefrom">
      <div className="cx-sheet__sub">Already connected in another company</div>
      {sources.map((src) => (
        <div key={src.companyId} className="cx-row">
          <ServiceRoundel name={s.name} />
          <div className="cx-row__id">
            <span className="cx-row__name">{src.name}’s {s.name}</span>
            <span className="cx-row__line">{companyName} reads it from {src.name}. Its settings stay {src.name}’s.</span>
          </div>
          <div className="cx-row__acts">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void use(src)}>
              Use the one from {src.name}
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}

/** SEC-1: saved connections that only look like this service: the founder says whether one is (agent tools only). */
function Suggested({ status, s, companyId }: { status: ServiceStatus; s: ServiceDef; companyId: Id }): React.JSX.Element {
  const use = async (connectionId: string): Promise<void> => {
    try {
      await hive.connections.confirm({ companyId, serviceId: s.id, connectionId })
      toast(`Agents use that connection for ${s.name} now. Dashboards still need ${s.name}’s own sign-in or a key.`)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }
  return (
    <div className="cx-forms">
      {(status.suggested ?? []).map((c) => (
        <div key={c.connectionId} className="cx-form">
          <Icon name="link" size={12} />
          <span className="flex1">
            “{c.name}” at <code>{c.host}</code> looks like {s.name}, but it isn’t {s.name}’s own server. Is it yours?
          </span>
          <button type="button" className="link-btn" onClick={() => void use(c.connectionId)}>
            Use it for agents
          </button>
        </div>
      ))}
    </div>
  )
}

/** How this company has it now, what uses it, what it can't do yet, its shared settings, reuse, and Disconnect. */
function Holding({ status, companyId, companyName, s, onWant }: { status: ServiceStatus; companyId: Id; companyName: string; s: ServiceDef; onWant: (purpose: Purpose, key: string) => void }): React.JSX.Element {
  const companies = useStore((st) => st.companies)
  const borrowers = new Set(status.usedBy.filter((u) => u.kind === 'company' && u.id).map((u) => u.id!))
  const others = companies.filter((c) => c.id !== companyId && c.system !== 'personal' && !c.archivedAt && !borrowers.has(c.id))
  const [busy, setBusy] = useState(false)
  const used = usedByLine(status)
  // QA-05: a borrowed connection is the other company's to disconnect; here it can only stop being used
  const own = status.forms.some((f) => !f.reused && (f.kind === 'key' ? f.keyNames?.some((k) => k.source === 'company') : f.kind === 'mcp' && !f.virtual))
  const disconnect = async (): Promise<void> => {
    setBusy(true)
    try {
      const st = await hive.connections.disconnect({ companyId, serviceId: s.id, forms: ['key', 'mcp'] })
      if (st.state === 'notConnected') toast(`${s.name} disconnected from ${companyName}.`)
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  const alsoUseIn = async (other: Id): Promise<void> => {
    const name = companies.find((c) => c.id === other)?.name ?? 'that company'
    try {
      await hive.connections.reuse({ companyId: other, serviceId: s.id, from: companyId })
      toast(`${name} now uses ${companyName}’s ${s.name}. Nothing was copied; disconnecting it here stops it there too.`)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }
  const stopReuse = async (): Promise<void> => {
    try {
      await hive.connections.reuse({ companyId, serviceId: s.id, from: null })
      toast(`${companyName} no longer uses ${status.sharedFrom?.name ?? 'the other company'}’s ${s.name}.`)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }
  const keyTools = async (on: boolean): Promise<void> => {
    try {
      await hive.connections.keyTools({ companyId, serviceId: s.id, on })
      toast(on ? `Agents get ${s.name}’s tools with the sync key from their next session.` : `Agents no longer get ${s.name}’s tools from the sync key.`)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }
  // QA-03: what this connection can't do yet, with the one key that does it
  const missing = s.capabilities.map((c) => ({ c, p: status.purposes[c.purpose] })).filter((x) => x.p && !x.p.ok && x.p.why)
  const fixField = (key: string): ServiceKeyField | undefined => keyForms(s).flatMap((f) => f.keys).find((k) => k.name === key)
  return (
    <>
      <div className="cx-sheet__sub">How {companyName} has it</div>
      <div className="cx-forms">
        {status.forms.map((f, i) => (
          <div key={i} className="cx-form">
            <span className={`cx-dot cx-dot--${f.state === 'connected' ? 'ok' : f.state === 'waiting' ? 'run' : f.state === 'attention' ? 'needs' : 'grey'}`} />
            <span>
              {formLabel(f, s)}: <code>{f.detail}</code>
              {f.problem ? ` · ${f.problem}` : ''}
            </span>
          </div>
        ))}
        {status.keyTools !== undefined && status.forms.some((f) => f.kind === 'key' && f.state === 'connected') && (
          <div className="cx-form">
            <Icon name="link" size={12} />
            <span className="flex1">{status.keyTools ? `Agents also use ${s.name}’s tools with the sync key.` : `The key is the Board sync’s. Agents don’t get ${s.name}’s tools from it unless you turn that on.`}</span>
            <button type="button" className="link-btn" onClick={() => void keyTools(!status.keyTools)}>
              {status.keyTools ? 'Turn off' : 'Turn on'}
            </button>
          </div>
        )}
      </div>
      <Unlocks status={status} s={s} />
      {missing.map(({ c, p }) => {
        const k = p!.fixKey ? fixField(p!.fixKey) : undefined
        return (
          <div key={c.purpose} className="cx-missing">
            <span className="cx-row__line is-why">{p!.why}</span>
            {k && !status.sharedFrom && (
              <Button size="sm" onClick={() => onWant(c.purpose, k.name)}>
                Paste a {k.label.replace(/\s*\(.*?\)/g, '').toLowerCase()}
              </Button>
            )}
          </div>
        )
      })}
      <p className="cx-sheet__p">{used ? <>Used by: {used}.</> : 'Nothing uses it yet. Dashboards, agents and autopilots here pick it up on their own.'}</p>
      {!!s.settings?.length &&
        (status.sharedFrom ? (
          <p className="cx-sheet__p">Settings come from {status.sharedFrom.name}: {settingsLine(s, status.settings) || 'none set'}. Change them in {status.sharedFrom.name}.</p>
        ) : (
          <SettingsForm s={s} status={status} companyId={companyId} />
        ))}
      <div className="cx-reuse">
        {others.length > 0 && !status.sharedFrom && own && status.state === 'connected' && (
          <select className="input input--sm" aria-label="Also use in another company" value="" onChange={(e) => e.target.value && void alsoUseIn(e.target.value)}>
            <option value="">Also use in…</option>
            {others.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <span className="flex1" />
        {status.sharedFrom && !own ? (
          <Button size="sm" variant="ghost" onClick={() => void stopReuse()}>
            Stop using {status.sharedFrom.name}’s {s.name}
          </Button>
        ) : (
          <>
            {status.sharedFrom && (
              <button type="button" className="link-btn" onClick={() => void stopReuse()}>
                Stop using {status.sharedFrom.name}’s
              </button>
            )}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void disconnect()}>
              Disconnect…
            </Button>
          </>
        )}
      </div>
    </>
  )
}

const settingsLine = (s: ServiceDef, v: Record<string, string>): string =>
  (s.settings ?? [])
    .filter((f) => v[f.key])
    .map((f) => `${f.label} ${f.choices?.find((c) => c.value && c.value === v[f.key])?.label ?? v[f.key]}`)
    .join(', ')

/** One setting: a choice (US / EU / self-hosted) or a field, with where to find it and why it matters. */
function SettingField({ f, value, onChange }: { f: ServiceSetting; value: string; onChange: (v: string) => void }): React.JSX.Element {
  const known = f.choices?.find((c) => c.value && c.value === value)
  const [custom, setCustom] = useState(!!value && !known && !!f.choices)
  return (
    <label className="dep-field">
      <span>{f.label}</span>
      <span className="dep-field__col">
        {f.choices ? (
          <span className="cx-choices" role="radiogroup" aria-label={f.label}>
            {f.choices.map((c) => {
              const on = c.value ? value === c.value && !custom : custom
              return (
                <button
                  key={c.label}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className="dsh-keychip"
                  onClick={() => {
                    setCustom(!c.value)
                    onChange(c.value)
                  }}
                >
                  {c.label}
                </button>
              )
            })}
          </span>
        ) : (
          <input className="input" value={value} placeholder={f.placeholder ?? ''} onChange={(e) => onChange(e.target.value)} />
        )}
        {f.choices && custom && <input className="input" value={value} placeholder="https://posthog.example.com" aria-label={`${f.label} address`} onChange={(e) => onChange(e.target.value)} />}
        <span className="dep-field__hint">
          {[f.hint, f.needed ?? (f.choices ? null : 'Optional.'), custom ? 'Your key is sent to this address: use only your own server.' : null].filter(Boolean).join(' ')}
        </span>
      </span>
    </label>
  )
}

/** Non-secret settings every surface shares (PostHog's region and project). */
function SettingsForm({ s, status, companyId }: { s: ServiceDef; status: ServiceStatus | null; companyId: Id }): React.JSX.Element {
  const [vals, setVals] = useState<Record<string, string>>(() => ({ ...(status?.settings ?? {}) }))
  const dirty = (s.settings ?? []).some((f) => (vals[f.key] ?? '') !== (status?.settings[f.key] ?? ''))
  const save = async (): Promise<void> => {
    try {
      await hive.connections.settings({ companyId, serviceId: s.id, settings: vals })
      toast(`${s.name} settings saved. Dashboards and links use them.`)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }
  return (
    <div className="dep-form">
      {(s.settings ?? []).map((f) => (
        <SettingField key={f.key} f={f} value={vals[f.key] ?? ''} onChange={(v) => setVals({ ...vals, [f.key]: v })} />
      ))}
      {dirty && (
        <div className="s5-sheet__row">
          <Button size="sm" onClick={() => void save()}>
            Save settings
          </Button>
        </div>
      )}
    </div>
  )
}

/** "Unlocks: dashboard, agent tools, session replays", ticked for what this connection does now. */
function Unlocks({ status, s }: { status: ServiceStatus | null; s: ServiceDef }): React.JSX.Element | null {
  const list = unlocks(status, s.id)
  if (!list.length) return null
  return (
    <div className="cx-unlocks" aria-label="What it unlocks">
      {list.map((u) => (
        <span key={u.purpose} className={`cx-unlock ${u.ok ? 'is-ok' : ''}`}>
          {u.ok && <Icon name="check" size={10} />}
          {u.label}
        </span>
      ))}
    </div>
  )
}

/** QA-03: what one key form unlocks and can't do, from its own `serves` (never per tab). */
function formReach(s: ServiceDef, f: KeyFormDef): { can: string[]; cannot: string[]; then: string } {
  const can: string[] = []
  const cannot: string[] = []
  let byKey = false
  let bySignIn = false
  for (const c of s.capabilities) {
    const ok = c.via.includes('key') ? !f.serves || f.serves.includes(c.purpose) : (c.via.includes('mcp') && !!mcpForm(s)?.bearerFromKey && f.keys.some((k) => k.name === mcpForm(s)!.bearerFromKey!.key))
    ;(ok ? can : cannot).push(c.label.toLowerCase())
    if (!ok && c.via.includes('key')) byKey = true
    if (!ok && c.via.includes('mcp') && mcpForm(s)) bySignIn = true
  }
  const then = byKey && bySignIn ? ': that needs another key or a sign-in.' : byKey ? ': that needs another key.' : bySignIn ? ': sign in for that.' : '.'
  return { can, cannot, then }
}

function KeyForm({ s, status, companyId, companyName, purpose, prefer, withSettings, onDone }: { s: ServiceDef; status: ServiceStatus | null; companyId: Id; companyName: string; purpose?: Purpose; prefer?: string; withSettings: boolean; onDone: () => void }): React.JSX.Element {
  const { plain, advanced } = keyFormsFor(s, purpose)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const forms = showAdvanced ? [...plain, ...advanced] : plain.length ? plain : advanced
  const first = Math.max(0, prefer ? forms.findIndex((f) => f.keys.some((k) => k.name === prefer)) : 0)
  const [pick, setPick] = useState(first)
  const form = forms[Math.min(pick, forms.length - 1)]!
  const [pasted, setPasted] = useState<Record<string, string>>({})
  const [settings, setSettings] = useState<Record<string, string>>(() => ({ ...(status?.sharedFrom ? {} : (status?.settings ?? {})) }))
  // a key the vendor turned down opens ready for a new one
  const [replace, setReplace] = useState<Record<string, boolean>>(() => {
    const out: Record<string, boolean> = {}
    for (const f of status?.forms ?? []) if (f.kind === 'key' && f.state === 'attention') for (const field of keyForms(s).flatMap((x) => x.keys)) if (f.keyNames?.some((k) => k.name === field.name || keyAliases(field.name).includes(k.name))) out[field.name] = true
    return out
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const saved = (k: ServiceKeyField): { name: string; source: string | null; masked: string | null } | null => {
    // a key saved under an older name (POSTHOG_API_KEY) is this field's key too
    const names = [k.name, ...keyAliases(k.name)]
    for (const f of status?.forms ?? []) for (const n of f.keyNames ?? []) if (names.includes(n.name) && n.source) return n
    return null
  }
  const filled = form.keys.filter((k) => (pasted[k.name] ?? '').trim())
  const ready = filled.length > 0 && form.keys.filter((k) => k.required).every((k) => (pasted[k.name] ?? '').trim() || saved(k))
  const reach = formReach(s, form)
  const submit = async (): Promise<void> => {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      const keys = Object.fromEntries(filled.map((k) => [k.name, pasted[k.name]!]))
      const clean = Object.fromEntries(Object.entries(settings).filter(([, v]) => v.trim()))
      const st = await hive.connections.connectKey({ companyId, serviceId: s.id, keys, ...(Object.keys(clean).length ? { settings: clean } : {}), ...(purpose ? { purpose } : {}) })
      // the pasted values are dropped here; main has them and never sends them back
      setPasted({})
      // QA-01 / QA-03: say what the key actually unlocked, and whether the vendor checked it
      const did = unlockedLine(st)
      const still = Object.values(st.purposes).filter((p) => p && !p.ok).map((p) => p!.label.toLowerCase())
      const check = st.checked === 'ok' ? `${s.name} checked the key.` : st.checked === 'unchecked' ? `Saved, not checked: ${s.name} couldn’t be reached. Principia checks it again when it’s used.` : ''
      toast([`${s.name} connected for ${companyName}${did ? `: ${did}` : ''}.`, check, still.length ? `Not yet: ${still.join(', ')}.` : 'Agents get it from their next session.'].filter(Boolean).join(' '))
      onDone()
    } catch (e) {
      setError(errorMessage(e) || (e as RendererHiveError).errors?.[0]?.message || 'That key could not be saved.')
    } finally {
      setBusy(false)
    }
  }
  const open = (url: string): void => void hive.app.openExternal({ url }).catch(() => undefined)
  return (
    <div className="dsh-install">
      {s.keyGuide && forms.length > 1 && <p className="cx-sheet__p">{s.keyGuide}</p>}
      {forms.length > 1 && (
        <div className="cx-keyforms" role="radiogroup" aria-label="Which key">
          {forms.map((f, i) => (
            <button key={f.keys[0]!.name} type="button" className="dsh-keychip" role="radio" aria-checked={i === pick} style={i === pick ? { color: 'var(--text-primary)', borderColor: 'rgba(255,255,255,.6)' } : undefined} onClick={() => setPick(i)}>
              {f.keys.map((k) => k.label).join(' + ')}
            </button>
          ))}
        </div>
      )}
      {form.good && <p className="cx-sheet__p">{form.good}</p>}
      {(reach.can.length > 0 || reach.cannot.length > 0) && (
        <p className="cx-sheet__p cx-sheet__reach">
          {reach.can.length > 0 && <>This key unlocks: {reach.can.join(', ')}. </>}
          {reach.cannot.length > 0 && <>It can’t do {reach.cannot.join(', ')}{reach.then}</>}
        </p>
      )}
      {error && (
        <div className="cx-sheet__err" role="alert">
          {error}
        </div>
      )}
      {form.keys.map((k) => {
        const have = saved(k)
        const showInput = !have || replace[k.name]
        return (
          <div key={k.name} className="dsh-key">
            <div className="dsh-key__head">
              <span className="dsh-key__label">
                {k.label}
                {!k.required && <span className="dsh-key__opt"> · optional</span>}
              </span>
              <code className="dsh-key__name">{k.name}</code>
              <span className="flex1" />
              <button type="button" className="dep-link" onClick={() => open(k.link)}>
                {k.linkLabel} <Icon name="external" size={10} />
              </button>
            </div>
            <p className="dsh-key__hint">{k.hint}</p>
            {have && !replace[k.name] && (
              <div className="dsh-key__saved">
                <Icon name="check" size={12} />
                <span>
                  Saved in {have.source === 'shared' ? 'Shared' : have.source === 'reused' ? 'another company' : 'this company'}
                  {have.name !== k.name ? ` as ${have.name}` : ''} <span className="dsh-key__mask">{have.masked}</span>
                </span>
                <span className="flex1" />
                <button type="button" className="dep-link" onClick={() => setReplace({ ...replace, [k.name]: true })}>
                  {have.name !== k.name ? `Replace (saves as ${k.name})` : 'Replace'}
                </button>
              </div>
            )}
            {showInput &&
              (k.multiline ? (
                <textarea className="input dsh-key__input dsh-key__input--multi" rows={4} spellCheck={false} autoComplete="off" placeholder={k.placeholder} aria-label={k.label} value={pasted[k.name] ?? ''} onChange={(e) => setPasted({ ...pasted, [k.name]: e.target.value })} />
              ) : (
                <input className="input dsh-key__input" type="password" spellCheck={false} autoComplete="off" placeholder={k.placeholder} aria-label={k.label} value={pasted[k.name] ?? ''} onChange={(e) => setPasted({ ...pasted, [k.name]: e.target.value })} />
              ))}
          </div>
        )
      })}
      {withSettings && !!s.settings?.length && (
        <div className="dep-form">
          {s.settings.map((f) => (
            <SettingField key={f.key} f={f} value={settings[f.key] ?? ''} onChange={(v) => setSettings({ ...settings, [f.key]: v })} />
          ))}
        </div>
      )}
      <div className="s5-sheet__row">
        {advanced.length > 0 && !showAdvanced && plain.length > 0 && (
          <button type="button" className="link-btn" onClick={() => setShowAdvanced(true)}>
            Advanced: {advanced.map((f) => f.keys.map((k) => k.label).join(' + ').toLowerCase()).join(', ')}
          </button>
        )}
        {showAdvanced && form.advanced && <span className="cx-sheet__why">{form.good ?? 'Advanced: use only if you know you need it.'}</span>}
        <span className="flex1" />
        <Button variant="primary" disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? 'Checking…' : `Connect ${s.name}`}
        </Button>
      </div>
    </div>
  )
}

function SignIn({ s, status, companyId, companyName, onDone }: { s: ServiceDef; status: ServiceStatus | null; companyId: Id; companyName: string; onDone: () => void }): React.JSX.Element {
  const [started, setStarted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const signedIn = !!status?.forms.some((f) => f.kind === 'mcp' && !f.virtual && f.auth === 'oauth' && f.state === 'connected')
  const waiting = !!status?.forms.some((f) => f.kind === 'mcp' && f.state === 'waiting')
  const was = useRef(signedIn)
  useEffect(() => {
    // the sign-in landed (connections:changed): every slot already shows it; close with one line
    if (started && signedIn && !was.current) {
      toast(`${s.name} connected for ${companyName}. Agents get its tools from their next session.`)
      onDone()
    }
    was.current = signedIn
  }, [signedIn, started, s.name, companyName, onDone])
  const go = async (): Promise<void> => {
    setError(null)
    setStarted(true)
    try {
      await hive.connections.signIn({ companyId, serviceId: s.id })
      toast(`Finish signing in to ${s.name} in your browser. ${companyName}’s agents get it as soon as you do.`)
    } catch (e) {
      setStarted(false)
      setError(errorMessage(e))
    }
  }
  const cannot = s.capabilities.filter((c) => !c.via.includes('mcp')).map((c) => c.label.toLowerCase())
  return (
    <div className="cx-sheet">
      <p className="cx-sheet__p">
        Your browser opens {s.name}’s own sign-in. Principia never sees your password; the sign-in belongs to {companyName} only.
        {cannot.length > 0 && ` A sign-in can’t do ${cannot.join(', ')}: paste a key for that.`}
      </p>
      {error && (
        <div className="cx-sheet__err" role="alert">
          {error}
        </div>
      )}
      <div className="s5-sheet__row">
        {waiting && <span className="cx-sheet__safe">Waiting for you to finish in the browser…</span>}
        <span className="flex1" />
        <Button variant="primary" disabled={started && waiting} onClick={() => void go()}>
          {signedIn ? `Sign in to ${s.name} again` : `Sign in to ${s.name}`}
        </Button>
      </div>
    </div>
  )
}

function Setup({ s, companyId, onDone }: { s: ServiceDef; companyId: Id; onDone: () => void }): React.JSX.Element {
  const f = s.forms.find((x) => x.kind === 'account' || x.kind === 'connector')
  const id = f?.kind === 'account' ? f.account : f?.kind === 'connector' ? f.connector : s.id
  return (
    <div className="s5-sheet__row">
      <span className="cx-sheet__p">{f?.kind === 'connector' ? `Principia’s own ${s.name} connector, set up on its card.` : `Uses your ${s.name} account, set up on its card.`}</span>
      <span className="flex1" />
      <Button
        onClick={() => {
          onDone()
          void navigate({ name: 'settings', section: 'connections', companyId, connect: id, nonce: Date.now() })
        }}
      >
        {SETUP_LABEL[id] ?? `Set up ${s.name}`}
      </Button>
    </div>
  )
}
