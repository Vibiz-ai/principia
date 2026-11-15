/**
 * The fleet's ports on AWS (docs/FLEET.md §3): DynamoDB for the records, EC2 for machines and their fixed addresses,
 * SSM for the current machine image, and GitHub for sign-in. Everything the fleet makes carries the tag
 * `principia-fleet`, which is also what its IAM policy is scoped to.
 */
import {
  AllocateAddressCommand,
  AssociateAddressCommand,
  DescribeAddressesCommand,
  DescribeInstancesCommand,
  EC2Client,
  GetConsoleOutputCommand,
  ModifyInstanceAttributeCommand,
  ReleaseAddressCommand,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
  type Instance
} from '@aws-sdk/client-ec2'
import { ConditionalCheckFailedException, DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb'
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import { CapacityError, type AddressInfo, type Compute, type GitHub, type InstanceInfo, type MachineRec, type Store, type UserRec } from './types'

export const TAG = 'principia-fleet'
export const TAG_MACHINE = 'principia-fleet:machine'
export const TAG_CREATED = 'principia-fleet:created'

// ---------------------------------------------------------------- DynamoDB

/**
 * One table, keyed by `pk`:
 *   user#<githubId>      the person (UserRec)
 *   key#<sha256>         → userId, the Mac's fleet key
 *   machine#<userId>     the machine (MachineRec), written only when its rev matches
 *   mtok#<sha256>        → userId, the machine's heartbeat token
 * The two indexes are only hints: core.ts checks every token against the record itself.
 */
/** the fleet-wide machine count: changed only in the same transaction as a machine record (insertMachine, deleteMachine) */
const COUNT_PK = 'fleet#machines'

export function dynamoStore(table: string, client = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } })): Store {
  const get = async <T>(pk: string): Promise<T | null> => ((await client.send(new GetCommand({ TableName: table, Key: { pk }, ConsistentRead: true }))).Item as T | undefined) ?? null
  const strip = <T>(item: (T & { pk?: string }) | null): T | null => {
    if (!item) return null
    const { pk: _pk, ...rest } = item
    return rest as T
  }
  return {
    getUser: async (id) => strip(await get<UserRec & { pk: string }>(`user#${id}`)),
    userIdByKeyHash: async (h) => (await get<{ userId: string }>(`key#${h}`))?.userId ?? null,
    async putUser(u, oldKeyHash) {
      await client.send(new PutCommand({ TableName: table, Item: { pk: `user#${u.id}`, ...u } }))
      await client.send(new PutCommand({ TableName: table, Item: { pk: `key#${u.keyHash}`, userId: u.id } }))
      if (oldKeyHash && oldKeyHash !== u.keyHash) await client.send(new DeleteCommand({ TableName: table, Key: { pk: `key#${oldKeyHash}` } }))
    },
    getMachine: async (uid) => strip(await get<MachineRec & { pk: string }>(`machine#${uid}`)),
    userIdByMachineTokenHash: async (h) => (await get<{ userId: string }>(`mtok#${h}`))?.userId ?? null,
    async putMachine(m, expectedRev) {
      const prev = await get<MachineRec>(`machine#${m.userId}`)
      try {
        await client.send(
          new PutCommand({
            TableName: table,
            Item: { pk: `machine#${m.userId}`, ...m },
            ConditionExpression: '#rev = :rev',
            ExpressionAttributeNames: { '#rev': 'rev' },
            ExpressionAttributeValues: { ':rev': expectedRev }
          })
        )
      } catch (e) {
        if (e instanceof ConditionalCheckFailedException) return false
        throw e
      }
      if (!prev || prev.machineTokenHash !== m.machineTokenHash) {
        await client.send(new PutCommand({ TableName: table, Item: { pk: `mtok#${m.machineTokenHash}`, userId: m.userId } }))
        if (prev?.machineTokenHash) await client.send(new DeleteCommand({ TableName: table, Key: { pk: `mtok#${prev.machineTokenHash}` } }))
      }
      return true
    },
    async insertMachine(m, maxMachines) {
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: table,
                  Key: { pk: COUNT_PK },
                  UpdateExpression: 'SET #n = if_not_exists(#n, :zero) + :one',
                  ConditionExpression: 'attribute_not_exists(#n) OR #n < :max',
                  ExpressionAttributeNames: { '#n': 'n' },
                  ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':max': maxMachines }
                }
              },
              { Put: { TableName: table, Item: { pk: `machine#${m.userId}`, ...m }, ConditionExpression: 'attribute_not_exists(pk)' } }
            ]
          })
        )
      } catch (e) {
        if (e instanceof TransactionCanceledException) {
          const [count, machine] = e.CancellationReasons ?? []
          if (machine?.Code === 'ConditionalCheckFailed') return 'exists'
          if (count?.Code === 'ConditionalCheckFailed') return 'full'
        }
        throw e
      }
      await client.send(new PutCommand({ TableName: table, Item: { pk: `mtok#${m.machineTokenHash}`, userId: m.userId } }))
      return 'ok'
    },
    async deleteMachine(m) {
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              { Delete: { TableName: table, Key: { pk: `machine#${m.userId}` }, ConditionExpression: '#rev = :rev', ExpressionAttributeNames: { '#rev': 'rev' }, ExpressionAttributeValues: { ':rev': m.rev } } },
              { Update: { TableName: table, Key: { pk: COUNT_PK }, UpdateExpression: 'SET #n = if_not_exists(#n, :one) - :one', ExpressionAttributeNames: { '#n': 'n' }, ExpressionAttributeValues: { ':one': 1 } } }
            ]
          })
        )
      } catch (e) {
        if (e instanceof TransactionCanceledException && e.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') return false
        throw e
      }
      await client.send(new DeleteCommand({ TableName: table, Key: { pk: `mtok#${m.machineTokenHash}` } }))
      return true
    },
    async listMachines() {
      const out: MachineRec[] = []
      let start: Record<string, unknown> | undefined
      do {
        const r = await client.send(new ScanCommand({ TableName: table, FilterExpression: 'begins_with(pk, :p)', ExpressionAttributeValues: { ':p': 'machine#' }, ExclusiveStartKey: start, ConsistentRead: true }))
        for (const it of r.Items ?? []) out.push(strip(it as MachineRec & { pk: string })!)
        start = r.LastEvaluatedKey
      } while (start)
      return out
    }
  }
}

