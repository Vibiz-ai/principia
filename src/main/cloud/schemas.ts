/** zod schemas for the cloud:* invoke channels (spread into REQUEST_SCHEMAS, ipcSchemas.ts). docs/CLOUD.md §13.1. */
import { z } from 'zod'
import { CLOUD_ADAPTERS, CLOUD_LIMITS, PROVIDER_CREDENTIAL_KINDS } from '../../shared/cloud'

const none = z.unknown().transform(() => undefined)
const id = z.string().min(1).max(200)
const adapter = z.enum(CLOUD_ADAPTERS)
const kind = z.enum([...new Set(Object.values(PROVIDER_CREDENTIAL_KINDS).flat())] as [string, ...string[]])

export const CLOUD_REQUEST_SCHEMAS = {
  'cloud:state': none,
  'cloud:pair': z
    .object({ link: z.string().trim().min(1).max(600).optional(), url: z.string().trim().min(1).max(500).optional(), code: z.string().trim().min(1).max(20).optional() })
    .strict()
    .refine((q) => !!q.link || (!!q.url && !!q.code), 'Paste your connect link'),
  'cloud:unlink': none,
  'cloud:summary': none,
  'cloud:providers': none,
  'cloud:providerPut': z.object({ adapter, kind, value: z.string().min(1, 'Paste a key or token').max(CLOUD_LIMITS.credentialBytes) }).strict(),
  'cloud:providerDelete': z.object({ adapter }).strict(),
  'cloud:providerTest': z.object({ adapter, live: z.boolean().optional() }).strict(),
  'cloud:loginClaude': none,
  'cloud:loginCodex': none,
  'cloud:loginCancel': none,
  'cloud:movePlan': z.object({ companyId: id }).strict(),
  'cloud:move': z
    .object({
      companyId: id,
      workflows: z.array(id).max(500),
      schedules: z.array(id).max(500),
      repos: z.array(z.object({ id, token: z.string().trim().max(400).nullable() }).strict()).max(100),
      keys: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/).max(128)).max(500),
      connections: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)).max(200),
      overwrite: z.array(id).max(500).optional()
    })
    .strict(),
  'cloud:runOnce': z.object({ companyId: id, workflowId: id.optional() }).strict(),
  'cloud:bringBack': z.object({ companyId: id }).strict(),
  'cloud:runs': z.union([z.object({ companyId: id.optional(), limit: z.number().int().min(1).max(200).optional() }).strict(), none]),
  'cloud:run': z.object({ id }).strict(),
  'cloud:runLog': z.object({ id, stepId: id.optional(), tail: z.number().int().min(1).max(CLOUD_LIMITS.logTailLines).optional() }).strict(),
  'cloud:runCancel': z.object({ id }).strict(),
  'cloud:asks': none,
  'cloud:answer': z.object({ id, answer: z.string().trim().min(1, 'Write an answer').max(CLOUD_LIMITS.forumTextChars) }).strict(),
  'cloud:proposals': z.object({ companyId: id }).strict(),
  'cloud:decideProposal': z.object({ companyId: id, proposalId: id, decision: z.enum(['accept', 'reject']) }).strict(),
  'cloud:devices': none,
  'cloud:revokeDevice': z.object({ id }).strict(),
  'cloud:loginLink': z.union([z.object({ open: z.boolean().optional() }).strict(), none]),
  'cloud:pause': z.object({ paused: z.boolean() }).strict(),
  'cloud:pauseCompany': z.object({ companyId: id, paused: z.boolean() }).strict(),
  'cloud:connectionAuthorize': z.object({ companyId: id, connectionId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) }).strict()
} as const
