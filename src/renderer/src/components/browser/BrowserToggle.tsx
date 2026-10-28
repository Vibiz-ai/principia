/**
 * BROWSER.md §6: the "Browser" button in a page's toolbar: opens or closes the company browser beside it, on the tabs
 * of this chat or task (`scope`). A page with no scope shows the founder's own tabs.
 */
import { Button } from '../ui'
import { useEffect } from 'react'
import { FOUNDER_SCOPE, type BrowserScope } from '@shared/browser'
import { closeBrowser, openBrowser, setPageCompany, stateOf, useDock } from '../../state/browser'

export function BrowserToggle({ companyId, scope }: { companyId: string | null | undefined; scope?: BrowserScope | null }): React.JSX.Element {
  const own = scope ?? FOUNDER_SCOPE
  const open = useDock((s) => s.open && (!companyId || s.companyId === companyId) && s.scope === own)
  const browsing = useDock((s) => !!stateOf(s, companyId, own)?.activity)
  // the page this button sits on belongs to this company and chat: an open panel follows it
  useEffect(() => {
    setPageCompany(companyId ?? null, scope ?? null)
    return () => setPageCompany(null, null)
  }, [companyId, scope])
  return (
    <Button
      icon="globe"
      variant={open ? 'primary' : 'secondary'}
      className={browsing && !open ? 'is-browsing' : ''}
      aria-pressed={open}
      title={open ? 'Close the browser (Esc)' : scope ? "Open this chat's browser tabs on the right. Its agents browse there; you can watch and take over." : "Open this company's browser on the right. Agents use it too, and you can watch and take over."}
      onClick={() => (open ? closeBrowser() : openBrowser({ companyId, scope: own }))}
    >
      Browser
    </Button>
  )
}
