import { useEffect, useRef, useState } from 'react'
import type { GatewayConnection, GatewayConnectionInput } from '@shared/gateway'
import { hive } from '../lib/hive'
const example = JSON.stringify({ id: 'company-tools', name: 'Company tools', transport: 'stdio', command: 'npx', args: ['-y', 'your-mcp-server'], enabled: true, roots: ['/absolute/path/to/project'], credentials: {} }, null, 2)
export function GatewayConnections(): React.JSX.Element {
  const [connections, setConnections] = useState<GatewayConnection[]>([])
  const [draft, setDraft] = useState(example)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const mounted = useRef(false)
  const revision = useRef(0)
  const pending = useRef(false)
  useEffect(() => {
    mounted.current = true
    const current = ++revision.current
    void hive.gateway.list().then(items => {
      if (mounted.current && revision.current === current) setConnections(items)
    }).catch(() => {
      if (mounted.current && revision.current === current) setMessage('Could not load MCP connections')
    })
    return () => { mounted.current = false }
  }, [])
  const action = async (fn: () => Promise<unknown>, success: string): Promise<void> => {
    if (pending.current) return
    pending.current = true
    const current = ++revision.current
    setBusy(true)
    setMessage('')
    try {
      const result = await fn()
      const items = await hive.gateway.list()
      if (mounted.current && revision.current === current) {
        setConnections(items)
        setMessage(typeof result === 'string' ? result : success)
      }
    } catch (error) {
      if (mounted.current && revision.current === current) setMessage((error as { message?: string }).message ?? 'Connection failed')
    } finally {
      pending.current = false
      if (mounted.current && revision.current === current) setBusy(false)
    }
  }
  return <section className="settings__section" aria-busy={busy}>
    <h2>Shared MCP connections</h2>
    <p>Connect tools once for Claude and Codex. Credentials stay encrypted in Principia; each session receives access only for its working directory. New connections apply to new sessions and workflow steps.</p>
    {connections.map(c => <div key={c.id} className="settings__row">
      <div><strong>{c.name}</strong><p>{c.transport} · {c.enabled ? 'Enabled' : 'Disabled'} · {c.roots.length} project folders</p></div>
      <button aria-label={`Edit ${c.name}`} disabled={busy} onClick={() => { setMessage(''); const { hasCredentials: _, ...config } = c; setDraft(JSON.stringify(config, null, 2)) }}>Edit</button>
      <button aria-label={`Test ${c.name}`} disabled={busy} onClick={() => void action(async () => { const result = await hive.gateway.test({ id: c.id }) as { tools?: unknown[] }; return `Connected: ${result.tools?.length ?? 0} tools` }, 'Connection test passed')}>Test</button>
      <button aria-label={`Remove ${c.name}`} disabled={busy} onClick={() => void action(() => hive.gateway.remove({ id: c.id }), 'Connection removed')}>Remove</button>
    </div>)}
    <label htmlFor="gateway-config">Connection configuration (JSON)</label>
    <textarea id="gateway-config" disabled={busy} aria-describedby="gateway-help" rows={16} spellCheck={false} value={draft} onChange={e => setDraft(e.target.value)} style={{ width: '100%', fontFamily: 'monospace' }} />
    <p id="gateway-help">For HTTP use transport "http", url "https://…/mcp", and credentials as headers, for example {'"Authorization": "Bearer …"'}. For stdio, credentials are environment variables. Only run server commands you trust. roots must contain existing absolute project folders; an empty list grants no sessions access. Omit credentials when editing to keep saved values; {'{}'} clears them. Browser OAuth setup is not supported yet.</p>
    <button disabled={busy} onClick={() => void action(async () => { let input: GatewayConnectionInput; try { input = JSON.parse(draft) as GatewayConnectionInput } catch { throw new Error('Configuration must contain valid JSON.') }; await hive.gateway.save(input); if (mounted.current) setDraft(example) }, 'Saved. Start a new session to use this connection.')}>Save connection</button>
    <p role="status">{message}</p>
  </section>
}
