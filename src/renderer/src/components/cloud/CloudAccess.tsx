/**
 * docs/ACCOUNTS.md on the Keys page: sign in once, here, and every run in your cloud is signed in. The model accounts
 * (Claude, Codex, Gemini) are the Cloud page's Accounts card; GitHub and the "In the cloud" switch on Shared keys are
 * new. Values go to the cloud once and never come back to this window.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { isGithubToken, type CloudAccountsView, type CloudAdapter, type ProviderCredentialKind } from '@shared/cloud'
import { Button, Switch } from '../ui'
import { confirmNative, errorMessage, hive, nativeMenu, useHiveEvent } from '../../lib/hive'
import { navigate, toast } from '../../state/store'
import { ensureCloud, useCloud } from '../../state/cloud'
import { AccountsCard } from './Accounts'
import { Tess } from './bits'

const NOT_LINKED: CloudAccountsView = { linked: false, github: null, inCloud: [], cloudKeys: [] }

/** The cloud's GitHub account and shared keys, refreshed when keys, settings or the cloud link change. */
export function useCloudAccounts(): { view: CloudAccountsView; refresh: () => void; set: (v: CloudAccountsView) => void } {
  const linked = useCloud((s) => !!s.state?.linked)
  const [view, set] = useState<CloudAccountsView>(NOT_LINKED)
  const refresh = useCallback(() => void hive.cloud.accounts().then(set, () => set(NOT_LINKED)), [])
  useEffect(() => ensureCloud(), [])
  useEffect(refresh, [linked, refresh])
  useHiveEvent('settings:changed', refresh)
  useHiveEvent('data:changed', ({ domain }) => domain === 'secrets' && refresh())
  return { view, refresh, set }
}

/** Top of the Keys page: the accounts every cloud run signs in with, or the one line that gets you a cloud. */
export function KeysAccounts({ view, set }: { view: CloudAccountsView; set: (v: CloudAccountsView) => void }): ReactElement {
  const [paste, setPaste] = useState<{ adapter: CloudAdapter; kind: ProviderCredentialKind } | null>(null)
  if (!view.linked)
    return (
      <div className="keys-note keys-note--where">
        Agents on this Mac use your own Claude, Codex and GitHub sign-ins. To give agents in the cloud the same accounts, sign in once from{' '}
        <button type="button" className="link-btn" onClick={() => void navigate({ name: 'cloud' })}>
          Cloud
        </button>
        .
      </div>
    )
  return (
    <div className="keys-accounts cl-view">
      <AccountsCard paste={paste} setPaste={setPaste} />
      <section className="cl-card">
        <div className="cl-ctitle">Tools</div>
        <GithubRow view={view} set={set} />
      </section>
    </div>
  )
}

function GithubRow({ view, set }: { view: CloudAccountsView; set: (v: CloudAccountsView) => void }): ReactElement {
  const [busy, setBusy] = useState(false)
  const [pasting, setPasting] = useState(false)
  const gh = view.github
  const run = async (f: () => Promise<CloudAccountsView>, done: string): Promise<void> => {
    setBusy(true)
    try {
      set(await f())
      toast(done)
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  const fromMac = async (): Promise<void> => {
    const ok = await confirmNative({
      message: 'Use this Mac’s GitHub sign-in in your cloud?',
      detail: 'Principia reads the token the GitHub CLI (gh) already holds and sends it to your cloud, encrypted. Repositories without a token of their own clone and push with it, and cloud agents can use gh. Remove it here any time.',
      confirmLabel: 'Use My GitHub'
    }).catch(() => false)
    if (ok) await run(() => hive.cloud.githubConnect({}), 'GitHub is connected to your cloud.')
  }
  const more = async (): Promise<void> => {
    const id = await nativeMenu([
      { id: 'paste', label: 'Paste a token instead…' },
      { id: 'remove', label: 'Remove', enabled: !!gh }
    ])
    if (id === 'paste') setPasting(true)
    if (id === 'remove' && (await confirmNative({ message: 'Remove GitHub from your cloud?', detail: 'Cloud runs keep repository tokens of their own; the rest can no longer push or use gh.', confirmLabel: 'Remove', destructive: true }).catch(() => false)))
      await run(() => hive.cloud.githubRemove(), 'GitHub removed from your cloud.')
  }
  return (
    <div className="cl-acct-wrap">
      <div className="cl-acct">
        <span className="cl-ghmark" aria-hidden>
          GH
        </span>
        <div className="cl-ai">
          <b>GitHub</b>
          <span>{gh ? `${gh.login ? `@${gh.login}` : 'Connected'} · clone, push and gh in every cloud run` : 'Lets cloud agents clone, push and use gh'}</span>
        </div>
        <span className={`cl-st ${gh ? '' : 'cl-st--dim'}`}>
          <Tess kind={gh ? 'ok' : 'q'} />
          {gh ? 'Connected' : 'Not connected'}
        </span>
        <Button size="sm" variant={gh ? 'secondary' : 'primary'} disabled={busy} onClick={() => void fromMac()}>
          {gh ? 'Replace' : 'Use This Mac’s GitHub'}
        </Button>
        <button type="button" className="cl-more" aria-label="More for GitHub" onClick={() => void more()}>
          ⋯
        </button>
      </div>
      {pasting && <GithubPaste onDone={() => setPasting(false)} set={set} />}
    </div>
  )
}

function GithubPaste({ onDone, set }: { onDone: () => void; set: (v: CloudAccountsView) => void }): ReactElement {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async (): Promise<void> => {
    if (!isGithubToken(value)) return setError('That does not look like a GitHub token (gho_, ghp_ or github_pat_…).')
    setBusy(true)
    setError(null)
    try {
      set(await hive.cloud.githubConnect({ token: value.trim() }))
      setValue('')
      onDone()
      toast('GitHub is connected to your cloud.')
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
        <span>GitHub token</span>
        <input className="input cl-mono" type="password" value={value} autoComplete="off" spellCheck={false} autoFocus onChange={(e) => setValue(e.target.value)} />
      </label>
      <p className="cl-dim">A fine-grained token limited to the repositories your agents need is the safest choice.</p>
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

/** "In the cloud" on a Shared key: every cloud run gets it too. Off without a cloud (the choice still sticks). */
export function CloudKeySwitch({ name, view, set }: { name: string; view: CloudAccountsView; set: (v: CloudAccountsView) => void }): ReactElement {
  const on = view.cloudKeys.includes(name)
  const [busy, setBusy] = useState(false)
  const flip = async (v: boolean): Promise<void> => {
    setBusy(true)
    try {
      set(await hive.cloud.keyCloud({ name, on: v }))
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  const title = !view.linked ? 'Connect a cloud to send this key there' : on ? (view.inCloud.includes(name) ? 'In the cloud: every cloud run gets it' : 'Sending to the cloud…') : 'Only agents on this Mac get it'
  return (
    <span className="key-cloud" title={title} onClick={(e) => e.stopPropagation()}>
      <Switch checked={on} disabled={busy || !view.linked} onChange={(v) => void flip(v)} label={`${name} in the cloud`} />
    </span>
  )
}
