/** Last line of defense: a render error shows a way back instead of unmounting the whole UI to an empty window. */
import { Component, type ReactNode } from 'react'

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    // console.error reaches main.log (windowManager logs renderer console errors)
    console.error(`UI crashed: ${error.stack ?? error.message}\n${info.componentStack ?? ''}`)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="crash">
        <div className="crash__title">Principia’s window hit an error</div>
        <div className="crash__text text-secondary">Your sessions and runs are still going; only the window needs a reload.</div>
        <pre className="crash__detail mono selectable">{this.state.error.message}</pre>
        <button className="btn btn--primary" onClick={() => location.reload()}>
          Reload Window
        </button>
      </div>
    )
  }
}
