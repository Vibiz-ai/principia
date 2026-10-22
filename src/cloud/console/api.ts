/**
 * Console API (docs/CLOUD.md §5): same-origin fetch with the session cookie, and the CSRF header from GET /v1/me on
 * every write. A 401 means there is no session: the console asks to open it from Principia on the Mac.
 */
import { CSRF_HEADER, routeMethod, routePath, type CloudRouteName, type MeResponse } from '../../shared/cloud'

export class SignedOut extends Error {
  constructor() {
    super('Open the console from Principia on your Mac to sign in.')
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
  me(): Promise<MeResponse>
  call<T>(route: CloudRouteName, o?: { params?: Record<string, string>; query?: Record<string, string | number | undefined>; body?: unknown }): Promise<T>
}

export function createApi(f: typeof fetch = (...a) => fetch(...a), base = ''): Api {
  let csrf: string | null = null
  const call = async <T>(route: CloudRouteName, o: { params?: Record<string, string>; query?: Record<string, string | number | undefined>; body?: unknown } = {}): Promise<T> => {
    const method = routeMethod(route)
    const q = Object.entries(o.query ?? {}).filter(([, v]) => v !== undefined && v !== '')
    const url = `${base}${routePath(route, o.params ?? {})}${q.length ? `?${q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')}` : ''}`
    const write = method !== 'GET'
    if (write && !csrf) await me()
    const res = await f(url, {
      method,
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(write ? { 'content-type': 'application/json', [CSRF_HEADER]: csrf ?? '' } : {}) },
      ...(write ? { body: JSON.stringify(o.body ?? {}) } : {})
    })
    if (res.status === 401) throw new SignedOut()
    const text = await res.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    if (!res.ok) throw new ApiError((body as { message?: string } | null)?.message ?? `The cloud answered ${res.status}.`, res.status)
    return body as T
  }
  const me = async (): Promise<MeResponse> => {
    const r = await call<MeResponse>('me')
    csrf = r.csrf
    return r
  }
  return { me, call }
}
