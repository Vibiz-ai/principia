/**
 * The Phone API client (REMOTE.md RA4, RA6). Two ways to reach the Mac:
 * - same-origin (the Mac serves this app): fetch with the device cookie, and the CSRF header from /api/me on every write;
 * - hosted (this app on its own https site): fetch to the Mac's address with `Authorization: Bearer <token>`, no
 *   cookies at all (`credentials: 'omit'`), no CSRF. The token rides in a header only, never in a URL.
 * A 401 means this phone is not paired (or was signed out): the app shows how to pair. A network failure in hosted mode
 * means the Mac's address is gone (the tunnel stopped, or Phone was turned off): the app asks to scan again.
 */
import { REMOTE_AUTH_SCHEME, REMOTE_CSRF_HEADER, remoteRouteMethod, remoteRoutePath, type PhoneMe, type RemoteRouteName } from '../../shared/remote'

export class NotPaired extends Error {
  constructor() {
    super('Open the pairing link from Principia on your Mac.')
  }
}
/** hosted mode: the Mac's address did not answer at all */
export class MacGone extends Error {
  constructor() {
    super('Your Mac is not reachable at its last address.')
  }
}
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

export interface Api {
  me(): Promise<PhoneMe>
  call<T>(route: RemoteRouteName, o?: { params?: Record<string, string>; query?: Record<string, string | undefined>; body?: unknown }): Promise<T>
}

export interface ApiTarget {
  /** '' = same origin, else the Mac's origin (hosted) */
  base(): string
  /** the device token in hosted mode, else null (the cookie does it) */
  token(): string | null
}
const SAME: ApiTarget = { base: () => '', token: () => null }

export function createApi(f: typeof fetch = (...a) => fetch(...a), target: ApiTarget = SAME): Api {
  let csrf: string | null = null
  const call = async <T>(route: RemoteRouteName, o: { params?: Record<string, string>; query?: Record<string, string | undefined>; body?: unknown } = {}): Promise<T> => {
    const method = remoteRouteMethod(route)
    const base = target.base()
    const token = base ? target.token() : null
    const q = Object.entries(o.query ?? {}).filter(([, v]) => v !== undefined && v !== '')
    const url = `${base}${remoteRoutePath(route, o.params ?? {})}${q.length ? `?${q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')}` : ''}`
    const write = method !== 'GET'
    const bearer = !!token
    if (write && !bearer && !base && !csrf && route !== 'pair') await me()
    const headers: Record<string, string> = { accept: 'application/json' }
    if (write) headers['content-type'] = 'application/json'
    if (bearer && route !== 'pair') headers.authorization = `${REMOTE_AUTH_SCHEME} ${token}`
    else if (write && !base && route !== 'pair') headers[REMOTE_CSRF_HEADER] = csrf ?? ''
    let res: Response
    try {
      res = await f(url, {
        method,
        // hosted: never a cookie across origins (Safari blocks them anyway); same-origin: the httpOnly device cookie
        credentials: base ? 'omit' : 'same-origin',
        mode: base ? 'cors' : 'same-origin',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers,
        ...(write ? { body: JSON.stringify(o.body ?? {}) } : {})
      })
    } catch (e) {
      if (base) throw new MacGone()
      throw e
    }
    if (res.status === 401) throw new NotPaired()
    const text = await res.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    if (res.status === 403 && write && route !== 'pair') csrf = null
    // a quick tunnel that is gone answers from Cloudflare's edge (HTML, 5xx): the Mac is not there
    if (base && res.status >= 500 && (typeof body !== 'object' || body === null)) throw new MacGone()
    if (!res.ok) throw new ApiError((body as { message?: string } | null)?.message ?? `The Mac answered ${res.status}.`, res.status)
    return body as T
  }
  const me = async (): Promise<PhoneMe> => {
    const r = await call<PhoneMe>('me')
    csrf = r.csrf
    return r
  }
  return { me, call }
}
