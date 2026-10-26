/**
 * "Use this Passport in other apps" and "Import into Passport" (open-passport docs/connect.md; PASSPORT.md §12b).
 * The connect panel shows copy-paste configs for the local server (Principia's runtime serving the live vault) and,
 * with Cloud sync on, the hosted URL for ChatGPT and Claude.ai. Buttons that touch another app (Claude Desktop's
 * config, Cursor's and VS Code's install links) only run when clicked. Writes from those apps arrive in the Inbox.
 */
import { useEffect, useState } from 'react'
import type { PassportConnectInfo, PassportConnectSnippet, PassportImportKind, PassportImportResult } from '@shared/passport'
import { Button, Sheet } from '../ui'
import { errorMessage, hive } from '../../lib/hive'
import { toast } from '../../state/store'

const copy = async (text: string, what: string): Promise<void> => {
  try {
    await hive.clipboard.writeText({ text })
    toast(`${what} copied`)
  } catch (e) {
    toast(errorMessage(e))
  }
}

export function PassportConnect({ companyId }: { companyId: string }): React.JSX.Element {
  const [info, setInfo] = useState<PassportConnectInfo | null>(null)
  const [tab, setTab] = useState<'local' | 'hosted'>('local')
  const [app, setApp] = useState<string>('claude-desktop')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  useEffect(() => {
    let live = true
    void hive.company.passportConnect({ op: 'info', companyId }).then(
      (r) => live && setInfo(r.info ?? null),
      (e) => live && setError(errorMessage(e))
    )
    return () => {
      live = false
    }
  }, [companyId])
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const snippets: PassportConnectSnippet[] = (tab === 'hosted' ? info?.hosted?.snippets : info?.local) ?? []
  const current = snippets.find((s) => s.app === app) ?? snippets[0]
  const act = (s: PassportConnectSnippet) =>
    run(async () => {
      if (s.app === 'claude-desktop') {
        const r = await hive.company.passportConnect({ op: 'install', companyId, app: 'claude-desktop' })
        if (r.info) setInfo(r.info)
        toast(`${r.installed?.replaced ? 'Updated' : 'Added'} ${info?.serverName} in Claude Desktop. Restart Claude Desktop to load it.`)
      } else if (s.app === 'cursor' || s.app === 'vscode') {
        await hive.company.passportConnect({ op: 'open', companyId, app: s.app, hosted: tab === 'hosted' })
      }
    })
  return (
    <section className="passport-section">
      <div className="passport-section-title">
        <span>04</span>
        <h2>Use in other apps</h2>
      </div>
      <p className="passport-section-description">
        One memory for the business, in the AI apps your team already uses (Claude Desktop, ChatGPT, Cursor). They read a short company summary first and look up the rest only when they need it. Anything they want to remember waits for your OK.
      </p>
      {error && (
        <div className="company-error" role="alert">
          {error}
        </div>
      )}
      {info && (
        <>
          <div className="op-connect-tabs" role="tablist" aria-label="How apps connect">
            <button type="button" role="tab" aria-selected={tab === 'local'} className={tab === 'local' ? 'is-on' : ''} onClick={() => (setTab('local'), setApp('claude-desktop'))}>
              Desktop apps on this Mac
            </button>
            <button type="button" role="tab" aria-selected={tab === 'hosted'} className={tab === 'hosted' ? 'is-on' : ''} onClick={() => (setTab('hosted'), setApp('chatgpt'))}>
              ChatGPT, Claude.ai and the web
            </button>
          </div>
          {tab === 'hosted' && !info.hosted ? (
            <p className="company-help">ChatGPT and Claude.ai connect to a URL, so Knowledge needs a host first. Set one under Knowledge folder → Cloud sync, then come back here for the URL. They sign in with your owner key and you choose what they may see.</p>
          ) : (
            <>
              {tab === 'hosted' && info.hosted && (
                <div className="cs-vault">
                  <span className="cs-vault__path selectable mono">{info.hosted.mcpUrl}</span>
                  <Button size="sm" variant="ghost" icon="copy" onClick={() => void copy(info.hosted!.mcpUrl, 'MCP URL')}>
                    Copy URL
                  </Button>
                  <Button size="sm" variant="ghost" icon="external" disabled={busy} title="Opens the host's connections page signed in: approve apps, trust or revoke them, review what they suggest" onClick={() => void run(async () => void (await hive.company.passportConnect({ op: 'hostSignIn', companyId })))}>
                    Sign In to Host
                  </Button>
                </div>
              )}
              <div className="op-connect-apps" role="tablist" aria-label="App">
                {snippets.map((s) => (
                  <button key={s.app + s.label} type="button" role="tab" aria-selected={current?.label === s.label} className={current?.label === s.label ? 'is-on' : ''} onClick={() => setApp(s.app)}>
                    {s.label}
                    {s.app === 'claude-desktop' && tab === 'local' && info.claudeDesktop.installed ? ' ✓' : ''}
                  </button>
                ))}
              </div>
              {current && (
                <div className="op-connect-snippet">
                  <p className="company-help">
                    {/* a config file path is for whoever wires it by hand: it sits with the setup text */}
                    {/^[~/]/.test(current.where) ? `Principia can add it to ${current.label} for you.` : current.where}
                    {current.app === 'chatgpt' ? '. A workspace admin may need to turn on developer mode first; ChatGPT asks before each write.' : ''}
                  </p>
                  {/* the raw config (JSON with paths on this Mac) is for whoever wires it by hand: folded away by default */}
                  <details className="op-connect-raw">
                    <summary>Show the setup text</summary>
                    {/^[~/]/.test(current.where) && <p className="company-help mono selectable">{current.where}</p>}
                    <pre className="selectable mono">{current.text}</pre>
                  </details>
                  <div className="cs-actions cs-actions--start">
                    <Button size="sm" icon="copy" onClick={() => void copy(current.text, `${current.label} config`)}>
                      Copy
                    </Button>
                    {current.action === 'install' && (
                      <Button size="sm" disabled={busy} title={`Adds ${info.serverName} to ${info.claudeDesktop.configPath} (the previous file is kept as .bak)`} onClick={() => void act(current)}>
                        {info.claudeDesktop.installed ? 'Update in Claude Desktop' : 'Add to Claude Desktop'}
                      </Button>
                    )}
                    {current.action === 'open' && (
                      <Button size="sm" disabled={busy} icon="external" onClick={() => void act(current)}>
                        Open in {current.app === 'cursor' ? 'Cursor' : 'VS Code'}
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
          <div className="cs-actions cs-actions--start">
            <Button size="sm" icon="upload" onClick={() => setImporting(true)}>
              Import into Knowledge…
            </Button>
            {info.queued > 0 && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const r = await hive.company.passportConnect({ op: 'ingest', companyId })
                    if (r.info) setInfo(r.info)
                    toast(`${r.ingested?.filed ?? 0} suggestions from other apps moved to the Inbox`)
                  })
                }
              >
                {info.queued} waiting from other apps
              </Button>
            )}
          </div>
        </>
      )}
      {importing && <PassportImportSources companyId={companyId} onClose={() => setImporting(false)} />}
    </section>
  )
}

const KINDS: { kind: PassportImportKind; label: string; hint: string }[] = [
  { kind: 'export', label: 'ChatGPT or Claude export', hint: 'The .zip from ChatGPT (Settings → Data controls → Export data) or Claude (Settings → Privacy → Export data). Reads your custom instructions, saved memories and your own messages, never the assistant’s.' },
  { kind: 'folder', label: 'Notion, Obsidian or a folder', hint: 'A Notion export or any folder of Markdown notes. About, handbook and brand pages count most.' },
  { kind: 'url', label: 'Your website', hint: 'The homepage and About page become a company card draft: name, what you do, your headline.' },
  { kind: 'text', label: 'Paste text', hint: 'A pitch, a brief, or memories copied from ChatGPT (Settings → Personalization → Manage memories).' }
]

/** Import into Passport: every candidate arrives in the Inbox as a suggestion; nothing is written until you accept it. */
export function PassportImportSources({ companyId, onClose }: { companyId: string; onClose: () => void }): React.JSX.Element {
  const [kind, setKind] = useState<PassportImportKind>('export')
  const [url, setUrl] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<PassportImportResult | null>(null)
  const go = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const r = await hive.company.passportImport({ companyId, kind, ...(kind === 'url' ? { source: url.trim() } : {}), ...(kind === 'text' ? { text } : {}) })
      if (r) setResult(r)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const ready = kind === 'url' ? /^https?:\/\/\S+\.\S+/.test(url.trim()) : kind === 'text' ? text.trim().length > 10 : true
  return (
    <Sheet
      title="Import into Knowledge"
      width={620}
      onCancel={() => !busy && onClose()}
      primaryLabel={result ? 'Done' : busy ? 'Reading…' : kind === 'export' || kind === 'folder' ? 'Choose…' : 'Import'}
      primaryDisabled={busy || (!result && !ready)}
      onPrimary={() => (result ? onClose() : void go())}
    >
      <div className="company-form">
        {error && (
          <div className="company-error" role="alert">
            {error}
          </div>
        )}
        {result ? (
          <>
            <p>
              {result.filed
                ? `${result.filed} suggestions are waiting in the Inbox (from ${result.candidates} things found in ${result.documents} ${result.kind === 'url' ? 'pages' : 'documents'}).`
                : result.candidates
                  ? 'Nothing new: everything found is already in the Inbox or in Knowledge.'
                  : 'Nothing that looks like lasting company memory was found.'}
              {result.known ? ` ${result.known} were already known.` : ''}
              {result.dropped ? ` ${result.dropped} weaker ones were left out.` : ''}
            </p>
            {!!result.preview.length && (
              <ul className="op-import-preview">
                {result.preview.map((p, i) => (
                  <li key={i}>
                    <strong>{p.note}</strong> {p.text}
                    <small>{p.from}</small>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <>
            <fieldset className="company-checklist" disabled={busy}>
              <legend>What do you have?</legend>
              {KINDS.map((k) => (
                <label key={k.kind} className="op-import-kind">
                  <input type="radio" name="op-import-kind" checked={kind === k.kind} onChange={() => setKind(k.kind)} />
                  <span>
                    <strong>{k.label}</strong>
                    <small>{k.hint}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            {kind === 'url' && (
              <label className="company-field">
                Website
                <input value={url} placeholder="https://acme.com" onChange={(e) => setUrl(e.target.value)} disabled={busy} />
              </label>
            )}
            {kind === 'text' && (
              <label className="company-field">
                Text
                <textarea rows={8} value={text} maxLength={200_000} placeholder="We sell… Our customers are… We never…" onChange={(e) => setText(e.target.value)} disabled={busy} />
              </label>
            )}
            <p className="company-help">Everything lands in the Inbox as suggestions you accept or reject. Secrets, emails and phone numbers are skipped.</p>
          </>
        )}
      </div>
    </Sheet>
  )
}
