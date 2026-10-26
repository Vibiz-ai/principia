/**
 * The Phone API client (REMOTE.md RA4): same-origin fetch with the device cookie, and the CSRF header from /api/me on
 * every write. A 401 means this phone is not paired (or was signed out): the app shows how to pair.
 */
import { REMOTE_CSRF_HEADER, remoteRouteMethod, remoteRoutePath, type PhoneMe, type RemoteRouteName } from '../../shared/remote'

export class NotPaired extends Error {
  constructor() {
    super('Open the pairing link from Principia on your Mac.')
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

export function createApi(f: typeof fetch = (...a) => fetch(...a), base = ''): Api {
  let csrf: string | null = null
  const call = async <T>(route: RemoteRouteName, o: { params?: Record<string, string>; query?: Record<string, string | undefined>; body?: unknown } = {}): Promise<T> => {
    const method = remoteRouteMethod(route)
    const q = Object.entries(o.query ?? {}).filter(([, v]) => v !== undefined && v !== '')
    const url = `${base}${remoteRoutePath(route, o.params ?? {})}${q.length ? `?${q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')}` : ''}`
    const write = method !== 'GET'
    if (write && !csrf && route !== 'pair') await me()
    const res = await f(url, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json', ...(write ? { 'content-type': 'application/json', ...(route === 'pair' ? {} : { [REMOTE_CSRF_HEADER]: csrf ?? '' }) } : {}) },
      ...(write ? { body: JSON.stringify(o.body ?? {}) } : {})
    })
    if (res.status === 401) throw new NotPaired()
    const text = await res.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    if (res.status === 403 && write && route !== 'pair') csrf = null
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
