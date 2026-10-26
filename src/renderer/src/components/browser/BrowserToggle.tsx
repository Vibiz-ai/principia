/** BROWSER.md §6: the "Browser" button in a page's toolbar: opens or closes the company browser beside it. */
import { Button } from '../ui'
import { useEffect } from 'react'
import { closeBrowser, openBrowser, setPageCompany, useDock } from '../../state/browser'

export function BrowserToggle({ companyId }: { companyId: string | null | undefined }): React.JSX.Element {
  const open = useDock((s) => s.open && (!companyId || s.companyId === companyId))
  const browsing = useDock((s) => !!(companyId && s.states[companyId]?.activity))
  // the page this button sits on belongs to this company: an open panel follows it
  useEffect(() => {
    setPageCompany(companyId ?? null)
    return () => setPageCompany(null)
  }, [companyId])
  return (
    <Button
      icon="globe"
      variant={open ? 'primary' : 'secondary'}
      className={browsing && !open ? 'is-browsing' : ''}
      aria-pressed={open}
      title={open ? 'Close the browser (Esc)' : "Open this company's browser on the right. Agents use it too, and you can watch and take over."}
      onClick={() => (open ? closeBrowser() : openBrowser({ companyId }))}
    >
      Browser
    </Button>
  )
}
