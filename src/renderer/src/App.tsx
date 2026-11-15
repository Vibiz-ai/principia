import { useEffect } from 'react'
import { Loading } from './components/ui'
import { CommandPalette } from './shell/CommandPalette'
import { CompanyRail, CompanySwitchToast, NewCompanySheet } from './shell/CompanyRail'
import { LogoPickerSheet } from './components/LogoPicker'
import { ChatCompanyCardHost } from './components/ChatCompanyCard'
import { installKeyboard } from './shell/keyboard'
import { SiblingOffer, Toasts } from './shell/Overlays'
import { ConnectSheetHost } from './components/connections/ConnectSheet'
import { DiagramOverlays } from './components/diagrams/DiagramOverlays'
import { Sidebar } from './shell/Sidebar'
import { StatusBar } from './shell/StatusBar'
import { activeCompany, boot, multiCompany, useStore, type SettingsSection, type ViewState } from './state/store'
import { resolveView, VIEW_TITLES } from './lib/nav'
import { ChatsView } from './views/ChatsView'
import { windowTitle } from './lib/company'
import { reportVisibleOwner } from './state/live'
import { ArtifactsView } from './views/ArtifactsView'
import { CanvasView } from './views/CanvasView'
import './styles/company.css'
import './styles/shell.css'
import './styles/rail.css'
import './styles/onboarding.css'
import './styles/cloud.css'
import { OnboardingFlow } from './views/onboarding/OnboardingFlow'
import { MemoryView } from './views/MemoryView'
import { RunInputsSheet } from './views/RunInputsSheet'
import { RunView } from './views/RunView'
import { SchedulesView } from './views/SchedulesView'
import { SessionView } from './views/SessionView'
import { SettingsView } from './views/SettingsView'
import { SlackView } from './views/SlackView'
import { KeysView } from './views/KeysView'
import { CloudView } from './views/CloudView'
import { WorkflowEditor } from './views/WorkflowEditor'
import { MarketplaceView } from './views/MarketplaceView'
import { WorkflowsView } from './views/WorkflowsView'
import { UsageView } from './views/UsageView'
import { BrowserDock } from './components/browser/BrowserDock'

type PassportViewState = Extract<ViewState, { name: 'passport' }>
/** PassportVaultView (PASSPORT.md P7) is Memory with the vault on; without it Memory is the v1 page. */
const lateViews = import.meta.glob(['./views/PassportVaultView.tsx'], { eager: true })
const PassportVaultView = lateViews['./views/PassportVaultView.tsx']?.PassportVaultView as ((p: { view: PassportViewState }) => React.JSX.Element) | undefined

/** Window titles in nav words: one table (lib/nav), so the sidebar, palette and title never disagree. */
const TITLES = VIEW_TITLES

