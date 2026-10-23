/**
 * S1a Connect your code (docs/ONBOARDING.md §2): This Mac (pick or drop folders, Personal repos to move) or GitHub
 * (gh list or a pasted link, clone folder). Nothing is added until launch: folders are only inspected and scanned.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { PERSONAL_COMPANY_ID } from '@shared/company'
import { CLONE_URL, MAX_ONBOARDING_PATHS, type DraftRepo, type FolderCandidate, type GithubRepo, type RepoScanSummary } from '@shared/onboarding'
import { Button, Segmented } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { tildify } from '../../lib/format'
import { errorMessage, hive } from '../../lib/hive'
import { reposOf } from '../../lib/companyModel'
import { attempt, onboardingDispatch, refreshOnboardingStatus, toast, useStore } from '../../state/store'
import { useCopy } from '../../lib/voice'
import { Chip, ScanChip, StepTitle } from './bits'
import { middleTruncate } from './model'

/** ⌘O on the Connect step (the flow's capture listener calls it). */
export const connectKeys: { pick: (() => void) | null } = { pick: null }

type Tab = 'mac' | 'github'

export function ConnectStep(): React.JSX.Element | null {
  const d = useStore((s) => s.onboardingDraft)
  const [tab, setTab] = useState<Tab>(d?.github && !d.repos.length ? 'github' : 'mac')
  const scanKey = d ? JSON.stringify([d.repos.map((r) => r.path), d.github?.fullName ?? null]) : ''
  const [scanning, setScanning] = useState(false)
  const [scanWarn, setScanWarn] = useState<string[]>([])
  const copy = useCopy()

  // read-only scan of what is picked; the summary rides in the draft (redacted by main)
  useEffect(() => {
    if (!d) return
    const paths = d.repos.map((r) => r.path)
    const fullName = d.github?.fullName
    if (!paths.length && !fullName) {
      onboardingDispatch({ type: 'setScan', scan: undefined })
      return
    }
    let live = true
    setScanning(true)
    const t = setTimeout(() => {
      hive.onboarding
        .scan({ ...(paths.length ? { paths } : {}), ...(fullName ? { github: { fullName } } : {}) })
        .then((res) => {
          if (!live) return
          onboardingDispatch({ type: 'setScan', scan: res.summary })
          setScanWarn(res.warnings ?? [])
        })
        .catch((e) => live && setScanWarn([errorMessage(e)]))
        .finally(() => live && setScanning(false))
    }, 200)
    return () => {
      live = false
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanKey])

  if (!d) return null
  return (
    <>
      <StepTitle>{copy('ob.connect.title')}</StepTitle>
      <p className="ob-sub">{copy('ob.connect.sub')}</p>
      <Segmented<Tab>
        className="ob-seg"
        items={[
          { value: 'mac', label: 'This Mac' },
          { value: 'github', label: 'GitHub' }
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'mac' ? <ThisMac scanning={scanning} /> : <GitHubPane scanning={scanning} />}
      {scanWarn.length > 0 && <div className="ob-hint ob-hint--warn">{scanWarn[0]}</div>}
    </>
  )
}

// ---------- This Mac ----------

function candidateRepo(c: FolderCandidate): DraftRepo | null {
  if (c.blockedReason) return null
  if (c.ownedBy && !c.ownedBy.personal) return null
  return c.existingRepoId ? { kind: 'local', path: c.path, existingRepoId: c.existingRepoId } : { kind: 'local', path: c.path }
}

function ThisMac({ scanning }: { scanning: boolean }): React.JSX.Element | null {
  const d = useStore((s) => s.onboardingDraft)
  const repos = useStore((s) => s.repos)
  const companies = useStore((s) => s.companies)
  const [cands, setCands] = useState<FolderCandidate[]>([])
  const [dropping, setDropping] = useState(false)
  const loaded = useRef(false)
  const personal = useMemo(() => reposOf(repos, PERSONAL_COMPANY_ID), [repos])

  // resume: re-inspect the picked folders that aren't Personal repos (their status may have changed)
  useEffect(() => {
    if (loaded.current || !d) return
    loaded.current = true
    const paths = d.repos.filter((r) => !r.existingRepoId || !personal.some((p) => p.id === r.existingRepoId)).map((r) => r.path)
    if (!paths.length) return
    hive.onboarding
      .inspectFolders({ paths: paths.slice(0, MAX_ONBOARDING_PATHS) })
      .then((list) => setCands(list))
      .catch(() => undefined)
  }, [d, personal])

  const add = (list: FolderCandidate[]): void => {
    if (!d) return
    const merged = [...cands.filter((c) => !list.some((n) => n.path === c.path)), ...list]
    setCands(merged)
    const next = [...d.repos]
    for (const c of list) {
      const r = candidateRepo(c)
      if (r && !next.some((x) => x.path === r.path)) next.push(r)
    }
    if (next.length > MAX_ONBOARDING_PATHS) toast(`Up to ${MAX_ONBOARDING_PATHS} folders.`)
    onboardingDispatch({ type: 'setRepos', repos: next.slice(0, MAX_ONBOARDING_PATHS) })
    // something usable was added: ↵ now continues instead of reopening the dialog
    if (next.length > d.repos.length) requestAnimationFrame(() => document.querySelector<HTMLElement>('.ob-foot .btn--primary:not(:disabled)')?.focus())
  }
  const pick = (): void => {
    void attempt(async () => add(await hive.onboarding.pickFolders()), 'Choose folders')
  }
  useEffect(() => {
    connectKeys.pick = pick
    return () => {
      if (connectKeys.pick === pick) connectKeys.pick = null
    }
  })
  const removePath = (path: string): void => {
    if (!d) return
    setCands(cands.filter((c) => c.path !== path))
    onboardingDispatch({ type: 'setRepos', repos: d.repos.filter((r) => r.path !== path) })
  }
  const togglePersonal = (id: string, path: string): void => {
    if (!d) return
    const on = d.repos.some((r) => r.path === path)
    onboardingDispatch({ type: 'setRepos', repos: on ? d.repos.filter((r) => r.path !== path) : [...d.repos, { kind: 'local', path, existingRepoId: id }] })
  }
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDropping(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => hive.pathForFile?.(f) ?? '')
      .filter(Boolean)
      .slice(0, MAX_ONBOARDING_PATHS)
    if (!paths.length) return
    void attempt(async () => add(await hive.onboarding.inspectFolders({ paths })), 'Add folders')
  }
  if (!d) return null
  const scanFor = (path: string): RepoScanSummary | undefined => findScan(d.scan?.repos, path)
  // folder rows: picked/dropped candidates, plus picked paths we have no candidate for yet (resume)
  const rows: FolderCandidate[] = [...cands]
  for (const r of d.repos) {
    if (rows.some((c) => c.path === r.path) || personal.some((p) => p.path === r.path)) continue
    rows.push({ path: r.path, name: r.path.split('/').pop() || r.path, isGit: false, ownedBy: null })
  }
  const personalRows = personal.filter((p) => !cands.some((c) => c.path === p.path))
  return (
    <div
      className={`ob-drop ${dropping ? 'is-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDropping(false)}
      onDrop={onDrop}
    >
      <div className="ob-row-inline">
        <Button icon="folder" onClick={pick} kbd="⌘O" data-autofocus="">
          Choose folders…
        </Button>
        <span className="ob-hint">or drop folders here</span>
      </div>
      {rows.length > 0 && (
        <div className="ob-rows" role="list">
          {rows.map((c) => {
            const blocked = !candidateRepo(c)
            const label = c.name
            return (
              <div key={c.path} role="listitem" className={`ob-row ${blocked ? 'is-dis' : ''}`}>
                <div className="ob-row__main">
                  <div className="ob-row__name">{label}</div>
                  <div className="ob-row__path" title={c.path}>
                    {middleTruncate(tildify(c.path))}
                  </div>
                </div>
                <div className="ob-row__end">
                  {!blocked && <ScanChip repo={scanFor(c.path)} pending={scanning} label={label} />}
                  {blocked ? (
                    <Chip tone="fail">{c.blockedReason ?? `Belongs to ${c.ownedBy?.name ?? 'another company'}, can't add`}</Chip>
                  ) : c.ownedBy?.personal ? (
                    <Chip tone="warn">In Personal, will move</Chip>
                  ) : c.isGit ? (
                    <Chip>git</Chip>
                  ) : (
                    <Chip>Not a git repo (fine)</Chip>
                  )}
                  <button type="button" className="ob-x" aria-label={`Remove ${label}`} onClick={() => removePath(c.path)}>
                    ×
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
      {personalRows.length > 0 && (
        <>
          <div className="ob-label">Already in Principia</div>
          <div className="ob-rows">
            {personalRows.map((r) => {
              const on = d.repos.some((x) => x.path === r.path)
              return (
                <label key={r.id} className="ob-row ob-row--check">
                  <input type="checkbox" className="ob-cb" checked={on} onChange={() => togglePersonal(r.id, r.path)} />
                  <div className="ob-row__main">
                    <div className="ob-row__name">{r.name}</div>
                    <div className="ob-row__path" title={r.path}>
                      {middleTruncate(tildify(r.path))}
                    </div>
                  </div>
                  <div className="ob-row__end">
                    {on && <ScanChip repo={scanFor(r.path)} pending={scanning} label={r.name} />}
                    <Chip tone="warn">In {companies.find((c) => c.id === PERSONAL_COMPANY_ID)?.name ?? 'Personal'}, will move</Chip>
                  </div>
                </label>
              )
            })}
          </div>
        </>
      )}
      <div className="ob-hint">Nothing is added until you launch.</div>
    </div>
  )
}

