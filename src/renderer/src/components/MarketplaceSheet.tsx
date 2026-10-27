/** Review an item before installing it. Installation never starts a workflow. */
import { serviceForKey } from '@shared/services'
import { ConnectionSlot } from './connections/ConnectionSlot'
import { useEffect, useState } from 'react'
import type { MarketItem, MarketPreview } from '@shared/marketplace'
import { errorMessage, hive } from '../lib/hive'
import { attempt, navigate, scopeCompanyId, toast } from '../state/store'
import { Button, ErrorState, Loading, Pill, Sheet } from './ui'

export function InstallSheet({
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
    let active = true
    hive.marketplace.preview({ source: item.source, id: item.id }).then(
      (preview) => { if (active) setP(preview) },
      (e) => { if (active) setError(errorMessage(e)) }
    )
    return () => { active = false }
  }, [item])
  const missing = (item.keys ?? []).filter((k) => !keys.has(k))
  const svcMissing = [...new Set(missing.map((k) => serviceForKey(k)?.id).filter((x): x is string => !!x))]
  const rawMissing = missing.filter((k) => !serviceForKey(k) || !scopeCompanyId())
  const commands = p?.nodes.filter((n) => n.command) ?? []

  const install = async (): Promise<void> => {
    setBusy(true)
    // COMPANY.md §3: workflows install into the focused company (All mode: Personal)
    const companyId = scopeCompanyId()
    const r = await attempt(() => hive.marketplace.install({ source: item.source, id: item.id, overwrite: p?.overwrites, ...(companyId ? { companyId } : {}) }), 'Install')
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
      primaryDisabled={busy || !p}
      primaryLabel={item.kind === 'workflow' || item.kind === 'script' ? (item.installed ? 'Add another copy' : 'Add to Workflows') : p?.overwrites ? 'Replace' : 'Install'}
      footerLeft={
        <Button variant="ghost" onClick={onClose}>
          Back to marketplace
        </Button>
      }
    >
      <p className="sheet__desc text-secondary">{item.description}</p>
      {/* CONNECTIONS.md §4.3 S13: a key that belongs to a service is that service's connection, connected in place */}
      {svcMissing.length > 0 && scopeCompanyId() && (
        <div className="cx-forms">
          {svcMissing.map((id) => (
            <ConnectionSlot key={id} companyId={scopeCompanyId()!} service={id} purpose="agentTools" actions={false} label={`Needs ${(item.keys ?? []).filter((k) => serviceForKey(k)?.id === id).join(', ')}`} />
          ))}
        </div>
      )}
      {rawMissing.length > 0 && (
        <div className="market__warn">
          Needs {rawMissing.join(', ')} — not in your Keys yet.{' '}
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
                {n.prompt && <p className="market__prompt selectable">{n.prompt}</p>}
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
