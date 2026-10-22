/** Small node:http helpers for the control plane: CloudError responses, capped bodies, security headers. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CloudError, CloudErrorCode } from '../../shared/cloud'

const STATUS: Record<CloudErrorCode, number> = {
  bad_request: 400, unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409, quota_exceeded: 429, paused: 409,
  payload_too_large: 413, rate_limited: 429, unavailable: 503, internal: 500, not_in_v1: 501
}

export class ApiError extends Error {
  readonly status: number
  constructor(readonly code: CloudErrorCode, message: string, readonly rev?: number) { super(message); this.status = STATUS[code] }
  body(): CloudError { return { error: this.code, message: this.message, ...(this.rev !== undefined ? { rev: this.rev } : {}) } }
}

export const notFound = (what = 'Not found.'): ApiError => new ApiError('not_found', what)
export const badRequest = (msg: string): ApiError => new ApiError('bad_request', msg)
export const notInV1 = (): ApiError => new ApiError('not_in_v1', 'This is not in Principia Cloud v1 yet.')

export const API_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }

export async function readBody(req: IncomingMessage, cap: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > cap) throw new ApiError('payload_too_large', `The request body is larger than ${cap} bytes.`)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > cap) { req.resume(); throw new ApiError('payload_too_large', `The request body is larger than ${cap} bytes.`) }
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

export async function readJson(req: IncomingMessage, cap: number): Promise<unknown> {
  const buf = await readBody(req, cap)
  if (!buf.length) return {}
  try { return JSON.parse(buf.toString('utf8')) } catch { throw badRequest('The body is not valid JSON.') }
}

export function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown'
}

export function cookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return null
}

export function sendHtml(res: ServerResponse, status: number, html: string, csp: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': csp, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' })
  res.end(html)
}

export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
