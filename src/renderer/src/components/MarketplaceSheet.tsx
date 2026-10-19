/**
 * Marketplace: search the built-in catalog (+ Settings › Marketplace URL) for workflows, Claude Code agents and skills,
 * preview what installing does, then install. Workflows open in the editor; nothing runs on install.
 */
import { useEffect, useMemo, useState } from 'react'
import type { MarketItem, MarketKind, MarketList, MarketPreview } from '@shared/marketplace'
import { errorMessage, hive } from '../lib/hive'
import { attempt, navigate, toast } from '../state/store'
import { Button, EmptyState, ErrorState, Loading, Pill, Segmented, Sheet } from './ui'

type Filter = 'all' | MarketKind
const KIND_LABEL: Record<MarketKind, string> = { workflow: 'Workflow', script: 'Script', agent: 'Agent', skill: 'Skill' }

export function matchesQuery(i: MarketItem, q: string): boolean {
  const hay = [i.name, i.description, i.kind, i.author ?? '', ...(i.tags ?? []), ...(i.keys ?? [])].join(' ').toLowerCase()
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w))
}

export function MarketplaceSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [list, setList] = useState<MarketList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [keys, setKeys] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<MarketItem | null>(null)

  const load = (refresh = false): void => {
    setError(null)
    hive.marketplace.list({ refresh }).then(setList, (e) => setError(errorMessage(e)))
  }
  useEffect(() => {
    load()
    void hive.secrets.list().then((s) => setKeys(new Set(s.map((x) => x.name))), () => undefined)
  }, [])

  const shown = useMemo(() => (list?.items ?? []).filter((i) => (filter === 'all' || i.kind === filter) && matchesQuery(i, q)), [list, q, filter])

  if (open) return <InstallSheet item={open} keys={keys} onBack={() => setOpen(null)} onClose={onClose} onInstalled={() => load()} />

  return (
    <Sheet title="Marketplace" onCancel={onClose} width={720} footerLeft={<RemoteNote list={list} onRefresh={() => load(true)} />}>
      <div className="market__bar">
        <input
          className="input"
          placeholder="Search workflows, scripts, agents, skills… (image, scraping, apify)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-autofocus
        />
        <Segmented
          size="sm"
          value={filter}
          onChange={setFilter}
          items={[
            { value: 'all', label: 'All' },
            { value: 'workflow', label: 'Workflows' },
            { value: 'script', label: 'Scripts' },
            { value: 'agent', label: 'Agents' },
            { value: 'skill', label: 'Skills' }
          ]}
        />
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => load(true)} />
      ) : !list ? (
        <Loading />
      ) : !shown.length ? (
        <EmptyState compact icon="search" text={q ? `Nothing matches “${q}”.` : 'The catalog is empty.'} />
      ) : (
        <div className="market__list">
          {shown.map((i) => (
            <button key={`${i.source}/${i.id}`} className="market__item" onClick={() => setOpen(i)}>
              <div className="market__head">
                <span className="market__name">{i.name}</span>
                <Pill tone="accent">{KIND_LABEL[i.kind]}</Pill>
                {i.source === 'remote' && <Pill>Remote</Pill>}
                {i.installed && <Pill tone="passed">Installed</Pill>}
                {(i.keys ?? []).map((k) => (
                  <Pill key={k} tone={keys.has(k) ? 'idle' : 'warning'} title={keys.has(k) ? 'In your Keys' : 'Not in your Keys yet'}>
                    {k}
                  </Pill>
                ))}
              </div>
              <div className="market__desc text-secondary">{i.description}</div>
            </button>
          ))}
        </div>
      )}
    </Sheet>
  )
}