export function App(): React.JSX.Element {
  const ready = useStore((s) => s.ready)
  const bootError = useStore((s) => s.bootError)
  const view = useStore((s) => s.view)
  const collapsed = useStore((s) => !!s.settings?.sidebarCollapsed)
  const multi = useStore((s) => multiCompany(s))
  const active = useStore((s) => activeCompany(s))
  const company = useStore((s) => (active === 'all' ? null : (s.companies.find((c) => c.id === active) ?? null)))
  // ONBOARDING.md §1: the first-run flow fills the window; the sidebar, rail and the rest of the chrome stay hidden
  const firstRunFlow = useStore((s) => !!s.onboarding?.open && s.onboarding.mode === 'first' && !!s.onboardingDraft)

  useEffect(() => {
    void boot()
    return installKeyboard()
  }, [])
  // All companies Home is the Portfolio; the window already says "All companies", so the view part stays "Home"
  const viewTitle = view.name === 'settings' && view.section ? (SETTINGS_TITLES[view.section] ?? TITLES.settings) : TITLES[view.name]
  const title = windowTitle(viewTitle, active === 'all' ? 'all' : company, multi)
  useEffect(() => {
    document.title = title
  }, [title])
  // what the user is looking at: main suppresses notifications for it, and idle sessions on screen count as seen (A3)
  const focusedSession = useStore((s) => s.focusedSession)
  const grid = useStore((s) => s.grid)
  const winFocused = useStore((s) => s.window.focused)
  useEffect(() => {
    if (ready) reportVisibleOwner()
    // SOUNDS.md: the Board on screen is per company (`active`)
  }, [ready, view, focusedSession, grid, winFocused, active])

  if (firstRunFlow)
    return (
      <div className="shell shell--onboarding">
        <OnboardingFlow />
        <ConnectSheetHost />
        <Toasts />
      </div>
    )

  return (
    <div className={`shell ${collapsed ? 'is-collapsed' : ''} ${multi ? 'has-rail' : ''}`}>
      <CompanyRail />
      {!collapsed && <Sidebar />}
      <main className="main">
        {!ready ? (
          <div className="view">
            <div className="toolbar drag" />
            <Loading label="Starting…" />
          </div>
        ) : (
          <>
            {bootError && <div className="banner banner--failed banner--bar selectable">Couldn’t load everything: {bootError}</div>}
            <ViewSwitch view={view} />
          </>
        )}
        <StatusBar />
      </main>
      {/* BROWSER.md §6: the company browser, beside whatever page is open */}
      {!firstRunFlow && <BrowserDock />}
      <CommandPalette />
      <RunInputsSheet />
      <SiblingOffer />
      <DiagramOverlays />
      <Toasts />
      <CompanySwitchToast />
      <NewCompanySheet />
      <LogoPickerSheet />
      <ChatCompanyCardHost />
      <OnboardingFlow />
      {/* after the flow, so a connect sheet opened from the Ready step sits above it */}
      <ConnectSheetHost />
    </div>
  )
}

/** Settings sections that used to be pages keep their own window title. */
const SETTINGS_TITLES: Partial<Record<SettingsSection, string>> = { company: TITLES.company, keys: TITLES.keys, cloud: TITLES.cloud }

function ViewSwitch({ view: raw }: { view: ViewState }): React.JSX.Element {
  // old routes (Home, Team, Board, Forum, Plans, Agents, Company Settings) render as what they resolve to
  const view = resolveView(raw)
  switch (view.name) {
    case 'passport':
      return PassportVaultView ? (
        <PassportVaultView view={view} />
      ) : (
        <MemoryView view={{ name: 'memory', runId: view.runId, sessionId: view.sessionId, search: !!view.search, nonce: view.nonce }} />
      )
    case 'chats':
      return <ChatsView filter={view.filter} chat={view.chat} />
    case 'session':
      return <SessionView />
    case 'keys':
      return <KeysView />
    case 'cloud':
      return <CloudView />
    case 'canvas':
      return <CanvasView focusRunId={view.focusRunId} />
    case 'marketplace':
      return <MarketplaceView />
    case 'workflows':
      return <WorkflowsView />
    case 'editor':
      return <WorkflowEditor workflowId={view.workflowId} nonce={view.nonce} approvalDraftId={view.approvalDraftId} script={view.script} />
    case 'run':
      return <RunView runId={view.runId} stepId={view.stepId} agentId={view.agentId} />
    case 'schedules':
      return <SchedulesView selectedId={view.selectedId} seed={view.seed} nonce={view.nonce} tab={view.tab} />
    case 'artifacts':
      return <ArtifactsView runId={view.runId} sessionId={view.sessionId} />
    case 'settings':
      return <SettingsView section={view.section} nonce={view.nonce} connect={view.connect} purpose={view.purpose} />
    case 'memory':
      return <MemoryView view={view} />
    case 'slack':
      return <SlackView channelId={view.channelId} threadTs={view.threadTs} search={view.search} nonce={view.nonce} />
    case 'usage':
      return <UsageView cap={view.cap} />
    default:
      // every other route resolves to Chats (lib/nav resolveView)
      return <ChatsView />
  }
}
