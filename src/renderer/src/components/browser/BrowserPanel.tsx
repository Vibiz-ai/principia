/**
 * BROWSER.md §6: one company's browser, self-contained. The page itself is a native view main places over the
 * `.bp-live` box (its rectangle is reported on every resize); everything around it is plain DOM.
 *
 * Mount API: <BrowserPanel companyId={id} onClose={fn} />. It owns its data (browser:state + browser:changed) and
 * can sit in any right-hand panel; it never takes keyboard focus by itself.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BrowserState } from '@shared/browser'
import { Button, IconButton } from '../ui'
import { Icon } from '../Icon'
import { hive } from '../../lib/hive'
import { activityLine, overlaps } from '../../lib/browserDock'
import { setBrowserState, takePendingUrl, useDock } from '../../state/browser'
import { toastError } from '../../state/store'

const EMPTY = (companyId: string): BrowserState => ({ companyId, tabs: [], activeTabId: null, takeover: false, activity: null, shots: [], downloads: [] })
/** Overlays that may sit on top of the live view: while one does, the native view steps aside. */
const OVERLAYS = '.sheet-layer, .palette-layer, .sheet, .popover, .cl-menu, .chat-menu, [role="dialog"], [role="menu"]'

export function BrowserPanel({ companyId, companyName, onClose }: { companyId: string; companyName?: string; onClose?: () => void }): React.JSX.Element {
  const state = useDock((s) => s.states[companyId]) ?? EMPTY(companyId)
  const live = useRef<HTMLDivElement>(null)
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  const [covered, setCovered] = useState(false)
  const tab = state.tabs.find((t) => t.id === state.activeTabId) ?? null

  useEffect(() => {
    let alive = true
    void hive.browser.state({ companyId }).then((s) => alive && setBrowserState(s), () => undefined)
    const url = takePendingUrl()
    if (url) void act(() => hive.browser.navigate({ companyId, url }))
    return () => {
      alive = false
    }
  }, [companyId])

  useEffect(() => {
    if (!editing) setAddress(tab?.url ?? '')
  }, [tab?.url, editing])

  // the live view follows the box: resize, scroll of ancestors, window resize, overlays
  useLayoutEffect(() => {
    const el = live.current
    if (!el) return
    let raf = 0
    let last = ''
    const report = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect()
        const blocking = [...document.querySelectorAll(OVERLAYS)].some((o) => !el.contains(o) && overlaps(o.getBoundingClientRect(), r))
        setCovered(blocking)
        const bounds = blocking || r.width < 40 || r.height < 40 ? null : { x: r.left, y: r.top, width: r.width, height: r.height }
        const key = JSON.stringify(bounds)
        if (key === last) return
        last = key
        void hive.browser.bounds({ companyId, bounds }).catch(() => undefined)
      })
    }
    const ro = new ResizeObserver(report)
    ro.observe(el)
    ro.observe(document.body)
    const mo = new MutationObserver(report)
    mo.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', report)
    report()
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener('resize', report)
      void hive.browser.bounds({ companyId, bounds: null }).catch(() => undefined)
    }
  }, [companyId])

  async function act(f: () => Promise<BrowserState | void>): Promise<void> {
    try {
      const s = await f()
      if (s) setBrowserState(s)
    } catch (e) {
      toastError(e, 'Browser')
    }
  }

  const go = (e: React.FormEvent): void => {
    e.preventDefault()
    const url = address.trim()
    if (!url) return
    setEditing(false)
    ;(document.activeElement as HTMLElement | null)?.blur()
    void act(() => hive.browser.navigate({ companyId, url }))
  }

  const busy = !!state.activity && !state.takeover
  return (
    <section className={`bp ${state.takeover ? 'is-takeover' : ''} ${busy ? 'is-agent' : ''}`} aria-label="Company browser">
      <header className="bp-bar">
        <IconButton icon="chevronLeft" label="Back" disabled={!tab?.canGoBack} onClick={() => void act(() => hive.browser.nav({ companyId, action: 'back' }))} />
        <IconButton icon="chevronRight" label="Forward" disabled={!tab?.canGoForward} onClick={() => void act(() => hive.browser.nav({ companyId, action: 'forward' }))} />
        <IconButton icon={tab?.loading ? 'close' : 'refresh'} label={tab?.loading ? 'Stop' : 'Reload'} disabled={!tab} onClick={() => void act(() => hive.browser.nav({ companyId, action: tab?.loading ? 'stop' : 'reload' }))} />
        <form className="bp-address" onSubmit={go}>
          <Icon name={tab?.url?.startsWith('https:') ? 'lock' : 'globe'} size={12} />
          <input
            value={address}
            placeholder="Type an address or search"
            spellCheck={false}
            onFocus={(e) => {
              setEditing(true)
              e.currentTarget.select()
            }}
            onBlur={() => setEditing(false)}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setAddress(tab?.url ?? '')
                e.currentTarget.blur()
              }
            }}
            aria-label="Address"
          />
        </form>
        {onClose && <IconButton icon="close" label="Close the browser (Esc)" onClick={onClose} />}
      </header>

      <nav className="bp-tabs" aria-label="Tabs">
        {companyName && (
          <span className="bp-co" title={`${companyName}'s browser: its own cookies and sign-ins`}>
            {companyName}
          </span>
        )}
        {state.tabs.map((t) => (
          <div key={t.id} className={`bp-tab ${t.id === state.activeTabId ? 'is-active' : ''}`}>
            <button type="button" className="bp-tab-main" title={t.url || t.title} onClick={() => void act(() => hive.browser.tab({ companyId, op: 'select', tabId: t.id }))}>
              {t.loading && <span className="bp-spin" aria-hidden />}
              <span className="bp-tab-title">{t.title || hostOf(t.url) || 'New tab'}</span>
            </button>
            <button type="button" className="bp-tab-x" aria-label="Close tab" onClick={() => void act(() => hive.browser.tab({ companyId, op: 'close', tabId: t.id }))}>
              <Icon name="close" size={10} />
            </button>
          </div>
        ))}
        <IconButton icon="plus" label="New tab" onClick={() => void act(() => hive.browser.tab({ companyId, op: 'new' }))} />
      </nav>

      <div className="bp-status" role="status" aria-live="polite">
        {state.takeover ? (
          <span className="bp-who">You are driving. Agents wait until you hand it back.</span>
        ) : state.activity ? (
          <span className="bp-who">
            <span className="bp-dot" aria-hidden />
            {activityLine(state)}
          </span>
        ) : (
          <span className="bp-who bp-who--quiet">{state.tabs.length ? 'Agents in this company can use this browser. You can watch and take over.' : ''}</span>
        )}
        <Button size="sm" variant={state.takeover ? 'primary' : 'secondary'} icon={state.takeover ? 'play' : 'pause'} onClick={() => void act(() => hive.browser.takeover({ companyId, on: !state.takeover }))}>
          {state.takeover ? 'Hand back' : 'Take over'}
        </Button>
      </div>

      <div className="bp-live" ref={live}>
        {!state.tabs.length && (
          <div className="bp-empty">
            <Icon name="globe" size={28} />
            <p>Nothing open yet.</p>
            <p className="bp-muted">Type an address above, or ask an agent to look something up: it opens here and you can watch.</p>
          </div>
        )}
        {state.tabs.length > 0 && covered && <div className="bp-empty bp-muted">The page is hidden while a window is open on top of it.</div>}
      </div>

      {(state.shots.length > 0 || state.downloads.length > 0) && (
        <footer className="bp-foot">
          {state.downloads.slice(0, 2).map((d) => (
            <div key={d.id} className={`bp-dl is-${d.state}`} title={d.path}>
              <Icon name="download" size={12} />
              <span>{d.name}</span>
              <span className="bp-muted">{d.note ?? downloadWord(d.state)}</span>
            </div>
          ))}
          {state.shots.length > 0 && (
            <div className="bp-shots" aria-label="Screenshots">
              {state.shots.map((s) => (
                <button key={s.id} type="button" className="bp-shot" title={`${s.agent ? `${s.agent} · ` : ''}${new Date(s.at).toLocaleTimeString()} · ${s.url}`} onClick={() => void act(() => hive.browser.openShot({ companyId, id: s.id }))}>
                  <img src={s.thumb} alt={`Screenshot of ${hostOf(s.url)}`} />
                </button>
              ))}
            </div>
          )}
        </footer>
      )}
    </section>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}
function downloadWord(s: string): string {
  return s === 'completed' ? 'Saved' : s === 'progressing' ? 'Downloading…' : s === 'waiting' ? 'Waiting for you' : s === 'cancelled' ? 'Stopped' : 'Failed'
}
