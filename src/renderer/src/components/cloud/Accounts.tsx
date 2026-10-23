/**
 * Accounts (docs/CLOUD.md §7.2, §13.1): two clear rows, Claude and Codex (ChatGPT), with status, the Subscription or
 * API billing badge and expiry. Gemini is under the card's ⋯ (Add another provider) and gets its own row once it has
 * a key. One primary action per row (Connect Claude, Sign in with ChatGPT; Test when connected) and a ⋯ menu
 * (Replace, Remove, Use an API key instead). Linking runs on this Mac in the browser; pasting is the fallback. The
 * one-account rule is said once, in the confirm before a browser sign-in.
 */
import { useState, type ReactElement } from 'react'
import { CLOUD_ADAPTERS, type CloudAdapter, type ProviderAccount, type ProviderCredentialKind } from '@shared/cloud'
import { Button } from '../ui'
import { ADAPTER_LABEL, API_KEY_KIND, PASTE_KIND, accountRow, loginLine, pasteProblem } from '../../lib/cloud'
import { confirmNative, errorMessage, hive, nativeMenu } from '../../lib/hive'
import { toast } from '../../state/store'
import { refreshCloud, useCloud } from '../../state/cloud'
import { ProviderMark, Tess } from './bits'

const KIND_LABEL: Record<ProviderCredentialKind, string> = {
  claude_oauth_token: 'Claude token (from claude setup-token)',
  anthropic_api_key: 'Anthropic API key',
  openai_api_key: 'OpenAI API key',
  codex_auth_json: 'Codex sign-in file',
  codex_access_token: 'Codex access token',
  gemini_api_key: 'Gemini API key',
  google_service_account: 'Vertex service account JSON'
}

/** The confirm before a browser sign-in: what happens, and the one rule (an account is one person's). */
export const LOGIN_CONFIRM: Record<'claude' | 'codex', { message: string; detail: string; confirmLabel: string }> = {
  claude: {
    message: 'Connect your Claude account to your cloud?',
    detail: 'Your browser opens once on claude.ai. The token goes straight to your cloud, encrypted, and is never shown. Use your own account: never share a subscription.',
    confirmLabel: 'Connect Claude'
  },
  codex: {
    message: 'Sign in with ChatGPT for your cloud?',
    detail: 'Your browser opens once on ChatGPT. This is a second sign-in just for the cloud, so Codex on this Mac stays signed in. Use your own account: never share a subscription.',
    confirmLabel: 'Sign In'
  }
}

/** Starts Connect Claude / Sign in with ChatGPT on this Mac; progress arrives through evt:cloud. */
export async function startLogin(adapter: 'claude' | 'codex'): Promise<void> {
  if (!(await confirmNative(LOGIN_CONFIRM[adapter]).catch(() => false))) return
  try {
    if (adapter === 'claude') await hive.cloud.loginClaude()
    else await hive.cloud.loginCodex()
  } catch (e) {
    toast(errorMessage(e), 'error')
  }
}

export function AccountsCard({ paste, setPaste }: { paste: { adapter: CloudAdapter; kind: ProviderCredentialKind } | null; setPaste: (p: { adapter: CloudAdapter; kind: ProviderCredentialKind } | null) => void }): ReactElement {
  const providers = useCloud((s) => s.summary?.providers) ?? []
  const rows = CLOUD_ADAPTERS.map((a) => providers.find((p) => p.adapter === a) ?? ({ adapter: a, credential: null, status: 'missing', detail: null, cliVersion: null } as ProviderAccount))
    // Gemini (the least-used harness) shows once it has a key, or while one is being added
    .filter((a) => a.adapter !== 'gemini' || !!a.credential || paste?.adapter === 'gemini')
  const more = async (): Promise<void> => {
    const id = await nativeMenu([
      { id: 'gemini', label: 'Add another provider: Gemini key…' },
      { id: 'sa', label: 'Add another provider: Vertex service account…' }
    ])
    if (id === 'gemini') setPaste({ adapter: 'gemini', kind: API_KEY_KIND.gemini })
    if (id === 'sa') setPaste({ adapter: 'gemini', kind: 'google_service_account' })
  }
  return (
    <section className="cl-card">
      <div className="cl-ctitle">
        Accounts
        <button type="button" className="cl-more cl-ctitle__more" aria-label="More accounts" onClick={() => void more()}>
          ⋯
        </button>
      </div>
      {rows.map((a) => (
        <AccountRowView key={a.adapter} account={a} pasting={paste?.adapter === a.adapter ? paste.kind : null} setPaste={setPaste} />
      ))}
    </section>
  )
}

