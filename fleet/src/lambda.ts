/**
 * The fleet on AWS Lambda (docs/FLEET.md §3): `http` answers the function URL (the Mac and the machines), `tick`
 * runs the reconciler every minute (EventBridge). Configuration is the environment the stack sets.
 */
import { randomBytes } from 'node:crypto'
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda'
import { configureScript } from '../../src/main/cloud/machines/bootstrap'
import { dynamoStore, ec2Compute, githubApi } from './aws'
import { api, reconcile } from './core'
import type { FleetConfig, Ports } from './types'

const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d
  if (v === undefined) throw new Error(`${k} is not set`)
  return v
}
const list = (k: string): string[] => (process.env[k] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const num = (k: string, d: number): number => {
  const n = Number(process.env[k])
  return Number.isFinite(n) && n > 0 ? n : d
}

const log = {
  info: (msg: string, meta?: Record<string, unknown>) => console.log(JSON.stringify({ level: 'info', msg, ...meta })),
  warn: (msg: string, meta?: Record<string, unknown>) => console.warn(JSON.stringify({ level: 'warn', msg, ...meta }))
}

let cached: Omit<Ports, 'config' | 'userData'> | null = null
function base(): Omit<Ports, 'config' | 'userData'> {
  cached ??= {
    store: dynamoStore(env('FLEET_TABLE')),
    compute: ec2Compute({ launchTemplateId: env('FLEET_LAUNCH_TEMPLATE_ID'), subnetIds: list('FLEET_SUBNET_IDS'), amiParameter: env('FLEET_AMI_PARAMETER') }),
    github: githubApi(),
    now: () => new Date(),
    random: (n) => randomBytes(n).toString('base64url'),
    log
  }
  return cached
}

export function ports(publicUrl: string): Ports {
  const config: FleetConfig = {
    publicUrl: (process.env.FLEET_PUBLIC_URL || publicUrl).replace(/\/+$/, ''),
    maxMachines: num('FLEET_MAX_MACHINES', 25),
    maxHoursPerMonth: num('FLEET_MAX_HOURS_PER_MONTH', 200),
    idleMinutes: num('FLEET_IDLE_MINUTES', 20),
    firstBootMinutes: num('FLEET_FIRST_BOOT_MINUTES', 20),
    wakeMinutes: num('FLEET_WAKE_MINUTES', 8),
    instanceTypes: list('FLEET_INSTANCE_TYPES').length ? list('FLEET_INSTANCE_TYPES') : ['t4g.large', 'm7g.large', 't4g.xlarge'],
    allowUsers: list('FLEET_ALLOW_USERS'),
    allowOrgs: list('FLEET_ALLOW_ORGS'),
    open: process.env.FLEET_OPEN === 'true'
  }
  return {
    ...base(),
    config,
    userData: (o) =>
      configureScript({
        domain: o.host,
        adminTokenSha256: o.adminTokenSha256,
        workspaceName: o.workspaceName,
        fleet: { url: config.publicUrl, machineToken: o.machineToken }
      })
  }
}

export async function http(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : null
  const handle = api(ports(`https://${event.requestContext.domainName}`))
  const r = await handle({ method: event.requestContext.http.method, path: event.rawPath, headers: event.headers ?? {}, body })
  return { statusCode: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(r.body) }
}

export async function tick(): Promise<void> {
  const report = await reconcile(ports(process.env.FLEET_PUBLIC_URL || 'https://unused.invalid'))
  log.info('fleet: tick', { ...report })
}
