/**
 * Company settings (COMPANY.md C6, PASSPORT.md §10): the old Passport form, now one company at a time with no company
 * list of its own. The company is the view's (`{ name: 'company', companyId }`, from the rail menu or a chooser) or
 * the focused one; All mode with nothing picked shows a "Pick a company" chooser. Sections: identity (name, colour),
 * profile (the seven fields; once the vault exists they edit the company hub note), repositories, Passport vault
 * location, export / import, archive.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CompanyPassport, CompanyPassportInput, PassportExport } from '@shared/company'
import { PERSONAL_COMPANY_ID, PROFILE_FIELDS } from '@shared/company'
import type { OpenPassportPreview, OpenPassportSyncView, VaultApplyResult, VaultNoteText, VaultStatus, VaultTreeEntry } from '@shared/passport'
import type { Repo } from '@shared/types'
import { Button, Loading, Sheet, Toolbar } from '../components/ui'
import { Icon } from '../components/Icon'
import { CompanyChooser, useScope } from '../components/CompanyChip'
import { PassportConnect } from '../components/passport/PassportConnect'
import { companyInitials, companyLabel, isPersonal, railLookAlikes, reposOf, useCompanyData } from '../lib/company'
import { parseRgb, type Rgb } from '../lib/companyModel'
import { prefixHint, taskPrefixProblem } from '../lib/settingsModel'
import { confirmNative, errorMessage, hive, nativeMenu } from '../lib/hive'
import { findHubNote, HUB_CATEGORY, hubFieldOps, hubFieldText, opFailures, type HubField } from '../lib/scope'
import { relative } from '../lib/time'
import { CompanyAvatar, RailMark } from '../shell/CompanyRail'
import {
  addRepos,
  archiveCompany,
  assignRepoToCompany,
  attempt,
  companyName,
  navigate,
  openCompanyPassport,
  openLogoPicker,
  openNewCompany,
  refreshCompanies,
  refreshTasks,
  toast,
  updateCompany,
  useStore
} from '../state/store'

type Profile = Pick<CompanyPassportInput, (typeof PROFILE_FIELDS)[number]>
const CONTEXT_FIELDS = [
  { key: 'mission', label: 'Mission', hint: 'Why this company exists. The problem it solves and the change it wants to make.', placeholder: 'What are we here to do?' },
  { key: 'audience', label: 'Customers & audience', hint: 'Who you serve, what they need and what they care about.', placeholder: 'Who are we building for?' },
  { key: 'products', label: 'Products & services', hint: 'What you offer, how it works and how the business makes money.', placeholder: 'What do we sell or deliver?' },
  { key: 'brandVoice', label: 'Brand & voice', hint: 'How the company should sound. Include positioning, examples and language to avoid.', placeholder: 'How should we show up in the world?' },
  { key: 'goals', label: 'Goals & priorities', hint: 'Current objectives, success measures and what matters most right now.', placeholder: 'What are we working toward?' },
  { key: 'context', label: 'Business context', hint: 'Decisions, operating knowledge, useful references and facts an agent should know.', placeholder: 'What context should travel with every task?' },
  { key: 'constraints', label: 'Boundaries & decisions', hint: 'Approval requirements, spending limits, promises and actions an agent must not take.', placeholder: 'Where should an agent stop and ask?' }
] as const satisfies readonly { key: HubField; label: string; hint: string; placeholder: string }[]
// cool colours only (no warm hues); Indigo is the accent the first companies were seeded with
const COLORS = ['var(--accent)', 'var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-other)']
const COLOR_NAMES = ['Indigo', 'Blue', 'Cyan', 'Green', 'Purple', 'Sky', 'Grey']

/** A colour token ("var(--series-1)") as the RGB it paints, read from the theme; the rail look-alike check uses it. */
function themeRgb(color: string): Rgb | null {
  const v = /^var\((--[\w-]+)\)$/.exec(color.trim())
  if (!v) return parseRgb(color)
  try {
    return parseRgb(getComputedStyle(document.documentElement).getPropertyValue(v[1]!))
  } catch {
    return null
  }
}

function profileOf(c: CompanyPassport): Profile {
  // legacy rows may carry NULL profile columns: the form always works on strings
  return { mission: c.mission ?? '', audience: c.audience ?? '', products: c.products ?? '', brandVoice: c.brandVoice ?? '', goals: c.goals ?? '', context: c.context ?? '', constraints: c.constraints ?? '' }
}