function AccountRowView({ account, pasting, setPaste }: { account: ProviderAccount; pasting: ProviderCredentialKind | null; setPaste: (p: { adapter: CloudAdapter; kind: ProviderCredentialKind } | null) => void }): ReactElement {
  const login = useCloud((s) => s.state?.login ?? null)
  const row = accountRow(account)
  const progress = loginLine(login, account.adapter)
  const [testing, setTesting] = useState(false)
  const primary = async (): Promise<void> => {
    if (row.primary.kind === 'connectClaude') return startLogin('claude')
    if (row.primary.kind === 'signInChatGPT') return startLogin('codex')
    if (row.primary.kind === 'addKey') return setPaste({ adapter: account.adapter, kind: API_KEY_KIND[account.adapter] })
    setTesting(true)
    try {
      const t = await hive.cloud.providerTest({ adapter: account.adapter })
      toast(t.ok ? `${row.name}: ${t.detail}` : `${row.name} test failed: ${t.detail}`, t.ok ? 'info' : 'error')
      await refreshCloud()
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setTesting(false)
    }
  }
  const more = async (): Promise<void> => {
    const id = await nativeMenu([
      { id: 'replace', label: 'Replace…', enabled: !!account.credential },
      { id: 'remove', label: 'Remove', enabled: !!account.credential },
      { type: 'separator' },
      { id: 'paste', label: account.adapter === 'claude' ? 'Paste a token…' : account.adapter === 'codex' ? 'Paste an API key…' : 'Paste a key…' },
      ...(account.adapter === 'gemini' ? [{ id: 'sa', label: 'Use a service account instead…' }] : [{ id: 'api', label: 'Use an API key instead…' }])
    ])
    if (id === 'replace') {
      if (account.adapter === 'claude') return startLogin('claude')
      if (account.adapter === 'codex') return startLogin('codex')
      return setPaste({ adapter: account.adapter, kind: account.credential?.kind ?? API_KEY_KIND.gemini })
    }
    if (id === 'remove') {
      if (!(await confirmNative({ message: `Remove the ${row.name} account from your cloud?`, detail: 'Cloud runs that use it stop until you connect one again.', confirmLabel: 'Remove', destructive: true }))) return
      try {
        await hive.cloud.providerDelete({ adapter: account.adapter })
        await refreshCloud()
      } catch (e) {
        toast(errorMessage(e), 'error')
      }
    }
    if (id === 'paste') setPaste({ adapter: account.adapter, kind: PASTE_KIND[account.adapter] })
    if (id === 'api') setPaste({ adapter: account.adapter, kind: API_KEY_KIND[account.adapter] })
    if (id === 'sa') setPaste({ adapter: account.adapter, kind: 'google_service_account' })
  }
  return (
    <div className="cl-acct-wrap">
      <div className="cl-acct">
        <ProviderMark adapter={account.adapter} />
        <div className="cl-ai">
          <b>{row.name}</b>
          <span>{row.line}</span>
        </div>
        {row.badge && <span className={`cl-badge ${row.badge === 'Subscription' ? 'cl-badge--sub' : ''}`}>{row.badge}</span>}
        <span className={`cl-st ${row.status.tone === 'off' ? 'cl-st--dim' : ''}`}>
          <Tess kind={row.status.tone === 'ok' ? 'ok' : row.status.tone === 'err' ? 'fail' : row.status.tone === 'warn' ? 'needs' : 'q'} />
          {row.status.label}
        </span>
        {!progress?.busy && (
          <Button size="sm" variant={row.primary.kind === 'test' ? 'secondary' : row.status.tone === 'err' || row.primary.kind !== 'addKey' ? 'primary' : 'secondary'} disabled={testing} onClick={() => void primary()}>
            {row.primary.label}
          </Button>
        )}
        <button type="button" className="cl-more" aria-label={`More for ${row.name}`} onClick={() => void more()}>
          ⋯
        </button>
      </div>
      {progress && <LoginProgress adapter={account.adapter} busy={progress.busy} text={progress.text} failed={progress.failed} onPaste={() => setPaste({ adapter: account.adapter, kind: PASTE_KIND[account.adapter] })} onApiKey={() => setPaste({ adapter: account.adapter, kind: API_KEY_KIND[account.adapter] })} />}
      {pasting && <PasteForm adapter={account.adapter} kind={pasting} onDone={() => setPaste(null)} />}
    </div>
  )
}

