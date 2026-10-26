/**
 * principia:// links reaching main (shared/deepLink.ts is the parser). macOS hands them over through `open-url` (also
 * on a cold launch, before ready); Windows and Linux through the second instance's argv (or this process's own argv on
 * a cold launch). Main only checks the link and forwards its canonical form to the renderer as a `ui:command`, which
 * navigates: a link can never approve, spend, delete or send.
 *
 * Registration as the system handler happens only in a packaged build that uses the real profile: a dev build or a
 * separate instance (HIVE_USER_DATA) never takes the scheme from the installed app. Dev-safe paths: `HIVE_DEEP_LINK`
 * at launch, a second `electron-vite dev` launch of the same profile with the link as its last argument, or the
 * renderer's own in-app clicks (they never leave the window).
 */
import { DEEP_LINK_SCHEME, formatDeepLink, parseDeepLink } from '../shared/deepLink'

/** The principia:// argument of a launch (the last one wins), or null. */
export function deepLinkFromArgv(argv: readonly string[]): string | null {
  for (let i = argv.length - 1; i >= 0; i--) {
    const a = argv[i]
    if (typeof a === 'string' && /^principia:/i.test(a)) return a
  }
  return null
}

/** Whether this process may register itself as the system's principia:// handler. */
export function shouldRegisterProtocol(o: { packaged: boolean; env: NodeJS.ProcessEnv }): boolean {
  return o.packaged && !o.env.HIVE_USER_DATA && o.env.HIVE_SMOKE !== '1' && o.env.HIVE_NO_PROTOCOL !== '1'
}

export interface DeepLinkInboxDeps {
  /** Deliver one checked link (canonical text) to the renderer, showing the window. */
  deliver(url: string): void
  log?: { info(m: string, meta?: Record<string, unknown>): void; warn(m: string, meta?: Record<string, unknown>): void }
}

/** Links that arrive before the app is ready wait here; unknown links are dropped (logged without their text). */
export class DeepLinkInbox {
  private pending: string[] = []
  private deps: DeepLinkInboxDeps | null = null

  /** A link from the OS. Returns the canonical link, or null when it was refused. */
  receive(raw: unknown): string | null {
    const link = parseDeepLink(raw)
    if (!link) {
      this.deps?.log?.warn('deep link refused', { length: typeof raw === 'string' ? raw.length : 0 })
      return null
    }
    const url = formatDeepLink(link)
    if (this.deps) this.deps.deliver(url)
    else if (this.pending.length < 10) this.pending.push(url)
    return url
  }

  /** The app is ready: deliver what waited, in order. */
  attach(deps: DeepLinkInboxDeps): void {
    this.deps = deps
    for (const url of this.pending.splice(0)) deps.deliver(url)
  }
}

export const PROTOCOL = DEEP_LINK_SCHEME
