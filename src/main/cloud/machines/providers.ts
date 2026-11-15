/**
 * docs/MACHINES.md §3: the provider APIs Principia creates machines with. Each is a handful of REST calls over fetch
 * (a seam: tests pass a fake). The token is the user's own and is sent only to its provider's API host.
 */
import { HiveError } from '../../../shared/errors'
import type { MachineOptions, MachineRegion, MachineSize } from '../../../shared/machines'

export interface CreatedServer {
  id: string
  ip: string | null
}
export interface ServerStatus {
  /** 'running' once booted; anything else is still starting (or gone: null) */
  running: boolean
  ip: string | null
}

export interface MachineApi {
  options(): Promise<MachineOptions>
  /** registers this Mac's SSH public key (idempotent) and returns the provider's id for it */
  ensureSshKey(name: string, publicKey: string): Promise<string>
  create(o: { name: string; region: string; size: string; userData: string; sshKeyId: string | null }): Promise<CreatedServer>
  status(id: string): Promise<ServerStatus | null>
  remove(id: string): Promise<void>
}

type Fetch = typeof fetch

/** The provider's own words for a failure, never the request (which may hold the user-data or a key). */
async function fail(provider: string, res: Response): Promise<never> {
  let msg = ''
  try {
    const j = (await res.json()) as { error?: { message?: string; code?: string }; message?: string; id?: string }
    msg = j.error?.message ?? j.message ?? ''
  } catch {
    /* not json */
  }
  const words = msg ? `${provider}: ${msg}` : `${provider} answered ${res.status}.`
  if (res.status === 401) throw new HiveError('forbidden', `${provider} rejected the API token. Make a new one and paste it again.`)
  if (res.status === 403) throw new HiveError('forbidden', `${words} The token needs read and write access.`)
  if (res.status === 404) throw new HiveError('not_found', words)
  if (res.status === 409 || res.status === 422) throw new HiveError('conflict', words)
  if (res.status === 429) throw new HiveError('conflict', `${provider} is rate limiting this token. Try again in a minute.`)
  throw new HiveError('internal', words)
}

