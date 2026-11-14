import { randomBytes } from 'node:crypto'
import { CapacityError, type AddressInfo, type Compute, type FleetConfig, type InstanceInfo, type MachineRec, type Ports, type Store, type UserRec } from '../src/types'

export class MemStore implements Store {
  users = new Map<string, UserRec>()
  keys = new Map<string, string>()
  machines = new Map<string, MachineRec>()
  async getUser(id: string) { return structuredClone(this.users.get(id) ?? null) }
  async userIdByKeyHash(h: string) { return this.keys.get(h) ?? null }
  async putUser(u: UserRec, old: string | null) {
    if (old) this.keys.delete(old)
    this.keys.set(u.keyHash, u.id)
    this.users.set(u.id, structuredClone(u))
  }
  async getMachine(uid: string) { return structuredClone(this.machines.get(uid) ?? null) }
  async userIdByMachineTokenHash(h: string) { return [...this.machines.values()].find(m => m.machineTokenHash === h)?.userId ?? null }
  async putMachine(m: MachineRec, expected: number | null) {
    const cur = this.machines.get(m.userId)
    if (expected === null ? !!cur : cur?.rev !== expected) return false
    this.machines.set(m.userId, structuredClone(m))
    return true
  }
  async deleteMachine(m: MachineRec) { return this.machines.delete(m.userId) }
  async listMachines() { return [...this.machines.values()].map(m => structuredClone(m)) }
}

export class FakeCompute implements Compute {
  instances = new Map<string, InstanceInfo>()
  addresses = new Map<string, AddressInfo>()
  calls: string[] = []
  /** instance types with no capacity (launch and start) */
  noRoom = new Set<string>()
  console = ''
  private n = 0
  constructor(private now: () => Date) {}
  async allocateAddress(machineId: string) {
    const id = `eipalloc-${++this.n}`
    const ip = `3.0.0.${this.n}`
    this.addresses.set(id, { allocationId: id, ip, machineId, instanceId: null, createdAt: this.now().toISOString() })
    this.calls.push(`allocate ${id}`)
    return { allocationId: id, ip }
  }
  async releaseAddress(id: string) {
    const a = this.addresses.get(id)
    if (a?.instanceId && this.instances.get(a.instanceId)?.state !== 'terminated') throw new Error('InvalidIPAddress.InUse')
    this.addresses.delete(id)
    this.calls.push(`release ${id}`)
  }
  async associateAddress(id: string, instanceId: string) {
    const a = this.addresses.get(id)!
    a.instanceId = instanceId
    this.instances.get(instanceId)!.publicIp = a.ip
    this.calls.push(`associate ${id} ${instanceId}`)
  }
  async launch(o: { machineId: string; name: string; instanceType: string; userData: string }) {
    if (this.noRoom.has(o.instanceType)) throw new CapacityError('InsufficientInstanceCapacity')
    const id = `i-${++this.n}`
    this.instances.set(id, { instanceId: id, state: 'pending', publicIp: '54.0.0.9', instanceType: o.instanceType, machineId: o.machineId, launchedAt: this.now().toISOString() })
    this.calls.push(`launch ${id} ${o.instanceType}`)
    this.lastUserData = o.userData
    return { instanceId: id }
  }
  lastUserData = ''
  async describe(ids: string[]) {
    const m = new Map<string, InstanceInfo>()
    for (const id of ids) { const i = this.instances.get(id); if (i) m.set(id, { ...i }) }
    return m
  }
  async listTagged() { return { instances: [...this.instances.values()].map(i => ({ ...i })), addresses: [...this.addresses.values()].map(a => ({ ...a })) } }
  async start(id: string) {
    const i = this.instances.get(id)!
    if (this.noRoom.has(i.instanceType)) throw new CapacityError('InsufficientInstanceCapacity')
    i.state = 'pending'
    this.calls.push(`start ${id}`)
  }
  async stop(id: string) { this.instances.get(id)!.state = 'stopping'; this.calls.push(`stop ${id}`) }
  async terminate(id: string) {
    const i = this.instances.get(id)
    if (i) { i.state = 'terminated'; for (const a of this.addresses.values()) if (a.instanceId === id) a.instanceId = null }
    this.calls.push(`terminate ${id}`)
  }
  async setInstanceType(id: string, t: string) { this.instances.get(id)!.instanceType = t; this.calls.push(`type ${id} ${t}`) }
  async consoleTail() { return this.console }
  /** AWS moves on: pending → running, stopping → stopped */
  settle() { for (const i of this.instances.values()) { if (i.state === 'pending') i.state = 'running'; if (i.state === 'stopping') i.state = 'stopped' } }
}

export const CONFIG: FleetConfig = {
  publicUrl: 'https://fleet.example.com',
  maxMachines: 3,
  maxHoursPerMonth: 100,
  idleMinutes: 20,
  firstBootMinutes: 30,
  wakeMinutes: 10,
  instanceTypes: ['t4g.large', 'm7g.large'],
  allowUsers: ['lautaro'],
  allowOrgs: ['vibiz-ai'],
  open: false
}

export function world(over: Partial<FleetConfig> = {}) {
  const clock = { t: new Date('2026-11-14T10:00:00.000Z') }
  const now = () => new Date(clock.t)
  const store = new MemStore()
  const compute = new FakeCompute(now)
  const logs: string[] = []
  const users: Record<string, { id: string; login: string; orgs: string[] }> = {
    'gho_lautaro_0123456789abcdef': { id: '1', login: 'lautaro', orgs: [] },
    'gho_friend_0123456789abcdefg': { id: '2', login: 'friend', orgs: ['Vibiz-ai'] },
    'gho_stranger_0123456789abcde': { id: '3', login: 'stranger', orgs: ['other'] }
  }
  const ports: Ports = {
    store, compute, config: { ...CONFIG, ...over },
    github: {
      async user(t) { const u = users[t]; if (!u) throw new Error('401'); return { id: u.id, login: u.login } },
      async orgs(t) { return users[t]?.orgs ?? [] }
    },
    userData: (o) => `#!/bin/bash\n# host=${o.host} admin=${o.adminTokenSha256} token=${o.machineToken}\n`,
    now,
    random: (n) => randomBytes(n).toString('base64url'),
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) }
  }
  const advance = (min: number) => { clock.t = new Date(clock.t.getTime() + min * 60_000) }
  return { ports, store, compute, clock, advance, logs }
}
