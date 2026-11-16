/**
 * Bakes the fleet's machine image (docs/FLEET.md §4): Ubuntu 24.04 (arm64) with Docker, the Principia Cloud image,
 * Caddy and the heartbeat already on it, so a new machine only configures itself and starts in about a minute.
 *
 *   npx tsx scripts/build-ami.ts [--ref <git ref>] [--image <image>] [--keep 3]
 *
 * 1. Launches a builder from the stack's launch template with `prepareScript` as user-data. The script powers the
 *    builder off when it is done, and prints "principia: image ready" on the console only on success.
 * 2. Makes an image of it, waits until it is available, and writes its id to the SSM parameter new machines read.
 * 3. Terminates the builder, and deregisters older fleet images (and their snapshots) beyond the newest `--keep`.
 *
 * Machines made before keep their image; only new ones use the new one.
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation'
import {
  CreateImageCommand,
  DeleteSnapshotCommand,
  DeregisterImageCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  EC2Client,
  GetConsoleOutputCommand,
  RunInstancesCommand,
  TerminateInstancesCommand
} from '@aws-sdk/client-ec2'
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import { prepareScript } from '../../src/main/cloud/machines/bootstrap'

const arg = (k: string, d: string): string => {
  const i = process.argv.indexOf(`--${k}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : d
}
const STACK = 'PrincipiaFleet'
const AMI_PARAMETER = '/principia-fleet/ami-id'
/** docs/FLEET.md §10: machines move to this published image by themselves (their heartbeat reads it) */
const IMAGE_PARAMETER = '/principia-fleet/cloud-image'
const PUBLISHED = /^ghcr\.io\/vibiz-ai\/principia-cloud:[0-9A-Za-z._-]{1,64}$/
const BASE = '/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id'
const ref = arg('ref', 'main')
const image = arg('image', 'ghcr.io/vibiz-ai/principia-cloud:latest')
const keep = Number(arg('keep', '3'))
const builderType = arg('type', 't4g.xlarge')

const ec2 = new EC2Client({})
const ssm = new SSMClient({})
const cf = new CloudFormationClient({})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const say = (s: string) => console.log(`[build-ami] ${s}`)

async function outputs(): Promise<Record<string, string>> {
  const r = await cf.send(new DescribeStacksCommand({ StackName: STACK }))
  return Object.fromEntries((r.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]))
}

async function consoleText(id: string): Promise<string> {
  const r = await ec2.send(new GetConsoleOutputCommand({ InstanceId: id, Latest: true })).catch(() => null)
  return r?.Output ? Buffer.from(r.Output, 'base64').toString('utf8') : ''
}

async function state(id: string): Promise<string> {
  const r = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [id] }))
  return r.Reservations?.[0]?.Instances?.[0]?.State?.Name ?? 'unknown'
}