function client(provider: string, base: string, token: string, f: Fetch) {
  return async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await f(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000)
      })
    } catch (e) {
      throw new HiveError('internal', `Could not reach ${provider}: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!res.ok) return fail(provider, res)
    if (res.status === 204) return undefined as T
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  }
}

/** "ssh-ed25519 AAAA… comment" → "ssh-ed25519 AAAA…" (providers compare keys without the comment). */
export const keyBody = (k: string): string => k.trim().split(/\s+/).slice(0, 2).join(' ')

/** At least 4 cores and 8 GB is what Claude Code, a build and a browser need side by side; 2/4 is the floor. */
export function pickDefaultSize(sizes: MachineSize[], region: string | null): MachineSize | null {
  const here = sizes.filter((s) => !region || !s.regions.length || s.regions.includes(region))
  const price = (s: MachineSize) => s.monthly?.amount ?? Number.MAX_SAFE_INTEGER
  const fit = (cores: number, mem: number) => here.filter((s) => s.cores >= cores && s.memoryGb >= mem).sort((a, b) => price(a) - price(b))[0]
  return fit(4, 8) ?? fit(2, 4) ?? null
}

// ---------------------------------------------------------------- Hetzner Cloud

interface HzServerType {
  id: number
  name: string
  description: string
  cores: number
  memory: number
  disk: number
  cpu_type: 'shared' | 'dedicated'
  architecture: 'x86' | 'arm'
  deprecated?: boolean | null
  deprecation?: unknown
  prices: { location: string; price_monthly: { gross: string } }[]
}
interface HzServer {
  id: number
  status: string
  public_net: { ipv4: { ip: string } | null }
}

export function hetzner(token: string, f: Fetch = fetch): MachineApi {
  const api = client('Hetzner', 'https://api.hetzner.cloud/v1', token, f)
  return {
    async options() {
      const [{ locations }, { server_types }] = await Promise.all([
        api<{ locations: { name: string; city: string; country: string }[] }>('GET', '/locations'),
        api<{ server_types: HzServerType[] }>('GET', '/server_types?per_page=50')
      ])
      const regions: MachineRegion[] = locations.map((l) => ({ id: l.name, label: `${l.city} (${l.country})` }))
      const sizes: MachineSize[] = server_types
        .filter((t) => t.architecture === 'x86' && !t.deprecated && !t.deprecation && t.prices.length)
        .map((t) => {
          const p = Math.min(...t.prices.map((x) => Number(x.price_monthly.gross)).filter(Number.isFinite))
          return {
            id: t.name,
            label: `${t.name.toUpperCase()} · ${t.cores} vCPU${t.cpu_type === 'dedicated' ? ' dedicated' : ''}, ${t.memory} GB, ${t.disk} GB`,
            cores: t.cores,
            memoryGb: t.memory,
            diskGb: t.disk,
            monthly: Number.isFinite(p) ? { amount: Math.round(p * 100) / 100, currency: 'EUR' } : null,
            regions: t.prices.map((x) => x.location)
          }
        })
      const defaultRegion = regions.find((r) => r.id === 'nbg1')?.id ?? regions[0]?.id ?? null
      return { provider: 'hetzner', regions, sizes, defaultRegion, defaultSize: pickDefaultSize(sizes, defaultRegion)?.id ?? null }
    },
    async ensureSshKey(name, publicKey) {
      const body = keyBody(publicKey)
      const { ssh_keys } = await api<{ ssh_keys: { id: number; public_key: string }[] }>('GET', '/ssh_keys?per_page=50')
      const have = ssh_keys.find((k) => keyBody(k.public_key) === body)
      if (have) return String(have.id)
      const { ssh_key } = await api<{ ssh_key: { id: number } }>('POST', '/ssh_keys', { name, public_key: publicKey.trim(), labels: { principia: 'mac' } })
      return String(ssh_key.id)
    },
    async create(o) {
      const { server } = await api<{ server: HzServer }>('POST', '/servers', {
        name: o.name,
        server_type: o.size,
        location: o.region,
        image: 'ubuntu-24.04',
        user_data: o.userData,
        ssh_keys: o.sshKeyId ? [Number(o.sshKeyId)] : [],
        labels: { principia: 'cloud' },
        public_net: { enable_ipv4: true, enable_ipv6: true },
        start_after_create: true
      })
      return { id: String(server.id), ip: server.public_net.ipv4?.ip ?? null }
    },
    async status(id) {
      try {
        const { server } = await api<{ server: HzServer }>('GET', `/servers/${encodeURIComponent(id)}`)
        return { running: server.status === 'running', ip: server.public_net.ipv4?.ip ?? null }
      } catch (e) {
        if (e instanceof HiveError && e.code === 'not_found') return null
        throw e
      }
    },
    async remove(id) {
      try {
        await api('DELETE', `/servers/${encodeURIComponent(id)}`)
      } catch (e) {
        if (!(e instanceof HiveError && e.code === 'not_found')) throw e
      }
    }
  }
}

// ---------------------------------------------------------------- DigitalOcean

interface DoSize {
  slug: string
  memory: number
  vcpus: number
  disk: number
  price_monthly: number
  available: boolean
  regions: string[]
  description?: string
}
interface DoDroplet {
  id: number
  status: string
  networks: { v4: { ip_address: string; type: 'public' | 'private' }[] }
}

const doIp = (d: DoDroplet): string | null => d.networks?.v4?.find((n) => n.type === 'public')?.ip_address ?? null

export function digitalocean(token: string, f: Fetch = fetch): MachineApi {
  const api = client('DigitalOcean', 'https://api.digitalocean.com/v2', token, f)
  return {
    async options() {
      const [{ regions }, { sizes }] = await Promise.all([
        api<{ regions: { slug: string; name: string; available: boolean }[] }>('GET', '/regions?per_page=200'),
        api<{ sizes: DoSize[] }>('GET', '/sizes?per_page=200')
      ])
      const rs: MachineRegion[] = regions.filter((r) => r.available).map((r) => ({ id: r.slug, label: r.name }))
      const ss: MachineSize[] = sizes
        .filter((s) => s.available && /^s-\d+vcpu-\d+gb(-intel|-amd)?$/.test(s.slug))
        .map((s) => ({
          id: s.slug,
          label: `${s.vcpus} vCPU, ${Math.round(s.memory / 1024)} GB, ${s.disk} GB`,
          cores: s.vcpus,
          memoryGb: Math.round(s.memory / 1024),
          diskGb: s.disk,
          monthly: { amount: s.price_monthly, currency: 'USD' },
          regions: s.regions
        }))
      const defaultRegion = rs.find((r) => r.id === 'nyc3')?.id ?? rs[0]?.id ?? null
      return { provider: 'digitalocean', regions: rs, sizes: ss, defaultRegion, defaultSize: pickDefaultSize(ss, defaultRegion)?.id ?? null }
    },
    async ensureSshKey(name, publicKey) {
      const body = keyBody(publicKey)
      const { ssh_keys } = await api<{ ssh_keys: { id: number; public_key: string }[] }>('GET', '/account/keys?per_page=200')
      const have = ssh_keys.find((k) => keyBody(k.public_key) === body)
      if (have) return String(have.id)
      const { ssh_key } = await api<{ ssh_key: { id: number } }>('POST', '/account/keys', { name, public_key: publicKey.trim() })
      return String(ssh_key.id)
    },
    async create(o) {
      const { droplet } = await api<{ droplet: DoDroplet }>('POST', '/droplets', {
        name: o.name,
        region: o.region,
        size: o.size,
        image: 'ubuntu-24-04-x64',
        user_data: o.userData,
        ssh_keys: o.sshKeyId ? [Number(o.sshKeyId)] : [],
        ipv6: true,
        monitoring: true,
        tags: ['principia']
      })
      return { id: String(droplet.id), ip: doIp(droplet) }
    },
    async status(id) {
      try {
        const { droplet } = await api<{ droplet: DoDroplet }>('GET', `/droplets/${encodeURIComponent(id)}`)
        return { running: droplet.status === 'active', ip: doIp(droplet) }
      } catch (e) {
        if (e instanceof HiveError && e.code === 'not_found') return null
        throw e
      }
    },
    async remove(id) {
      try {
        await api('DELETE', `/droplets/${encodeURIComponent(id)}`)
      } catch (e) {
        if (!(e instanceof HiveError && e.code === 'not_found')) throw e
      }
    }
  }
}