function RemoteNote({ list, onRefresh }: { list: MarketList | null; onRefresh: () => void }): React.JSX.Element {
  if (!list) return <span />
  if (!list.remoteUrl)
    return (
      <span className="sheet__note text-secondary">
        Built-in catalog · add your own in{' '}
        <a href="#" onClick={(e) => (e.preventDefault(), void navigate({ name: 'settings', section: 'data' }))}>
          Settings
        </a>
      </span>
    )
  return (
    <span className="sheet__note text-secondary" title={list.remoteUrl}>
      {list.remoteError ? <span className="market__err">Remote catalog: {list.remoteError}</span> : 'Built-in + remote catalog'} ·{' '}
      <a href="#" onClick={(e) => (e.preventDefault(), onRefresh())}>
        Refresh
      </a>
    </span>
  )
}

function InstallSheet({
  item,
  keys,
  onBack,
  onClose,
  onInstalled
}: {
  item: MarketItem
  keys: Set<string>
  onBack: () => void
  onClose: () => void
  onInstalled: () => void
}): React.JSX.Element {
  const [p, setP] = useState<MarketPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    hive.marketplace.preview({ source: item.source, id: item.id }).then(setP, (e) => setError(errorMessage(e)))
  }, [item])
  const missing = (item.keys ?? []).filter((k) => !keys.has(k))
  const commands = p?.nodes.filter((n) => n.command) ?? []

  const install = async (): Promise<void> => {
    setBusy(true)
    const r = await attempt(() => hive.marketplace.install({ source: item.source, id: item.id, overwrite: p?.overwrites }), 'Install')
    setBusy(false)
    if (!r) return
    onInstalled()
    if ('workflowId' in r) {
      toast(`Added “${item.name}” to Workflows`)
      onClose()
      void navigate({ name: 'editor', workflowId: r.workflowId, nonce: Date.now() })
    } else {
      toast(`Installed to ${r.path.replace(/^\/Users\/[^/]+/, '~')} · new Claude sessions pick it up`)
      onBack()
    }
  }

  return (
    <Sheet
      title={item.name}
      width={720}
      onCancel={onBack}
      onPrimary={p ? () => void install() : undefined}
      primaryDisabled={busy}
      primaryLabel={item.kind === 'workflow' || item.kind === 'script' ? (item.installed ? 'Add another copy' : 'Add to Workflows') : p?.overwrites ? 'Replace' : 'Install'}
      footerLeft={
        <Button variant="ghost" onClick={onClose}>
          Close marketplace
        </Button>
      }
    >
      <p className="sheet__desc text-secondary">{item.description}</p>
      {missing.length > 0 && (
        <div className="market__warn">
          Needs {missing.join(', ')} — not in your Keys yet.{' '}
          <a href="#" onClick={(e) => (e.preventDefault(), onClose(), void navigate({ name: 'keys' }))}>
            Add in Keys
          </a>
        </div>
      )}
      {item.adapters?.length ? <div className="sheet__note text-secondary">Also uses: {item.adapters.join(', ')}</div> : null}
      {error ? (
        <ErrorState error={error} />
      ) : !p ? (
        <Loading />
      ) : item.kind === 'workflow' || item.kind === 'script' ? (
        <>
          <div className="sheet__note text-secondary">Adds the workflow and opens it in the editor. Nothing runs until you run it.</div>
          <div className="market__steps">
            {p.nodes.map((n) => (
              <div key={n.id} className="market__step">
                <Pill>{n.type}</Pill> {n.label || n.id}
                {n.command && <code className="mono market__cmd">{n.command}</code>}
              </div>
            ))}
          </div>
          {commands.length > 0 && <div className="sheet__note market__warn">This workflow runs shell commands on your Mac (shown above).</div>}
        </>
      ) : (
        <>
          <div className="sheet__note text-secondary">
            {p.overwrites ? 'Replaces' : 'Writes'} <code className="mono">{p.target?.replace(/^\/Users\/[^/]+/, '~')}</code>. Claude Code loads it in new sessions.
          </div>
          <pre className="market__pre mono selectable">{p.text}</pre>
        </>
      )}
    </Sheet>
  )
}
