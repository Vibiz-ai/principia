/** BROWSER.md: request schemas of the browser:* channels (merged into ipcSchemas REQUEST_SCHEMAS). */
import { z } from 'zod'

const companyId = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/, 'invalid company')
const tabId = z.string().regex(/^t\d{1,6}$/, 'invalid tab')
const px = z.number().finite().min(-10_000).max(20_000)

export const BROWSER_REQUEST_SCHEMAS = {
  'browser:state': z.object({ companyId }).strict(),
  'browser:bounds': z.object({ companyId, bounds: z.object({ x: px, y: px, width: px, height: px }).strict().nullable() }).strict(),
  'browser:navigate': z.object({ companyId, url: z.string().min(1).max(4096) }).strict(),
  'browser:nav': z.object({ companyId, action: z.enum(['back', 'forward', 'reload', 'stop']) }).strict(),
  'browser:tab': z.object({ companyId, op: z.enum(['new', 'close', 'select']), tabId: tabId.optional(), url: z.string().max(4096).optional() }).strict(),
  'browser:takeover': z.object({ companyId, on: z.boolean() }).strict(),
  'browser:openShot': z.object({ companyId, id: z.string().regex(/^s[a-z0-9]{4,20}$/, 'invalid id') }).strict(),
  'browser:clear': z.object({ companyId }).strict()
}
