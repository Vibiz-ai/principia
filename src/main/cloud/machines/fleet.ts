/**
 * docs/FLEET.md: the Mac's client for the managed fleet (fleet/src/core.ts). The fleet key is this Mac's credential
 * there; it comes from enroll (GitHub sign-in, which the fleet uses once and never keeps) and stays in main,
 * encrypted. Errors come back as HiveErrors with the fleet's own plain sentence.
 */
import { HiveError } from '../../../shared/errors'
import type { HiveErrorCode } from '../../../shared/types'

export interface FleetMachine {
  id: string
  state: 'creating' | 'starting' | 'running' | 'stopping' | 'sleeping' | 'failed' | 'deleting'
  host: string | null
  url: string | null
  instanceType: string
  createdAt: string
  error: string | null
  wakeAt: string | null
  sleepReason: string | null
  usage: { month: string; hours: number; limitHours: number }
  idleMinutes: number
}

export interface FleetClient {
  enroll(githubToken: string): Promise<{ key: string; login: string; allowed: boolean }>
  machine(key: string): Promise<{ login: string; allowed: boolean; machine: FleetMachine | null }>
  create(key: string, b: { adminTokenSha256: string; workspaceName: string }): Promise<FleetMachine>
  wake(key: string): Promise<FleetMachine>
  remove(key: string): Promise<void>
  /** docs/CLOUD-PHONE.md: a token the phone uses to wake this machine (and nothing else) */
  phoneWake(key: string): Promise<{ url: string; token: string }>
}

const CODE: Record<number, HiveErrorCode> = { 400: 'bad_request', 401: 'forbidden', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 429: 'conflict', 503: 'conflict' }

export class FleetRequestError extends HiveError {
  constructor(
    readonly status: number,
    readonly fleetCode: string,
    message: string
  ) {
    super(CODE[status] ?? 'internal', message)
  }
}

export function fleetClient(url: string, f: typeof fetch = fetch): FleetClient {
  const base = url.replace(/\/+$/, '')
  async function call<T>(method: string, path: string, key: string | null, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await f(`${base}${path}`, {
        method,
        headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(45_000)
      })
    } catch (e) {
      throw new FleetRequestError(0, 'network', `Can't reach Principia Cloud: ${e instanceof Error ? e.message : String(e)}`)
    }
    const text = await res.text().catch(() => '')
    let j: Record<string, unknown> = {}
    try {
      j = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    } catch {
      /* not json */
    }
    if (!res.ok) throw new FleetRequestError(res.status, typeof j.error === 'string' ? j.error : 'error', typeof j.message === 'string' ? j.message.slice(0, 400) : `Principia Cloud answered ${res.status}.`)
    return j as T
  }
  return {
    enroll: (githubToken) => call('POST', '/v1/enroll', null, { githubToken }),
    machine: (key) => call('GET', '/v1/machine', key),
    create: (key, b) => call('POST', '/v1/machine', key, b),
    wake: (key) => call('POST', '/v1/machine/wake', key, {}),
    remove: async (key) => void (await call('DELETE', '/v1/machine', key)),
    phoneWake: (key) => call('POST', '/v1/phone-wake', key, {})
  }
}
