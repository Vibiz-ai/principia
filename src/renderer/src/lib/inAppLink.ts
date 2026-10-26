/**
 * Links inside agent text (chat, the agent desk, the Forum, Knowledge notes): principia:// opens the page in the app
 * (the store listens for DEEP_LINK_EVENT and navigates; it never runs an action), http(s) opens the browser.
 */
import { isDeepLinkUrl } from '@shared/deepLink'
import { hive } from './hive'

export const DEEP_LINK_EVENT = 'principia:link'

export function followLink(href: string): void {
  if (isDeepLinkUrl(href)) {
    window.dispatchEvent(new CustomEvent(DEEP_LINK_EVENT, { detail: href }))
    return
  }
  if (/^https?:|^mailto:/i.test(href)) void hive.app.openExternal({ url: href }).catch(() => undefined)
}