export function PassportView(): React.JSX.Element {
  const view = useStore((s) => s.view)
  const { active, companies, multi } = useScope()
  const { loading, error, reload } = useCompanyData()
  const [importing, setImporting] = useState(false)
  // Settings → Company carries what the old `company` route did (lib/nav resolveView)
  const own = view.name === 'company' || (view.name === 'settings' && (view.section === 'company' || view.section === 'repos' || view.section === 'danger')) ? view : null
  // five doors step 4: Settings › This company splits the old page into General, Repositories and Danger zone
  const part: CompanyPart = view.name === 'settings' && (view.section === 'repos' || view.section === 'danger') ? view.section : 'general'
  const target = own?.companyId
  const create = !!own?.create
  const nonce = own?.nonce
  // the view's company, else the focused one; a Personal-only user always edits Personal
  const companyId = target ?? (active !== 'all' ? active : multi ? null : (companies[0]?.id ?? null))
  const company = companyId ? companies.find((c) => c.id === companyId) : undefined

  useEffect(() => {
    if (create) openNewCompany()
  }, [create, nonce])

  const importButton = (
    <Button icon="upload" onClick={() => setImporting(true)} title="Import a Passport file as a new company">
      Import
    </Button>
  )
  return (
    <div className="view company-view">
      {company ? (
        <CompanySettings key={company.id} company={company} importButton={importButton} part={part} />
      ) : (
        <>
          <Toolbar title="Company settings">
            {importButton}
            <Button variant="primary" icon="plus" onClick={openNewCompany}>
              New Company
            </Button>
          </Toolbar>
          {error && (
            <div className="company-error" role="alert">
              {error}
              <Button size="sm" onClick={reload}>
                Retry
              </Button>
            </div>
          )}
          {loading ? (
            <Loading label="Loading companies…" />
          ) : (
            <div className="scroll view__body">
              <CompanyChooser
                title="Pick a company"
                text={target ? 'That company is archived or no longer exists. Pick another one.' : 'Settings belong to one company: its name and colour, profile, repositories, Knowledge folder and export.'}
                onPick={(id) => void navigate({ name: 'settings', section: 'company', companyId: id, nonce: Date.now() })}
              />
            </div>
          )}
        </>
      )}
      {importing && (
        <PassportImport
          companies={companies}
          onClose={() => setImporting(false)}
          onImported={(c) => {
            setImporting(false)
            void refreshCompanies().catch(() => undefined)
            toast(`Imported ${c.name}`)
            void navigate({ name: 'settings', section: 'company', companyId: c.id, nonce: Date.now() })
          }}
        />
      )}
    </div>
  )
}

/**
 * The hub note behind the profile once the company vault exists (PASSPORT.md §9.3, one observation per field line).
 * Only with `experimental.vault` on: with it off agents still read the flat profile, so the form must keep editing
 * it. null while the vault is missing or main doesn't serve the Passport channels yet: the flat profile is used.
 */
function useHubNote(company: CompanyPassport): { status: VaultStatus | null; note: VaultNoteText | null; reload: () => void } {
  const enabled = useStore((s) => !!s.settings?.experimental?.vault)
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [note, setNote] = useState<VaultNoteText | null>(null)
  const request = useRef(0)
  const load = (): void => {
    const n = ++request.current
    const current = (): boolean => request.current === n
    if (!enabled) {
      setStatus(null)
      setNote(null)
      return
    }
    void (async () => {
      let st: VaultStatus | null = null
      try {
        st = (await hive.memory.vault({ op: 'status', companyId: company.id })) as VaultStatus
        if (!current()) return
        setStatus(st)
        if (!st.exists || (st.state !== 'ready' && st.state !== 'readonly')) return setNote(null)
        // the hub keeps its path across renames (and a brought vault may name it differently): look it up
        const tree = (await hive.memory.links({ op: 'tree', companyId: company.id })) as VaultTreeEntry[]
        const hub = findHubNote(tree, company.name)
        const text = hub ? ((await hive.memory.note({ op: 'get', companyId: company.id, path: hub.path })) as VaultNoteText) : null
        if (current()) setNote(text)
      } catch {
        if (!current()) return
        // status failed: no vault in this build; a later step failed: keep the status, fall back to the flat profile
        if (!st) setStatus(null)
        setNote(null)
      }
    })()
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [enabled, company.id, company.name, company.vaultPath])
  return { status, note, reload: load }
}

export type CompanyPart = 'general' | 'repos' | 'danger'
const PART_TITLE: Record<CompanyPart, string> = { general: 'General', repos: 'Repositories', danger: 'Danger zone' }

