/**
 * Companies (docs/CLOUD.md §3 steps 5-6, §7.9, §13.1): a cloud company shows Ready (or its fixes, each mapped to its
 * one-click action), the passport revision and new facts, Run once now and a ⋯ menu (Manage, Copy Passport URL for
 * ChatGPT and Claude, Pause company, Bring back to this Mac). A local company shows "Run in the cloud…", which opens
 * the dependency-aware checklist.
 */
import { useEffect, useReducer, useState, type ReactElement } from 'react'
import type { CloudCompany, CloudFix } from '@shared/cloud'
import type { CloudMoveItem, CloudMovePlan, CloudMoveResult } from '@shared/types'
import { Button, Loading, Sheet } from '../ui'
import { PUBLIC_HTTPS_URL, andList, fixAction, initChecklist, keyLabel, passportCopy, passportLine, readinessLabel, reduceChecklist, toChoices, tokenLinkLabel, usedByLine, visibleNeeds, type Checklist, type ChecklistAction } from '../../lib/cloud'
import { confirmNative, errorMessage, hive, nativeMenu } from '../../lib/hive'
import { getState, toast, updateSettings, useStore } from '../../state/store'
import { refreshCloud, setCloudState, useCloud } from '../../state/cloud'
import { Tess } from './bits'
import { RunResult } from './Runs'

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`
const cap = (t: string): string => (t ? t[0]!.toUpperCase() + t.slice(1) : t)
/** "the fal.ai key" in a sentence, the name when it is not a well-known one */
const knownKeyShort = (k: string): string => keyLabel(k).replace(/ \([A-Z0-9_]+\)$/, '')

export type FixHandler = (companyId: string, fix: CloudFix) => void

export function CompaniesCard({ onManage, onFix, onRunOnce }: { onManage: (companyId: string) => void; onFix: FixHandler; onRunOnce: (companyId: string) => void }): ReactElement {
  const allCompanies = useStore((s) => s.companies)
  const companies = allCompanies.filter((c) => !c.archivedAt)
  const cloud = useCloud((s) => s.summary?.companies) ?? []
  return (
    <section className="cl-card">
      <div className="cl-ctitle">Companies</div>
      {companies.map((c) => {
        const cc = cloud.find((x) => x.id === c.id)
        return cc ? (
          <CloudCompanyRow key={c.id} color={c.color} c={cc} onManage={onManage} onFix={onFix} onRunOnce={onRunOnce} />
        ) : (
          <div key={c.id} className="cl-corow">
            <i className="cl-sq" style={{ background: c.color }} />
            <div className="cl-ai">
              <b>{c.name}</b>
              <span>Local only</span>
            </div>
            <Button size="sm" variant="primary" onClick={() => onManage(c.id)}>
              Run in the cloud…
            </Button>
          </div>
        )
      })}
    </section>
  )
}

function CloudCompanyRow({ c, color, onManage, onFix, onRunOnce }: { c: CloudCompany; color: string; onManage: (id: string) => void; onFix: FixHandler; onRunOnce: (id: string) => void }): ReactElement {
  const r = readinessLabel(c.readiness)
  const fix = c.readiness && !c.readiness.ready ? c.readiness.fixes[0] : null
  const pp = passportLine(c.passport)
  const line = [plural(c.counts.workflows, 'workflow'), `${plural(c.counts.schedules, 'schedule')} in the cloud`]
  const more = async (): Promise<void> => {
    const id = await nativeMenu([
      { id: 'manage', label: 'Manage…' },
      { id: 'copy', label: 'Copy Passport URL for ChatGPT and Claude', enabled: !!c.passport?.mcpUrl },
      { id: 'pause', label: c.paused ? 'Resume company' : 'Pause company' },
      { type: 'separator' },
      { id: 'back', label: 'Bring back to this Mac…' }
    ])
    try {
      if (id === 'manage') onManage(c.id)
      if (id === 'copy') {
        // CLOUD.md §7.1: ChatGPT and Claude.ai reach only a public https origin; a local URL is never copied
        const out = passportCopy(c.passport)
        if (out.ok) {
          await hive.clipboard.writeText({ text: out.url })
          toast('Passport URL copied. Paste it into ChatGPT or Claude as a connector.')
        } else if (await confirmNative({ message: out.message, detail: out.detail, confirmLabel: 'Show How' })) await hive.app.openExternal({ url: PUBLIC_HTTPS_URL })
      }
      if (id === 'pause') {
        await hive.cloud.pauseCompany({ companyId: c.id, paused: !c.paused })
        await refreshCloud()
      }
      if (id === 'back') {
        const ok = await confirmNative({
          message: `Bring ${c.name} back to this Mac?`,
          detail: 'Its schedules fire on this Mac again, and the company is deleted from your cloud with its cloud runs. Your Passport stays on this Mac.',
          confirmLabel: 'Bring Back',
          destructive: true
        })
        if (!ok) return
        setCloudState(await hive.cloud.bringBack({ companyId: c.id }))
        await refreshCloud()
      }
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }
  return (
    <div className="cl-corow-wrap">
      <div className="cl-corow">
        <i className="cl-sq" style={{ background: color }} />
        <div className="cl-ai">
          <b>
            {c.name}
            {c.paused && <span className="cl-paused">Paused</span>}
          </b>
          <span>
            {line.join(' · ')} ·{' '}
            <span title={pp.title}>{(c.passport?.pendingProposals ?? 0) > 0 ? <em>{pp.text}</em> : pp.text}</span>
          </span>
        </div>
        <span className="cl-ready" title={c.readiness?.fixes.map((f) => f.message).join('\n')}>
          <Tess kind={r.tone} />
          {r.label}
        </span>
        {fix ? (
          fixAction(fix).kind === 'none' ? null : (
            <Button size="sm" onClick={() => onFix(c.id, fix)}>
              {fixAction(fix).label}
            </Button>
          )
        ) : (
          <Button size="sm" onClick={() => onRunOnce(c.id)} disabled={c.paused}>
            Run once now
          </Button>
        )}
        <button type="button" className="cl-more" aria-label={`More for ${c.name}`} onClick={() => void more()}>
          ⋯
        </button>
      </div>
    </div>
  )
}

/**
 * Readiness after a move (CLOUD.md §3 step 6): what moved, then Ready or up to three one-click fixes. The sheet's
 * footer holds Run once now; its result shows here, inline, so the move ends with proof and not with hope.
 */
export function ReadinessCard({ company, onFix, runId }: { company: CloudCompany; onFix: FixHandler; runId: string | null }): ReactElement {
  const fixes = company.readiness?.fixes ?? []
  const r = readinessLabel(company.readiness)
  const pp = passportLine(company.passport)
  return (
    <div className="cl-readiness">
      <div className="cl-fix">
        <span title={pp.title}>
          <Tess kind="ok" /> {pp.text} · {plural(company.counts.workflows, 'workflow')} · {plural(company.counts.schedules, 'schedule')} · {company.counts.repos ? plural(company.counts.repos, 'repo') : 'no repo'}
        </span>
      </div>
      {fixes.length === 0 ? (
        <div className="cl-fix">
          <span>
            <Tess kind={r.tone} /> Ready. It runs without this Mac.
          </span>
        </div>
      ) : (
        fixes.slice(0, 3).map((f) => (
          <div key={`${f.kind}:${f.ref}`} className="cl-fix">
            <span>
              <Tess kind={f.action === 'wait' ? 'needs' : 'fail'} /> {f.message}
            </span>
            {fixAction(f).kind !== 'none' && (
              <Button size="sm" onClick={() => onFix(company.id, f)}>
                {fixAction(f).label}
              </Button>
            )}
          </div>
        ))
      )}
      {runId && <RunResult id={runId} />}
    </div>
  )
}

// ---------- the checklist sheet ----------

function Check({ on, disabled, onChange, title, children }: { on: boolean; disabled?: boolean; onChange?: (v: boolean) => void; title: string; children?: React.ReactNode }): ReactElement {
  return (
    <label className={`cl-chk ${on ? 'is-on' : ''} ${disabled ? 'is-disabled' : ''}`}>
      <input type="checkbox" checked={on} disabled={disabled || !onChange} onChange={(e) => onChange?.(e.target.checked)} />
      <i aria-hidden="true" />
      <div>
        <b>{title}</b>
        {children}
      </div>
      <span />
    </label>
  )
}

export function MoveSheet({ companyId, onClose, onFix }: { companyId: string; onClose: () => void; onFix: FixHandler }): ReactElement {
  const [plan, setPlan] = useState<CloudMovePlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<CloudMoveResult | null>(null)
  const [running, setRunning] = useState(false)
  const [firstRun, setFirstRun] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [list, dispatch] = useReducer((s: Checklist | null, a: ChecklistAction | { type: 'init'; plan: CloudMovePlan }) => (a.type === 'init' ? initChecklist(a.plan) : s && plan ? reduceChecklist(plan, s, a) : s), null)
  useEffect(() => {
    hive.cloud
      .movePlan({ companyId })
      .then((p) => {
        setPlan(p)
        // a re-check (Turn on Passport) keeps the ticks the user already made
        if (!list) dispatch({ type: 'init', plan: p })
      })
      .catch((e) => setError(errorMessage(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, nonce])
  const passportOff = !!plan?.passport && !plan.passport.ready
  const turnOnPassport = async (): Promise<void> => {
    await updateSettings({ experimental: { ...(getState().settings?.experimental ?? {}), vault: true } })
    setNonce((n) => n + 1)
  }
  const runNow = async (id: string): Promise<void> => {
    setRunning(true)
    try {
      const r = await hive.cloud.runOnce({ companyId: id })
      setFirstRun(r.id)
      await refreshCloud()
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setRunning(false)
    }
  }

  const send = async (overwrite?: string[]): Promise<void> => {
    if (!plan || !list) return
    setBusy(true)
    setError(null)
    try {
      const r = await hive.cloud.move(toChoices(plan, list, overwrite))
      setResult(r)
      await refreshCloud()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (result) {
    const conflicts = result.items.filter((i) => i.status === 'conflict')
    const failed = result.items.filter((i) => i.status === 'failed')
    const co = result.company
    return (
      <Sheet
        title={`${plan?.companyName ?? 'Company'} in the cloud`}
        onCancel={onClose}
        cancelLabel="Done"
        onPrimary={co && !co.paused ? () => void runNow(co.id) : undefined}
        primaryLabel={running ? 'Starting…' : firstRun ? 'Run again' : 'Run once now'}
        primaryDisabled={running}
        width={560}
      >
        {co ? <ReadinessCard company={co} onFix={onFix} runId={firstRun} /> : <p className="cl-error">The company could not be created in your cloud.</p>}
        {[...conflicts, ...failed].map((i: CloudMoveItem) => (
          <div key={`${i.kind}:${i.id}`} className="cl-fix">
            <span>
              <Tess kind={i.status === 'conflict' ? 'needs' : 'fail'} /> {i.name}: {i.message}
            </span>
            {i.status === 'conflict' && (
              <Button size="sm" disabled={busy} onClick={() => void send(conflicts.map((c) => c.id))}>
                Overwrite
              </Button>
            )}
          </div>
        ))}
      </Sheet>
    )
  }

  return (
    <Sheet
      title={plan ? `Run ${plan.companyName} in the cloud` : 'Run in the cloud'}
      onCancel={onClose}
      onPrimary={plan && list ? () => void send() : undefined}
      primaryLabel={busy ? 'Sending…' : 'Run in the cloud'}
      primaryDisabled={busy || !plan || !list || passportOff}
      primaryTitle={passportOff ? 'Turn on Passport first' : undefined}
      width={600}
    >
      {error && <p className="cl-error selectable">{error}</p>}
      {!plan || !list ? (
        !error && <Loading label="Checking what can run in the cloud…" />
      ) : (
        <Checklist plan={plan} list={list} dispatch={dispatch} companyId={companyId} onTurnOnPassport={() => void turnOnPassport()} />
      )}
    </Sheet>
  )
}

function Checklist({ plan, list, dispatch, companyId, onTurnOnPassport }: { plan: CloudMovePlan; list: Checklist; dispatch: (a: ChecklistAction) => void; companyId: string; onTurnOnPassport: () => void }): ReactElement {
  const needs = visibleNeeds(plan, list)
  const okWf = plan.workflows.filter((w) => w.ok)
  const refused = plan.workflows.filter((w) => !w.ok)
  const okSched = plan.schedules.filter((s) => s.ok)
  const authorize = async (id: string): Promise<void> => {
    try {
      await hive.cloud.connectionAuthorize({ companyId, connectionId: id })
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }
  return (
    <div className="cl-sheet">
      {plan.passport && !plan.passport.ready ? (
        <div className="cl-fix cl-line">
          <span>
            <Tess kind="fail" /> {plan.passport.reason}
          </span>
          <Button size="sm" variant="primary" onClick={onTurnOnPassport}>
            Turn on Passport
          </Button>
        </div>
      ) : (
        <p className="cl-line">
          <b>Passport:</b> created on your cloud and kept in sync. Always on.
        </p>
      )}
      {okWf.length > 0 ? (
        okWf.map((w) => (
          <Check key={w.id} on={list.workflows.includes(w.id)} title={w.name} onChange={(v) => dispatch({ type: 'workflow', id: w.id, on: v })}>
            <span>Workflow{w.adapters.length ? ` · ${w.adapters.filter((a) => a !== 'shell').join(', ') || 'shell'}` : ''}</span>
          </Check>
        ))
      ) : (
        <p className="cl-dim">No workflow of this company can run in the cloud yet.</p>
      )}
      {okSched.length > 0 && (
        <div className="cl-group">
          <div className="cl-group__t">Schedules that fire in the cloud</div>
          {okSched.map((s) => (
            <Check key={s.id} on={list.schedules.includes(s.id)} title={s.name} onChange={(v) => dispatch({ type: 'schedule', id: s.id, on: v })}>
              <span>{s.sentence}. It stops firing on this Mac.</span>
            </Check>
          ))}
        </div>
      )}
      {plan.repos.map((r) =>
        r.ok ? (
          <Check key={r.id} on={!!list.repos[r.id]?.on} title="Repo" onChange={(v) => dispatch({ type: 'repo', id: r.id, on: v })}>
            <span>
              github.com/{r.ownerRepo} ·{' '}
              <button type="button" className="cl-link" onClick={(e) => (e.preventDefault(), void hive.app.openExternal({ url: r.tokenUrl }))}>
                {tokenLinkLabel(r.ownerRepo)}
              </button>
            </span>
            {list.repos[r.id]?.on && (
              <input
                className="input input--sm cl-mono cl-token"
                type="password"
                autoComplete="off"
                placeholder="Fine-grained token (leave empty for a public repo)"
                value={list.repos[r.id].token}
                onClick={(e) => e.preventDefault()}
                onChange={(e) => dispatch({ type: 'repoToken', id: r.id, token: e.target.value })}
              />
            )}
          </Check>
        ) : (
          <Check key={r.id} on={false} disabled title={r.name}>
            <span>{r.reason}</span>
          </Check>
        )
      )}
      {(needs.keys.length > 0 || needs.connections.length > 0) && (
        <div className="cl-group">
          <div className="cl-group__t">What these workflows need</div>
          {needs.keys.map((k) => (
            <Check key={k} on={list.keys.includes(k)} title={keyLabel(k)} onChange={(v) => dispatch({ type: 'key', id: k, on: v })}>
              <span>{cap(usedByLine(plan.needs.keys.find((x) => x.name === k)?.usedBy.filter((w) => list.workflows.includes(w)) ?? [], plan.workflows)) || 'Key'}</span>
            </Check>
          ))}
          {needs.connections.map((c) => (
            <Check key={c.id} on={list.connections.includes(c.id)} title={c.name} onChange={(v) => dispatch({ type: 'connection', id: c.id, on: v })}>
              <span>Connection{(() => { const u = usedByLine(plan.needs.connections.find((x) => x.id === c.id)?.usedBy.filter((w) => list.workflows.includes(w)) ?? [], plan.workflows); return u ? `, ${u}` : '' })()}</span>
            </Check>
          ))}
          <p className="cl-dim cl-plain">
            {andList([...list.keys.filter((k) => needs.keys.includes(k)).map((k) => knownKeyShort(k)), ...needs.connections.filter((c) => list.connections.includes(c.id)).map((c) => c.name)]) || 'Nothing'} {list.keys.length + list.connections.length === 1 ? 'is' : 'are'} copied encrypted. Never shown again. Anything unticked shows as a fix once the company is in the cloud.
          </p>
        </div>
      )}
      {needs.oauth.map((c) => (
        <div key={c.id} className="cl-fix cl-line">
          <span>
            <b>{c.name}:</b> signs in on its own in the cloud{plan.inCloud ? '.' : '. Authorize it right after.'}
          </span>
          {plan.inCloud && (
            <Button size="sm" onClick={() => void authorize(c.id)}>
              Authorize
            </Button>
          )}
        </div>
      ))}
      {refused.map((w) => (
        <p key={w.id} className="cl-warn">
          {w.reason}
        </p>
      ))}
    </div>
  )
}

/** for render tests (the checklist is otherwise only reached through MoveSheet's effect) */
export { Checklist as MoveChecklist }
