/** CHAT-UI.md §3.2: request schemas of the chat:* channels (merged into ipcSchemas REQUEST_SCHEMAS). */
import { z } from 'zod'
import { CHAT_IMAGE_MAX, CHAT_IMAGE_TYPES } from '../../shared/chat'

const id = z.string().min(1).max(64).regex(/^[a-z]+_[0-9a-z]+$/, 'invalid id')
const requestId = z.string().min(1).max(200)
/** ~5 MB of base64 per image, at most 6 per message */
const image = z.object({ mediaType: z.enum(CHAT_IMAGE_TYPES), data: z.string().min(1).max(7_000_000).regex(/^[A-Za-z0-9+/=]+$/, 'base64'), thumb: z.string().max(60_000).regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/, 'thumb').optional() }).strict()
const decision = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('allow') }).strict(),
  z.object({ kind: z.literal('allowAlways'), suggestion: z.number().int().min(0).max(20) }).strict(),
  z.object({ kind: z.literal('deny'), message: z.string().max(4000).optional() }).strict(),
  z.object({ kind: z.literal('answer'), answers: z.record(z.string().max(2000), z.string().max(4000)).refine((r) => Object.keys(r).length <= 10, 'Too many answers') }).strict(),
  z.object({ kind: z.literal('skip') }).strict(),
  z.object({ kind: z.literal('approvePlan'), acceptEdits: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('rejectPlan'), message: z.string().max(4000).optional() }).strict()
])

export const CHAT_REQUEST_SCHEMAS = {
  'chat:snapshot': z.object({ id }).strict(),
  'chat:send': z.object({ id, text: z.string().max(200_000), images: z.array(image).max(CHAT_IMAGE_MAX).optional() }).strict(),
  'chat:queueEdit': z.object({ id, queueId: z.string().min(1).max(64), text: z.string().max(200_000).nullable() }).strict(),
  'chat:interrupt': z.object({ id, sendNow: z.boolean().optional() }).strict(),
  'chat:answer': z.object({ id, requestId, decision }).strict(),
  'chat:setPermissionMode': z.object({ id, mode: z.enum(['default', 'acceptEdits', 'plan', 'auto']) }).strict(),
  'chat:setModel': z.object({ id, model: z.string().min(1).max(100).regex(/^[A-Za-z0-9._:[\]-]+$/, 'model') }).strict(),
  'chat:files': z.object({ id, query: z.string().max(200) }).strict(),
  'chat:toTerminal': z.object({ id, force: z.boolean().optional() }).strict(),
  'chat:toChat': z.object({ id, force: z.boolean().optional() }).strict(),
  'chat:openAgent': z.object({ agentId: id }).strict(),
  // images alone are a message too (the handler refuses neither words nor images)
  'chat:sendAgent': z.object({ agentId: id, text: z.string().max(200_000), images: z.array(image).max(CHAT_IMAGE_MAX).optional() }).strict()
}
