import { useState } from 'react'
import type { LinearStatusView, LinearTeamView } from '@shared/linear'
import { Button, Sheet, Switch } from '../ui'
import { Icon } from '../Icon'
import { errorMessage, hive } from '../../lib/hive'
import { toast } from '../../state/store'
import { defaultTeam } from '../../lib/linear'
import '../../styles/linear.css'

/**
 * LINEAR.md §6 the connect sheet: three steps on one screen. API key with Check Key, then the team, then Autosync (on)
 * and Also send open tasks, and one primary button, Connect. The key is sent to main and never comes back; a saved
 * one shows as its mask.
 */
export function LinearSheet({ companyId, companyName, status, onClose, onConnected }: { companyId: string; companyName: string; status: LinearStatusView | null; onClose: () => void; onConnected?: (s: LinearStatusView) => void }): React.JSX.Element {
  const [key, setKey] = useState('')
  const [teams, setTeams] = useState<LinearTeamView[] | null>(null)
  const [workspace, setWorkspace] = useState<string | null>(null)
  const [teamId, setTeamId] = useState<string>(status?.team?.id ?? '')
  const [autosync, setAutosync] = useState(true)
  const [sendOpen, setSendOpen] = useState(false)
  const [busy, setBusy] = useState<'check' | 'connect' | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const saved = !!status?.keyMasked && status.state !== 'auth'
  const check = async (): Promise<void> => {
    setBusy('check'); setProblem(null)
    try {
      const r = await hive.linear.checkKey({ companyId, ...(key.trim() ? { key: key.trim() } : {}) })
      if (!r.ok) { setTeams(null); setProblem(r.message ?? 'Linear turned down the key.'); return }
      setTeams(r.teams); setWorkspace(r.workspace)
      setTeamId(defaultTeam(r.teams, teamId || status?.team?.id))
      if (r.message) setProblem(r.message)
    } catch (e) { setProblem(errorMessage(e)) } finally { setBusy(null) }
  }
  const connect = async (): Promise<void> => {
    setBusy('connect'); setProblem(null)
    try {
      const s = await hive.linear.connect({ companyId, ...(key.trim() ? { key: key.trim() } : {}), teamId, autosync, sendOpen })
      toast(`${companyName} is synced with Linear · ${s.team?.name ?? 'team'}`)
      onConnected?.(s)
      onClose()
    } catch (e) { setProblem(errorMessage(e)) } finally { setBusy(null) }
  }
  return <Sheet title="Sync with Linear" width={520} onCancel={() => { if (!busy) onClose() }} onPrimary={() => void connect()} primaryLabel={busy === 'connect' ? 'Connecting…' : 'Connect'} primaryDisabled={!!busy || !teams || !teamId}>
    <div className="company-form linear-sheet">
      <p className="company-help">Keep this company’s Board and one Linear team in step, both ways. Without it, nothing changes: the Board stays the task system.</p>
      {problem && <div className="company-error" role="alert">{problem}</div>}
      <div className="linear-step">
        <span className="linear-step__n">1</span>
        <label className="company-field">API key
          <div className="linear-key-row">
            <input type="password" autoComplete="off" spellCheck={false} data-autofocus placeholder={saved ? `Saved · ${status!.keyMasked}` : 'lin_api_…'} value={key} onChange={(e) => { setKey(e.target.value); setTeams(null) }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void check() } }} aria-label="Linear API key" />
            <Button disabled={!!busy || (!key.trim() && !saved)} onClick={() => void check()}>{busy === 'check' ? 'Checking…' : 'Check Key'}</Button>
          </div>
          <small>A personal API key from Linear › Settings › Security &amp; access. It is kept in this company’s Keys and stays on this Mac.</small>
        </label>
      </div>
      <div className={`linear-step ${teams ? '' : 'is-off'}`}>
        <span className="linear-step__n">2</span>
        <div className="company-field">Team{workspace && <span className="linear-muted"> · {workspace}</span>}
          {teams ? <div className="linear-teams" role="radiogroup" aria-label="Linear team">{teams.map((t) => <label key={t.id} className={`linear-team ${teamId === t.id ? 'is-on' : ''}`}><input type="radio" name="linear-team" checked={teamId === t.id} onChange={() => setTeamId(t.id)} /><span className="linear-team__key">{t.key}</span><span>{t.name}</span>{teamId === t.id && <Icon name="check" size={12} />}</label>)}</div> : <small>Check the key to see its teams.</small>}
          {(() => { const used = teams?.find((t) => t.id === teamId)?.syncedWith; return used?.length ? <small className="linear-warn" role="note">{used.join(', ')} {used.length === 1 ? 'already syncs' : 'already sync'} with this team. Both Boards would get its issues, and each would send its tasks there.</small> : null })()}
        </div>
      </div>
      <div className={`linear-step ${teams ? '' : 'is-off'}`}>
        <span className="linear-step__n">3</span>
        <div className="linear-toggles">
          <label className="linear-toggle"><span><strong>Autosync</strong><small>Every minute, and a few seconds after a change here.</small></span><Switch checked={autosync} onChange={setAutosync} disabled={!teams} label="Autosync" /></label>
          <label className="linear-toggle"><span><strong>Also send open tasks</strong><small>This company’s open tasks go to Linear too. Off: only tasks made from now on.</small></span><Switch checked={sendOpen} onChange={setSendOpen} disabled={!teams} label="Also send open tasks" /></label>
        </div>
      </div>
    </div>
  </Sheet>
}

/** The grey "ENG-123" chip of a linked task; opens the issue in the browser. */
export function LinearChip({ issueKey, url }: { issueKey: string; url: string }): React.JSX.Element {
  const open = (e: React.SyntheticEvent): void => { e.stopPropagation(); e.preventDefault(); void hive.app.openExternal({ url }).catch(() => undefined) }
  return <span role="link" tabIndex={0} className="linear-chip" title={`Open ${issueKey} in Linear`} onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open(e) }}>{issueKey}</span>
}

/** The Board banner when Linear turned the key down: one sentence and Reconnect. */
export function LinearBanner({ status, onReconnect }: { status: LinearStatusView | null; onReconnect: () => void }): React.JSX.Element | null {
  if (!status?.connected || status.state !== 'auth') return null
  return <div className="linear-banner" role="alert"><span className="linear-banner__dot" aria-hidden />{status.message ?? 'Linear turned down the key. Autosync is off.'}<span className="flex1" /><Button size="sm" onClick={onReconnect}>Reconnect</Button></div>
}
