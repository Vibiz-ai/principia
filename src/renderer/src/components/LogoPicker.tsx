/**
 * "Change Logo…" (rail right-click, Portfolio card, Company Settings): the logo-like images found in the company's
 * repositories as a grid, best first, plus "Choose File…", "Use Initials" and, after a manual pick, "Detect
 * Automatically". The pick is copied into the company's app data by main (company:setLogo); the repo file is never
 * referenced afterwards.
 */
import { useEffect, useState } from 'react'
import type { LogoCandidate } from '@shared/company'
import { companyLabel } from '../lib/company'
import { errorMessage, hive } from '../lib/hive'
import { useLogoFit } from '../lib/logo'
import { CompanyCoin } from '../shell/CompanyRail'
import { closeLogoPicker, setCompanyLogo, useStore } from '../state/store'
import { Button, Sheet } from './ui'

export function LogoPickerSheet(): React.JSX.Element | null {
  const id = useStore((s) => s.logoPickerFor)
  if (!id) return null
  return <LogoPicker key={id} companyId={id} />
}

function LogoPicker({ companyId }: { companyId: string }): React.JSX.Element | null {
  const company = useStore((s) => s.companies.find((c) => c.id === companyId))
  const logo = useStore((s) => s.companyLogos[companyId])
  const [list, setList] = useState<LogoCandidate[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    hive.company.logoCandidates({ id: companyId }).then(
      (l) => live && setList(l),
      (e) => live && (setError(errorMessage(e)), setList([]))
    )
    return () => {
      live = false
    }
  }, [companyId])
  if (!company) return null
  const repoCount = company.repoIds.length
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    if (busy) return
    setBusy(true)
    const res = await fn().finally(() => setBusy(false))
    if (res) closeLogoPicker()
  }
  const use = (path: string) => run(() => setCompanyLogo(companyId, { kind: 'candidate', path }))
  const current = logo?.origin ?? null
  const status =
    logo?.source === 'manual' ? `Chosen by you${current ? ` · ${current}` : ''}` : logo?.source === 'none' ? 'Initials (chosen by you)' : logo?.dataUrl ? `Found automatically · ${current}` : 'Initials (no logo found yet)'
  return (
    <Sheet
      title={`Logo for ${companyLabel(company, true)}`}
      width={560}
      onCancel={closeLogoPicker}
      onPrimary={sel ? () => void use(sel) : undefined}
      primaryLabel="Use This Logo"
      primaryDisabled={!sel || busy}
      footerLeft={
        <div className="logo-pick__actions">
          <Button icon="folder" disabled={busy} onClick={() => void run(() => setCompanyLogo(companyId, { kind: 'file' }))}>
            Choose File…
          </Button>
          <Button disabled={busy || logo?.source === 'none'} onClick={() => void run(() => setCompanyLogo(companyId, { kind: 'none' }))}>
            Use Initials
          </Button>
          {logo && logo.source !== 'auto' && (
            <Button disabled={busy} title="Use the best logo found in this company’s repositories, and keep it up to date as repositories are added" onClick={() => void run(() => setCompanyLogo(companyId, { kind: 'auto' }))}>
              Detect Automatically
            </Button>
          )}
        </div>
      }
    >
      <div className="logo-pick">
        <div className="logo-pick__now">
          <CompanyCoin company={company} size={40} />
          <div className="logo-pick__now-text">
            <div className="logo-pick__now-title">Shown on the rail and in the sidebar</div>
            <div className="text-tertiary logo-pick__now-sub" title={current ?? undefined}>
              {status}
            </div>
          </div>
        </div>
        {list === null ? (
          <div className="logo-pick__empty text-tertiary">
            Looking in {repoCount} repositor{repoCount === 1 ? 'y' : 'ies'}…
          </div>
        ) : list.length === 0 ? (
          <div className="logo-pick__empty text-tertiary">
            {error ?? (repoCount ? 'No logo found in this company’s repositories (public/, app/icon, assets/, logo files, web manifest).' : 'This company has no repositories yet. Add one with a logo, or choose a file.')}
          </div>
        ) : (
          <div className="logo-pick__grid" role="listbox" aria-label="Logos found in the repositories">
            {list.map((c, i) => (
              <Candidate key={c.path} c={c} suggested={i === 0 && c.confident} selected={sel === c.path} current={!!current && c.label === current} onSelect={() => setSel(c.path)} onUse={() => void use(c.path)} />
            ))}
          </div>
        )}
      </div>
    </Sheet>
  )
}

function Candidate({ c, suggested, selected, current, onSelect, onUse }: { c: LogoCandidate; suggested: boolean; selected: boolean; current: boolean; onSelect: () => void; onUse: () => void }): React.JSX.Element {
  const fit = useLogoFit(c.dataUrl)
  const file = c.label.split('/').pop() ?? c.label
  const size = c.width && c.height ? `${Math.round(c.width)}×${Math.round(c.height)}` : ''
  return (
    <button type="button" role="option" aria-selected={selected} className={`logo-pick__item ${selected ? 'is-sel' : ''}`} title={`${c.label}${size ? ` · ${size}` : ''}\nDouble-click to use`} onClick={onSelect} onDoubleClick={onUse}>
      <span className={`logo-pick__img logo-pick__img--${fit ?? 'plain'}`}>
        <img src={c.dataUrl} alt="" draggable={false} />
      </span>
      <span className="logo-pick__name">{file}</span>
      <span className="logo-pick__meta text-tertiary">{current ? 'Current' : suggested ? 'Best match' : size || c.label.split('/')[0]}</span>
    </button>
  )
}
