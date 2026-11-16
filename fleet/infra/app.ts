/**
 * The fleet's AWS stack (docs/FLEET.md §3). One `cdk deploy` makes:
 *
 * - a VPC with public subnets in three zones and no NAT gateway (machines have their own public address)
 * - a security group: 80 and 443 in (Caddy and its certificate), nothing else; no SSH
 * - a launch template: IMDSv2 only with a hop limit of 1 (containers can't reach the metadata service), an encrypted
 *   40 GB gp3 disk, no instance profile (nothing on a machine can call AWS), and "shut down" means stop
 * - a DynamoDB table (on-demand, point-in-time recovery, kept if the stack is deleted)
 * - the API Lambda behind a function URL, and the reconciler Lambda every minute (one at a time)
 * - IAM scoped to what carries the `principia-fleet` tag
 * - optionally a monthly AWS Budget that emails `alertEmail` at 80 % and 100 %
 *
 * Context (cdk deploy -c key=value): allowUsers, allowOrgs, open, maxMachines, maxHoursPerMonth, idleMinutes,
 * instanceTypes, monthlyBudgetUsd, alertEmail.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cdk from 'aws-cdk-lib'
import { aws_budgets as budgets, aws_dynamodb as ddb, aws_ec2 as ec2, aws_events as events, aws_events_targets as targets, aws_iam as iam, aws_lambda as lambda, aws_lambda_nodejs as nodejs, aws_logs as logs } from 'aws-cdk-lib'
import type { Construct } from 'constructs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')
export const AMI_PARAMETER = '/principia-fleet/ami-id'
/** docs/FLEET.md §10: the Principia Cloud image machines move to (written by scripts/build-ami.ts --image) */
export const IMAGE_PARAMETER = '/principia-fleet/cloud-image'
export const STACK = 'PrincipiaFleet'

class FleetStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props)
    const ctx = (k: string, d = ''): string => String(this.node.tryGetContext(k) ?? d)

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 3,
      natGateways: 0,
      subnetConfiguration: [{ name: 'machines', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 20, mapPublicIpOnLaunch: true }]
    })
    const sg = new ec2.SecurityGroup(this, 'MachineSg', { vpc, description: 'Principia fleet machines: https only', allowAllOutbound: true })
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Caddy (certificate challenge and redirect)')
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Principia Cloud over https')

    const template = new ec2.CfnLaunchTemplate(this, 'MachineTemplate', {
      launchTemplateData: {
        metadataOptions: { httpTokens: 'required', httpPutResponseHopLimit: 1, httpEndpoint: 'enabled', instanceMetadataTags: 'disabled' },
        blockDeviceMappings: [{ deviceName: '/dev/sda1', ebs: { volumeSize: 40, volumeType: 'gp3', encrypted: true, deleteOnTermination: true } }],
        instanceInitiatedShutdownBehavior: 'stop',
        securityGroupIds: [sg.securityGroupId],
        monitoring: { enabled: false }
      }
    })

    const table = new ddb.Table(this, 'Table', {
      partitionKey: { name: 'pk', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN
    })

    const environment: Record<string, string> = {
      FLEET_TABLE: table.tableName,
      FLEET_LAUNCH_TEMPLATE_ID: template.ref,
      FLEET_SUBNET_IDS: vpc.publicSubnets.map((s) => s.subnetId).join(','),
      FLEET_AMI_PARAMETER: AMI_PARAMETER,
      FLEET_IMAGE_PARAMETER: IMAGE_PARAMETER,
      FLEET_ALLOW_USERS: ctx('allowUsers'),
      FLEET_ALLOW_ORGS: ctx('allowOrgs'),
      FLEET_OPEN: ctx('open', 'false'),
      FLEET_MAX_MACHINES: ctx('maxMachines', '25'),
      FLEET_MAX_HOURS_PER_MONTH: ctx('maxHoursPerMonth', '200'),
      FLEET_IDLE_MINUTES: ctx('idleMinutes', '20'),
      FLEET_INSTANCE_TYPES: ctx('instanceTypes', 't4g.large,m7g.large,t4g.xlarge'),
      FLEET_PUBLIC_URL: ctx('publicUrl')
    }
    const fn = (name: string, handler: string, o: Partial<nodejs.NodejsFunctionProps>) =>
      new nodejs.NodejsFunction(this, name, {
        entry: path.join(here, '../src/lambda.ts'),
        handler,
        projectRoot: repo,
        depsLockFilePath: path.join(here, '../package-lock.json'),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        environment,
        logGroup: new logs.LogGroup(this, `${name}Logs`, { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY }),
        bundling: { externalModules: [], format: nodejs.OutputFormat.ESM, target: 'node22', minify: true, sourceMap: true, banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
        ...o
      })
    const apiFn = fn('Api', 'http', { timeout: cdk.Duration.seconds(30), reservedConcurrentExecutions: 20 })
    const tickFn = fn('Tick', 'tick', { timeout: cdk.Duration.seconds(55), reservedConcurrentExecutions: 1 })
    const url = apiFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE })
    new events.Rule(this, 'EveryMinute', { schedule: events.Schedule.rate(cdk.Duration.minutes(1)), targets: [new targets.LambdaFunction(tickFn, { retryAttempts: 0 })] })

    for (const f of [apiFn, tickFn]) {
      table.grantReadWriteData(f)
      f.addToRolePolicy(new iam.PolicyStatement({ actions: ['ec2:DescribeInstances', 'ec2:DescribeAddresses'], resources: ['*'] }))
      f.addToRolePolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [AMI_PARAMETER, IMAGE_PARAMETER].map((n) => this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: n.slice(1) })) }))
      // making: only with the fleet's tag, only through the fleet's template
      f.addToRolePolicy(new iam.PolicyStatement({ actions: ['ec2:AllocateAddress'], resources: ['*'], conditions: { StringEquals: { [`aws:RequestTag/principia-fleet`]: 'address' } } }))
      f.addToRolePolicy(new iam.PolicyStatement({ actions: ['ec2:RunInstances'], resources: [`arn:${this.partition}:ec2:${this.region}:${this.account}:instance/*`], conditions: { StringEquals: { [`aws:RequestTag/principia-fleet`]: 'machine' } } }))
      f.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ec2:RunInstances'],
          resources: [
            `arn:${this.partition}:ec2:${this.region}:${this.account}:launch-template/${template.ref}`,
            `arn:${this.partition}:ec2:${this.region}:${this.account}:subnet/*`,
            `arn:${this.partition}:ec2:${this.region}:${this.account}:security-group/${sg.securityGroupId}`,
            `arn:${this.partition}:ec2:${this.region}:${this.account}:network-interface/*`,
            `arn:${this.partition}:ec2:${this.region}:${this.account}:volume/*`,
            `arn:${this.partition}:ec2:${this.region}::image/*`
          ]
        })
      )
      f.addToRolePolicy(new iam.PolicyStatement({ actions: ['ec2:CreateTags'], resources: ['*'], conditions: { StringEquals: { 'ec2:CreateAction': ['RunInstances', 'AllocateAddress'] } } }))
      // changing: only what carries the tag
      f.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ec2:StartInstances', 'ec2:StopInstances', 'ec2:TerminateInstances', 'ec2:ModifyInstanceAttribute', 'ec2:GetConsoleOutput', 'ec2:AssociateAddress', 'ec2:ReleaseAddress'],
          resources: ['*'],
          conditions: { StringEquals: { 'aws:ResourceTag/principia-fleet': ['machine', 'address'] } }
        })
      )
    }

    const budgetUsd = Number(ctx('monthlyBudgetUsd', '0'))
    const email = ctx('alertEmail')
    if (budgetUsd > 0 && email) {
      new budgets.CfnBudget(this, 'Budget', {
        budget: { budgetType: 'COST', timeUnit: 'MONTHLY', budgetLimit: { amount: budgetUsd, unit: 'USD' }, budgetName: 'principia-fleet' },
        notificationsWithSubscribers: [80, 100].map((threshold) => ({
          notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold, thresholdType: 'PERCENTAGE' },
          subscribers: [{ subscriptionType: 'EMAIL', address: email }]
        }))
      })
    }

    new cdk.CfnOutput(this, 'FleetUrl', { value: url.url })
    new cdk.CfnOutput(this, 'LaunchTemplateId', { value: template.ref })
    new cdk.CfnOutput(this, 'SubnetIds', { value: vpc.publicSubnets.map((s) => s.subnetId).join(',') })
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName })
    new cdk.CfnOutput(this, 'AmiParameter', { value: AMI_PARAMETER })
  }
}

const app = new cdk.App()
new FleetStack(app, STACK, { env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-2' }, description: 'Principia Cloud managed fleet (docs/FLEET.md)' })
