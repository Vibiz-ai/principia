/**
 * The managed fleet (docs/FLEET.md): Principia runs one cloud machine per person on its own AWS account, wakes it when
 * it is needed and stops it when it is idle. The core (core.ts) is pure over these ports, so every rule is tested
 * without AWS; aws.ts implements them with the AWS SDK.
 */

export type MachineState = 'creating' | 'starting' | 'running' | 'stopping' | 'sleeping' | 'failed' | 'deleting'

/** What the control plane reports through the host heartbeat (src/cloud/control/activity.ts). */
export interface Activity {
  busy: boolean
  running: number
  queued: number
  lastActivityAt: string | null
  nextScheduleAt: string | null
  at: string
}

export interface UserRec {
  /** GitHub's numeric user id, as a string */
  id: string
  login: string
  allowed: boolean
  /** sha256 of the current fleet key (the Mac's credential) */
  keyHash: string
  createdAt: string
  lastSeenAt: string
  /** awake time of machines this person deleted this month: a new machine starts from it, so delete + make doesn't reset the cap */
  usage?: { month: string; awakeSeconds: number }
  /** docs/CLOUD-PHONE.md: sha256 of each paired phone's wake token (it can only wake this machine and read its state), newest last */
  phoneWakeHashes?: string[]
}

export interface MachineRec {
  id: string
  userId: string
  login: string
  state: MachineState
  instanceId: string | null
  instanceType: string
  allocationId: string | null
  ip: string | null
  host: string | null
  machineTokenHash: string
  createdAt: string
  updatedAt: string
  /** set when the instance last started (create or wake); null while stopped */
  awakeSince: string | null
  /** the first boot gets longer to come up than a wake */
  firstBoot: boolean
  lastWakeAt: string | null
  /** a wake asked for while it was stopping: start once stopped */
  wakeRequested: boolean
  /** a sleeping machine is started at this time (its next cloud schedule, a little early) */
  wakeAt: string | null
  lastHeartbeatAt: string | null
  up: boolean
  activity: Activity | null
  /** accounting: YYYY-MM and the seconds awake in it */
  month: string
  awakeSeconds: number
  lastTickAt: string | null
  error: string | null
  /** why it went to sleep last (idle, limit, broken heartbeat) */
  sleepReason: string | null
  /** optimistic concurrency: every write checks and bumps it */
  rev: number
}

/** The machine as the Mac sees it: no ids it can't use, nothing secret. */
export interface MachineView {
  id: string
  state: MachineState
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

export interface FleetConfig {
  /** the fleet's own public URL (heartbeats go to <url>/v1/heartbeat) */
  publicUrl: string
  /** machines across everyone: the hard cap on what the fleet can spend */
  maxMachines: number
  /** awake hours per person per calendar month (UTC) */
  maxHoursPerMonth: number
  /** no run and no change for this long: stop */
  idleMinutes: number
  /** a first boot (or a wake) that hasn't reported "up" by then is stopped and marked failed */
  firstBootMinutes: number
  wakeMinutes: number
  /** tried in order: the first is the default, the others are for when AWS has no capacity */
  instanceTypes: string[]
  /** who may have a machine: GitHub logins, members of GitHub orgs, or everyone */
  allowUsers: string[]
  allowOrgs: string[]
  open: boolean
}

export interface InstanceInfo {
  instanceId: string
  state: 'pending' | 'running' | 'stopping' | 'stopped' | 'shutting-down' | 'terminated'
  publicIp: string | null
  instanceType: string
  machineId: string | null
  launchedAt: string | null
}

export interface AddressInfo {
  allocationId: string
  ip: string
  machineId: string | null
  instanceId: string | null
  /** from the fleet's own tag: when it was allocated */
  createdAt: string | null
}

export interface Store {
  getUser(id: string): Promise<UserRec | null>
  userIdByKeyHash(hash: string): Promise<string | null>
  /** writes the user and moves the key index from `oldKeyHash` to the user's current key */
  putUser(u: UserRec, oldKeyHash: string | null): Promise<void>
  getMachine(userId: string): Promise<MachineRec | null>
  userIdByMachineTokenHash(hash: string): Promise<string | null>
  /** conditional on `expectedRev`; false when someone else wrote first */
  putMachine(m: MachineRec, expectedRev: number): Promise<boolean>
  /**
   * A new machine, in one transaction with the fleet-wide count: 'full' when `maxMachines` are already counted,
   * 'exists' when this person has one. Concurrent creates can never pass the cap together.
   */
  insertMachine(m: MachineRec, maxMachines: number): Promise<'ok' | 'exists' | 'full'>
  /** conditional on its `rev`, and gives its slot in the fleet-wide count back */
  deleteMachine(m: MachineRec): Promise<boolean>
  listMachines(): Promise<MachineRec[]>
}

export class CapacityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CapacityError'
  }
}

export interface Compute {
  allocateAddress(machineId: string): Promise<{ allocationId: string; ip: string }>
  releaseAddress(allocationId: string): Promise<void>
  associateAddress(allocationId: string, instanceId: string): Promise<void>
  /** throws CapacityError when no subnet has room for this type */
  launch(o: { machineId: string; name: string; instanceType: string; userData: string }): Promise<{ instanceId: string }>
  describe(instanceIds: string[]): Promise<Map<string, InstanceInfo>>
  /** every instance and address the fleet tagged, to find orphans */
  listTagged(): Promise<{ instances: InstanceInfo[]; addresses: AddressInfo[] }>
  /** throws CapacityError when the instance's zone has no room for its type */
  start(instanceId: string): Promise<void>
  stop(instanceId: string): Promise<void>
  terminate(instanceId: string): Promise<void>
  setInstanceType(instanceId: string, instanceType: string): Promise<void>
  /** the tail of the serial console, for a machine that didn't come up */
  consoleTail(instanceId: string): Promise<string>
}

export interface GitHub {
  user(token: string): Promise<{ id: string; login: string }>
  orgs(token: string): Promise<string[]>
}

export interface Ports {
  store: Store
  compute: Compute
  github: GitHub
  config: FleetConfig
  /** the first-boot script for a machine (configureScript with its fleet heartbeat) */
  userData(o: { host: string; adminTokenSha256: string; workspaceName: string; machineToken: string }): string
  now(): Date
  random(bytes: number): string
  /**
   * docs/FLEET.md §10: the Principia Cloud image every machine should run (a published ghcr.io tag). A machine's
   * heartbeat gets it back and the machine moves to it when nothing runs. null: leave machines as they are.
   */
  cloudImage?(): Promise<string | null>
  log: { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void }
}

export interface Req {
  method: string
  path: string
  headers: Record<string, string | undefined>
  body: string | null
}
export interface Res {
  status: number
  body: unknown
}
