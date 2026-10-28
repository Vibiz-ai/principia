/**
 * BROWSER.md §6: the right-hand dock that hosts <BrowserPanel> beside whatever page is open (a chat, an agent's desk,
 * a session). Resizable from its left edge; Esc closes it (unless a field outside it is being edited).
 */
import { useEffect, useRef, useState } from 'react'
import { dockLayout, type DockLayout } from '../../lib/browserDock'
import { BrowserPanel } from './BrowserPanel'
import { closeBrowser, followPage, setDockWidth, useDock, wireBrowser } from '../../state/browser'
import { scopeCompanyId, useStore } from '../../state/store'
import '../../styles/browser.css'

export function BrowserDock(): React.JSX.Element | null {
  const open = useDock((s) => s.open)
  const companyId = useDock((s) => s.companyId)
  const scope = useDock((s) => s.scope)
  const width = useDock((s) => s.width)
  const company = useStore((s) => (companyId ? s.companies.find((c) => c.id === companyId) : undefined))
  const pageCompany = useDock((s) => s.pageCompany)
  const pageScope = useDock((s) => s.pageScope)
  const railCompany = useStore((s) => scopeCompanyId(s) ?? null)
  const ref = useRef<HTMLElement>(null)

  useEffect(() => wireBrowser(), [])

  // switching company or chat (or going to a page of another company) switches the open browser with it, to the tabs
  // of the chat on screen. Only on a change: a link that opened one company's browser on purpose is not overridden.
  const target = pageCompany ?? railCompany
  const targetKey = `${target ?? ''}|${pageScope ?? ''}`
  const lastTarget = useRef(targetKey)
  useEffect(() => {
    if (lastTarget.current === targetKey) return
    lastTarget.current = targetKey
    if (open) followPage(target, pageScope)
  }, [open, target, pageScope, targetKey])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      const typingElsewhere = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) && !ref.current?.contains(t)
      // a sheet or menu on top closes first
      if (typingElsewhere || document.querySelector('.sheet-layer, .palette-layer, [role="dialog"]')) return
      closeBrowser()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // the page keeps a readable width: beside it when there is room, over its right side when not
  const [layout, setLayout] = useState<DockLayout>(() => dockLayout(width, window.innerWidth, 0))
  const sidebarWidth = useRef(0)
  useEffect(() => {
    if (!open) return
    const main = document.querySelector('.main')
    const measure = (): void => {
      // measured with the sidebar in place (a tight layout hides it; its width is remembered)
      const sb = document.querySelector('.sidebar')
      const sbWidth = sb && getComputedStyle(sb).display !== 'none' ? sb.getBoundingClientRect().width : sidebarWidth.current
      if (sb && getComputedStyle(sb).display !== 'none') sidebarWidth.current = sbWidth
      const pageLeft = (main?.getBoundingClientRect().left ?? 0) + (sb && getComputedStyle(sb).display === 'none' ? sbWidth : 0)
      setLayout((old) => {
        const next = dockLayout(width, window.innerWidth, pageLeft, sbWidth)
        return old.mode === next.mode && old.width === next.width ? old : next
      })
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (main) ro.observe(main)
    window.addEventListener('resize', measure)
    document.body.classList.add('has-browser-dock')
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
      document.body.classList.remove('has-browser-dock')
    }
  }, [open, width])
  // a small window: the sidebar steps aside while the browser is open (nothing saved; it is back on close)
  useEffect(() => {
    const tight = open && layout.mode === 'tight'
    document.body.classList.toggle('is-dock-tight', tight)
    return () => document.body.classList.remove('is-dock-tight')
  }, [open, layout.mode])

  if (!open || !companyId) return null

  const startResize = (e: React.PointerEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = layout.width
    const move = (ev: PointerEvent): void => setDockWidth(startW + (startX - ev.clientX))
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('is-resizing-dock')
    }
    document.body.classList.add('is-resizing-dock')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <aside className={`browser-dock is-${layout.mode}`} ref={ref} style={{ width: layout.width }} aria-label={`Browser${company ? ` · ${company.name}` : ''}`}>
      <div className="browser-dock-grip" role="separator" aria-orientation="vertical" aria-label="Resize the browser" onPointerDown={startResize} />
      <BrowserPanel key={`${companyId}|${scope}`} companyId={companyId} scope={scope} companyName={company?.name} onClose={closeBrowser} />
    </aside>
  )
}
