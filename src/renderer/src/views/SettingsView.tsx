import { useEffect, useRef, useState } from 'react'
import type { AdapterId, AgentProfile, AgentProfileInput, ChimeKind, PermissionMode, SecretMeta, TrackTasks } from '@shared/types'
import { ADAPTER_IDS } from '@shared/types'
import type { MemoryMode } from '@shared/memory'
import { MEMORY_MODES } from '@shared/memory'
import type { CompanyPassport } from '@shared/company'
import { CLAUDE_PLAN_PRICES, claudePlanLabel, onPlan } from '@shared/providerAuth'
import { useClaudeAuth } from '../state/claudeAuth'
import { ClaudeSignInButton, DESKTOP_SIGN_IN_NOTE } from '../components/ClaudeSignIn'
import { MEMORY_MODE_LABEL } from '../lib/memory'
import { Button, Field, IconButton, Pill, RelativeTime, Segmented, Sheet, Stepper, Switch, Toolbar } from '../components/ui'
import { Icon } from '../components/Icon'
import { LeftoverEmpty, LeftoverList, useLeftovers } from '../components/agents/LimitBits'
import { confirmNative, hive, nativeMenu, useHiveEvent } from '../lib/hive'
import { ADAPTER_AUTH_VARS } from '../lib/secrets'
import { personasOn, t, toneOf, type Tone } from '../lib/voice'
import { isPersonal } from '../lib/company'
import { autonomyPhrase } from '../lib/desk'
import { APP_SECTIONS, companySections, pickTarget, resolveSection, type AppSection, type CompanySection, type SectionDef } from '../lib/settingsModel'
import { attempt, enterCompany, navigate, providerLabel, refreshCompanies, refreshProfiles, refreshProviders, setCompanyAutopilot, setCompanyPaused, setState, toast, updateSettings, useStore, type SettingsSection } from '../state/store'
import type { AuthorRunGrant } from '@shared/authoring'
import type { RunWorktree } from '@shared/types'
import { worktreeState } from '../lib/authoring'
import { tildify } from '../lib/format'
import { playChime } from '../lib/chimeSound'
import { slackCall } from '../lib/slackApi'
import { acceptAlertSuggestion, isSetUp, useSlack } from '../state/slack'
import { UserPicker } from '../components/slack/bits'
import { useScope } from '../components/CompanyChip'
import { useIsCode } from '../components/desk/Desk'
import { useDeskAgents } from '../state/desk'
import { ConnectionsPage } from '../components/connections/ConnectionsPage'
import type { Purpose } from '@shared/services'
import { DiskSection } from '../components/usage/DiskSection'
import { PrincipiaRunsTeam } from '../components/orchestrator/PrincipiaTeam'
import { PhoneSettings } from '../components/phone/PhoneSettings'
import { checkForUpdates, restartForUpdate, useUpdates } from '../state/updates'
import { DOWNLOAD_PAGE_URL, updateLine } from '@shared/updates'
import { CompanyAvatar } from '../shell/CompanyRail'
import { PassportView } from './PassportView'
import { KeysView } from './KeysView'
import { CloudView } from './CloudView'
import '../styles/settings5.css'

/**
 * Five doors step 4 (design §2.4): Settings in two scopes, the way Notion splits Workspace and Account.
 * This company: General (name, logo, colour, task prefix, profile), Team & autonomy, Connections, Repositories (code
 * companies), Keys & secrets, Danger zone. App, for every company: General, AI providers, Notifications, Cloud sync,
 * Storage, Experimental, About. In All companies the company pages ask which company first, so one client's keys or
 * connections never list beside another's. Old section names still open (lib/settingsModel normalizeSection).
 */
export { defaultSettingsSection } from '../lib/settingsModel'

