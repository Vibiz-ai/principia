/**
 * Principia Cloud pane (docs/CLOUD.md §13.1, mockup docs/cloud.html). Not connected: one field for the connect link.
 * Connected, in this order: header (status, Pause cloud, Workspace ▾), Needs you,
 * Companies (Ready or fixes, Run once now, ⋯), Cloud runs (last 8) and Accounts. The cloud is for status and setup;
 * the work itself stays in the rest of the app, and Home's Needs you shows the same asks.
 */
import { useEffect, useState, type ReactElement } from 'react'
import type { CloudAdapter, CloudFix, ProviderCredentialKind } from '@shared/cloud'
import { Loading, Toolbar } from '../components/ui'
import { AccountsCard, startLogin } from '../components/cloud/Accounts'
import { CompaniesCard, MoveSheet } from '../components/cloud/Companies'
import { NotConnected } from '../components/cloud/Connect'
import { CloudHeader } from '../components/cloud/Header'
import { NeedsYouCard } from '../components/cloud/NeedsYou'
import { RunSheet, RunsCard } from '../components/cloud/Runs'
import { API_KEY_KIND } from '../lib/cloud'
import { errorMessage, hive } from '../lib/hive'
import { toast } from '../state/store'
import { ensureCloud, refreshCloud, useCloud } from '../state/cloud'

export function CloudView(): ReactElement {
  useEffect(() => ensureCloud(), [])
  const state = useCloud((s) => s.state)
  const error = useCloud((s) => s.error)
  const hasSummary = useCloud((s) => !!s.summary)
  const [move, setMove] = useState<string | null>(null)
  const [run, setRun] = useState<string | null>(null)
  const [paste, setPaste] = useState<{ adapter: CloudAdapter; kind: ProviderCredentialKind } | null>(null)

  if (!state)
    return (
      <div className="view cl-view">
        <Toolbar title="Cloud sync" />
        <Loading />
      </div>
    )
  if (!state.linked)
    return (
      <div className="view cl-view">
        <Toolbar title="Cloud sync" />
        <div className="cl-scroll">
          <NotConnected />
        </div>
      </div>
    )

  const runOnce = async (companyId: string): Promise<void> => {
    try {
      const r = await hive.cloud.runOnce({ companyId })
      await refreshCloud()
      setRun(r.id)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }
  const onFix = (companyId: string, f: CloudFix): void => {
    if (f.kind === 'account') {
      if (f.ref === 'claude' || f.ref === 'codex') void startLogin(f.ref)
      else setPaste({ adapter: 'gemini', kind: API_KEY_KIND.gemini })
    } else if (f.kind === 'connection') {
      void hive.cloud.connectionAuthorize({ companyId, connectionId: f.ref }).catch((e) => toast(errorMessage(e), 'error'))
    } else setMove(companyId)
  }

  return (
    <div className="view cl-view">
      <CloudHeader />
      <div className="cl-scroll">
        {error && !hasSummary && <p className="cl-error cl-pad selectable">{error}</p>}
        <div className="cl-grid">
          <div className="cl-col">
            <NeedsYouCard />
            <CompaniesCard onManage={setMove} onFix={onFix} onRunOnce={(id) => void runOnce(id)} />
          </div>
          <div className="cl-col">
            <RunsCard onOpen={setRun} />
            <AccountsCard paste={paste} setPaste={setPaste} />
          </div>
        </div>
      </div>
      {move && <MoveSheet companyId={move} onClose={() => setMove(null)} onFix={onFix} />}
      {run && <RunSheet id={run} onClose={() => setRun(null)} />}
    </div>
  )
}
