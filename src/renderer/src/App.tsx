import { useEffect } from 'react'
import { Loading, Toolbar } from './components/ui'
import { CommandPalette } from './shell/CommandPalette'
import { CompanyRail, CompanySwitchToast, NewCompanySheet } from './shell/CompanyRail'
import { LogoPickerSheet } from './components/LogoPicker'
import { ChatCompanyCardHost } from './components/ChatCompanyCard'
import { installKeyboard } from './shell/keyboard'
import { SiblingOffer, Toasts } from './shell/Overlays'
import { NewChatSheet } from './components/desk/NewChatSheet'
import { DiagramOverlays } from './components/diagrams/DiagramOverlays'
import { Sidebar } from './shell/Sidebar'
import { StatusBar } from './shell/StatusBar'
import { activeCompany, boot, departmentsOn, multiCompany, useStore, type SettingsSection, type ViewState } from './state/store'
import { resolveView, VIEW_TITLES } from './lib/nav'
import { TeamView } from './views/TeamView'
import { ChatsView } from './views/ChatsView'
import { windowTitle } from './lib/company'
import { reportVisibleOwner } from './state/live'
import { ArtifactsView } from './views/ArtifactsView'
import { CanvasView } from './views/CanvasView'
import { TasksView } from './views/TasksView'
import { PlansView } from './views/PlansView'
import { plansEnabled, PLANS_OFF } from '@shared/plans'
import { AgentSeatView } from './views/AgentSeatView'
import { DepartmentView } from './views/DepartmentView'
import { EmptyState } from './components/ui'
import './styles/company.css'
import './styles/shell.css'
import './styles/rail.css'
import './styles/onboarding.css'
import './styles/cloud.css'
import { OnboardingFlow } from './views/onboarding/OnboardingFlow'
import { HomeView } from './views/HomeView'
import { MilestoneWatcher } from './components/home/MilestoneStrip'
import { MemoryView } from './views/MemoryView'
import { RunInputsSheet } from './views/RunInputsSheet'
import { RunView } from './views/RunView'
import { SchedulesView } from './views/SchedulesView'
import { SessionView } from './views/SessionView'
import { SettingsView } from './views/SettingsView'
import { SlackView } from './views/SlackView'
import { ForumView } from './views/ForumView'
import { WorkflowEditor } from './views/WorkflowEditor'
import { MarketplaceView } from './views/MarketplaceView'
import { WorkflowsView } from './views/WorkflowsView'
import { UsageView } from './views/UsageView'

type PassportViewState = Extract<ViewState, { name: 'passport' }>
/**
 * Views owned by later packages, picked up when their file exists: PortfolioView (COMPANY.md C6) is Home in All mode;
 * PassportVaultView (PASSPORT.md P7) is the Passport. Until then Home stays Home and the Passport is the Memory page.
 */
const lateViews = import.meta.glob(['./views/PortfolioView.tsx', './views/PassportVaultView.tsx'], { eager: true })
const PortfolioView = lateViews['./views/PortfolioView.tsx']?.PortfolioView as (() => React.JSX.Element) | undefined
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
  }, [ready, view, focusedSession, grid, winFocused])

  if (firstRunFlow)
    return (
      <div className="shell shell--onboarding">
        <OnboardingFlow />
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
      <CommandPalette />
      <RunInputsSheet />
      <SiblingOffer />
      <NewChatSheet />
      <DiagramOverlays />
      <Toasts />
      {/* VOICE.md §7: one toast per company per newly earned milestone (mounted once, outside the first-run flow) */}
      <MilestoneWatcher />
      <CompanySwitchToast />
      <NewCompanySheet />
      <LogoPickerSheet />
      <ChatCompanyCardHost />
      <OnboardingFlow />
    </div>
  )
}

/** Settings sections that used to be pages keep their own window title. */
const SETTINGS_TITLES: Partial<Record<SettingsSection, string>> = { company: TITLES.company, keys: TITLES.keys, cloud: TITLES.cloud }

function ViewSwitch({ view: raw }: { view: ViewState }): React.JSX.Element {
  // old routes (Agents, Keys, Cloud, Company Settings) render as what they resolve to, even if set directly
  const view = resolveView(raw)
  const portfolioHome = useStore((s) => multiCompany(s) && activeCompany(s) === 'all')
  const plansOn = useStore((s) => plansEnabled(s.settings?.experimental))
  const departments = useStore((s) => departmentsOn(s))
  switch (view.name) {
    case 'department':
    case 'agentSeat':
      // DEPARTMENTS.md §0.8: a stale deep link with the flag off lands on a plain notice, never a half-working page
      if (!departments) return <DepartmentsOff />
      return view.name === 'department' ? <DepartmentView id={view.id} focus={view.focus} nonce={view.nonce} /> : <AgentSeatView id={view.id} focus={view.focus} nonce={view.nonce} />
    case 'tasks':
      return <TasksView />
    case 'plans':
      if (!departments) return <DepartmentsOff />
      // PLANS.md §0: behind experimental.plans; a stale deep link lands on a plain notice
      if (!plansOn) return <div className="view"><Toolbar title="Plans" /><EmptyState icon="plans" text={PLANS_OFF} /></div>
      return <PlansView planId={view.planId} create={view.create} nonce={view.nonce} />
    case 'passport':
      return PassportVaultView ? (
        <PassportVaultView view={view} />
      ) : (
        <MemoryView view={{ name: 'memory', runId: view.runId, sessionId: view.sessionId, search: !!view.search, nonce: view.nonce }} />
      )
    case 'team':
      return <TeamView />
    case 'chats':
      return <ChatsView filter={view.filter} chat={view.chat} />
    case 'portfolio':
      return PortfolioView ? <PortfolioView /> : <HomeView />
    case 'home':
      return portfolioHome && PortfolioView ? <PortfolioView /> : <HomeView />
    case 'session':
      return <SessionView />
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
      return <SchedulesView selectedId={view.selectedId} seed={view.seed} nonce={view.nonce} tab={view.tab} addRoutine={view.addRoutine} routineTime={view.routineTime} />
    case 'artifacts':
      return <ArtifactsView runId={view.runId} sessionId={view.sessionId} />
    case 'settings':
      return <SettingsView section={view.section} nonce={view.nonce} connect={view.connect} />
    case 'memory':
      return <MemoryView view={view} />
    case 'slack':
      return <SlackView channelId={view.channelId} threadTs={view.threadTs} search={view.search} nonce={view.nonce} />
    case 'usage':
      return <UsageView cap={view.cap} />
    case 'forum':
      return <ForumView companyId={view.companyId} channelId={view.channelId} threadId={view.threadId} nonce={view.nonce} />
    default:
      // agents, keys, cloud and company never reach here: resolveView turned them into chats and settings
      return <HomeView />
  }
}

function DepartmentsOff(): React.JSX.Element {
  return (
    <div className="view">
      <Toolbar title="Departments" />
      <EmptyState icon="agents" text="Departments are off. They need the experimental companies and departments settings turned on." />
    </div>
  )
}