async function main(): Promise<void> {
  const out = await outputs()
  const subnet = out.SubnetIds!.split(',')[0]!
  const base = (await ssm.send(new GetParameterCommand({ Name: BASE }))).Parameter!.Value!
  say(`base ${base}, ref ${ref}, image ${image}`)
  // the markers go straight to the serial console: the script's own output goes through tee, which a power-off cuts
  const script = `${prepareScript({ image, sourceRef: ref })}
# a clean first boot for every machine made from this image
cloud-init clean --logs --machine-id || cloud-init clean --logs
rm -f /etc/ssh/ssh_host_*
: > /var/log/principia-bootstrap.log
sync
echo "principia: image ready" > /dev/console
sleep 10
poweroff
`.replace('set -euo pipefail', `set -euo pipefail\ntrap 'echo "principia: build failed at line $LINENO" > /dev/console; sleep 10; poweroff' ERR`)
  const run = await ec2.send(
    new RunInstancesCommand({
      LaunchTemplate: { LaunchTemplateId: out.LaunchTemplateId!, Version: '$Latest' },
      ImageId: base,
      InstanceType: builderType as never,
      SubnetId: subnet,
      MinCount: 1,
      MaxCount: 1,
      UserData: Buffer.from(script).toString('base64'),
      TagSpecifications: [{ ResourceType: 'instance', Tags: [{ Key: 'Name', Value: 'principia-fleet-ami-builder' }, { Key: 'principia-fleet', Value: 'builder' }] }]
    })
  )
  const id = run.Instances![0]!.InstanceId!
  say(`builder ${id} launched`)
  try {
    const until = Date.now() + 75 * 60_000
    let seen = ''
    for (;;) {
      await sleep(30_000)
      const text = await consoleText(id)
      for (const l of text.split('\n').filter((l) => l.includes('principia:'))) if (!seen.includes(l)) { say(l.trim()); seen += `${l}\n` }
      const s = await state(id)
      if (s === 'stopped') break
      if (Date.now() > until) throw new Error('the builder did not finish in 75 minutes')
    }
    // "prepared" is the last line of prepareScript; what follows (clean-up, power-off) is trivial, and the console API
    // often never shows the very last lines
    const done = (t: string): boolean => t.includes('principia: image ready') || t.includes('principia: prepared')
    // the console log reaches the API minutes late: wait for one of the two markers before deciding
    let text = ''
    for (let i = 0; i < 12; i++) {
      text = await consoleText(id)
      if (done(text) || text.includes('principia: build failed')) break
      await sleep(30_000)
    }
    if (!done(text) || text.includes('principia: build failed')) {
      say(text.split('\n').slice(-25).join('\n'))
      throw new Error('the build failed: see the lines above')
    }
    const name = `principia-fleet-${ref.replace(/[^A-Za-z0-9.-]/g, '-')}-${new Date().toISOString().replace(/[:.]/g, '-')}`.slice(0, 120)
    const img = await ec2.send(
      new CreateImageCommand({ InstanceId: id, Name: name, TagSpecifications: [{ ResourceType: 'image', Tags: [{ Key: 'principia-fleet', Value: 'image' }, { Key: 'principia-fleet:ref', Value: ref }] }, { ResourceType: 'snapshot', Tags: [{ Key: 'principia-fleet', Value: 'image' }] }] })
    )
    const amiId = img.ImageId!
    say(`image ${amiId} (${name}) making…`)
    for (;;) {
      await sleep(20_000)
      const d = await ec2.send(new DescribeImagesCommand({ ImageIds: [amiId] }))
      const s = d.Images?.[0]?.State
      if (s === 'available') break
      if (s === 'failed' || s === 'invalid' || s === 'error') throw new Error(`image ${amiId} is ${s}`)
    }
    await ssm.send(new PutParameterCommand({ Name: AMI_PARAMETER, Value: amiId, Type: 'String', Overwrite: true, DataType: 'aws:ec2:image' }))
    say(`${AMI_PARAMETER} = ${amiId}`)
    // the image was pulled (not built from source): running machines move to it too
    if (PUBLISHED.test(image) && !image.endsWith(':latest') && !text.includes('is not published')) {
      await ssm.send(new PutParameterCommand({ Name: IMAGE_PARAMETER, Value: image, Type: 'String', Overwrite: true }))
      say(`${IMAGE_PARAMETER} = ${image}`)
    }

    // older images cost their snapshots every month
    const all = await ec2.send(new DescribeImagesCommand({ Owners: ['self'], Filters: [{ Name: 'tag:principia-fleet', Values: ['image'] }] }))
    const old = (all.Images ?? []).sort((a, b) => (b.CreationDate ?? '').localeCompare(a.CreationDate ?? '')).slice(keep)
    for (const im of old) {
      if (im.ImageId === amiId) continue
      await ec2.send(new DeregisterImageCommand({ ImageId: im.ImageId! }))
      for (const b of im.BlockDeviceMappings ?? []) if (b.Ebs?.SnapshotId) await ec2.send(new DeleteSnapshotCommand({ SnapshotId: b.Ebs.SnapshotId })).catch(() => undefined)
      say(`removed old image ${im.ImageId}`)
    }
  } finally {
    await ec2.send(new TerminateInstancesCommand({ InstanceIds: [id] })).catch(() => undefined)
    say(`builder ${id} terminated`)
  }
}

main().catch((e) => {
  console.error(`[build-ami] ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
