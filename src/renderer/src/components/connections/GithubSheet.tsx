/**
 * Connect GitHub (five doors step 4, design §4.10): "Use my gh login (found on this Mac: diego-ledgerly)". Agents push
 * their task branches and open pull requests through the GitHub CLI login on this Mac; connecting records that this
 * company may use it, and the card names the account. Nothing to paste. When gh is missing or signed out, the sheet
 * says how to fix that in one line and offers Recheck.
 */
import { useEffect, useState } from 'react'
import type { CompanyPassport } from '@shared/company'
import { Button, Sheet } from '../ui'
import { Icon } from '../Icon'
import { errorMessage, hive } from '../../lib/hive'
import { refreshCompanies, setState, toast } from '../../state/store'

export interface GhLogin {
  state: 'ok' | 'signedOut' | 'missing' | 'unknown'
  login: string | null
}
let memo: GhLogin | null = null
/** gh on this Mac (`gh auth status`, through onboarding:status), read once per window and on Recheck. */
export function useGhLogin(): GhLogin & { recheck: () => Promise<void> } {
  const [v, setV] = useState<GhLogin>(memo ?? { state: 'unknown', login: null })
  const load = async (): Promise<void> => {
    try {
      const s = await hive.onboarding.status()
      memo = { state: s.gh, login: s.ghLogin ?? null }
    } catch {
      memo = { state: 'unknown', login: null }
    }
    setV(memo)
  }
  useEffect(() => {
    if (!memo) void load()
  }, [])
  return { ...v, recheck: load }
}

export function GithubSheet({ company, gh, onClose }: { company: CompanyPassport; gh: GhLogin & { recheck: () => Promise<void> }; onClose: () => void }): React.JSX.Element {
  const current = company.accounts?.github ?? null
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async (handle: string | null): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await hive.company.update({ id: company.id, patch: { account: { kind: 'github', handle } } })
      setState((s) => ({ companies: s.companies.map((c) => (c.id === res.id ? res : c)) }))
      void refreshCompanies().catch(() => undefined)
      toast(handle ? `GitHub is connected for ${company.name} · ${handle}` : `GitHub disconnected from ${company.name}`)
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const why = (
    <div className="s5-box">
      <Icon name="shield" size={14} />
      <div>
        <b>Why connect if gh already works?</b> Agents work in their own copy of the repository, on a branch per task, and push it with your gh login. Connecting says {company.name}’s agents may push their branches and open pull requests, and shows which account they push as.
      </div>
    </div>
  )
  if (current)
    return (
      <Sheet title={`GitHub · ${company.name}`} width={540} onCancel={onClose} cancelLabel="Done" footerLeft={<Button variant="ghost" disabled={busy} onClick={() => void save(null)}>Disconnect</Button>}>
        <div className="s5-sheet">
          <p className="s5-sheet__lead">
            <Icon name="check" size={14} /> Connected as <b>{current.handle}</b>, with the gh login on this Mac.
          </p>
          {gh.state === 'signedOut' && <p className="s5-sheet__warn">gh is signed out on this Mac right now. Run <span className="mono">gh auth login</span> in Terminal, then Recheck.</p>}
          {gh.state === 'missing' && <p className="s5-sheet__warn">The GitHub CLI (gh) isn’t installed on this Mac any more. Install it (brew install gh), then Recheck.</p>}
          {gh.state === 'ok' && gh.login && gh.login !== current.handle && <p className="s5-sheet__warn">gh on this Mac is now signed in as {gh.login}. Agents push as {gh.login}. Reconnect to record that.</p>}
          {why}
          {error && <p className="s5-sheet__warn" role="alert">{error}</p>}
          <div className="s5-sheet__row">
            <Button size="sm" disabled={busy} onClick={() => void gh.recheck()}>
              Recheck
            </Button>
            {gh.state === 'ok' && gh.login && gh.login !== current.handle && (
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void save(gh.login)}>
                Use {gh.login}
              </Button>
            )}
          </div>
        </div>
      </Sheet>
    )
  const ready = gh.state === 'ok'
  return (
    <Sheet title={`Connect GitHub to ${company.name}`} width={560} onCancel={onClose} cancelLabel="Not now" onPrimary={ready ? () => void save(gh.login ?? 'github') : undefined} primaryLabel="Use my gh login" primaryDisabled={!ready || busy}>
      <div className="s5-sheet">
        {ready ? (
          <div className="s5-choice is-on">
            <Icon name="check" size={16} />
            <div>
              <b>Use my gh login</b> <span className="text-tertiary">(found on this Mac{gh.login ? `: ${gh.login}` : ''})</span>
              <div className="text-secondary">One click. Nothing to paste.</div>
            </div>
          </div>
        ) : (
          <div className="s5-choice">
            <Icon name="warning" size={16} />
            <div>
              <b>{gh.state === 'missing' ? 'The GitHub CLI isn’t on this Mac' : gh.state === 'signedOut' ? 'gh isn’t signed in on this Mac' : 'Checking gh on this Mac…'}</b>
              <div className="text-secondary">
                {gh.state === 'missing' ? (
                  <>
                    Install it with <span className="mono">brew install gh</span>, run <span className="mono">gh auth login</span> in Terminal, then Recheck.
                  </>
                ) : gh.state === 'signedOut' ? (
                  <>
                    Run <span className="mono">gh auth login</span> in Terminal, then Recheck.
                  </>
                ) : (
                  'One moment.'
                )}
              </div>
            </div>
            <span className="flex1" />
            <Button size="sm" onClick={() => void gh.recheck()}>
              Recheck
            </Button>
          </div>
        )}
        {why}
        {error && <p className="s5-sheet__warn" role="alert">{error}</p>}
      </div>
    </Sheet>
  )
}