function CompanySettings({ company: c, importButton, part }: { company: CompanyPassport; importButton: React.ReactNode; part: CompanyPart }): React.JSX.Element {
  const allRepos = useStore((s) => s.repos)
  const companies = useStore((s) => s.companies)
  const repos = useMemo(() => reposOf(allRepos, c.id), [allRepos, c.id])
  const personal = isPersonal(c)
  const hub = useHubNote(c)
  const facts = hub.note?.detail.facts ?? null
  const saved: Profile = useMemo(() => {
    if (!facts) return profileOf(c)
    const p = {} as Profile
    for (const f of CONTEXT_FIELDS) p[f.key] = hubFieldText(facts, f.key)
    return p
  }, [facts, c])
  const [name, setName] = useState(c.name)
  const [draft, setDraft] = useState<Profile | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => setName(c.name), [c.name])
  const values = draft ?? saved
  const dirty = !!draft && CONTEXT_FIELDS.some((f) => draft[f.key] !== saved[f.key])
  const filled = CONTEXT_FIELDS.filter((f) => values[f.key].trim()).length
  const readOnly = !!hub.note && hub.status?.state === 'readonly'

  const saveName = (): void => {
    const next = name.trim()
    if (!next || next === c.name) return setName(c.name)
    void updateCompany(c.id, { name: next })
  }
  const saveProfile = async (): Promise<void> => {
    if (!draft) return
    setBusy(true)
    setMessage(null)
    try {
      if (hub.note) {
        const title = hub.note.detail.note.title
        const ops = CONTEXT_FIELDS.flatMap((f) => hubFieldOps(hub.note!.detail.facts, f.key, draft[f.key], title))
        const res = ops.length ? ((await hive.memory.note({ op: 'ops', companyId: c.id, ops })) as VaultApplyResult) : null
        hub.reload()
        // the writer reports a stale line or a refused op per op instead of throwing: keep the draft and say so
        const failed = res ? opFailures(res.results) : null
        if (failed) throw new Error(failed)
      } else {
        await hive.company.save({ id: c.id, passport: { name: c.name, ...draft, repoIds: c.repoIds, color: c.color, vaultPath: c.vaultPath ?? null } })
        await refreshCompanies()
      }
      setDraft(null)
      toast('Company profile saved')
    } catch (e) {
      setMessage(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  /** Open Passport (open-passport SPEC.md): the whole Passport as a `.passport.zip` any harness can load, or the v1 profile JSON. */
  const exportMenu = async (): Promise<void> => {
    const id = await nativeMenu([
      { id: 'open', label: 'Open Passport Bundle (.passport.zip)…' },
      { id: 'json', label: 'Profile Only (.json)' }
    ])
    if (id === 'json') return download()
    if (id !== 'open') return
    setBusy(true)
    try {
      const r = await hive.company.exportOpenPassport({ id: c.id })
      if (r) toast(`Exported revision ${r.revision}: company card ${r.tokens.l0} tokens, largest department ${r.tokens.l1Max}`)
    } catch (e) {
      setMessage(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const download = async (): Promise<void> => {
    setBusy(true)
    try {
      const bundle = await hive.company.export({ id: c.id })
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `${c.slug || c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'company'}.passport.json`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast('Knowledge export prepared')
    } catch (e) {
      setMessage(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const addRepo = async (): Promise<void> => {
    const others = allRepos.filter((r) => !repos.some((x) => x.id === r.id))
    const id = await nativeMenu([
      { id: 'pick', label: 'Add Folder…' },
      ...(others.length
        ? [
            { type: 'separator' as const },
            { id: '__from', label: 'Move here from another company', enabled: false },
            ...others.map((r) => ({ id: `repo:${r.id}`, label: `${r.name} — ${companyName(r.companyId)}` }))
          ]
        : [])
    ])
    if (id === 'pick') return addRepos(c.id)
    const repo = id?.startsWith('repo:') ? others.find((r) => r.id === id.slice(5)) : undefined
    if (repo) await assignRepoToCompany(repo, c.id)
  }
  const repoMenu = async (r: Repo): Promise<void> => {
    const id = await nativeMenu([
      { label: 'Move to Company', submenu: companies.map((x) => ({ id: `to:${x.id}`, label: companyLabel(x, true), enabled: x.id !== c.id })) },
      ...(personal ? [] : [{ id: 'unassign', label: 'Unassign (move to Personal)' }])
    ])
    if (id === 'unassign') await assignRepoToCompany(r, PERSONAL_COMPANY_ID)
    else if (id?.startsWith('to:')) await assignRepoToCompany(r, id.slice(3))
  }
  const vault = async (op: 'reveal' | 'openInObsidian' | 'pick' | 'default'): Promise<void> => {
    if (op === 'reveal') return void attempt(() => hive.memory.vault({ op: 'reveal', companyId: c.id }), 'Open vault')
    if (op === 'openInObsidian') {
      const res = (await attempt(() => hive.memory.vault({ op: 'openInObsidian', companyId: c.id }), 'Open in Obsidian')) as { hint?: string | null } | undefined
      if (res?.hint) toast(res.hint)
      return
    }
    if (op === 'default') {
      const ok = await confirmNative({ message: 'Use the default Knowledge folder?', detail: 'Principia stops using the custom folder. Its notes stay where they are.', confirmLabel: 'Use Default' }).catch(() => false)
      if (!ok) return
    }
    const res = await attempt(() => hive.memory.vault(op === 'pick' ? { op: 'setPath', companyId: c.id, pick: true } : { op: 'setPath', companyId: c.id, path: null }), 'Knowledge folder')
    if (res) {
      await refreshCompanies().catch(() => undefined)
      hub.reload()
    }
  }

  return (
    <>
      <Toolbar title={PART_TITLE[part]} sub={<span className="company-toolbar-meta">{companyLabel(c, true)}</span>}>
        {part === 'general' && importButton}
        {part === 'general' && <Button icon="download" disabled={busy || dirty} title={dirty ? 'Save your changes before exporting' : 'Export what this company’s agents know, as a file any agent or tool can load'} onClick={() => void exportMenu()}>
          Export
        </Button>}
        {part === 'general' && (
          <Button icon="knowledge" onClick={() => openCompanyPassport(c.id)} title="What this company's agents know: brand voice, audience, notes (⌘5)">
            Open Knowledge
          </Button>
        )}
      </Toolbar>
      {message && (
        <div className="company-error" role="alert">
          {message}
        </div>
      )}
      <div className="passport-document-scroll">
        <div className="passport-document">
          {part === 'general' && <div className="passport-document-header">
            <CompanyAvatar company={{ id: c.id, name: name || c.name, color: c.color, railLabel: c.railLabel }} size={58} className="cs-avatar" />
            <div>
              <div className="passport-eyebrow">
                COMPANY SETTINGS {personal && <span>RESERVED</span>}
              </div>
              <h1>{companyLabel(c, true)}</h1>
              <p>{dirty ? 'Unsaved changes' : c.updatedAt ? `Updated ${relative(c.updatedAt)}` : ''}</p>
              {!personal && (
                <button type="button" className="link-btn cs-logo-btn" onClick={() => openLogoPicker(c.id)}>
                  Change logo…
                </button>
              )}
            </div>
            <div className="passport-context-meter" title={`${filled} of 7 profile fields filled`}>
              <strong>
                {filled}
                <span>/7</span>
              </strong>
              <small>profile fields</small>
            </div>
          </div>}

          {part === 'general' && <>
          <section className="passport-section">
            <div className="passport-section-title">
              <span>01</span>
              <h2>Identity</h2>
            </div>
            <label className="company-field">
              Name
              <input value={name} maxLength={120} placeholder="Company or brand name" onChange={(e) => setName(e.target.value)} onBlur={saveName} onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()} />
              <small>The folder name stays “{c.slug}”, so renaming never moves files.</small>
            </label>
            <div className="company-field">
              Colour
              <div className="cs-colors" role="radiogroup" aria-label="Colour">
                {COLORS.map((col, i) => (
                  <button key={col} type="button" role="radio" aria-checked={c.color === col} aria-label={COLOR_NAMES[i]} title={COLOR_NAMES[i]} className={`cs-color ${c.color === col ? 'is-on' : ''}`} style={{ background: col }} onClick={() => void updateCompany(c.id, { color: col })} />
                ))}
              </div>
            </div>
            {!personal && <TaskPrefixField company={c} />}
            {!personal && <RailTagFields company={c} />}
          </section>

          <section className="passport-section">
            <div className="passport-section-title">
              <span>02</span>
              <h2>Profile</h2>
            </div>
            <p className="passport-section-description">
              {hub.note ? (
                <>
                  These fields are sections of the <strong>{hub.note.detail.note.title}</strong> note in this company’s Knowledge. Saving adds new lines and keeps the old ones in its History.
                  {readOnly && ` ${hub.status?.readOnlyReason ?? 'Knowledge is read-only right now.'}`}
                </>
              ) : (
                'Every agent of this company gets this context. Once the Knowledge folder exists, these fields live in its company note.'
              )}
            </p>
            {CONTEXT_FIELDS.map((field) => (
              <label className="company-field" key={field.key}>
                {field.label}
                <small>{field.hint}</small>
                <textarea
                  value={values[field.key]}
                  rows={field.key === 'context' ? 5 : 3}
                  maxLength={12000}
                  placeholder={field.placeholder}
                  disabled={readOnly}
                  data-category={HUB_CATEGORY[field.key]}
                  onChange={(e) => setDraft({ ...values, [field.key]: e.target.value })}
                />
              </label>
            ))}
            <div className="cs-actions">
              {dirty && (
                <Button variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
                  Discard
                </Button>
              )}
              <Button variant="primary" disabled={busy || !dirty || readOnly} onClick={() => void saveProfile()}>
                {busy ? 'Saving…' : 'Save Profile'}
              </Button>
            </div>
          </section>

          </>}
          {part === 'repos' && <>
          <section className="passport-section">
            <div className="passport-section-title">
              <span>01</span>
              <h2>Repositories</h2>
            </div>
            <p className="passport-section-description">
              {personal
                ? 'Repositories no company owns. Sessions and runs in them use Personal’s keys and Knowledge.'
                : 'Each repository belongs to one company, so agents never mix businesses. Moving one changes future runs and sessions only.'}
            </p>
            <div className="company-checklist cs-repos">
              {repos.map((r) => (
                <div key={r.id} className={`cs-repo ${r.exists ? '' : 'is-unavailable'}`}>
                  <Icon name={r.exists ? 'folder' : 'folderMissing'} size={15} />
                  <span className="cs-repo__name">
                    {r.name}
                    <small>{r.path}</small>
                  </span>
                  <Button size="sm" variant="ghost" icon="more" onClick={() => void repoMenu(r)} aria-label={`Move ${r.name}`} />
                </div>
              ))}
              {!repos.length && <p className="company-help">{personal ? 'Every repository belongs to a company.' : 'No repositories yet.'}</p>}
            </div>
            <div className="cs-actions cs-actions--start">
              <Button icon="plus" onClick={() => void addRepo()}>
                Add Repository…
              </Button>
            </div>
          </section>

          </>}
          {part === 'general' && <>
          <section className="passport-section">
            <div className="passport-section-title">
              <span>03</span>
              <h2>Knowledge folder</h2>
            </div>
            <p className="passport-section-description">Where this company’s Knowledge is kept on this Mac, as plain notes you can open in any notes app. Only this company’s agents read and write it.</p>
            <div className="cs-vault">
              <Icon name="folder" size={15} />
              <span className="cs-vault__path selectable mono">{hub.status?.root ?? (c.vaultPath || `companies/${c.slug}/Passport (in Principia’s data folder)`)}</span>
              {hub.status && <span className="text-tertiary">{hub.status.exists ? `${hub.status.noteCount} notes` : 'not created yet'}</span>}
            </div>
            {hub.status?.onICloud && <p className="company-help">This folder is on iCloud Drive: changes made on another Mac can take a moment to show up.</p>}
            <div className="cs-actions cs-actions--start">
              <Button size="sm" disabled={!hub.status} onClick={() => void vault('pick')}>
                Use Another Folder…
              </Button>
              {(hub.status?.customPath || !!c.vaultPath) && (
                <Button size="sm" variant="ghost" onClick={() => void vault('default')}>
                  Use Default
                </Button>
              )}
              <Button size="sm" variant="ghost" disabled={!hub.status?.exists} onClick={() => void vault('reveal')}>
                Reveal in Finder
              </Button>
              <Button size="sm" variant="ghost" disabled={!hub.status?.exists} onClick={() => void vault('openInObsidian')}>
                Open in Obsidian
              </Button>
            </div>
            {!hub.status && <p className="company-help">The Knowledge folder isn’t available in this build yet.</p>}
            {hub.status?.exists && <PassportCloudSync companyId={c.id} />}
          </section>

          {hub.status?.exists && <PassportConnect companyId={c.id} />}
          </>}


          {part === 'danger' && (
            <section className="passport-section">
              <div className="passport-section-title">
                <span>01</span>
                <h2>Export</h2>
              </div>
              <p className="passport-section-description">Everything {c.name}’s agents know, as one file (an Open Passport) any agent or tool can load. Repository paths and connections stay on this Mac. Keep API keys and passwords in Keys &amp; secrets.</p>
              <div className="cs-actions cs-actions--start">
                <Button icon="download" disabled={busy} onClick={() => void exportMenu()}>
                  Export Knowledge…
                </Button>
              </div>
            </section>
          )}
          {part === 'danger' && (
            <section className="passport-section">
              <div className="passport-section-title">
                <span>02</span>
                <h2>Archive {personal ? '' : c.name}</h2>
              </div>
              <p className="passport-section-description">
                {personal
                  ? 'Personal holds what no company owns, so it can’t be archived.'
                  : `Archiving takes ${c.name} off the rail and the sidebar. Nothing is deleted: its repositories, chats, runs, keys and knowledge stay, and you can bring it back from Settings › Storage › Archived companies.`}
              </p>
              {!personal && (
                <div className="cs-actions cs-actions--start">
                  <Button variant="destructive" onClick={() => void archiveCompany(c)}>
                    Archive {c.name}…
                  </Button>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </>
  )
}

/**
 * Publish / sync this company's Passport with an Open Passport host (open-passport SPEC.md §11.4). Off until a host is
 * set; the token is stored on this Mac and never shown again.
 */
function PassportCloudSync({ companyId }: { companyId: string }): React.JSX.Element {
  const [cfg, setCfg] = useState<OpenPassportSyncView | null>(null)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({ url: '', passportId: '', token: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void hive.company.openPassportSync({ op: 'get', companyId }).then((r) => live && setCfg(r.config), () => undefined)
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
  const save = () =>
    run(async () => {
      const r = await hive.company.openPassportSync({ op: 'set', companyId, url: form.url.trim(), passportId: form.passportId.trim(), ...(form.token.trim() ? { token: form.token.trim() } : {}) })
      setCfg(r.config)
      setEditing(false)
      setForm((f) => ({ ...f, token: '' }))
    })
  const sync = () =>
    run(async () => {
      const r = await hive.company.openPassportSync({ op: 'sync', companyId })
      setCfg(r.config)
      const s = r.sync
      const parts = [s?.pulled ? `pulled revision ${s.pulled.to}${s.pulled.conflicts ? ` (${s.pulled.conflicts} to review in the Inbox)` : ''}` : null, s?.pushed ? `published revision ${s.pushed.revision}` : null].filter(Boolean)
      toast(parts.length ? `Knowledge synced: ${parts.join(', ')}` : 'Knowledge already up to date')
    })
  return (
    <div className="cs-sync">
      <h3>Cloud sync</h3>
      {error && (
        <div className="company-error" role="alert">
          {error}
        </div>
      )}
      {cfg && !editing ? (
        <>
          <p className="company-help">
            Synced with <span className="mono selectable">{cfg.url}/v1/passports/{cfg.passportId}</span>
            {cfg.base ? ` at revision ${cfg.base}` : ''}
            {cfg.lastSync ? `, ${relative(cfg.lastSync)}` : ', not synced yet'}.
          </p>
          <div className="cs-actions cs-actions--start">
            <Button size="sm" disabled={busy} onClick={() => void sync()}>
              {busy ? 'Syncing…' : 'Sync Now'}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => (setForm({ url: cfg.url, passportId: cfg.passportId, token: '' }), setEditing(true))}>
              Change Host…
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => setCfg((await hive.company.openPassportSync({ op: 'clear', companyId })).config))}>
              Disconnect
            </Button>
          </div>
        </>
      ) : editing ? (
        <div className="company-form">
          <label className="company-field">
            Host URL
            <input value={form.url} placeholder="https://passport.example.com" onChange={(e) => setForm({ ...form, url: e.target.value })} />
          </label>
          <label className="company-field">
            Passport id
            <input value={form.passportId} placeholder="acme" onChange={(e) => setForm({ ...form, passportId: e.target.value })} />
          </label>
          <label className="company-field">
            Token
            <input type="password" value={form.token} placeholder={cfg?.hasToken ? 'Unchanged' : 'opk_…'} onChange={(e) => setForm({ ...form, token: e.target.value })} />
          </label>
          <div className="cs-actions cs-actions--start">
            <Button size="sm" disabled={busy || !form.url.trim() || !form.passportId.trim()} onClick={() => void save()}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="company-help">Off. Publish this company’s Knowledge to an Open Passport host so other tools and cloud runners use the same memory, and pull back what they learn.</p>
          <div className="cs-actions cs-actions--start">
            <Button size="sm" onClick={() => setEditing(true)}>
              Connect a Host…
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

function PassportImport({ companies, onClose, onImported }: { companies: CompanyPassport[]; onClose: () => void; onImported: (c: CompanyPassport) => void }): React.JSX.Element {
  const [open, setOpen] = useState<OpenPassportPreview | null>(null)
  const [mergeInto, setMergeInto] = useState('')
  const [json, setJson] = useState('')
  const [preview, setPreview] = useState<PassportExport | null>(null)
  const [repoIds, setRepoIds] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const allRepos = useStore((s) => s.repos)
  // only unowned (Personal) repositories can be assigned to the new company here
  const free = reposOf(allRepos, PERSONAL_COMPANY_ID).filter((r) => !companies.some((c) => !isPersonal(c) && c.repoIds.includes(r.id)))
  const fileRef = useRef<HTMLInputElement>(null)
  const review = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setPreview(await hive.company.previewImport({ json }))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const apply = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      onImported(await hive.company.import({ json, repoIds }))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const chooseOpen = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const p = await hive.company.previewOpenPassport({})
      if (p) setOpen(p)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const applyOpen = async (mode: 'new' | 'merge'): Promise<void> => {
    if (!open) return
    setBusy(true)
    setError(null)
    try {
      const r = await hive.company.importOpenPassport({ source: open.source, mode, ...(mode === 'merge' ? { companyId: mergeInto } : { repoIds }) })
      await refreshCompanies()
      const target = (await hive.company.list({})).find((x) => x.id === r.companyId)
      if (r.mode === 'merge') toast(`Merged ${r.notes} notes${r.conflicts ? `; ${r.conflicts} differences wait in the Inbox` : ''}`)
      if (target) onImported(target)
      else onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  if (open) {
    const blocked = open.errors.length > 0
    return (
      <Sheet
        title="Review Open Passport"
        width={650}
        onCancel={() => {
          if (!busy) onClose()
        }}
        primaryLabel={busy ? 'Please wait…' : 'Import as new company'}
        primaryDisabled={busy || blocked}
        onPrimary={() => void applyOpen('new')}
      >
        <div className="company-form">
          {error && (
            <div className="company-error" role="alert">
              {error}
            </div>
          )}
          <div className="passport-import-name">
            <Icon name="passport" size={24} />
            <div>
              <h2>{open.name}</h2>
              <p>
                {open.revision ? `Revision ${open.revision} · ` : ''}
                {open.notes} notes · {open.departments.length} departments · {open.taste} taste lines
              </p>
            </div>
          </div>
          {blocked && (
            <div className="company-error" role="alert">
              This passport can’t be imported: {open.errors.join('; ')}
            </div>
          )}
          <div className="passport-import-preview">
            <div>
              <h3>Company card (what every agent loads)</h3>
              <pre className="selectable mono">{open.card}</pre>
            </div>
            {open.departments.map((d) => (
              <div key={d.slug}>
                <h3>{d.name}</h3>
                <p className="selectable">{d.does || 'No charter'}</p>
              </div>
            ))}
          </div>
          {!!open.warnings.length && <p className="company-help">{open.warnings.length} warnings: {open.warnings.slice(0, 3).join('; ')}</p>}
          <fieldset className="company-checklist">
            <legend>Or merge into an existing company</legend>
            <select value={mergeInto} onChange={(e) => setMergeInto(e.target.value)} aria-label="Company to merge into">
              <option value="">Choose a company…</option>
              {companies
                .filter((x) => !x.archivedAt)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {companyLabel(x, true)}
                  </option>
                ))}
            </select>
            <Button size="sm" disabled={busy || blocked || !mergeInto} onClick={() => void applyOpen('merge')}>
              Merge
            </Button>
            <p className="company-help">Lines are matched by id; where both sides changed the same line, yours stays and theirs waits in the Inbox.</p>
          </fieldset>
          <Button variant="ghost" onClick={() => setOpen(null)}>
            Back
          </Button>
        </div>
      </Sheet>
    )
  }
  return (
    <Sheet
      title={preview ? 'Review company Passport' : 'Import a Passport'}
      width={650}
      onCancel={() => {
        if (!busy) onClose()
      }}
      primaryLabel={busy ? 'Please wait…' : preview ? 'Import as new company' : 'Review Passport'}
      primaryDisabled={busy || !json.trim()}
      onPrimary={() => void (preview ? apply() : review())}
    >
      <div className="company-form">
        {error && (
          <div className="company-error" role="alert">
            {error}
          </div>
        )}
        {!preview ? (
          <>
            <p className="company-help">Choose an Open Passport (a .passport.zip or folder, from Principia or any tool), or a Principia profile file. You’ll review it before anything is added.</p>
            <Button disabled={busy} onClick={() => void chooseOpen()}>
              Choose Open Passport…
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              className="company-file-input"
              aria-label="Choose Passport file"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (!file) return
                if (file.size > 1024 * 1024) {
                  setError('Choose a Passport smaller than 1 MB.')
                  return
                }
                void file.text().then(
                  (text) => {
                    setJson(text)
                    setError(null)
                  },
                  (err) => setError(errorMessage(err))
                )
              }}
            />
            <label className="company-field">
              Passport JSON
              <textarea className="company-json" value={json} rows={12} onChange={(e) => setJson(e.target.value)} placeholder="Paste your exported company Passport…" />
            </label>
          </>
        ) : (
          <>
            <div className="passport-import-name">
              <Icon name="passport" size={24} />
              <div>
                <h2>{preview.passport.name}</h2>
                <p>A new company will be created. Existing companies stay unchanged.</p>
              </div>
            </div>
            <div className="passport-import-preview">
              {CONTEXT_FIELDS.map((field) => (
                <div key={field.key}>
                  <h3>{field.label}</h3>
                  <p className="selectable">{preview.passport[field.key] || 'Not provided'}</p>
                </div>
              ))}
            </div>
            <fieldset className="company-checklist">
              <legend>Assign repositories on this Mac · optional</legend>
              {free.map((r) => (
                <label key={r.id}>
                  <input type="checkbox" checked={repoIds.includes(r.id)} onChange={(e) => setRepoIds(e.target.checked ? [...repoIds, r.id] : repoIds.filter((id) => id !== r.id))} />
                  <Icon name="folder" size={14} />
                  <span>{r.name}</span>
                </label>
              ))}
              {!free.length && <p className="company-help">Every repository already belongs to a company.</p>}
            </fieldset>
            <Button variant="ghost" onClick={() => setPreview(null)}>
              Back to file
            </Button>
          </>
        )}
      </div>
    </Sheet>
  )
}

/**
 * Five doors E14: how this company looks on the rail. A short label (1-3 letters or digits) replaces the initials, the
 * colour above tints the tile, and "This company is a client" adds the tag to its hover label. When another company
 * would look the same, it says which, so an agency with five "HD" clients can tell them apart.
 */
function RailTagFields({ company: c }: { company: CompanyPassport }): React.JSX.Element {
  const companies = useStore((s) => s.companies)
  const [v, setV] = useState(c.railLabel ?? '')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setV(c.railLabel ?? ''), [c.railLabel])
  const preview = { ...c, railLabel: v || undefined }
  const same = railLookAlikes(preview, companies, themeRgb)
  const commit = async (): Promise<void> => {
    const next = v.trim().toUpperCase()
    if (next === (c.railLabel ?? '')) return
    try {
      setError(null)
      await updateCompany(c.id, { railLabel: next || null })
    } catch (e) {
      setError(errorMessage(e))
      setV(c.railLabel ?? '')
    }
  }
  return (
    <div className="company-field cs-rail">
      On the rail
      <div className="cs-rail__row">
        <RailMark company={preview} size={32} />
        <input
          className="mono cs-prefix"
          aria-label="Rail label"
          value={v}
          maxLength={3}
          spellCheck={false}
          placeholder={companyInitials(c.name)}
          onChange={(e) => (setV(e.target.value.toUpperCase().replace(/[^\p{L}\p{N}]/gu, '')), setError(null))}
          onBlur={() => void commit()}
          onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
        />
        <label className="cs-rail__client">
          <input type="checkbox" checked={!!c.client} onChange={(e) => void updateCompany(c.id, { client: e.target.checked })} /> This company is a client
        </label>
      </div>
      <small className={error ? 'cs-prefix__err' : undefined}>
        {error ?? (same.length ? `${same.map((o) => o.name).join(', ')} ${same.length === 1 ? 'looks' : 'look'} the same on the rail: the same letters in almost the same colour. Change the label or the colour.` : 'Up to 3 letters or digits instead of the initials. Hover the rail to see the full name.')}
      </small>
    </div>
  )
}

/**
 * Five doors step 2's per-company task prefix, editable (step 4): NW-12, LA-3. 2 to 5 letters or digits, starting with
 * a letter, never another company's or Personal's PRN. Renaming keeps every task's number (NC-12 becomes NW-12).
 */
function TaskPrefixField({ company: c }: { company: CompanyPassport }): React.JSX.Element {
  const companies = useStore((s) => s.companies)
  const [v, setV] = useState(c.taskPrefix ?? '')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setV(c.taskPrefix ?? ''), [c.taskPrefix])
  const problem = taskPrefixProblem(v, c.id, companies)
  const commit = async (): Promise<void> => {
    const next = v.trim().toUpperCase()
    if (!next || next === c.taskPrefix) return setV(c.taskPrefix ?? '')
    if (problem) return setError(problem)
    setError(null)
    try {
      await hive.company.update({ id: c.id, patch: { taskPrefix: next } })
      await Promise.all([refreshCompanies(), refreshTasks().catch(() => undefined)])
      toast(`${c.name}’s tasks are numbered ${next}-1, ${next}-2… now`)
    } catch (e) {
      setError(errorMessage(e))
      setV(c.taskPrefix ?? '')
    }
  }
  return (
    <label className="company-field">
      Task prefix
      <input
        className="mono cs-prefix"
        value={v}
        maxLength={5}
        spellCheck={false}
        placeholder={c.taskPrefix || prefixHint(c.name)}
        aria-invalid={!!problem}
        onChange={(e) => (setV(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')), setError(null))}
        onBlur={() => void commit()}
        onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
      />
      <small className={error || problem ? 'cs-prefix__err' : undefined}>{error ?? problem ?? `Tasks read ${(v || c.taskPrefix || prefixHint(c.name)).toUpperCase()}-12. Changing it keeps every task’s number.`}</small>
    </label>
  )
}