function findScan<T extends { path?: string; fullName?: string }>(list: T[] | undefined, path: string): T | undefined {
  return list?.find((r) => r.path === path || (!!r.fullName && r.fullName === path))
}

// ---------- GitHub ----------

function GitHubPane({ scanning }: { scanning: boolean }): React.JSX.Element | null {
  const d = useStore((s) => s.onboardingDraft)
  const status = useStore((s) => s.onboardingStatus)
  const [query, setQuery] = useState('')
  const [list, setList] = useState<GithubRepo[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [paste, setPaste] = useState(d?.github?.url ?? '')
  const parentDir = d?.github?.parentDir ?? status?.defaultCloneDir ?? ''
  const gh = status?.gh ?? 'missing'

  useEffect(() => {
    if (gh !== 'ok') return
    let live = true
    const t = setTimeout(
      () => {
        hive.onboarding
          .github({ op: 'list', ...(query.trim() ? { query: query.trim() } : {}) })
          .then((r) => live && (setList(r), setErr(null)))
          .catch((e) => live && setErr(errorMessage(e)))
      },
      query ? 250 : 0
    )
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [gh, query])

  if (!d) return null
  const selected = d.github?.fullName ?? null
  const choose = (r: GithubRepo): void => {
    if (!parentDir) return toast('Choose a folder to clone into first.')
    onboardingDispatch({ type: 'setGithub', github: selected === r.fullName ? undefined : { fullName: r.fullName, parentDir } })
  }
  const changeDir = (): void => {
    void attempt(async () => {
      const dir = await hive.onboarding.pickCloneDir()
      if (!dir) return
      onboardingDispatch({ type: 'setGithub', github: d.github ? { ...d.github, parentDir: dir } : { parentDir: dir } })
    }, 'Choose folder')
  }
  const recheck = (): void => void refreshOnboardingStatus()
  const shown = (list ?? []).filter((r) => !query.trim() || `${r.fullName} ${r.description ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
  const pasteOk = !paste.trim() || CLONE_URL.test(paste.trim())
  return (
    <div className="ob-gh">
      {gh === 'ok' ? (
        <>
          <input
            className="input"
            type="search"
            placeholder="Search your repos"
            aria-label="Search your repos"
            value={query}
            data-autofocus=""
            data-enter-local=""
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                ;(e.currentTarget.parentElement?.querySelector('.ob-row--btn') as HTMLElement | null)?.focus()
              } else if (e.key === 'Enter' && !e.metaKey && shown[0] && selected !== shown[0].fullName) {
                e.preventDefault()
                choose(shown[0])
              }
            }}
          />
          <div className="ob-rows ob-rows--scroll" role="listbox" aria-label="Your GitHub repos">
            {list === null && !err && <div className="ob-row ob-hint">Loading your repos…</div>}
            {err && <div className="ob-row ob-hint ob-hint--warn">{err}</div>}
            {list !== null && shown.length === 0 && <div className="ob-row ob-hint">No repos match.</div>}
            {shown.slice(0, 100).map((r) => {
              const on = selected === r.fullName
              return (
                <button
                  key={r.fullName}
                  type="button"
                  role="option"
                  aria-selected={on}
                  className={`ob-row ob-row--btn ${on ? 'is-sel' : ''}`}
                  onClick={() => choose(r)}
                  onKeyDown={(e) => {
                    const el = e.currentTarget
                    if (e.key === 'ArrowDown') {
                      e.preventDefault()
                      ;(el.nextElementSibling as HTMLElement | null)?.focus()
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault()
                      ;((el.previousElementSibling as HTMLElement | null) ?? (el.parentElement?.previousElementSibling as HTMLElement | null))?.focus()
                    }
                  }}
                >
                  <span className={`ob-cb-look ${on ? 'is-on' : ''}`} aria-hidden>
                    {on ? '✓' : ''}
                  </span>
                  <div className="ob-row__main">
                    <div className="ob-row__name">
                      {r.fullName} {r.isPrivate && <Icon name="lock" size={11} />}
                    </div>
                    {r.description && <div className="ob-row__path">{r.description}</div>}
                  </div>
                  {on && (
                    <div className="ob-row__end">
                      <ScanChip repo={findScan(d.scan?.repos, r.fullName)} pending={scanning} label={r.name} />
                    </div>
                  )}
                </button>
              )
            })}
          </div>
          {status?.ghLogin && <div className="ob-hint">Signed in to GitHub as {status.ghLogin}</div>}
        </>
      ) : (
        <>
          <p className="ob-text">
            To list your repos, run <code>gh auth login</code> in Terminal, then{' '}
            <Button size="sm" onClick={recheck}>
              Recheck
            </Button>
          </p>
          <label className="ob-field">
            <span className="ob-field__label">Or paste a repo URL</span>
            <input
              className="input"
              placeholder="https://github.com/you/repo or git@github.com:you/repo.git"
              value={paste}
              data-autofocus=""
              spellCheck={false}
              onChange={(e) => {
                const v = e.target.value
                setPaste(v)
                const url = v.trim()
                if (!url) onboardingDispatch({ type: 'setGithub', github: d.github?.fullName ? { ...d.github, url: undefined } : undefined })
                else if (parentDir) onboardingDispatch({ type: 'setGithub', github: { parentDir, url: url.slice(0, 2048), ...(d.github?.fullName ? { fullName: d.github.fullName } : {}) } })
              }}
            />
            {!pasteOk && <span className="ob-hint ob-hint--warn">Use an https://, ssh:// or git@ link.</span>}
          </label>
        </>
      )}
      <div className="ob-hint">
        Clone into <b className="ob-strong">{parentDir ? tildify(parentDir) : 'a folder'}</b>{' '}
        <button type="button" className="link-btn" onClick={changeDir}>
          Change…
        </button>{' '}
        · We'll clone it when you launch.
      </div>
    </div>
  )
}