function LoginProgress({ adapter, busy, text, failed, onPaste, onApiKey }: { adapter: CloudAdapter; busy: boolean; text: string; failed: boolean; onPaste: () => void; onApiKey: () => void }): ReactElement {
  const login = useCloud((s) => s.state?.login ?? null)
  return (
    <div className={`cl-login ${failed ? 'is-failed' : ''}`} role="status">
      <p>
        {busy && <Tess kind="running" />} {text}
      </p>
      {busy && adapter === 'codex' && <p className="cl-dim">This is a separate sign-in for your cloud. Codex on this Mac stays signed in.</p>}
      {login?.installHint && <pre className="cl-pre selectable">{login.installHint}</pre>}
      <div className="cl-row">
        {busy && (
          <Button size="sm" variant="ghost" onClick={() => void hive.cloud.loginCancel()}>
            Cancel
          </Button>
        )}
        {busy && login?.browserUrl && (
          <button type="button" className="cl-link" onClick={() => void hive.app.openExternal({ url: login.browserUrl! })}>
            Open the page again
          </button>
        )}
        {failed && adapter === 'claude' && (
          <button type="button" className="cl-link" onClick={onPaste}>
            Paste a token
          </button>
        )}
        {(failed || busy) && (
          <button type="button" className="cl-link cl-link--quiet" onClick={onApiKey}>
            Use an API key instead
          </button>
        )}
      </div>
    </div>
  )
}

function PasteForm({ adapter, kind, onDone }: { adapter: CloudAdapter; kind: ProviderCredentialKind; onDone: () => void }): ReactElement {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const json = kind === 'google_service_account'
  const save = async (): Promise<void> => {
    const problem = pasteProblem(kind, value)
    if (problem) return setError(problem)
    setBusy(true)
    setError(null)
    try {
      await hive.cloud.providerPut({ adapter, kind, value: value.trim() })
      setValue('')
      onDone()
      await refreshCloud()
      toast(`${ADAPTER_LABEL[adapter]} saved in your cloud, encrypted.`)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="cl-paste"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <label className="cl-field">
        <span>{KIND_LABEL[kind]}</span>
        {json ? (
          <textarea className="input cl-secret-area" rows={3} value={value} spellCheck={false} autoComplete="off" autoFocus onChange={(e) => setValue(e.target.value)} />
        ) : (
          <input className="input cl-mono" type="password" value={value} autoComplete="off" spellCheck={false} autoFocus onChange={(e) => setValue(e.target.value)} />
        )}
      </label>
      {kind === 'claude_oauth_token' && <p className="cl-dim">Run claude setup-token in Terminal and paste what it prints.</p>}
      {(kind === 'anthropic_api_key' || kind === 'openai_api_key' || kind === 'gemini_api_key') && <p className="cl-dim">API keys bill per token on that provider's account.</p>}
      {error && <p className="cl-error">{error}</p>}
      <div className="cl-row">
        <Button size="sm" variant="primary" disabled={busy || !value.trim()} onClick={() => void save()}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <span className="cl-dim">Sent encrypted. Never shown again.</span>
      </div>
    </form>
  )
}