// ---------------------------------------------------------------- EC2

const CAPACITY = new Set(['InsufficientInstanceCapacity', 'InsufficientCapacity', 'Unsupported', 'InsufficientHostCapacity', 'VcpuLimitExceeded', 'InstanceLimitExceeded'])
const NOT_FOUND = new Set(['InvalidInstanceID.NotFound', 'InvalidAllocationID.NotFound', 'InvalidAddressID.NotFound'])
const code = (e: unknown): string => (e as { name?: string; Code?: string })?.name ?? (e as { Code?: string })?.Code ?? ''

function capacity(e: unknown): never {
  if (CAPACITY.has(code(e))) throw new CapacityError(`${code(e)}: ${(e as Error).message}`)
  throw e
}

const tagOf = (tags: { Key?: string; Value?: string }[] | undefined, k: string): string | null => tags?.find((t) => t.Key === k)?.Value ?? null

function info(i: Instance): InstanceInfo {
  return {
    instanceId: i.InstanceId!,
    state: (i.State?.Name ?? 'terminated') as InstanceInfo['state'],
    publicIp: i.PublicIpAddress ?? null,
    instanceType: i.InstanceType ?? '',
    machineId: tagOf(i.Tags, TAG_MACHINE),
    launchedAt: i.LaunchTime ? new Date(i.LaunchTime).toISOString() : null
  }
}

export interface Ec2Options {
  launchTemplateId: string
  subnetIds: string[]
  /** SSM parameter holding the current machine image id (written by scripts/build-ami.ts) */
  amiParameter: string
  ec2?: EC2Client
  ssm?: SSMClient
}