export function SettingsView({ section, nonce, connect, purpose }: { section?: SettingsSection; nonce?: number; connect?: string; purpose?: Purpose }): React.JSX.Element {
  const { company, multi } = useScope()
  const companies = useStore((s) => s.companies)
  const inCompany = !!company
  const personal = !!company && isPersonal(company)
  const code = useIsCode(company?.id ?? null)
  const opts = { inCompany, personal, code }
  const [cur, setCur] = useState<CompanySection | AppSection | 'pick'>(() => resolveSection(section, opts))
  useEffect(() => {
    setCur(resolveSection(section, opts))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, nonce, company?.id])
  const settings = useStore((s) => s.settings)
  const go = (id: CompanySection | AppSection): void => {
    setCur(id)
    // keep the route in step so ⌘[ / a reload / the window title follow the section
    setState((st) => (st.view.name === 'settings' ? { view: { ...st.view, section: id, connect: undefined } } : {}))
  }
  const navRow = (s: SectionDef<CompanySection | AppSection>): React.JSX.Element => (
    <div
      key={s.id}
      className={`side-row side-row--nav ${cur === s.id ? 'is-selected' : ''}`}
      role="link"
      tabIndex={0}
      aria-current={cur === s.id ? 'page' : undefined}
      onClick={() => go(s.id)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), go(s.id))}
    >
      <span className="side-row__label">{s.label}</span>
    </div>
  )
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
  const hosted = cur === 'company' || cur === 'repos' || cur === 'danger' || cur === 'keys' || cur === 'cloud'
  const pickable = companies.filter((c) => !c.archivedAt)
  return (
    <div className="view">
      <Toolbar title="Settings" sub={<span className="company-toolbar-meta">{company ? company.name : 'All companies'}</span>} />
      <div className="settings">
        <nav className="settings__nav" aria-label="Settings sections">
          {company ? (
            <>
              <div className="settings__group" title={`These pages belong to ${company.name} only`}>
                {multi ? `This company · ${company.name}` : company.name}
              </div>
              {companySections({ personal, code }).map(navRow)}
            </>
          ) : (
            <>
              <div className="settings__group">This company</div>
              <div
                className={`side-row side-row--nav ${cur === 'pick' ? 'is-selected' : ''}`}
                role="link"
                tabIndex={0}
                onClick={() => setCur('pick')}
                onKeyDown={(e) => e.key === 'Enter' && setCur('pick')}
              >
                <span className="side-row__label">Pick a company…</span>
              </div>
            </>
          )}
          <div className="settings__group">App · all companies</div>
          {APP_SECTIONS.map(navRow)}
        </nav>
        {hosted ? (
          <div className="settings__host">{cur === 'keys' ? <KeysView /> : cur === 'cloud' ? <CloudView /> : <PassportView />}</div>
        ) : (
          <div className="settings__body scroll">
            {!settings ? null : cur === 'pick' ? (
              <CompanyPick companies={pickable} section={pickTarget(section)} />
            ) : cur === 'connections' && company ? (
              <ConnectionsPage key={connect ? `open-${nonce ?? 0}` : company.id} company={company} open={connect ?? null} {...(purpose ? { purpose } : {})} />
            ) : cur === 'team' && company ? (
              <TeamAutonomy company={company} />
            ) : cur === 'general' ? (
              <General />
            ) : cur === 'providers' ? (
              <Providers />
            ) : cur === 'notifications' ? (
              <Notifications />
            ) : cur === 'phone' ? (
              <PhoneSettings />
            ) : cur === 'storage' ? (
              <Storage />
            ) : cur === 'experimental' ? (
              <div className="sgroup">
                <ExperimentalSection />
              </div>
            ) : (
              <About />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** All companies: company settings live inside each company. One row per company opens its Settings there. */
function CompanyPick({ companies, section }: { companies: CompanyPassport[]; section: CompanySection }): React.JSX.Element {
  const open = (c: CompanyPassport): void => void enterCompany(c.id, { view: { name: 'settings', section, nonce: Date.now() } })
  return (
    <div className="s5">
      <h2 className="s5__title">Company settings live inside each company</h2>
      <p className="s5__lede">Connections, keys, the team and the task prefix belong to one company, so they never show next to another client’s. Pick the company:</p>
      <div className="sgroup">
        {companies.map((c) => (
          <div key={c.id} className="srow srow--click" role="button" tabIndex={0} onClick={() => open(c)} onKeyDown={(e) => e.key === 'Enter' && open(c)}>
            <CompanyAvatar company={c} size={20} />
            <div className="srow__text">
              <div>{c.name}</div>
              <div className="srow__desc">{isPersonal(c) ? 'What no company owns' : c.pausedAt ? 'Paused' : 'Running'}</div>
            </div>
            <Icon name="chevronRight" size={14} />
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Team & autonomy (design §2.4): this company's Pause and Autopilot, how many tasks run at once, "Principia runs the
 * team" (ORCHESTRATOR.md) and each agent's one autonomy phrase (the same words as Team and onboarding). Nothing here
 * touches another company.
 */
function TeamAutonomy({ company: c }: { company: CompanyPassport }): React.JSX.Element {
  const agents = useDeskAgents(c.id)
  const raw = useStore((s) => s.companyAgents)
  const paused = !!c.pausedAt
  const short = c.name.split(/\s+/)[0]
  const [inFlight, setInFlight] = useState(c.maxInFlight ?? 3)
  useEffect(() => setInFlight(c.maxInFlight ?? 3), [c.maxInFlight])
  return (
    <div className="s5">
      <h2 className="s5__title">Team &amp; autonomy</h2>
      <p className="s5__lede">How {c.name}’s agents work when you’re not looking. Every switch here is for {c.name} only; your other companies keep their own.</p>
      <div className="sgroup">
        <SRow label={`Pause ${c.name}`} desc={paused ? `Paused. Agents start nothing and schedules wait. Chats you open yourself still work. Other companies keep running.` : 'Stops every agent and schedule in this company only. Work in flight is saved and continues when you resume.'}>
          <Switch checked={paused} onChange={(v) => void setCompanyPaused(c.id, v)} label={`Pause ${c.name}`} />
        </SRow>
        <SRow label="Autopilot" desc={paused ? 'Off while paused.' : 'Agents pick up the tasks assigned to them on their own. Off: they wait for you to press Start.'}>
          <Switch checked={!paused && !!c.autopilot} disabled={paused} onChange={(v) => void setCompanyAutopilot(c.id, v)} label="Autopilot" />
        </SRow>
        <SRow label="Tasks at once" desc={`How many of ${short}’s tasks agents work on at the same time.`}>
          <Stepper
            value={inFlight}
            min={1}
            max={20}
            onChange={(v) => {
              setInFlight(v)
              void attempt(() => hive.board.autopilot({ companyId: c.id, on: !!c.autopilot, maxInFlight: v }), 'Tasks at once').then(() => refreshCompanies().catch(() => undefined))
            }}
            label="Tasks at once"
          />
        </SRow>
      </div>
      <PrincipiaRunsTeam companyId={c.id} companyName={c.name} />
      <div className="sgroup">
        <div className="sgroup__title">
          Each agent
          <span className="flex1" />
          <Button size="sm" variant="ghost" onClick={() => void navigate({ name: 'team' })}>
            Open Team →
          </Button>
        </div>
        {agents.length === 0 ? (
          <div className="srow">
            <div className="srow__text">
              <div className="srow__desc">No agents yet. Add a department in Team.</div>
            </div>
          </div>
        ) : (
          agents.map((a) => {
            const seat = raw.find((x) => x.id === a.id)
            const auto = seat?.data.autonomy === 'auto'
            return (
              <div key={a.id} className="srow srow--click" role="button" tabIndex={0} onClick={() => void navigate({ name: 'agentSeat', id: a.id })} onKeyDown={(e) => e.key === 'Enter' && void navigate({ name: 'agentSeat', id: a.id })}>
                <div className="srow__text">
                  <div>
                    {a.name}
                    {a.name !== a.role && <span className="text-tertiary"> · {a.role}</span>}
                  </div>
                  <div className="srow__desc">
                    {autonomyPhrase({ auto, role: a.role, department: a.department ?? null })}
                    {a.paused ? ' · Paused' : ''}
                  </div>
                </div>
                <Icon name="chevronRight" size={14} />
              </div>
            )
          })
        )}
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
    <>
    <div className="s5">
      <h2 className="s5__title">General</h2>
      <p className="s5__lede">How Principia looks and behaves on this Mac, for every company. A company’s own name, prefix and profile are in its Settings › General.</p>
    </div>
    <div className="sgroup">
      <VoiceRows tone={toneOf(s)} personas={personasOn(s)} />
      <SRow label="Launch Principia at login" desc="Schedules only fire while Principia is running. Principia starts hidden in the menu bar.">
        <Switch checked={s.launchAtLogin} onChange={(v) => void updateSettings({ launchAtLogin: v })} label="Launch at login" />
      </SRow>
      <SRow label="Keep Mac awake while agents run" desc="Prevents app suspension while a session or run is active.">
        <Switch checked={s.keepAwake} onChange={(v) => void updateSettings({ keepAwake: v })} label="Keep awake" />
      </SRow>
      <SRow label="Max parallel agents" desc="Tasks and workflow steps, across all your companies; the rest wait for a free slot. Chat replies have their own slots, so they never wait behind this work.">
        <Stepper value={s.concurrency} min={1} max={16} onChange={(v) => void updateSettings({ concurrency: v })} />
      </SRow>
      <SRow label="Terminal font size" desc="⌘= / ⌘- in a session.">
        <Stepper value={s.terminalFontSize} min={9} max={24} onChange={(v) => void updateSettings({ terminalFontSize: v })} />
      </SRow>
      <SRow label="Retry scheduled runs once at the usage-limit reset" desc="A scheduled run that stops on a usage limit gets exactly one retry when the limit resets (in 1 hour when the CLI doesn’t say).">
        <Switch checked={s.autoRetryRateLimit ?? true} onChange={(v) => void updateSettings({ autoRetryRateLimit: v })} label="Retry scheduled runs at the usage-limit reset" />
      </SRow>
      <SRow label="Flag a step or session as Stalled? after N minutes without output" desc="Working agents with no output and no activity get a cyan “Stalled?” badge and one notification. Principia never stops them.">
        <Stepper value={s.stallMinutes ?? 10} min={1} max={240} onChange={(v) => void updateSettings({ stallMinutes: Math.min(240, Math.max(1, v)) })} label="Stalled after minutes" />
      </SRow>
      <SRow label="Hold every company’s schedules" desc="All companies at once. To stop one company, pause it in its Team & autonomy (or its menu): the others keep running.">
        <Switch checked={s.schedulesPaused} onChange={(v) => void hive.schedules.pauseAll({ paused: v }).then((status) => setState({ status }), (e) => toast(String(e.message), 'error'))} label="Hold every company’s schedules" />
      </SRow>
    </div>
    <AgentBehaviour />
    <SessionMemory />
    <div className="sgroup">
      <div className="sgroup__title">More</div>
      <HistoryToggle />
      <MarketplaceUrlRow />
    </div>
    </>
  )
}

/** How agents behave in every company: work on their own, track work as tasks. (Was Settings › Agents.) */
function AgentBehaviour(): React.JSX.Element {
  const proactiveAgents = useStore((s) => s.settings?.proactiveAgents !== false)
  const trackTasks = useStore((s) => s.settings?.trackTasks ?? 'auto')
  return (
    <div className="sgroup">
      <div className="sgroup__title">Agents, in every company</div>
      <SRow
        label="Agents use Principia on their own"
        desc="On: chats and agents track their work as board tasks, hand work to the right department, read and write company memory and ask teammates without being asked. Spending money, publishing, deleting and new companies still wait for your yes."
      >
        <Switch checked={proactiveAgents} onChange={(v) => void updateSettings({ proactiveAgents: v })} label="Agents use Principia on their own" />
      </SRow>
      <SRow
        label="Track work as tasks"
        desc="When it helps: a chat opens board tasks when one message asks for several things or multi-step work, never for questions, quick asks or when you say “just do it”. Always: every multi-step turn, with one gentle reminder when it forgets. Off: only when you ask."
      >
        <Segmented<TrackTasks>
          size="sm"
          value={trackTasks}
          items={[
            { value: 'off', label: 'Off' },
            { value: 'auto', label: 'When it helps' },
            { value: 'always', label: 'Always' }
          ]}
          onChange={(v) => void updateSettings({ trackTasks: v })}
        />
      </SRow>
    </div>
  )
}

/** CHAT-UI.md §4.4: Claude sessions open as a chat or a terminal (the pane's toggle changes one session). */
function OpenChatsAsRow(): React.JSX.Element {
  const openChatsAs = useStore((s) => s.settings?.openChatsAs ?? 'auto')
  return (
    <SRow
      label="Open Claude chats as"
      desc="Chat shows tools as cards and approvals as buttons; Terminal is Claude Code itself. Auto: chats open as Chat (a company’s chats too, even in its repository folder); a session you start on a repository or a worktree (New Session › a repository) opens as Terminal. Every chat has a Chat | Terminal switch (⌃`)."
    >
      <Segmented<'auto' | 'chat' | 'terminal'>
        size="sm"
        value={openChatsAs}
        items={[
          { value: 'auto', label: 'Auto' },
          { value: 'chat', label: 'Chat' },
          { value: 'terminal', label: 'Terminal' }
        ]}
        onChange={(v) => void updateSettings({ openChatsAs: v })}
      />
    </SRow>
  )
}

/**
 * AI providers (design §2.4, pm-review E12): the AI behind every company's agents. The Claude sign-in is checked for
 * real (`claude auth status`); then the CLIs, the optional model API keys (shared by every company, used only by a
 * profile set to API-key billing), permissions and profiles. What goes where is said on the page: a company's own
 * secrets are in Keys & secrets.
 */
function Providers(): React.JSX.Element {
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
      <div className="s5">
        <h2 className="s5__title">AI providers</h2>
        <p className="s5__lede">
          The AI that powers every company’s agents: your Claude and Codex sign-ins, and model API keys if you use them instead of a plan. Shared by all companies. A company’s own secrets, like STRIPE_SECRET_KEY, go in{' '}
          <button type="button" className="link-btn" onClick={() => void navigate({ name: 'settings', section: 'keys', nonce: Date.now() })}>
            Keys &amp; secrets
          </button>
          <span>.</span>
        </p>
      </div>
      <ClaudeAccount />
      <ModelKeys />
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
          label="Skip permission prompts in chats and terminal sessions"
          desc="Off: chats and terminal panes start in the CLI’s normal mode and ask before editing or running commands (a chat asks with Allow / Deny buttons; on, its mode chip reads “Runs without asking”). Workflow steps run headless and can’t ask, so they follow each profile’s setting below."
        >
          <Switch checked={interactiveBypass} onChange={(v) => void updateSettings({ interactiveBypass: v })} label="Skip permission prompts in chats and terminal sessions" />
        </SRow>
        <OpenChatsAsRow />
      </div>
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
          <Field label="Permissions in workflow steps" hint="Workflow steps run unattended and can’t answer questions, so a step that needs permission stops. Terminal sessions use the switch in Settings › AI providers.">
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
    <>
      <div className="s5">
        <h2 className="s5__title">Notifications</h2>
        <p className="s5__lede">When Principia taps you on the shoulder with a Mac notification, in every company. Everything also waits in Needs you, whatever you pick here.</p>
      </div>
      <div className="sgroup">
        <SRow label="Tell me when something needs me" desc="An agent asks a question, wants your OK, or finished and waits for you.">
          <Switch checked={s.notifyNeedsYou !== false} onChange={(v) => void updateSettings({ notifyNeedsYou: v })} label="Tell me when something needs me" />
        </SRow>
        <SRow label="When a job fails" desc="Always on, so a stopped job never goes unnoticed.">
          <Switch checked onChange={() => undefined} disabled label="When a job fails" />
        </SRow>
        <SRow label="When a job finishes" desc="Jobs are what agents run for you, on a schedule or when you press Run.">
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
        <SRow label="When a schedule was missed" desc="Always on. Schedules only run while Principia is open.">
          <Switch checked onChange={() => undefined} disabled label="When a schedule was missed" />
        </SRow>
      </div>
      <SoundRows />
      <div className="sgroup">
        <div className="sgroup__title">Also on Slack</div>
        <SlackAlertRows />
      </div>
    </>
  )
}

/** SOUNDS.md: one row per sound, each with a preview. */
const SOUND_ROWS: { kind: ChimeKind; key: 'soundDone' | 'soundNeedsYou' | 'soundProblem'; label: string; desc: string }[] = [
  { kind: 'done', key: 'soundDone', label: 'Done', desc: 'A team task is ready for your review, a milestone or plan finished, or a long chat turn ended while you were elsewhere.' },
  { kind: 'needs', key: 'soundNeedsYou', label: 'Needs you', desc: 'An agent asks a question or wants your OK. A burst of asks is one sound.' },
  { kind: 'problem', key: 'soundProblem', label: 'Problem', desc: 'A job failed, an agent looks stalled, or a usage limit or monthly cap was hit.' }
]

/**
 * SOUNDS.md: "Sounds" is notificationSound (old settings files keep working); the per-kind switches and the volume sit
 * under it. Only important moments make a sound, never routine runs, and never what you are already looking at.
 */
export function SoundRows(): React.JSX.Element {
  const s = useStore((st) => st.settings)!
  const on = s.notificationSound !== false
  const volume = typeof s.soundVolume === 'number' ? s.soundVolume : 0.5
  // the slider moves freely; the setting is written once it settles
  const [draft, setDraft] = useState<number | null>(null)
  const shown = draft ?? volume
  const commit = (): void => {
    if (draft === null) return
    void updateSettings({ soundVolume: draft })
    playChime('done', draft)
    setDraft(null)
  }
  return (
    <div className="sgroup">
      <div className="sgroup__title">Sounds</div>
      <SRow label="Sounds" desc="A short sound for the moments that matter. Routine jobs stay quiet, and so does whatever you are looking at.">
        <Switch checked={on} onChange={(v) => void updateSettings({ notificationSound: v })} label="Sounds" />
      </SRow>
      {SOUND_ROWS.map((r) => (
        <SRow key={r.kind} label={r.label} desc={r.desc}>
          <div className="sound-ctl">
            <IconButton icon="play" label={`Play the ${r.label} sound`} onClick={() => playChime(r.kind, volume)} data-sound={r.kind} />
            <Switch checked={on && s[r.key] !== false} disabled={!on} onChange={(v) => void updateSettings({ [r.key]: v })} label={`${r.label} sound`} />
          </div>
        </SRow>
      ))}
      <SRow label="Volume">
        <input
          className="sound-volume"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={shown}
          disabled={!on}
          aria-label="Sound volume"
          onChange={(e) => setDraft(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
      </SRow>
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
              Alerts can also reach you as a Slack message.{' '}
              <button type="button" className="link-btn" onClick={() => void navigate({ name: 'settings', section: 'connections' })}>
                Connect Slack first
              </button>
              .
            </>
          ) : alertUser ? (
            'Alerts meant for you reach this person as a Slack message, next to the Mac notification.'
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
      <SRow label="Also send Needs you to Slack" desc="When something needs you, also message the person above: just what it is and who asked, at most one every 2 minutes. Failed jobs stay on the Mac.">
        <Switch checked={mirror} disabled={!setUp || !alertUser} onChange={(v) => void updateSettings({ slackMirrorNeedsYou: v })} label="Also send Needs you to Slack" />
      </SRow>
    </>
  )
}

/**
 * COMPANY.md / DEPARTMENTS.md §0.8: the experimental flags the refusals point at ("Settings → Experimental").
 * Departments only take effect with Companies on; turning either off never deletes anything, and Autopilot stays off
 * until turned on per company.
 */
function ExperimentalSection(): React.JSX.Element {
  const flags = useStore((st) => st.settings?.experimental) ?? {}
  const set = (patch: { companies?: boolean; departments?: boolean; plans?: boolean }): void => void updateSettings({ experimental: { ...flags, ...patch } })
  const board = !!flags.companies && !!flags.departments
  return (
    <>
      <div className="s5">
        <h2 className="s5__title">Experimental</h2>
        <p className="s5__lede">Features still being finished. Turning one off hides it; nothing is deleted.</p>
      </div>
      <SRow label="Companies" desc="Group repos, workflows, keys and runs by company, with company guards enforced.">
        <Switch checked={!!flags.companies} onChange={(v) => set({ companies: v })} label="Companies" />
      </SRow>
      <SRow label="Departments and the company board" desc="Departments, agent seats and one task board per company. Agents start work on their own only where you turn Autopilot on. Needs Companies.">
        <Switch checked={!!flags.companies && !!flags.departments} disabled={!flags.companies} onChange={(v) => set({ departments: v })} label="Departments" />
      </SRow>
      <SRow label="Plans" desc="Turn one goal into milestones and tasks a head agent runs at the pace you pick, one worktree per milestone, ending in a pull request you merge. Task briefs stay on either way. Needs Departments.">
        <Switch checked={board && !!flags.plans} disabled={!board} onChange={(v) => set({ plans: v })} label="Plans" />
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
              Archived <RelativeTime iso={c.archivedAt!} /> · its repositories, runs and Knowledge are kept
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
function WorktreesSection({ companyId }: { companyId?: string | null }): React.JSX.Element | null {
  const repos = useStore((s) => s.repos)
  const [all, setItems] = useState<RunWorktree[] | null>(null)
  // inside a company only the worktrees of its own repositories
  const items = all && companyId ? all.filter((w) => repos.some((r) => r.companyId === companyId && r.path === w.repoPath)) : all
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

/**
 * pm-review E12, "the Claude check is real": `claude auth status`. Signed in: the plan it reports. Not signed in: how
 * to sign in and what a plan costs. An older Claude Code that can't say: we say we can't tell, never a guess.
 */
function ClaudeAccount(): React.JSX.Element {
  const { auth, recheck, checking } = useClaudeAuth({ fresh: true })
  const load = (refresh = false): void => void (refresh ? recheck() : undefined)
  const plan = claudePlanLabel(auth?.plan)
  const billed = onPlan(auth)
  return (
    <div className="sgroup s5-claude">
      <div className="sgroup__title">
        Claude
        <span className="flex1" />
        <Button size="sm" icon="refresh" disabled={checking} onClick={() => load(true)}>
          {checking ? 'Checking…' : 'Recheck'}
        </Button>
      </div>
      <div className="srow">
        <span className={`s5-claude__mark ${auth?.state === 'ok' ? 'is-ok' : ''}`} aria-hidden>
          {auth?.state === 'ok' ? '✓' : '○'}
        </span>
        <div className="srow__text">
          {!auth ? (
            <div className="text-tertiary">Checking Claude Code on this Mac…</div>
          ) : auth.state === 'ok' ? (
            <>
              <div>Signed in{plan ? ` · ${plan}` : ''} · used by every company’s agents</div>
              <div className="srow__desc">{billed === false ? 'Signed in with an API key: Anthropic bills each use.' : 'Agents run on your plan. Principia adds nothing on top.'}</div>
            </>
          ) : auth.state === 'signedOut' ? (
            <>
              <div>Sign in to Claude, or get a plan</div>
              <div className="srow__desc">
                Claude Code is installed but nobody is signed in to it, so agents can’t start. {DESKTOP_SIGN_IN_NOTE} No plan yet? {CLAUDE_PLAN_PRICES}
              </div>
              <ClaudeSignInButton onDone={() => load(true)} />
            </>
          ) : auth.state === 'missing' ? (
            <>
              <div>Claude Code isn’t installed</div>
              <div className="srow__desc">Install it (see the CLIs below), sign in with your Claude plan, then Recheck. {CLAUDE_PLAN_PRICES}</div>
            </>
          ) : (
            <>
              <div>Claude Code is installed</div>
              <div className="srow__desc">This version can’t tell us whether you’re signed in. Update Claude Code to see it here.</div>
            </>
          )}
        </div>
        {auth && auth.state !== 'ok' && auth.state !== 'unknown' && (
          <Button size="sm" variant={auth.state === 'signedOut' ? 'secondary' : 'primary'} onClick={() => void hive.app.openExternal({ url: 'https://claude.com/pricing' }).catch(() => undefined)}>
            See plans
          </Button>
        )}
      </div>
      <div className="srow">
        <div className="srow__text">
          <div className="srow__desc">Plan limits: Claude doesn’t report how much of your plan is left yet, so Principia never shows a percentage it can’t read. When an agent hits the limit, Spend shows when it resets.</div>
        </div>
      </div>
    </div>
  )
}

/** Optional model API keys, shared by every company. A subscription sign-in keeps working: only API-key profiles use them. */
function ModelKeys(): React.JSX.Element {
  const [keys, setKeys] = useState<SecretMeta[] | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [value, setValue] = useState('')
  const load = (): void => void hive.secrets.list({ companyId: null }).then((l) => setKeys(l.filter((k) => !k.companyId)), () => setKeys([]))
  useEffect(load, [])
  useHiveEvent('data:changed', ({ domain }) => domain === 'secrets' && load())
  const rows = [
    { name: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', hint: 'Optional: pay per use instead of your Claude plan.' },
    { name: 'OPENAI_API_KEY', label: 'OpenAI API key', hint: 'Optional: Codex and image tools.' }
  ]
  const save = async (name: string): Promise<void> => {
    if (!value.trim()) return
    const r = await attempt(() => hive.secrets.set({ name, value: value.trim(), companyId: null }), 'Save key')
    if (!r) return
    setEditing(null)
    setValue('')
    toast(`${name} saved for every company`)
    load()
  }
  return (
    <div className="sgroup">
      <div className="sgroup__title">Model API keys · every company</div>
      {rows.map((r) => {
        const k = keys?.find((x) => x.name === r.name)
        return (
          <div key={r.name} className="srow">
            <div className="srow__text">
              <div>
                {r.label} <span className="text-tertiary mono">{r.name}</span>
              </div>
              <div className="srow__desc">{k ? `Set · ${k.masked}. Used only by profiles set to API-key billing.` : `Not set. ${r.hint}`}</div>
              {editing === r.name && (
                <form
                  className="s5-inline"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void save(r.name)
                  }}
                >
                  <input className="input mono" type="password" autoFocus autoComplete="off" placeholder="Paste the key" value={value} onChange={(e) => setValue(e.target.value)} aria-label={r.label} />
                  <Button size="sm" variant="primary" type="submit" disabled={!value.trim()}>
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => (setEditing(null), setValue(''))}>
                    Cancel
                  </Button>
                </form>
              )}
            </div>
            {editing !== r.name && (
              <Button size="sm" onClick={() => (setEditing(r.name), setValue(''))}>
                {k ? 'Replace' : 'Add key'}
              </Button>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Storage (design §2.4, was Settings › Data and Usage › Disk): what Principia keeps on this Mac for all companies,
 * with Clean up; the data folders; kept worktrees; leftover processes; archived companies.
 */
function Storage(): React.JSX.Element {
  const info = useStore((s) => s.info)
  const { scope, company } = useScope()
  return (
    <>
      <div className="s5">
        <h2 className="s5__title">Storage</h2>
        <p className="s5__lede">Disk Principia uses on this Mac: agent folders (worktrees), files agents saved, logs and company folders{company ? `. Here: ${company.name}’s, and the total for all companies` : ', for every company'}. Your repositories and ~/.claude are not counted.</p>
      </div>
      <DiskSection companyId={scope ?? null} />
      <div className="sgroup">
        <div className="sgroup__title">Folders</div>
        {info
          ? ([
              ['Data folder', info.userDataDir],
              ['Files agents saved', info.artifactsDir],
              ['Logs', info.logsDir],
              ['Database', info.dbPath]
            ] as [string, string][]).map(([l, p]) => (
              <SRow key={l} label={l} desc={<span className="mono selectable">{p}</span>}>
                <Button size="sm" onClick={() => void attempt(() => hive.app.showItemInFolder({ path: p }))}>
                  Reveal in Finder
                </Button>
              </SRow>
            ))
          : null}
      </div>
      <div className="sgroup">
        <WorktreesSection companyId={scope ?? null} />
        <LeftoverSection />
        {/* the archived list names other companies: only in All companies (leak gate A1) */}
        {!company && <ArchivedCompaniesSection />}
      </div>
    </>
  )
}

function About(): React.JSX.Element {
  const info = useStore((s) => s.info)
  const beta = useStore((s) => s.settings?.betaUpdates === true)
  const upd = useUpdates()
  const [checking, setChecking] = useState(false)
  return (
    <>
    <div className="s5">
      <h2 className="s5__title">About</h2>
      <p className="s5__lede">The version on this Mac, and what Principia sends where.</p>
    </div>
    <div className="sgroup about">
      <div className="about__name">Principia</div>
      {info && (
        <div className="text-secondary selectable">
          Version {info.version} · Electron {info.electron} · Node {info.node} · {info.arch}
          {info.isPackaged ? '' : ' · development build'}
        </div>
      )}
      <p className="text-secondary">No network listeners unless you turn on Phone. No telemetry. Everything stays on this Mac.</p>
    </div>
    {upd && (
      <div className="sgroup">
        <SRow label="Updates" desc={<span aria-live="polite">{updateLine(upd)}</span>}>
          {upd.phase === 'ready' ? (
            <Button size="sm" variant="primary" onClick={() => void restartForUpdate()}>Restart to install</Button>
          ) : upd.phase === 'available' ? (
            <Button size="sm" variant="primary" onClick={() => void hive.app.openExternal({ url: DOWNLOAD_PAGE_URL })}>Download</Button>
          ) : upd.phase !== 'off' ? (
            <Button
              size="sm"
              disabled={checking || upd.phase === 'checking' || upd.phase === 'downloading'}
              onClick={() => {
                setChecking(true)
                void checkForUpdates().finally(() => setChecking(false))
              }}
            >
              Check for updates
            </Button>
          ) : null}
        </SRow>
        {upd.phase !== 'off' && (
          <SRow
            label="Get beta updates"
            desc={beta ? 'Beta versions arrive before everyone else and may have rough edges. Turning this off keeps the beta until a newer stable version is out.' : 'Try new versions before everyone else. Off: stable releases only.'}
          >
            <Switch checked={beta} onChange={(v) => void updateSettings({ betaUpdates: v })} label="Get beta updates" />
          </SRow>
        )}
      </div>
    )}
    </>
  )
}
