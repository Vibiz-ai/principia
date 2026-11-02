/** BROWSER.md §2: the "Also open" row of the panel. */
import type { BrowserOpenScope, BrowserScope } from '@shared/browser'

/** The company's other open tabs, by chat or task: an agent's tab is one click away from wherever the founder is. */
export function AlsoOpen({ scopes, onPick }: { scopes: BrowserOpenScope[]; onPick: (scope: BrowserScope) => void }): React.JSX.Element | null {
  if (!scopes.length) return null
  return (
    <nav className="bp-also" aria-label="Tabs open in other chats and tasks">
      <span className="bp-muted">Also open</span>
      {scopes.map((s) => (
        <button key={s.scope} type="button" className="bp-also-item" title={`${s.label}: ${s.title}${s.tabs > 1 ? ` and ${s.tabs - 1} more` : ''}`} onClick={() => onPick(s.scope)}>
          <span className="bp-also-who">{s.label}</span>
          <span className="bp-tab-title">{s.title}</span>
        </button>
      ))}
    </nav>
  )
}
