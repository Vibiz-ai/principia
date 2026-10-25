/**
 * Settings › This company › Connections (five doors step 4, design §4.10). One catalog for one company: search,
 * Connected, Popular for {company} (consumer tools first, developer tools first in a code company), More tools, For
 * developers, Custom (MCP) last. Every card shows one state and one button; a connected tool shows once. Instagram,
 * GitHub and Linear open their own sheets; an MCP tool connects in one click (browser sign-in) and belongs to this
 * company only.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CompanyPassport } from '@shared/company'
import type { GatewayConnection } from '@shared/gateway'
import { Button, Sheet } from '../ui'
import { Icon } from '../Icon'
import { GatewayConnections } from '../GatewayConnections'
import { SlackConnectionCard } from '../slack/SetupGuide'
import { buildCatalog, GROUP_TITLE, searchCards, type CardGroup, type ConnCard } from '../../lib/connections'
import { CONNECTION_CATALOG } from '../../lib/connectionCatalog'
import { routeAsk } from '../../lib/desk'
import { syncedAgo, useLinear } from '../../lib/linear'
import { confirmNative, errorMessage, hive, useHiveEvent } from '../../lib/hive'
import { useIsCode } from '../desk/Desk'
import { useDeskAgents } from '../../state/desk'
import { loadSlack, useSlack } from '../../state/slack'
import { navigate, toast } from '../../state/store'
import { InstagramSheet } from './InstagramSheet'
import { GithubSheet, useGhLogin } from './GithubSheet'
import { LinearConnectSheet } from './LinearConnectSheet'
import '../../styles/settings5.css'

export type ConnectSheet = 'instagram' | 'github' | 'linear' | 'slack'

export function ConnectionsPage({ company, open: openFirst }: { company: CompanyPassport; open?: ConnectSheet | null }): React.JSX.Element {
  const code = useIsCode(company.id)
  const agents = useDeskAgents(company.id)
  const writer = useMemo(() => (agents.length ? (routeAsk('write this week’s instagram posts', agents)?.agent.name ?? null) : null), [agents])
  const [connections, setConnections] = useState<GatewayConnection[] | null>(null)
  const [keyNames, setKeyNames] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [sheet, setSheet] = useState<ConnectSheet | null>(openFirst ?? null)
  const [editor, setEditor] = useState<{ connectionId: string | null } | null>(null)
  const [manage, setManage] = useState<GatewayConnection | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const gh = useGhLogin()
  const slackAvailable = useSlack((s) => s.available)
  const slackStatus = useSlack((s) => s.status)
  const { status: linear, reload: reloadLinear } = useLinear(company.id)
  const n = useRef(0)
  const load = (): void => {
    const k = ++n.current
    void hive.gateway.list({ companyId: company.id }).then((l) => n.current === k && setConnections(l), () => n.current === k && setConnections([]))
    void hive.secrets.list({ companyId: company.id }).then((l) => n.current === k && setKeyNames(new Set(l.filter((s) => s.companyId === company.id).map((s) => s.name))), () => undefined)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [company.id])
  useEffect(() => setSheet(openFirst ?? null), [openFirst])
  useEffect(() => {
    if (slackAvailable === null) void loadSlack()
  }, [slackAvailable])
  useHiveEvent('data:changed', ({ domain }) => (domain === 'secrets' || domain === 'company') && load())
  // a browser sign-in in flight: poll until it lands
  const waiting = connections?.some((c) => c.authStatus === 'connecting')
  useEffect(() => {
    if (!waiting) return
    const t = setInterval(load, 1500)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting])

  const slack = slackAvailable === false ? 'unavailable' : slackStatus?.state === 'connected' ? 'connected' : slackStatus && slackStatus.state !== 'disabled' ? 'set-up' : 'none'
  const cards = useMemo(
    () =>
      buildCatalog({
        companyId: company.id,
        companyName: company.name,
        code,
        writer,
        accounts: company.accounts,
        connections: connections ?? [],
        gh,
        slack,
        linear: { connected: !!linear?.connected, teamKey: linear?.team?.key ?? null, problem: linear?.connected && linear.state === 'auth' ? (linear.message ?? 'Linear turned down the key.') : null, offline: linear?.connected && (linear.state === 'network' || linear.state === 'error') ? { kind: linear.state, synced: syncedAgo(linear.lastSyncedAt) } : null },
        instagramKey: keyNames.has('INSTAGRAM_ACCESS_TOKEN'),
        personal: company.system === 'personal'
      }),
    [company, code, writer, connections, gh, slack, linear, keyNames]
  )
  const shown = useMemo(() => searchCards(cards, query), [cards, query])
  const groups = useMemo(() => {
    const m = new Map<CardGroup, ConnCard[]>()
    for (const c of shown) m.set(c.group, [...(m.get(c.group) ?? []), c])
    return [...m.entries()]
  }, [shown])

  const connectPreset = async (presetId: string): Promise<void> => {
    const p = CONNECTION_CATALOG.find((x) => x.id === presetId)
    if (!p) return
    setBusy(presetId)
    try {
      const id = `connection-${crypto.randomUUID()}`
      await hive.gateway.save({ id, name: p.name, transport: 'http', url: p.url, authentication: p.auth === 'oauth' ? 'oauth' : 'none', enabled: true, roots: [], scope: 'global', companyIds: [company.id] })
      if (p.auth === 'oauth') {
        await hive.gateway.connect({ id })
        toast(`Finish signing in to ${p.name} in your browser. ${company.name}’s agents get it as soon as you do.`)
      }
      load()
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(null)
    }
  }
  const act = (c: ConnCard): void => {
    const a = c.action
    if (a.kind === 'instagram' || a.kind === 'github' || a.kind === 'linear' || a.kind === 'slack') return setSheet(a.kind)
    if (a.kind === 'preset') return void connectPreset(a.presetId)
    if (a.kind === 'custom') return setEditor({ connectionId: null })
    if (a.kind === 'manage' || a.kind === 'signIn') {
      const conn = connections?.find((x) => x.id === a.connectionId)
      if (!conn) return
      if (a.kind === 'signIn') return void hive.gateway.connect({ id: conn.id }).then(() => (toast('Continue in your browser to finish signing in.'), load()), (e) => toast(errorMessage(e), 'error'))
      return setManage(conn)
    }
    if (a.kind === 'guide') {
      const p = CONNECTION_CATALOG.find((x) => x.id === a.presetId)
      if (p) void hive.app.openExternal({ url: p.docs }).catch(() => undefined)
    }
  }

  return (
    <div className="s5">
      <h2 className="s5__title">Connections</h2>
      <p className="s5__lede">Tools {company.name}’s agents can use. Each one signs in on its own; a connection you make here belongs to {company.name} only.</p>
      <label className="s5-search">
        <Icon name="search" size={14} />
        <input className="input" type="search" aria-label="Search connections" placeholder={code ? 'Search: GitHub, Linear, Sentry…' : 'Search: Instagram, Stripe, Slack…'} value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {connections === null ? (
        <div className="text-tertiary s5__loading">Loading connections…</div>
      ) : shown.length === 0 ? (
        <p className="text-tertiary s5__loading">No tool matches “{query}”. Try another word, or add a custom (MCP) server.</p>
      ) : (
        groups.map(([g, list]) => (
          <section key={g} className="s5-group" aria-label={GROUP_TITLE[g](company.name, code)}>
            <div className="s5-group__title">{GROUP_TITLE[g](company.name, code)}</div>
            <div className="s5-cards">
              {list.map((c) => (
                <Card key={c.id} card={c} busy={busy === c.id} onAct={() => act(c)} />
              ))}
            </div>
          </section>
        ))
      )}
      <p className="s5__foot text-tertiary">
        Need to give agents a secret that isn’t a connection, like STRIPE_SECRET_KEY?{' '}
        <button type="button" className="link-btn" onClick={() => void navigate({ name: 'settings', section: 'keys', nonce: Date.now() })}>
          Keys &amp; secrets →
        </button>
      </p>
      {sheet === 'instagram' && <InstagramSheet company={company} writer={writer} onClose={() => setSheet(null)} />}
      {sheet === 'github' && <GithubSheet company={company} gh={gh} onClose={() => setSheet(null)} />}
      {sheet === 'linear' && <LinearConnectSheet company={company} status={linear} mcp={(connections ?? []).find((c) => /mcp\.linear\.app/.test(c.url ?? '')) ?? null} onClose={() => setSheet(null)} onChanged={() => (reloadLinear(), load())} />}
      {sheet === 'slack' && (
        <Sheet title="Slack" width={620} onCancel={() => setSheet(null)} cancelLabel="Done">
          <SlackConnectionCard />
        </Sheet>
      )}
      {manage && <ManageSheet connection={manage} companyName={company.name} onClose={() => setManage(null)} onEdit={() => (setEditor({ connectionId: manage.id }), setManage(null))} onChanged={load} />}
      {editor && (
        <div className="sheet-layer" onMouseDown={(e) => e.target === e.currentTarget && setEditor(null)}>
          <div className="sheet s5-editor" role="dialog" aria-label={editor.connectionId ? 'Edit connection' : 'Custom (MCP) server'}>
            <div className="sheet__body">
              <GatewayConnections editorOnly={editor} onClose={() => (setEditor(null), load())} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Card({ card: c, busy, onAct }: { card: ConnCard; busy: boolean; onAct: () => void }): React.JSX.Element {
  const tone = c.state === 'connected' ? 'ok' : c.state === 'attention' ? 'needs' : c.state === 'waiting' ? 'run' : 'grey'
  // one primary per card at most, and only where something needs you (the prototype's Reconnect)
  const primary = c.state === 'attention'
  return (
    <article className={`s5-card ${c.state === 'soon' ? 'is-soon' : ''}`} data-conn={c.id}>
      <div className="s5-card__head">
        <span className="s5-card__logo" aria-hidden>
          {c.id === 'github' ? <Icon name="branch" size={15} /> : c.id === 'custom' ? '+' : logoText(c.name)}
        </span>
        <span className="s5-card__name">{c.name}</span>
        {c.chip && <span className={`s5-chip s5-chip--${tone}`}>{c.chip}</span>}
      </div>
      <p className="s5-card__blurb">{c.blurb}</p>
      {c.note && <p className="s5-card__note">{c.note}</p>}
      <div className="s5-card__foot">
        {c.action.kind !== 'none' && (
          <Button size="sm" variant={primary ? 'primary' : 'secondary'} disabled={busy} onClick={onAct}>
            {busy ? 'Opening sign-in…' : c.actionLabel}
          </Button>
        )}
      </div>
    </article>
  )
}

function logoText(name: string): string {
  if (name === 'Instagram') return 'IG'
  const w = name.replace(/\(.*?\)/g, '').trim().split(/\s+/)
  return (w.length > 1 ? `${w[0]![0]}${w[1]![0]}` : name[0]!).toUpperCase()
}

/** Manage one MCP connection: its one state, Test, turn off or on, sign in again, edit details, remove. */
function ManageSheet({ connection: c, companyName, onClose, onEdit, onChanged }: { connection: GatewayConnection; companyName: string; onClose: () => void; onEdit: () => void; onChanged: () => void }): React.JSX.Element {
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<string | void>): Promise<void> => {
    setBusy(true)
    try {
      const r = await fn()
      if (r) setNote(r)
      onChanged()
    } catch (e) {
      setNote(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const shared = !c.companyIds?.length
  return (
    <Sheet title={c.name} width={520} onCancel={onClose} cancelLabel="Done" footerLeft={<Button variant="ghost" disabled={busy} onClick={onEdit}>Edit details…</Button>}>
      <p className="s5-sheet__p">{shared ? `Shared by every company: ${companyName}’s agents and your other companies’ agents get it.` : `${companyName}’s agents get it. Your other companies don’t.`}</p>
      {c.authError && <p className="s5-sheet__warn">{c.authError}</p>}
      <div className="s5-sheet__row">
        <Button size="sm" disabled={busy || !c.enabled} onClick={() => void run(async () => `${c.name} answers · ${((await hive.gateway.test({ id: c.id })) as { tools?: unknown[] }).tools?.length ?? 0} tools available.`)}>
          Test
        </Button>
        {c.authentication === 'oauth' && (
          <Button size="sm" disabled={busy || !c.enabled} onClick={() => void run(async () => (await hive.gateway.connect({ id: c.id }), 'Continue in your browser to finish signing in.'))}>
            Sign in again
          </Button>
        )}
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const { hasCredentials: _h, authStatus: _s, authError: _e, ...config } = c
              await hive.gateway.save({ ...config, enabled: !c.enabled })
              onClose()
            })
          }
        >
          {c.enabled ? 'Turn off' : 'Turn on'}
        </Button>
        <span className="flex1" />
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              if (!(await confirmNative({ message: `Remove ${c.name}?`, detail: shared ? 'Every company’s agents lose it.' : `${companyName}’s agents lose it.`, confirmLabel: 'Remove', destructive: true }).catch(() => false))) return
              await hive.gateway.remove({ id: c.id })
              onClose()
            })
          }
        >
          Remove…
        </Button>
      </div>
      {note && <p className="s5-sheet__note" role="status">{note}</p>}
    </Sheet>
  )
}
