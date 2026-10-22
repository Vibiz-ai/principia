import { GatewayConnections } from '../components/GatewayConnections'
import { useEffect, useRef, useState } from 'react'
import type { AdapterId, AgentProfile, AgentProfileInput, PermissionMode, SecretMeta } from '@shared/types'
import { ADAPTER_IDS } from '@shared/types'
import type { MemoryMode } from '@shared/memory'
import { MEMORY_MODES } from '@shared/memory'
import { MEMORY_MODE_LABEL } from '../lib/memory'
import { Button, Field, IconButton, Pill, RelativeTime, Segmented, Sheet, Stepper, Switch, Toolbar } from '../components/ui'
import { LeftoverEmpty, LeftoverList, useLeftovers } from '../components/agents/LimitBits'
import { confirmNative, hive, nativeMenu, useHiveEvent } from '../lib/hive'
import { ADAPTER_AUTH_VARS } from '../lib/secrets'
import { personasOn, t, toneOf, type Tone } from '../lib/voice'
import { attempt, navigate, providerLabel, refreshCompanies, refreshProfiles, refreshProviders, setState, toast, updateSettings, useStore, type SettingsSection } from '../state/store'
import type { AuthorRunGrant } from '@shared/authoring'
import type { RunWorktree } from '@shared/types'
import type { CompanyPassport } from '@shared/company'
import { worktreeState } from '../lib/authoring'
import { tildify } from '../lib/format'
import { slackCall } from '../lib/slackApi'
import { acceptAlertSuggestion, isSetUp, useSlack } from '../state/slack'
import { SlackConnectionCard } from '../components/slack/SetupGuide'
import { UserPicker } from '../components/slack/bits'

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'agents', label: 'Agents' },
  { id: 'connections', label: 'Connections' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'data', label: 'Data' },
  { id: 'about', label: 'About' }
]

