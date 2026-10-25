/**
 * The Linear card's sheet (five doors step 4, design §4.10, pm-review E13). One card covers both things Linear does:
 * 1. Agents use Linear: Linear's own MCP server, signed in with "Continue with Linear" in the browser (OAuth, no key),
 *    for this company only.
 * 2. Sync with the Board: a personal API key (Linear's sync API has no sign-in for apps like Principia yet), the team,
 *    and a preview of what comes in before anything is linked (LinearSheet).
 * Connected: the team, the last sync, both switches, Sync now and Disconnect.
 */
import { useState } from 'react'
import type { CompanyPassport } from '@shared/company'
import type { GatewayConnection } from '@shared/gateway'
import type { LinearStatusView } from '@shared/linear'
import { Button, Sheet, Switch } from '../ui'
import { LinearSheet } from '../board/LinearSheet'
import { CONNECTION_CATALOG } from '../../lib/connectionCatalog'
import { connectionState } from '../../lib/connections'
import { linearLine } from '../../lib/linear'
import { confirmNative, errorMessage, hive } from '../../lib/hive'
import { toast } from '../../state/store'

export function LinearConnectSheet({ company, status, mcp, onClose, onChanged }: { company: CompanyPassport; status: LinearStatusView | null; mcp: GatewayConnection | null; onClose: () => void; onChanged: () => void }): React.JSX.Element {
  const [keySheet, setKeySheet] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const synced = !!status?.connected
  const agents = mcp ? connectionState(mcp) : null
  const run = async (fn: () => Promise<string | void>): Promise<void> => {
    setBusy(true)
    setNote(null)
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
  /** "Let agents read and update Linear issues": Linear's MCP server for this company, signed in in the browser. */
  const setAgents = (on: boolean): Promise<void> =>
    run(async () => {
      if (mcp) {
        const { hasCredentials: _h, authStatus: _s, authError: _e, ...config } = mcp
        await hive.gateway.save({ ...config, enabled: on })
        if (on && mcp.authStatus !== 'connected') {
          await hive.gateway.connect({ id: mcp.id })
          return 'Finish signing in to Linear in your browser.'
        }
        return on ? `${company.name}’s agents can use Linear.` : `${company.name}’s agents no longer use Linear.`
      }
      if (!on) return
      const p = CONNECTION_CATALOG.find((x) => x.id === 'linear')!
      const id = `connection-${crypto.randomUUID()}`
      await hive.gateway.save({ id, name: 'Linear', transport: 'http', url: p.url, authentication: 'oauth', enabled: true, roots: [], scope: 'global', companyIds: [company.id] })
      await hive.gateway.connect({ id })
      return 'Finish signing in to Linear in your browser. No API key needed for this part.'
    })
  const disconnect = (): Promise<void> =>
    run(async () => {
      const ok = await confirmNative({ message: `Stop syncing ${company.name} with Linear?`, detail: 'Principia forgets the key and unlinks the tasks. The tasks stay here, and nothing changes in Linear.', confirmLabel: 'Disconnect' }).catch(() => false)
      if (!ok) return
      await hive.linear.disconnect({ companyId: company.id })
      toast('Disconnected from Linear')
    })

  if (keySheet) return <LinearSheet companyId={company.id} companyName={company.name} status={status} onClose={() => (setKeySheet(false), onChanged())} onConnected={() => onChanged()} />

  const agentsOn = !!mcp?.enabled
  return (
    <Sheet title={synced ? `Linear · ${status!.team?.name ?? ''} (${status!.team?.key ?? ''})` : `Connect Linear to ${company.name}`} width={560} onCancel={onClose} cancelLabel="Done">
      <div className="s5-sheet">
        <div className="s5-opt">
          <div className="s5-opt__text">
            <b>Let agents read and update Linear issues</b>
            <small>
              {agents?.state === 'connected'
                ? 'Signed in with Linear. Only this company’s agents get it.'
                : agents?.state === 'waiting'
                  ? 'Waiting for you to finish signing in in your browser…'
                  : agents && agentsOn
                    ? 'Sign-in needed: turn it off and on again to sign in.'
                    : 'Agents can look up and update issues. Continue with Linear in your browser; no API key needed. It doesn’t put issues on your Board.'}
            </small>
          </div>
          {!mcp && !busy ? (
            <Button size="sm" variant="primary" onClick={() => void setAgents(true)}>
              Continue with Linear
            </Button>
          ) : (
            <Switch checked={agentsOn} disabled={busy} onChange={(v) => void setAgents(v)} label="Let agents read and update Linear issues" />
          )}
        </div>
        <div className="s5-opt">
          <div className="s5-opt__text">
            <b>Sync issues with the Board, both ways</b>
            <small>{synced ? `${linearLine(status).replace(/^Linear: /, '')} · ${status!.linkedCount} linked` : 'Issues show up on the Board as tasks, and changes go both ways. Needs a personal API key from Linear; you see what comes in before anything is linked.'}</small>
          </div>
          {synced ? (
            <Switch checked={!!status!.autosync} disabled={busy} onChange={(v) => void run(async () => void (await hive.linear.setAutosync({ companyId: company.id, on: v })))} label="Autosync" />
          ) : (
            <Button size="sm" onClick={() => setKeySheet(true)}>
              Use an API key…
            </Button>
          )}
        </div>
        {synced && (
          <div className="s5-sheet__row">
            <Button size="sm" disabled={busy} onClick={() => void run(async () => (await hive.linear.sync({ companyId: company.id }), 'Synced with Linear.'))}>
              Sync now
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setKeySheet(true)}>
              {status!.state === 'auth' ? 'Reconnect…' : 'Change team or key…'}
            </Button>
            <span className="flex1" />
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void disconnect()}>
              Stop syncing…
            </Button>
          </div>
        )}
        {note && <p className="s5-sheet__note" role="status">{note}</p>}
      </div>
    </Sheet>
  )
}
