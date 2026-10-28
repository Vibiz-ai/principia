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
import { wireFieldDrops } from './lib/fieldDrop'
import { hive } from './lib/hive'
import { toast } from './state/store'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)

// drop (or paste) an image into any text box: boxes without their own attach take it as an @path mention
wireFieldDrops(document, {
  pathFor: (f) => hive.pathForFile?.(f) ?? '',
  saveImage: async (data, type) => (await hive.sessions.saveImage({ data, type })).path,
  skipped: (names) => toast(`Couldn't add ${names.join(', ')}: drop a file from Finder or a PNG, JPEG, GIF or WebP image.`, 'error')
})

// uncaught async errors would otherwise vanish; console.error lands in main.log
window.addEventListener('unhandledrejection', (e) => console.error(`Unhandled rejection: ${e.reason instanceof Error ? (e.reason.stack ?? e.reason.message) : String(e.reason)}`))