export function SettingsView({ section }: { section?: SettingsSection }): React.JSX.Element {
  const [cur, setCur] = useState<SettingsSection>(section ?? 'general')
  useEffect(() => {
    if (section) setCur(section)
  }, [section])
  const settings = useStore((s) => s.settings)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !document.querySelector('.sheet-layer') && !(e.target as HTMLElement).closest('input, textarea')) {
        e.preventDefault()
        void navigate({ name: 'home' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div className="view">
      <Toolbar title="Settings" />
      <div className="settings">
        <nav className="settings__nav">
          {SECTIONS.map((s) => (
            <div key={s.id} className={`side-row side-row--nav ${cur === s.id ? 'is-selected' : ''}`} onClick={() => setCur(s.id)}>
              <span className="side-row__label">{s.label}</span>
            </div>
          ))}
        </nav>
        <div className="settings__body scroll">
          {!settings ? null : cur === 'general' ? (
            <General />
          ) : cur === 'agents' ? (
            <Agents />
          ) : cur === 'connections' ? (
            <Connections />
          ) : cur === 'notifications' ? (
            <Notifications />
          ) : cur === 'data' ? (
            <Data />
          ) : (
            <About />
          )}
        </div>
      </div>
    </div>
  )
}

function SRow({ label, desc, children }: { label: string; desc?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="srow">
      <div className="srow__text">
        <div>{label}</div>
        {desc && <div className="srow__desc">{desc}</div>}
      </div>
      <div className="srow__ctl">{children}</div>
    </div>
  )
}

/**
 * VOICE.md §3.8: Tone (Playful / Plain) and "Agent names and busts". Every flavored string reads the tone through the
 * copy module, so switching applies live, without a reload. Hook-free so a test can call its handlers.
 */
export function VoiceRows({ tone, personas }: { tone: Tone; personas: boolean }): React.JSX.Element {
  return (
    <>
      <SRow label={t('settings.tone.label')} desc={t('settings.tone.desc')}>
        <Segmented<Tone>
          size="sm"
          value={tone}
          items={[
            { value: 'playful', label: t('settings.tone.playful') },
            { value: 'plain', label: t('settings.tone.plain') }
          ]}
          onChange={(v) => void updateSettings({ tone: v })}
        />
      </SRow>
      <SRow label={t('settings.personas.label')} desc={t('settings.personas.desc')}>
        <Switch checked={personas} onChange={(v) => void updateSettings({ personas: v })} label={t('settings.personas.label')} />
      </SRow>
    </>
  )
}

function General(): React.JSX.Element {
  const s = useStore((st) => st.settings)!
  return (
    <div className="sgroup">
      <VoiceRows tone={toneOf(s)} personas={personasOn(s)} />
      <SRow label="Launch Principia at login" desc="Schedules only fire while Principia is running. Principia starts hidden in the menu bar.">
        <Switch checked={s.launchAtLogin} onChange={(v) => void updateSettings({ launchAtLogin: v })} label="Launch at login" />
      </SRow>
      <SRow label="Keep Mac awake while agents run" desc="Prevents app suspension while a session or run is active.">
        <Switch checked={s.keepAwake} onChange={(v) => void updateSettings({ keepAwake: v })} label="Keep awake" />
      </SRow>
      <SRow label="Max parallel workflow steps">
        <Stepper value={s.concurrency} min={1} max={16} onChange={(v) => void updateSettings({ concurrency: v })} />
      </SRow>
      <SRow label="Terminal font size" desc="⌘= / ⌘- in a session.">
        <Stepper value={s.terminalFontSize} min={9} max={24} onChange={(v) => void updateSettings({ terminalFontSize: v })} />
      </SRow>
      <SRow label="Retry scheduled runs once at the usage-limit reset" desc="A scheduled run that stops on a usage limit gets exactly one retry when the limit resets (in 1 hour when the CLI doesn’t say).">
        <Switch checked={s.autoRetryRateLimit ?? true} onChange={(v) => void updateSettings({ autoRetryRateLimit: v })} label="Retry scheduled runs at the usage-limit reset" />
      </SRow>
      <SRow label="Flag a step or session as Stalled? after N minutes without output" desc="Working agents with no output and no activity get an amber “Stalled?” badge and one notification. Principia never stops them.">
        <Stepper value={s.stallMinutes ?? 10} min={1} max={240} onChange={(v) => void updateSettings({ stallMinutes: Math.min(240, Math.max(1, v)) })} label="Stalled after minutes" />
      </SRow>
      <SRow label="Pause all schedules">
        <Switch checked={s.schedulesPaused} onChange={(v) => void hive.schedules.pauseAll({ paused: v }).then((status) => setState({ status }), (e) => toast(String(e.message), 'error'))} label="Pause all schedules" />
      </SRow>
    </div>
  )
}

function Agents(): React.JSX.Element {
  const providers = useStore((s) => s.providers)
  const profiles = useStore((s) => s.profiles)
  const info = useStore((s) => s.info)
  const interactiveBypass = useStore((s) => s.settings?.interactiveBypass ?? false)
  const [checking, setChecking] = useState(false)
  const [showPath, setShowPath] = useState(false)
  const [editing, setEditing] = useState<AgentProfile | 'new' | null>(null)
  useHiveEvent('data:changed', ({ domain }) => domain === 'profiles' && void refreshProfiles().catch(() => undefined))

  const recheck = async (): Promise<void> => {
    setChecking(true)
    await attempt(() => refreshProviders(true), 'Recheck')
    const fresh = await hive.app.info().catch(() => null)
    if (fresh) setState({ info: fresh })
    setChecking(false)
  }
  const removeProfile = async (p: AgentProfile): Promise<void> => {
    const ok = await confirmNative({ message: `Delete profile “${p.name}”?`, confirmLabel: 'Delete Profile', destructive: true }).catch(() => false)
    if (!ok) return
    await attempt(() => hive.profiles.remove({ id: p.id }), 'Delete profile')
    void refreshProfiles()
  }
  return (
    <>
      <div className="sgroup">
        <div className="sgroup__title">
          CLIs
          <span className="flex1" />
          <Button size="sm" icon="refresh" onClick={() => void recheck()} disabled={checking}>
            {checking ? 'Checking…' : 'Recheck'}
          </Button>
        </div>
        {providers.map((p) => (
          <div key={p.id} className="srow">
            <div className="srow__text">
              <div>
                <span className="provider-dot" style={{ background: `var(--provider-${p.id})` }} /> {p.label}{' '}
                {p.available ? <span className="text-tertiary">{p.version ?? ''}</span> : <Pill tone="canceled">⊘ not installed</Pill>}
              </div>
              <div className="srow__desc mono selectable">{p.available ? p.binPath : p.installHint}</div>
            </div>
            {!p.available && <IconButton icon="copy" label="Copy install command" onClick={() => void attempt(() => hive.clipboard.writeText({ text: p.installHint })).then(() => toast('Copied'))} />}
          </div>
        ))}
        <div className="srow">
          <div className="srow__text">
            <div>Environment resolved from your login shell</div>
            <div className="srow__desc">{info?.loginShellPath ? 'PATH, nvm, Homebrew and other login variables are passed to every agent.' : 'Couldn’t resolve your login shell — using fallback folders.'}</div>
            {showPath && info?.loginShellPath && <div className="srow__desc mono selectable path-list">{info.loginShellPath.split(':').join('\n')}</div>}
          </div>
          <Button size="sm" onClick={() => setShowPath(!showPath)} disabled={!info?.loginShellPath}>
            {showPath ? 'Hide PATH' : 'Show PATH'}
          </Button>
        </div>
      </div>
      <div className="sgroup">
        <div className="sgroup__title">Permissions</div>
        <SRow
          label="Skip permission prompts in terminal sessions"
          desc="Off: interactive panes start in the CLI’s normal mode and ask before editing or running commands. Workflow steps run headless and can’t ask, so they follow each profile’s setting below."
        >
          <Switch checked={interactiveBypass} onChange={(v) => void updateSettings({ interactiveBypass: v })} label="Skip permission prompts in terminal sessions" />
        </SRow>
      </div>
      <SessionMemory />
      <div className="sgroup">
        <div className="sgroup__title">
          Profiles
          <span className="flex1" />
          <Button size="sm" icon="plus" onClick={() => setEditing('new')}>
            New Profile
          </Button>
        </div>
        {profiles.map((p) => (
          <div
            key={p.id}
            className="srow srow--click"
            onDoubleClick={() => setEditing(p)}
            onContextMenu={async (e) => {
              e.preventDefault()
              const id = await nativeMenu([{ id: 'edit', label: 'Edit…' }, { type: 'separator' }, { id: 'delete', label: 'Delete' }])
              if (id === 'edit') setEditing(p)
              if (id === 'delete') void removeProfile(p)
            }}
          >
            <div className="srow__text">
              <div>
                <span className="provider-dot" style={{ background: `var(--provider-${p.adapter})` }} /> {p.name}
              </div>
              <div className="srow__desc">
                {[providerLabel(p.adapter), p.model, p.permissionMode === 'bypass' ? 'workflow steps run without asking' : 'workflow steps stop if they need permission', p.secretNames.includes('*') ? 'all keys' : `${p.secretNames.length} keys`, p.useApiKeyAuth ? 'API-key billing' : null]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            <Button size="sm" onClick={() => setEditing(p)}>
              Edit
            </Button>
          </div>
        ))}
      </div>
      <RunGrants />
      {editing && <ProfileSheet profile={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  )
}

/** PO3: standing "run without asking" permissions agents got on an approval card. Each covers one exact version. */
function RunGrants(): React.JSX.Element | null {
  const [grants, setGrants] = useState<AuthorRunGrant[] | null>(null)
  const load = (): void => void hive.author.grants().then(setGrants, () => setGrants(null))
  useEffect(load, [])
  useHiveEvent('author:updated', () => load())
  useHiveEvent('data:changed', ({ domain }) => domain === 'workflows' && load())
  if (!grants) return null
  const revoke = async (g: AuthorRunGrant): Promise<void> => {
    await attempt(() => hive.author.revokeRun({ workflowId: g.workflowId, ownerKey: g.ownerKey }), 'Revoke')
    load()
  }
  return (
    <div className="sgroup">
      <div className="sgroup__title">Agents that can run workflows without asking</div>
      {grants.length === 0 ? (
        <div className="srow">
          <div className="srow__text">
            <div className="srow__desc">None. When you tick “Allow this agent to run workflows it created” on an approval card, it shows up here.</div>
          </div>
        </div>
      ) : (
        grants.map((g) => (
          <div key={`${g.workflowId}:${g.ownerKey}`} className="srow">
            <div className="srow__text">
              <div>{g.workflowName}</div>
              <div className="srow__desc">
                {g.ownerLabel} · since <RelativeTime iso={g.createdAt} />
                {g.active === false && ' · paused: the workflow changed since you allowed it'}
              </div>
            </div>
            <div className="srow__ctl">
              <Button size="sm" onClick={() => void revoke(g)}>
                Revoke
              </Button>
            </div>
          </div>
        ))
      )}
    </div>
  )
}

/** Memory for new interactive sessions (MEMORY.md §3.3). Workflow steps set it per step in the editor. */
function SessionMemory(): React.JSX.Element {
  // LIVE.md A10: the default is Read & write; an explicit Off the user chose is kept
  const mode: MemoryMode = useStore((s) => s.settings?.sessionMemory ?? 'read-write')
  const providers = useStore((s) => s.providers)
  const inject = providers.filter((p) => p.available && p.memory === 'inject').map((p) => providerLabel(p.id))
  return (
    <div className="sgroup">
      <div className="sgroup__title">
        Memory
        <span className="flex1" />
        <Button size="sm" variant="ghost" icon="memory" onClick={() => void navigate({ name: 'memory' })}>
          Open Memory
        </Button>
      </div>
      <SRow
        label="Memory for new sessions"
        desc={
          <>
            Read: agents start with a brief of what earlier runs learned about the repository and can search it. Read &amp; write: they can also record decisions, conventions and gotchas. Everything is visible and editable on the Memory page.
            {inject.length > 0 && mode !== 'off' ? ` ${inject.join(', ')} get${inject.length === 1 ? 's' : ''} the brief only.` : ''}
          </>
        }
      >
        <Segmented<MemoryMode>
          size="sm"
          items={MEMORY_MODES.map((m) => ({ value: m, label: MEMORY_MODE_LABEL[m] }))}
          value={mode}
          onChange={(v) => void updateSettings({ sessionMemory: v })}
        />
      </SRow>
    </div>
  )
}

function ProfileSheet({ profile, onClose }: { profile: AgentProfile | null; onClose: () => void }): React.JSX.Element {
  const providers = useStore((s) => s.providers)
  const [name, setName] = useState(profile?.name ?? '')
  const [adapter, setAdapter] = useState<AdapterId>(profile?.adapter ?? 'claude')
  const [model, setModel] = useState(profile?.model ?? '')
  const [extra, setExtra] = useState((profile?.extraArgs ?? []).join(' '))
  const [perm, setPerm] = useState<PermissionMode>(profile?.permissionMode ?? 'bypass')
  const [allKeys, setAllKeys] = useState(profile ? profile.secretNames.includes('*') : true)
  const [names, setNames] = useState<string[]>(profile && !profile.secretNames.includes('*') ? profile.secretNames : [])
  const [apiKey, setApiKey] = useState(profile?.useApiKeyAuth ?? false)
  const [secrets, setSecrets] = useState<SecretMeta[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => void hive.secrets.list().then(setSecrets, () => undefined), [])
  const authVars = ADAPTER_AUTH_VARS[adapter]

  const save = async (): Promise<void> => {
    const input: AgentProfileInput = {
      name: name.trim(),
      adapter,
      model: model.trim() || null,
      extraArgs: extra.trim() ? extra.trim().split(/\s+/) : [],
      permissionMode: perm,
      secretNames: allKeys ? ['*'] : names,
      useApiKeyAuth: apiKey
    }
    setBusy(true)
    const r = await attempt(() => (profile ? hive.profiles.update({ id: profile.id, ...input }) : hive.profiles.create(input)), 'Save profile')
    setBusy(false)
    if (r) {
      void refreshProfiles()
      onClose()
    }
  }
  return (
    <Sheet title={profile ? `Edit ${profile.name}` : 'New Profile'} onCancel={onClose} onPrimary={() => void save()} primaryDisabled={!name.trim() || busy}>
      <Field label="Name">
        <input className="input" value={name} placeholder="Claude · opus" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="CLI">
        <select className="input" value={adapter} onChange={(e) => setAdapter(e.target.value as AdapterId)} disabled={!!profile}>
          {ADAPTER_IDS.map((a) => {
            const p = providers.find((x) => x.id === a)
            return (
              <option key={a} value={a}>
                {p?.label ?? providerLabel(a)}
                {p && !p.available ? ' (not installed)' : ''}
              </option>
            )
          })}
        </select>
      </Field>
      {adapter !== 'shell' && (
        <>
          <Field label="Model" hint="Leave empty for the CLI default.">
            <input className="input mono" value={model} placeholder="e.g. opus" onChange={(e) => setModel(e.target.value)} />
          </Field>
          <Field label="Permissions in workflow steps" hint="Workflow steps run unattended and can’t answer questions, so a step that needs permission stops. Terminal sessions use the switch in Settings › Agents.">
            <Segmented
              size="sm"
              items={[
                { value: 'bypass', label: 'Runs without asking' },
                { value: 'default', label: 'Stops if it needs permission' }
              ]}
              value={perm}
              onChange={setPerm}
            />
          </Field>
          <Field label="Extra args">
            <input className="input mono" value={extra} placeholder="--verbose" onChange={(e) => setExtra(e.target.value)} />
          </Field>
        </>
      )}
      <Field label="Keys" align="start" hint={allKeys ? 'Every key in the vault, including ones you add later.' : undefined}>
        <Segmented
          size="sm"
          items={[
            { value: 'all', label: 'All keys' },
            { value: 'some', label: 'Only these' }
          ]}
          value={allKeys ? 'all' : 'some'}
          onChange={(v) => setAllKeys(v === 'all')}
        />
        {!allKeys && (
          <div className="env-list env-list--compact">
            {secrets.length === 0 && <span className="text-tertiary">No keys in the vault yet.</span>}
            {secrets.map((s) => (
              <label key={s.name} className="env-row">
                <input type="checkbox" checked={names.includes(s.name)} onChange={() => setNames(names.includes(s.name) ? names.filter((n) => n !== s.name) : [...names, s.name])} />
                <span className="mono">{s.name}</span>
              </label>
            ))}
          </div>
        )}
      </Field>
      {authVars && (
        <Field label="" hint={`Off: ${authVars.join(' / ')} are never passed, so your ${adapter === 'claude' ? 'Claude' : 'ChatGPT'} subscription login keeps working.`}>
          <label className="checkbox">
            <input type="checkbox" checked={apiKey} onChange={(e) => setApiKey(e.target.checked)} /> Use API key instead of subscription login (metered billing)
          </label>
        </Field>
      )}
    </Sheet>
  )
}

function Notifications(): React.JSX.Element {
  const s = useStore((st) => st.settings)!
  return (
    <div className="sgroup">
      <SRow label="Run failed" desc="Always on.">
        <Switch checked onChange={() => undefined} disabled label="Run failed" />
      </SRow>
      <SRow label="Run passed">
        <Segmented
          size="sm"
          items={[
            { value: 'scheduled', label: 'Scheduled only' },
            { value: 'always', label: 'Always' },
            { value: 'never', label: 'Never' }
          ]}
          value={s.notifyOnSuccess}
          onChange={(v) => void updateSettings({ notifyOnSuccess: v })}
        />
      </SRow>
      <SRow label="Missed or caught-up schedules" desc="Always on.">
        <Switch checked onChange={() => undefined} disabled label="Missed schedules" />
      </SRow>
      <SRow label="Sound">
        <Switch checked={s.notificationSound} onChange={(v) => void updateSettings({ notificationSound: v })} label="Sound" />
      </SRow>
      <SlackAlertRows />
    </div>
  )
}

/**
 * SLACK.md §10.3: notify nodes and (optionally) Needs-you alerts DM this Slack user. Only the user sets it; agents
 * never can. Normally filled during setup by the one-click "Send your alerts here?" suggestion (PO-S1).
 */
function SlackAlertRows(): React.JSX.Element {
  const status = useSlack((st) => st.status)
  const available = useSlack((st) => st.available)
  const users = useSlack((st) => st.users)
  const alertUser = useStore((st) => st.settings?.slackAlertUserId ?? null)
  const mirror = useStore((st) => !!st.settings?.slackMirrorNeedsYou)
  const wantFocus = useStore((st) => st.view.name === 'settings' && st.view.focus === 'slackAlerts')
  const [testing, setTesting] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const setUp = isSetUp(status)
  const connected = status?.state === 'connected'
  useEffect(() => {
    if (wantFocus) ref.current?.querySelector('input')?.focus()
  }, [wantFocus])
  const test = async (): Promise<void> => {
    setTesting(true)
    setNote(null)
    const r = await attempt(() => slackCall('slack:testAlert'), 'Send test alert')
    setTesting(false)
    if (!r) return
    const res = (r as { slack?: string }).slack
    setNote(res === 'sent' ? 'Sent. Check your Slack DMs.' : (r.note ?? (res === 'skipped' ? 'Pick who gets alerts first.' : 'Couldn’t send.')))
  }
  const sug = status?.alertSuggestion
  return (
    <>
      <SRow
        label="Send my alerts to"
        desc={
          !setUp ? (
            <>
              Notify steps DM this person on Slack (and always post a Mac notification).{' '}
              <button type="button" className="link-btn" onClick={() => void navigate({ name: 'settings', section: 'connections' })}>
                Connect Slack first
              </button>
              .
            </>
          ) : alertUser ? (
            'Notify steps set to “Me” DM this person on Slack. A Mac notification is always posted too.'
          ) : sug ? (
            <>
              Got it from {sug.name}.{' '}
              <button type="button" className="link-btn" onClick={() => void acceptAlertSuggestion()}>
                Send your alerts here
              </button>
              ?
            </>
          ) : (
            'Pick yourself. Tip: DM @hive “hi” in Slack and Principia offers it in one click.'
          )
        }
      >
        <div ref={ref} className={`slack-alert-pick ${available === false || !setUp ? 'is-disabled' : ''}`}>
          {setUp ? (
            <>
              <UserPicker value={alertUser} onPick={(u) => void updateSettings({ slackAlertUserId: u.id })} placeholder={Object.keys(users).length ? 'Search people…' : 'No people synced yet'} />
              {alertUser && (
                <IconButton icon="close" label="Stop sending alerts to Slack" onClick={() => void updateSettings({ slackAlertUserId: null })} />
              )}
            </>
          ) : (
            <Button size="sm" onClick={() => void navigate({ name: 'settings', section: 'connections' })}>
              Connect Slack…
            </Button>
          )}
        </div>
      </SRow>
      <SRow label="Test" desc={note ?? (connected ? 'Sends “Principia test alert” to the person above.' : 'Connect Slack first.')}>
        <Button size="sm" disabled={testing || !connected || !alertUser} onClick={() => void test()} title={!connected ? 'Connect Slack first' : !alertUser ? 'Pick who gets alerts first' : undefined}>
          {testing ? 'Sending…' : 'Send test alert'}
        </Button>
      </SRow>
      <SRow label="Mirror Needs you to Slack DM" desc="When something needs you and Principia posts a Mac notification, also DM the person above: just the title and who asked, at most one every 2 minutes. Run failures stay Mac-only.">
        <Switch checked={mirror} disabled={!setUp || !alertUser} onChange={(v) => void updateSettings({ slackMirrorNeedsYou: v })} label="Mirror Needs you to Slack DM" />
      </SRow>
    </>
  )
}

function Connections(): React.JSX.Element {
  return <><GatewayConnections /><SlackConnectionCard /></>
}

function Data(): React.JSX.Element {
  const info = useStore((s) => s.info)
  if (!info) return <div className="text-tertiary">Loading…</div>
  const rows: [string, string][] = [
    ['Data folder', info.userDataDir],
    ['Artifacts', info.artifactsDir],
    ['Logs', info.logsDir],
    ['Database', info.dbPath]
  ]
  return (
    <div className="sgroup">
      {rows.map(([l, p]) => (
        <SRow key={l} label={l} desc={<span className="mono selectable">{p}</span>}>
          <Button size="sm" onClick={() => void attempt(() => hive.app.showItemInFolder({ path: p }))}>
            Reveal in Finder
          </Button>
        </SRow>
      ))}
      <LeftoverSection />
      <HistoryToggle />
      <MarketplaceUrlRow />
      <WorktreesSection />
      <ArchivedCompaniesSection />
      <ExperimentalSection />
    </div>
  )
}

/**
 * COMPANY.md / DEPARTMENTS.md §0.8: the experimental flags the refusals point at ("Settings → Experimental").
 * Departments only take effect with Companies on; turning either off never deletes anything, and Autopilot stays off
 * until turned on per company.
 */
function ExperimentalSection(): React.JSX.Element {
  const flags = useStore((st) => st.settings?.experimental) ?? {}
  const set = (patch: { companies?: boolean; departments?: boolean }): void => void updateSettings({ experimental: { ...flags, ...patch } })
  return (
    <>
      <div className="sgroup__title">Experimental</div>
      <SRow label="Companies" desc="Group repos, workflows, keys and runs by company, with company guards enforced.">
        <Switch checked={!!flags.companies} onChange={(v) => set({ companies: v })} label="Companies" />
      </SRow>
      <SRow label="Departments and the company board" desc="Departments, agent seats and one task board per company. Agents start work on their own only where you turn Autopilot on. Needs Companies.">
        <Switch checked={!!flags.companies && !!flags.departments} disabled={!flags.companies} onChange={(v) => set({ departments: v })} label="Departments" />
      </SRow>
    </>
  )
}

/** A3 off switch: no reads of ~/.claude/projects at all when off. */
function HistoryToggle(): React.JSX.Element {
  const on = useStore((st) => st.settings?.claudeHistory !== false)
  return (
    <SRow label="Claude Code history" desc="Show your Claude Code sessions from outside Principia on Home and the Canvas. Read-only: Principia never changes ~/.claude.">
      <Switch checked={on} onChange={(v) => void updateSettings({ claudeHistory: v })} label="Claude Code history" />
    </SRow>
  )
}

/** Marketplace: an https index.json (e.g. raw.githubusercontent.com/<org>/<repo>/main/index.json) next to the built-in catalog. */
function MarketplaceUrlRow(): React.JSX.Element {
  const saved = useStore((st) => st.settings?.marketplaceUrl ?? '')
  const [v, setV] = useState(saved)
  useEffect(() => setV(saved), [saved])
  const commit = (): void => {
    const url = v.trim()
    if (url !== saved) void updateSettings({ marketplaceUrl: url || null })
  }
  return (
    <SRow label="Marketplace URL" desc="Optional. An https link to a marketplace index.json, listed next to Principia's built-in catalog (Marketplace in the sidebar).">
      <input
        className="input"
        style={{ width: 280 }}
        placeholder="https://raw.githubusercontent.com/…/index.json"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
    </SRow>
  )
}

/** COMPANY.md §2.1: archiving hides a company (its data stays); this is where it comes back. */
function ArchivedCompaniesSection(): React.JSX.Element | null {
  const [items, setItems] = useState<CompanyPassport[] | null>(null)
  const load = (): void =>
    void hive.company.list({ includeArchived: true }).then((list) => setItems(list.filter((c) => !!c.archivedAt)), () => setItems(null))
  useEffect(load, [])
  useHiveEvent('data:changed', ({ domain }) => domain === 'company' && load())
  if (!items?.length) return null
  const unarchive = async (c: CompanyPassport): Promise<void> => {
    const r = await attempt(() => hive.company.archive({ id: c.id, archived: false }), 'Unarchive')
    if (!r) return
    await refreshCompanies().catch(() => undefined)
    toast(`${c.name} is back`)
    load()
  }
  return (
    <div className="settings-leftovers">
      <div className="srow__title">Archived companies</div>
      {items.map((c) => (
        <div key={c.id} className="srow">
          <div className="srow__text">
            <div>{c.name}</div>
            <div className="srow__desc">
              Archived <RelativeTime iso={c.archivedAt!} /> · its repositories, runs and Passport are kept
            </div>
          </div>
          <div className="srow__ctl">
            <Button size="sm" onClick={() => void unarchive(c)}>
              Unarchive
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}

/** Worktrees Principia kept after a run (pushed work, unpushed work, failures). Principia never removes these on its own. */
function WorktreesSection(): React.JSX.Element | null {
  const [items, setItems] = useState<RunWorktree[] | null>(null)
  const load = (): void => void hive.worktrees.list({ status: ['kept', 'error'] }).then(setItems, () => setItems(null))
  useEffect(load, [])
  useHiveEvent('worktree:updated', () => load())
  if (!items) return null
  const remove = async (w: RunWorktree): Promise<void> => {
    const ok = await confirmNative({
      message: `Remove the worktree ${w.branch}?`,
      detail: `Deletes ${tildify(w.path)}${w.keptReason === 'dirty' ? ', including uncommitted or unpushed work' : ''}. Your checkout is not touched.`,
      confirmLabel: 'Remove Worktree',
      destructive: true
    }).catch(() => false)
    if (!ok) return
    await attempt(() => hive.worktrees.remove({ id: w.id }), 'Remove worktree')
    load()
  }
  return (
    <div className="settings-leftovers">
      <div className="srow__title">Kept worktrees</div>
      {items.length === 0 ? (
        <div className="text-tertiary">None. Worktrees with nothing new are removed when their run ends.</div>
      ) : (
        items.map((w) => (
          <div key={w.id} className="srow">
            <div className="srow__text">
              <div className="mono">{w.branch}</div>
              <div className="srow__desc">
                {worktreeState(w)} · {tildify(w.repoPath)} · <RelativeTime iso={w.createdAt} />
              </div>
            </div>
            <div className="srow__ctl">
              <Button size="sm" variant="ghost" onClick={() => void navigate({ name: 'run', runId: w.runId })}>
                Run
              </Button>
              <Button size="sm" onClick={() => void attempt(() => hive.app.showItemInFolder({ path: w.path }))}>
                Reveal
              </Button>
              <Button size="sm" onClick={() => void remove(w)}>
                Remove
              </Button>
            </div>
          </div>
        ))
      )}
    </div>
  )
}

/** Processes agents left running in an earlier Principia run (tagged HIVE_SPAWN_ID, owner gone). Never stopped automatically. */
function LeftoverSection(): React.JSX.Element {
  const { items, reload } = useLeftovers()
  return (
    <div className="settings-leftovers">
      <div className="srow__title">Leftover processes</div>
      {items === null ? <div className="text-tertiary">Not available.</div> : <LeftoverList items={items} onChanged={reload} empty={<LeftoverEmpty />} />}
    </div>
  )
}

function About(): React.JSX.Element {
  const info = useStore((s) => s.info)
  return (
    <div className="sgroup about">
      <div className="about__name">Principia</div>
      {info && (
        <div className="text-secondary selectable">
          Version {info.version} · Electron {info.electron} · Node {info.node} · {info.arch}
          {info.isPackaged ? '' : ' · development build'}
        </div>
      )}
      <p className="text-secondary">No network listeners. No telemetry. Everything stays on this Mac.</p>
    </div>
  )
}
