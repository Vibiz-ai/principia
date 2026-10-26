import { useState } from 'react'
import { Button } from '../ui'
import { confirmNative, errorMessage, hive } from '../../lib/hive'
import { linearLine, useLinear } from '../../lib/linear'
import { toast } from '../../state/store'
import { LinearSheet } from './LinearSheet'
import '../../styles/linear.css'

/** LINEAR.md §6: Company Settings › Integrations. One row: "Linear: Not connected · Connect…" until it is wanted. */
export function LinearIntegration({ companyId, companyName, n }: { companyId: string; companyName: string; n: string }): React.JSX.Element {
  const { status, reload } = useLinear(companyId)
  const [sheet, setSheet] = useState(false)
  const connected = !!status?.connected
  const disconnect = async (): Promise<void> => {
    const ok = await confirmNative({ message: `Disconnect ${companyName} from Linear?`, detail: 'Principia forgets the key and unlinks the tasks. The tasks stay here, and nothing changes in Linear.', confirmLabel: 'Disconnect' }).catch(() => false)
    if (!ok) return
    try { await hive.linear.disconnect({ companyId }); toast('Disconnected from Linear') } catch (e) { toast(errorMessage(e), 'error') }
    reload()
  }
  return <section className="passport-section">
    <div className="passport-section-title"><span>{n}</span><h2>Integrations</h2></div>
    <p className="passport-section-description">Optional. If this company already plans in Linear, its Board and one Linear team stay in step both ways. Otherwise the Board is the task system and nothing changes.</p>
    <div className="cs-integration">
      <span className="cs-integration__name">Linear</span>
      <span className="cs-integration__state">{connected ? `${linearLine(status).replace(/^Linear: /, '')} · ${status!.team?.name ?? ''} (${status!.team?.key ?? ''}) · ${status!.linkedCount} linked` : 'Not connected'}</span>
      {connected ? <>
        <Button size="sm" onClick={() => setSheet(true)}>{status!.state === 'auth' ? 'Reconnect…' : 'Change…'}</Button>
        <Button size="sm" variant="ghost" onClick={() => void disconnect()}>Disconnect…</Button>
      </> : <Button size="sm" onClick={() => setSheet(true)}>Connect…</Button>}
    </div>
    {sheet && <LinearSheet companyId={companyId} companyName={companyName} status={status} onClose={() => setSheet(false)} onConnected={reload} />}
  </section>
}
