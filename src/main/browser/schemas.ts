/** BROWSER.md: request schemas of the browser:* channels (merged into ipcSchemas REQUEST_SCHEMAS). */
import { z } from 'zod'
import { BROWSER_SCOPE_RE } from '../../shared/browser'

const companyId = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/, 'invalid company')
const tabId = z.string().regex(/^t\d{1,6}$/, 'invalid tab')
const scope = z.string().max(140).regex(BROWSER_SCOPE_RE, 'invalid scope')
const px = z.number().finite().min(-10_000).max(20_000)

export const BROWSER_REQUEST_SCHEMAS = {
  'browser:state': z.object({ companyId, scope }).strict(),
  'browser:bounds': z.object({ companyId, scope, bounds: z.object({ x: px, y: px, width: px, height: px }).strict().nullable() }).strict(),
  'browser:navigate': z.object({ companyId, scope, url: z.string().min(1).max(4096) }).strict(),
  'browser:nav': z.object({ companyId, scope, action: z.enum(['back', 'forward', 'reload', 'stop']) }).strict(),
  'browser:tab': z.object({ companyId, scope, op: z.enum(['new', 'close', 'select']), tabId: tabId.optional(), url: z.string().max(4096).optional() }).strict(),
  'browser:takeover': z.object({ companyId, scope, on: z.boolean() }).strict(),
  'browser:openShot': z.object({ companyId, id: z.string().regex(/^s[a-z0-9]{4,20}$/, 'invalid id') }).strict(),
  'browser:clear': z.object({ companyId, scope }).strict()
}
