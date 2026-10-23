import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import '@xyflow/react/dist/base.css'
import './styles/tokens.css'
import './styles/roman.css'
import './styles/app.css'
import './styles/live.css'
import './styles/authoring.css'
import './styles/slack.css'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)

// uncaught async errors would otherwise vanish; console.error lands in main.log
window.addEventListener('unhandledrejection', (e) => console.error(`Unhandled rejection: ${e.reason instanceof Error ? (e.reason.stack ?? e.reason.message) : String(e.reason)}`))
