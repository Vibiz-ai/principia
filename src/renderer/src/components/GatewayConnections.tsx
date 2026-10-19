import { useEffect, useRef, useState } from 'react'
import type { GatewayConnection, GatewayConnectionInput } from '@shared/gateway'
import type { Repo } from '@shared/types'
import { confirmNative, errorMessage, hive } from '../lib/hive'
import { connectionProblem, importGatewayConfig } from '../lib/gatewayForm'
import { Button, Switch } from './ui'
import { ConnectionCatalog } from './ConnectionCatalog'
import { presetForUrl, type ConnectionPreset } from '../lib/connectionCatalog'

type Auth = 'oauth' | 'token' | 'none'
type Draft = { id: string; name: string; transport: 'http' | 'stdio'; url: string; command: string; args: string; auth: Auth; token: string; header: string; env: string; roots: string[]; scope: 'projects' | 'global'; enabled: boolean; importedCredentials?: Record<string, string> }
const blank = (): Draft => ({ id: '', name: '', transport: 'http', url: '', command: '', args: '', auth: 'oauth', token: '', header: 'Authorization', env: '', roots: [], scope: 'projects', enabled: true })

export function GatewayConnections(): React.JSX.Element {
  const [connections, setConnections] = useState<GatewayConnection[]>([])
  const [repos, setRepos] = useState<Repo[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [catalogOpen, setCatalogOpen] = useState(true)
  const editorRef = useRef<HTMLFormElement>(null)
  const catalogRef = useRef<HTMLDivElement>(null)
  const [importText, setImportText] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [tested, setTested] = useState<Record<string, number>>({})
  const mounted = useRef(false)
  const revision = useRef(0)
  const pending = useRef(false)
  useEffect(() => {
    mounted.current = true
    const current = ++revision.current
    void Promise.all([hive.gateway.list(), hive.repos.list()]).then(([items, projects]) => {
      if (mounted.current) { setRepos(projects); if (revision.current === current) setConnections(items) }
    }).catch(() => { if (mounted.current) setMessage('Could not load connections. Try reopening Settings.') })
    return () => { mounted.current = false }
  }, [])
  const connecting = connections.some(c => c.authStatus === 'connecting')
  useEffect(() => {
    if (!connecting) return
    let canceled = false
    const timer = setInterval(() => { if (!pending.current) { const current = revision.current; void hive.gateway.list().then(items => { if (!canceled && revision.current === current) setConnections(items) }).catch(() => {}) } }, 1200)
    return () => { canceled = true; clearInterval(timer) }
  }, [connecting])
  const action = async (fn: () => Promise<string>): Promise<void> => {
    if (pending.current) return
    pending.current = true; ++revision.current; setBusy(true); setMessage('')
    try { const result = await fn(); const items = await hive.gateway.list(); if (mounted.current) { setConnections(items); setMessage(result) } }
    catch (error) { const items = await hive.gateway.list().catch(() => null); if (mounted.current) { if (items) setConnections(items); setMessage(errorMessage(error)) } }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  useEffect(() => { if (draft) editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, [draft?.id])
  const choosePreset = (preset: ConnectionPreset): void => {
    setDraft({ ...blank(), name: preset.name, url: preset.url, auth: preset.auth }); setCatalogOpen(false); setImportText(''); setMessage('')
  }
  const open = (connection?: GatewayConnection): void => {
    setCatalogOpen(false)
    setImportText(''); setMessage('')
    setDraft(connection ? { ...blank(), id: connection.id, name: connection.name, transport: connection.transport, url: connection.url ?? '', command: connection.command ?? '', args: (connection.args ?? []).join('\n'), auth: connection.authentication === 'oauth' ? 'oauth' : connection.hasCredentials ? 'token' : 'none', roots: [...connection.roots], scope: connection.scope ?? 'projects', enabled: connection.enabled } : blank())
  }
  const update = (patch: Partial<Draft>): void => setDraft(current => current ? { ...current, ...patch } : current)
  const needsSignIn = !!draft && draft.transport === 'http' && draft.auth === 'oauth' && !connections.some(c => c.id === draft.id && c.url === draft.url.trim() && c.authentication === 'oauth' && c.authStatus === 'connected')
  const save = async (connect: boolean): Promise<string> => {
    if (!draft) return ''
    const problem = connectionProblem(draft.name, draft.transport, draft.transport === 'http' ? draft.url : draft.command, draft.roots, draft.scope)
    if (problem) throw new Error(problem)
    if (draft.transport === 'http' && draft.auth === 'token' && !draft.token.trim() && !Object.keys(draft.importedCredentials ?? {}).length && !connections.find(c => c.id === draft.id)?.hasCredentials) throw new Error('Enter the API key or access token for this connection.')
    let credentials = draft.importedCredentials
    if (draft.transport === 'http') {
      if (draft.auth === 'token' && draft.token.trim()) credentials = { [draft.header.trim() || 'Authorization']: draft.header.trim().toLowerCase() === 'authorization' && !/^Bearer /i.test(draft.token.trim()) ? `Bearer ${draft.token.trim()}` : draft.token.trim() }
      if (draft.auth !== 'token') credentials = {}
    } else if (draft.env.trim()) {
      credentials = {}
      for (const line of draft.env.split('\n').filter(l => l.trim())) {
        const at = line.indexOf('='); if (at < 1) throw new Error('Enter environment variables as NAME=value, one per line.')
        credentials[line.slice(0, at).trim()] = line.slice(at + 1)
      }
    }
    const input: GatewayConnectionInput = { id: draft.id || `connection-${crypto.randomUUID()}`, name: draft.name.trim(), transport: draft.transport, ...(draft.transport === 'http' ? { url: draft.url.trim() } : { command: draft.command.trim(), args: draft.args.split('\n').filter(a => a.length > 0) }), authentication: draft.transport === 'http' && draft.auth === 'oauth' ? 'oauth' : 'none', enabled: draft.enabled, roots: draft.roots, scope: draft.scope, ...(credentials !== undefined ? { credentials } : {}) }
    await hive.gateway.save(input)
    if (mounted.current) { setDraft(null); setImportText(''); setTested(previous => { const next = { ...previous }; delete next[input.id]; return next }) }
    if (connect) { await hive.gateway.connect({ id: input.id }); return 'Finish signing in in your browser. Principia will update this connection automatically.' }
    return 'Connection saved. Start a new session to use it in Claude or Codex.'
  }
  const applyImport = (): void => {
    try {
      const config = importGatewayConfig(importText)
      update({ name: config.name ?? draft?.name ?? '', transport: config.transport ?? 'http', url: config.url ?? '', command: config.command ?? '', args: (config.args ?? []).join('\n'), auth: config.authentication === 'oauth' || (presetForUrl(config.url ?? '')?.auth === 'oauth' && !Object.keys(config.credentials ?? {}).length) ? 'oauth' : config.credentials && Object.keys(config.credentials).length ? 'token' : 'none', importedCredentials: config.credentials, scope: config.scope ?? 'projects', ...(config.roots ? { roots: config.roots } : {}) })
      setImportText(''); setMessage('Imported. Choose the projects that can use this connection, then save.')
    } catch (error) { setMessage(errorMessage(error)) }
  }
  return <section className="gateway" aria-labelledby="gateway-title" aria-busy={busy}>
    <div className="gateway__heading"><div><h2 id="gateway-title">Company connections</h2><p>Connect once. Use your tools in Claude, Codex, and workflows.</p></div><Button size="sm" disabled={busy} onClick={() => { setDraft(null); setCatalogOpen(true); requestAnimationFrame(() => { catalogRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); catalogRef.current?.querySelector('input')?.focus({ preventScroll: true }) }) }}>Add connection</Button></div>
    <div className="gateway__cards">{connections.map(c => <article key={c.id} className="gateway__card">
      <div className="gateway__card-top"><div className="gateway__card-name"><strong>{c.name}</strong><span className={`gateway__state ${c.enabled && c.authStatus !== 'error' && (c.authStatus === 'connected' || tested[c.id] !== undefined) ? 'gateway__state--ready' : ''}`}>{!c.enabled ? 'Disabled' : c.authStatus === 'connecting' ? 'Waiting for sign-in' : c.authStatus === 'error' ? 'Sign-in needed' : c.authStatus === 'connected' || tested[c.id] !== undefined ? 'Connected' : c.authentication === 'oauth' ? 'Not signed in' : 'Saved'}</span></div><Switch checked={c.enabled} disabled={busy} label={`Enable ${c.name}`} onChange={enabled => void action(async () => { const { hasCredentials: _, authStatus: _s, authError: _e, ...config } = c; await hive.gateway.save({ ...config, enabled }); return enabled ? `${c.name} enabled.` : `${c.name} disabled.` })} /></div>
      <p className="gateway__endpoint">{c.url ?? [c.command, ...(c.args ?? [])].join(' ')}</p>
      <div className="gateway__meta">{c.scope === 'global' ? 'All projects' : `${c.roots.length} ${c.roots.length === 1 ? 'project' : 'projects'}`} · Claude + Codex{tested[c.id] !== undefined ? ` · ${tested[c.id]} tools` : ''}</div>
      {c.authError && <p className="gateway__error">{c.authError}</p>}
      <div className="gateway__actions">{c.authentication === 'oauth' && c.authStatus !== 'connected' && <Button size="sm" variant="primary" disabled={busy || !c.enabled || c.authStatus === 'connecting'} onClick={() => void action(async () => { await hive.gateway.connect({ id: c.id }); return 'Continue in your browser to finish connecting.' })}>{c.authStatus === 'connecting' ? 'Signing in…' : 'Sign in'}</Button>}<Button size="sm" disabled={busy || !c.enabled || c.authStatus === 'connecting'} aria-label={`Test ${c.name}`} onClick={() => void action(async () => { const result = await hive.gateway.test({ id: c.id }) as { tools?: unknown[] }; if (mounted.current) setTested(previous => ({ ...previous, [c.id]: result.tools?.length ?? 0 })); return `${c.name} connected · ${result.tools?.length ?? 0} tools available.` })}>Test</Button><Button size="sm" disabled={busy} aria-label={`Edit ${c.name}`} onClick={() => open(c)}>Edit</Button><Button size="sm" variant="ghost" disabled={busy} aria-label={`Remove ${c.name}`} onClick={() => void action(async () => { if (!await confirmNative({ message: `Remove ${c.name}?`, detail: 'Agents will lose access to this connection.', confirmLabel: 'Remove connection', destructive: true })) return ''; await hive.gateway.remove({ id: c.id }); return 'Connection removed.' })}>Remove</Button></div>
    </article>)}</div>
    {catalogOpen && <div ref={catalogRef}><ConnectionCatalog busy={busy} savedUrls={connections.map(c => c.url ?? '')} onSelect={choosePreset} onCustom={() => open()}/></div>}
    {draft && <form ref={editorRef} className="gateway__editor" onSubmit={e => { e.preventDefault(); void action(() => save(needsSignIn)) }}>
      <div className="gateway__editor-heading"><h3>{draft.id ? 'Edit connection' : 'New connection'}</h3><Button size="sm" variant="ghost" disabled={busy} onClick={() => { setDraft(null); setCatalogOpen(true); setImportText(''); setMessage('') }}>Back to tools</Button></div>
      {presetForUrl(draft.url)?.note && <p className="gateway__hint gateway__preset-note">{presetForUrl(draft.url)?.note}</p>}
      {presetForUrl(draft.url) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { const preset = presetForUrl(draft.url); if (preset) void hive.app.openExternal({ url: preset.docs }).catch(() => setMessage('Could not open the service setup guide.')) }}>Service setup guide ↗</Button>}
      <fieldset disabled={busy}><div className="gateway__fields"><label>Name<input className="input" value={draft.name} onChange={e => update({ name: e.target.value })} placeholder="e.g. Mobbin" autoFocus /></label><label>Connection type<select className="input" value={draft.transport} onChange={e => update({ transport: e.target.value as 'http' | 'stdio' })}><option value="http">Remote server</option><option value="stdio">Local server (advanced)</option></select></label></div>
      {draft.transport === 'http' ? <><label className="gateway__field">Server URL<input className="input" type="url" value={draft.url} onChange={e => update({ url: e.target.value })} placeholder="https://api.mobbin.com/mcp" /></label><label className="gateway__field">Authentication<select className="input" value={draft.auth} onChange={e => update({ auth: e.target.value as Auth })}><option value="oauth">Sign in with browser</option><option value="token">API key / access token</option><option value="none">No authentication</option></select></label>{draft.auth === 'oauth' && <p className="gateway__hint">Your browser opens to the service’s sign-in page. One connection works across both harnesses.</p>}{draft.auth === 'token' && <div className="gateway__fields"><label>API key / access token<input className="input" type="password" autoComplete="new-password" value={draft.token} onChange={e => update({ token: e.target.value })} placeholder={draft.id ? 'Leave blank to keep saved key' : draft.importedCredentials ? 'Imported credentials will be saved' : 'Paste your key'} /></label><label>Header name<input className="input" value={draft.header} onChange={e => update({ header: e.target.value })} /></label></div>}</> : <><label className="gateway__field">Executable<input className="input" value={draft.command} onChange={e => update({ command: e.target.value })} placeholder="Full executable path or command name" /></label><label className="gateway__field">Arguments <span className="gateway__hint">one per line</span><textarea className="input" rows={3} value={draft.args} onChange={e => update({ args: e.target.value })} spellCheck={false} /></label><label className="gateway__field">Environment variables <span className="gateway__hint">optional, NAME=value per line</span><textarea className="input" rows={2} value={draft.env} onChange={e => update({ env: e.target.value })} spellCheck={false} placeholder={draft.id ? 'Leave blank to retain saved variables' : ''} /></label></>}
      <div className="gateway__projects"><label className="gateway__project"><input type="checkbox" checked={draft.scope === 'global'} onChange={e => update({ scope: e.target.checked ? 'global' : 'projects' })} /><span>All projects<small>Available in all current and future projects, for Claude and Codex.</small></span></label>{draft.scope !== 'global' && <><div className="gateway__project-heading"><strong>Allow in these projects</strong><Button size="sm" variant="ghost" onClick={() => void action(async () => { const added = await hive.repos.pick(); const all = await hive.repos.list(); if (mounted.current) { setRepos(all); setDraft(current => current ? { ...current, roots: [...new Set([...current.roots, ...added.map(r => r.path)])] } : current) }; return '' })}>Add folder…</Button></div>{repos.length === 0 && <p className="gateway__hint">Add a project folder to choose where agents can use this connection.</p>}{[...repos.map(r => ({ path: r.path, name: r.name })), ...draft.roots.filter(root => !repos.some(r => r.path === root)).map(root => ({ path: root, name: root.split('/').pop() ?? root }))].map(repo => <label key={repo.path} className="gateway__project"><input type="checkbox" checked={draft.roots.includes(repo.path)} onChange={e => update({ roots: e.target.checked ? [...draft.roots, repo.path] : draft.roots.filter(root => root !== repo.path) })} /><span>{repo.name}<small>{repo.path}</small></span></label>)}</>}</div>
      <details className="gateway__advanced"><summary>Import an MCP configuration</summary><p className="gateway__hint">Optional: paste a server configuration from a setup guide, including the common mcpServers format.</p><textarea className="input" aria-label="MCP configuration to import" rows={5} spellCheck={false} value={importText} onChange={e => setImportText(e.target.value)} /><Button size="sm" disabled={!importText.trim()} onClick={applyImport}>Import configuration</Button></details>
      <div className="gateway__footer"><span className="gateway__hint">Available to new sessions and workflow steps after connecting.</span><Button variant="primary" type="submit" disabled={busy}>{busy ? 'Connecting…' : needsSignIn ? 'Save & sign in' : draft.id ? 'Save changes' : 'Save connection'}</Button></div></fieldset>
    </form>}
    <p className="gateway__message" role="status">{message}</p>
  </section>
}
