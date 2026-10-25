/**
 * Connect Instagram (five doors step 4, design §4.10, pm-review E12), in drafts-only mode and honest about why:
 * Instagram lets only Meta-approved apps sign in, save drafts or post, and Principia's app review takes weeks. So this
 * sheet asks which account is the company's, says exactly what the agent does (gets each post ready for your OK, you
 * tap Post), and never asks for a password. Connected names the account (@northwindcoffee) and belongs to this company
 * only. A founder with their own Meta app can still give agents its token in Keys & secrets.
 */
import { useState } from 'react'
import type { CompanyPassport } from '@shared/company'
import { Button, Sheet } from '../ui'
import { Icon } from '../Icon'
import { errorMessage, hive } from '../../lib/hive'
import { instagramAccount } from '../../lib/connections'
import { navigate, refreshCompanies, setState, toast } from '../../state/store'

export function InstagramSheet({ company, writer, onClose }: { company: CompanyPassport; writer: string | null; onClose: () => void }): React.JSX.Element {
  const current = company.accounts?.instagram ?? null
  const [step, setStep] = useState<'explain' | 'done' | 'manage'>(current ? 'manage' : 'explain')
  const [raw, setRaw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const handle = instagramAccount(raw)
  const who = writer ?? 'Your agents'
  const short = company.name.split(/\s+/)[0]

  const save = async (next: string | null): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await hive.company.update({ id: company.id, patch: { account: { kind: 'instagram', handle: next } } })
      setState((s) => ({ companies: s.companies.map((c) => (c.id === res.id ? res : c)) }))
      void refreshCompanies().catch(() => undefined)
      if (next) setStep('done')
      else {
        toast(`Instagram disconnected from ${company.name}`)
        onClose()
      }
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (step === 'done' || step === 'manage') {
    const h = step === 'done' ? handle : current?.handle
    return (
      <Sheet
        title={step === 'done' ? 'Instagram is connected' : `Instagram · ${h ?? ''}`}
        width={540}
        onCancel={onClose}
        cancelLabel="Done"
        footerLeft={
          step === 'manage' ? (
            <Button variant="ghost" disabled={busy} onClick={() => void save(null)}>
              Disconnect
            </Button>
          ) : undefined
        }
      >
        <div className="s5-sheet">
          <p className="s5-sheet__lead">
            <Icon name="check" size={14} /> <b>{h}</b> is connected to {company.name} only.
          </p>
          <p className="s5-sheet__p">
            From now on {who} writes each post for {h}: the picture, the caption and the hashtags. It waits in Needs you for your OK. Then you open Instagram on your phone and tap Post.
          </p>
          <p className="s5-sheet__p text-tertiary">Instagram doesn’t let apps post or save drafts for you yet. When Meta approves Principia, we’ll ask before turning that on.</p>
          {error && <p className="s5-sheet__warn" role="alert">{error}</p>}
        </div>
      </Sheet>
    )
  }

  return (
    <Sheet title={`Connect Instagram to ${company.name}`} width={560} onCancel={onClose} cancelLabel="Not now" onPrimary={() => { if (handle && !busy) void save(handle) }} primaryLabel={handle ? `Connect ${handle}` : 'Connect'} primaryDisabled={!handle || busy}>
      <form
        className="s5-sheet"
        onSubmit={(e) => {
          e.preventDefault()
          if (handle && !busy) void save(handle)
        }}
      >
        <ol className="s5-steps">
          <li>
            <b>1.</b> Tell us which Instagram account is {short}’s.
          </li>
          <li>
            <b>2.</b> {who} gets each post ready: picture, caption and hashtags, in your brand voice. It waits in Needs you for your OK.
          </li>
          <li>
            <b>3.</b> You open Instagram on your phone and tap Post.
          </li>
        </ol>
        <label className="s5-field">
          <span>Instagram account</span>
          <input className="input" data-autofocus value={raw} placeholder="@yourshop" spellCheck={false} autoComplete="off" onChange={(e) => setRaw(e.target.value)} aria-invalid={!!raw.trim() && !handle} />
          {raw.trim() && !handle && <small className="s5-field__err">That doesn’t look like an Instagram account name. Use letters, numbers, dots and underscores.</small>}
        </label>
        <div className="s5-box">
          <Icon name="shield" size={14} />
          <div>
            <b>Why drafts only?</b> Instagram lets only apps Meta has approved sign in, save drafts or post. Principia’s review with Meta is in progress, and it takes weeks. Until then nothing is sent to Instagram, and Principia never sees your Instagram password.
          </div>
        </div>
        <p className="s5-sheet__p text-tertiary">
          Have your own Meta app?{' '}
          <button type="button" className="link-btn" onClick={() => (onClose(), void navigate({ name: 'settings', section: 'keys', nonce: Date.now() }))}>
            Add its INSTAGRAM_ACCESS_TOKEN in Keys &amp; secrets
          </button>{' '}
          and agents can post through it.
        </p>
        {error && <p className="s5-sheet__warn" role="alert">{error}</p>}
      </form>
    </Sheet>
  )
}
