/** REMOTE.md: request schemas of the remote:* channels (merged into ipcSchemas REQUEST_SCHEMAS). */
import { z } from 'zod'

const none = z.unknown().transform(() => undefined)

export const REMOTE_REQUEST_SCHEMAS = {
  'remote:state': none,
  'remote:setEnabled': z.object({ on: z.boolean() }).strict(),
  'remote:tunnel': z.object({ on: z.boolean() }).strict(),
  'remote:pairLink': none,
  'remote:revoke': z.object({ id: z.string().min(1).max(64).regex(/^dev_[0-9a-z]+$/, 'invalid id') }).strict()
}