export function ec2Compute(o: Ec2Options): Compute {
  const ec2 = o.ec2 ?? new EC2Client({})
  const ssm = o.ssm ?? new SSMClient({})
  let ami: { id: string; at: number } | null = null
  async function imageId(): Promise<string> {
    if (ami && Date.now() - ami.at < 5 * 60_000) return ami.id
    try {
      const r = await ssm.send(new GetParameterCommand({ Name: o.amiParameter }))
      const id = r.Parameter?.Value ?? ''
      if (!/^ami-[0-9a-f]+$/.test(id)) throw new Error(`bad ${o.amiParameter}`)
      ami = { id, at: Date.now() }
      return id
    } catch (e) {
      throw new Error(`No machine image yet (${o.amiParameter}): run scripts/build-ami.ts. ${(e as Error).message}`, { cause: e })
    }
  }
  const tags = (machineId: string, extra: Record<string, string> = {}) => Object.entries({ [TAG]: 'machine', [TAG_MACHINE]: machineId, ...extra }).map(([Key, Value]) => ({ Key, Value }))

  async function describeWhere(Filters: { Name: string; Values: string[] }[]): Promise<InstanceInfo[]> {
    const out: InstanceInfo[] = []
    let NextToken: string | undefined
    do {
      const r = await ec2.send(new DescribeInstancesCommand({ Filters, NextToken, MaxResults: 1000 }))
      for (const res of r.Reservations ?? []) for (const i of res.Instances ?? []) out.push(info(i))
      NextToken = r.NextToken
    } while (NextToken)
    return out
  }

  return {
    async allocateAddress(machineId) {
      const r = await ec2.send(
        new AllocateAddressCommand({
          Domain: 'vpc',
          TagSpecifications: [{ ResourceType: 'elastic-ip', Tags: [...tags(machineId, { [TAG]: 'address', [TAG_CREATED]: new Date().toISOString() })] }]
        })
      )
      return { allocationId: r.AllocationId!, ip: r.PublicIp! }
    },
    async releaseAddress(allocationId) {
      try {
        await ec2.send(new ReleaseAddressCommand({ AllocationId: allocationId }))
      } catch (e) {
        if (!NOT_FOUND.has(code(e))) throw e
      }
    },
    async associateAddress(allocationId, instanceId) {
      await ec2.send(new AssociateAddressCommand({ AllocationId: allocationId, InstanceId: instanceId, AllowReassociation: true }))
    },
    async launch(l) {
      const ImageId = await imageId()
      // spread machines over the zones, and move on when one has no room
      const start = parseInt(l.machineId.replace(/[^0-9a-f]/g, '').slice(-4) || '0', 16) % o.subnetIds.length
      const order = [...o.subnetIds.slice(start), ...o.subnetIds.slice(0, start)]
      let last: unknown = null
      for (const SubnetId of order) {
        try {
          const r = await ec2.send(
            new RunInstancesCommand({
              LaunchTemplate: { LaunchTemplateId: o.launchTemplateId, Version: '$Latest' },
              ImageId,
              InstanceType: l.instanceType as never,
              SubnetId,
              MinCount: 1,
              MaxCount: 1,
              ClientToken: `${l.machineId}-${SubnetId}-${Date.now()}`.slice(0, 64),
              UserData: Buffer.from(l.userData, 'utf8').toString('base64'),
              TagSpecifications: [
                { ResourceType: 'instance', Tags: tags(l.machineId, { Name: l.name }) },
                { ResourceType: 'volume', Tags: tags(l.machineId, { Name: l.name }) }
              ]
            })
          )
          return { instanceId: r.Instances![0]!.InstanceId! }
        } catch (e) {
          if (!CAPACITY.has(code(e))) throw e
          last = e
        }
      }
      return capacity(last)
    },
    async describe(ids) {
      const out = new Map<string, InstanceInfo>()
      for (let k = 0; k < ids.length; k += 150) {
        // a filter never fails on an id AWS has forgotten (InstanceIds would)
        for (const i of await describeWhere([{ Name: 'instance-id', Values: ids.slice(k, k + 150) }])) out.set(i.instanceId, i)
      }
      return out
    },
    async listTagged() {
      const instances = await describeWhere([{ Name: `tag:${TAG}`, Values: ['machine'] }])
      const r = await ec2.send(new DescribeAddressesCommand({ Filters: [{ Name: `tag:${TAG}`, Values: ['address'] }] }))
      const addresses: AddressInfo[] = (r.Addresses ?? []).map((a) => ({
        allocationId: a.AllocationId!,
        ip: a.PublicIp ?? '',
        machineId: tagOf(a.Tags, TAG_MACHINE),
        instanceId: a.InstanceId ?? null,
        createdAt: tagOf(a.Tags, TAG_CREATED)
      }))
      return { instances, addresses }
    },
    async start(id) {
      try {
        await ec2.send(new StartInstancesCommand({ InstanceIds: [id] }))
      } catch (e) {
        capacity(e)
      }
    },
    async stop(id) {
      await ec2.send(new StopInstancesCommand({ InstanceIds: [id] }))
    },
    async terminate(id) {
      try {
        await ec2.send(new TerminateInstancesCommand({ InstanceIds: [id] }))
      } catch (e) {
        if (!NOT_FOUND.has(code(e))) throw e
      }
    },
    async setInstanceType(id, t) {
      await ec2.send(new ModifyInstanceAttributeCommand({ InstanceId: id, InstanceType: { Value: t } }))
    },
    async consoleTail(id) {
      const r = await ec2.send(new GetConsoleOutputCommand({ InstanceId: id, Latest: true }))
      return r.Output ? Buffer.from(r.Output, 'base64').toString('utf8').slice(-8000) : ''
    }
  }
}

// ---------------------------------------------------------------- GitHub

export function githubApi(f: typeof fetch = fetch): GitHub {
  const get = async <T>(path: string, token: string): Promise<T> => {
    const res = await f(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'principia-fleet', 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) throw new Error(`GitHub ${res.status}`)
    return (await res.json()) as T
  }
  return {
    async user(token) {
      const u = await get<{ id: number; login: string }>('/user', token)
      return { id: String(u.id), login: u.login }
    },
    async orgs(token) {
      return (await get<{ login: string }[]>('/user/orgs?per_page=100', token)).map((o) => o.login)
    }
  }
}
