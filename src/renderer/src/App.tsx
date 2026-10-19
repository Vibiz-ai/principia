import { useEffect } from 'react'
import { Loading } from './components/ui'
import { CommandPalette } from './shell/CommandPalette'
import { installKeyboard } from './shell/keyboard'
import { SiblingOffer, Toasts } from './shell/Overlays'
import { Sidebar } from './shell/Sidebar'
import { StatusBar } from './shell/StatusBar'
import { boot, useStore, type ViewState } from './state/store'
import { reportVisibleOwner } from './state/live'
import { AgentsView } from './views/AgentsView'
import { ArtifactsView } from './views/ArtifactsView'
import { CanvasView } from './views/CanvasView'
import { HomeView } from './views/HomeView'
import { KeysView } from './views/KeysView'
import { MemoryView } from './views/MemoryView'
import { RunInputsSheet } from './views/RunInputsSheet'
import { RunView } from './views/RunView'
import { SchedulesView } from './views/SchedulesView'
import { SessionView } from './views/SessionView'
import { SettingsView } from './views/SettingsView'
import { SlackView } from './views/SlackView'
import { WorkflowEditor } from './views/WorkflowEditor'
import { MarketplaceView } from './views/MarketplaceView'
import { WorkflowsView } from './views/WorkflowsView'

const TITLES: Record<ViewState['name'], string> = {
  agents: 'Agents',
  home: 'Home',
  session: 'Session',
  canvas: 'Canvas',
  workflows: 'Workflows',
  marketplace: 'Marketplace',
  editor: 'Workflow',
  run: 'Run',
  schedules: 'Schedules',
  artifacts: 'Artifacts',
  keys: 'Keys',
  settings: 'Settings',
  memory: 'Memory',
  slack: 'Slack'
}

export function App(): React.JSX.Element {
  const ready = useStore((s) => s.ready)
  const bootError = useStore((s) => s.bootError)
  const view = useStore((s) => s.view)
  const collapsed = useStore((s) => !!s.settings?.sidebarCollapsed)

  useEffect(() => {
    void boot()
    return installKeyboard()
  }, [])
  useEffect(() => {
    document.title = `Principia — ${TITLES[view.name]}`
  }, [view.name])
  // what the user is looking at: main suppresses notifications for it, and idle sessions on screen count as seen (A3)
  const focusedSession = useStore((s) => s.focusedSession)
  const grid = useStore((s) => s.grid)
  const winFocused = useStore((s) => s.window.focused)
  useEffect(() => {
    if (ready) reportVisibleOwner()
  }, [ready, view, focusedSession, grid, winFocused])

  return (
    <div className={`shell ${collapsed ? 'is-collapsed' : ''}`}>
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
      <Toasts />
    </div>
  )
}

function ViewSwitch({ view }: { view: ViewState }): React.JSX.Element {
  switch (view.name) {
    case 'agents':
      return <AgentsView />
    case 'home':
      return <HomeView />
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
      return <SchedulesView selectedId={view.selectedId} seed={view.seed} nonce={view.nonce} tab={view.tab} />
    case 'artifacts':
      return <ArtifactsView runId={view.runId} sessionId={view.sessionId} />
    case 'keys':
      return <KeysView />
    case 'settings':
      return <SettingsView section={view.section} />
    case 'memory':
      return <MemoryView view={view} />
    case 'slack':
      return <SlackView channelId={view.channelId} threadTs={view.threadTs} search={view.search} nonce={view.nonce} />
  }
}
