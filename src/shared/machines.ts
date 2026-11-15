/**
 * docs/MACHINES.md: a cloud machine Principia creates for you. One click on the Mac makes a server at a provider
 * (Hetzner, DigitalOcean) or installs on one you already have (SSH), installs Principia Cloud on it with its own https
 * address, pairs this Mac, and signs it in with the accounts you choose (GitHub, Shared keys, Claude, Codex). Agents
 * then run there in the sandbox, signed in, with the tools they need.
 *
 * The default is 'principia' (docs/FLEET.md): Principia runs the machine on its own AWS account, wakes it when you use it
 * and stops it when it is idle. You only click "Turn on cloud". The others are under "Use my own".
 *
 * Nothing secret ever reaches the renderer: the provider token, the fleet key and the one-time admin token stay in
 * main (safeStorage).
 */

export const MACHINE_PROVIDERS = ['principia', 'hetzner', 'digitalocean', 'ssh'] as const
export type MachineProvider = (typeof MACHINE_PROVIDERS)[number]
/** the providers whose API this Mac calls with your token */
export type ApiProvider = 'hetzner' | 'digitalocean'

/**
 * The managed fleet's address (fleet/, docs/FLEET.md). null: not deployed for this build, and the app offers only
 * your own provider or server. PRINCIPIA_FLEET_URL in the app's environment overrides it.
 */
export const FLEET_URL: string | null = 'https://iidiv5cyyd6dvedragk4kux7240eakjh.lambda-url.us-east-2.on.aws'

export const MACHINE_PROVIDER_INFO: Record<MachineProvider, { label: string; tokenUrl: string | null; tokenHint: string | null; note: string }> = {
  principia: {
    label: 'Principia Cloud',
    tokenUrl: null,
    tokenHint: null,
    note: 'We run it for you. It sleeps when nothing is running and wakes when you start something.'
  },
  hetzner: {
    label: 'Hetzner Cloud',
    tokenUrl: 'https://console.hetzner.cloud/projects',
    tokenHint: 'Project › Security › API tokens › Generate (Read & Write)',
    note: 'Cheapest. A 4 vCPU, 8 GB machine is about €8–10 a month, billed by the hour.'
  },
  digitalocean: {
    label: 'DigitalOcean',
    tokenUrl: 'https://cloud.digitalocean.com/account/api/tokens',
    tokenHint: 'API › Generate New Token (Full Access, or droplet, ssh_key, regions and sizes scopes)',
    note: 'A 4 vCPU, 8 GB droplet is about $48 a month, billed by the hour.'
  },
  ssh: {
    label: 'My own server',
    tokenUrl: null,
    tokenHint: null,
    note: 'Any Ubuntu or Debian server with a public IP that this Mac can reach over SSH as root (or with sudo).'
  }
}

export interface MachineRegion {
  id: string
  label: string
}

export interface MachineSize {
  id: string
  label: string
  cores: number
  memoryGb: number
  diskGb: number
  /** what the provider says a month costs, in its currency, or null when it does not say */
  monthly: { amount: number; currency: string } | null
  /** the regions this size is offered in ([] = all) */
  regions: string[]
}

export interface MachineOptions {
  provider: ApiProvider
  regions: MachineRegion[]
  sizes: MachineSize[]
  defaultRegion: string | null
  defaultSize: string | null
}

/** What the new cloud is signed in with once it is up (docs/ACCOUNTS.md). */
export interface MachineBring {
  /** this Mac's `gh` sign-in */
  github: boolean
  /** the Shared keys marked "In the cloud" */
  keys: boolean
  /** a Claude sign-in made just for the cloud (opens the browser once) */
  claude: boolean
  /** a ChatGPT sign-in for Codex made just for the cloud (opens the browser once) */
  codex: boolean
}

export interface CreateMachineRequest {
  provider: MachineProvider
  /** the provider's API token (hetzner, digitalocean). Kept on this Mac, encrypted, to delete the machine later. */
  token?: string
  region?: string
  size?: string
  /** provider 'ssh' */
  ssh?: { host: string; user?: string; port?: number }
  bring: MachineBring
}

export const MACHINE_PHASES = ['creating', 'booting', 'installing', 'pairing', 'signing-in', 'ready', 'failed'] as const
export type MachinePhase = (typeof MACHINE_PHASES)[number]

export const MACHINE_PHASE_LABEL: Record<MachinePhase, string> = {
  creating: 'Creating the machine',
  booting: 'Starting it',
  installing: 'Installing Principia Cloud',
  pairing: 'Connecting this Mac',
  'signing-in': 'Signing it in',
  ready: 'Ready',
  failed: 'Stopped'
}

/** The machine as the renderer sees it: no token, no admin token. */
export interface MachineView {
  provider: MachineProvider
  name: string
  serverId: string | null
  ip: string | null
  /** https://<ip>.sslip.io */
  url: string | null
  region: string | null
  size: string | null
  createdAt: string
  phase: MachinePhase
  /** the phase where it stopped, when phase is 'failed' */
  failedAt: MachinePhase | null
  detail: string | null
  error: string | null
  bring: MachineBring
  /** steps of the sign-in phase that need you (e.g. "Connect Claude"), or that failed */
  notes: string[]
  /** 'published' (pulled the image) or 'source' (built on the machine) once known */
  install: 'published' | 'source' | null
  /** managed machines only: awake, asleep (stopped to save money) or waking; null for the others */
  power?: MachinePower | null
  /** managed machines only: why it sleeps, when it wakes on its own, and this month's awake hours */
  sleep?: { reason: string | null; wakeAt: string | null; idleMinutes: number } | null
  usage?: { month: string; hours: number; limitHours: number } | null
}

export type MachinePower = 'awake' | 'asleep' | 'waking'

/** What this Mac can offer: the managed cloud when the fleet is there, and who it signs in as. */
export interface MachineInfo {
  managed: boolean
  /** the GitHub login this Mac's gh is signed in as, or null */
  github: string | null
}

/** sslip.io name for an IPv4 address: 1.2.3.4 → 1-2-3-4.sslip.io (dashes: each address is its own registrable name). */
export function sslipHost(ip: string): string {
  return `${ip.trim().replace(/\./g, '-')}.sslip.io`
}

export const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

/** Private, loopback, CGNAT (Tailscale) and link-local IPv4: no public certificate can be issued for these. */
export function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number]
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
}
