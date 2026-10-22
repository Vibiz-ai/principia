/**
 * The hivemem side of the write spool (PASSPORT.md §7.1). The server never writes SQLite or vault files: each write tool
 * call becomes `<id>.request` in HIVE_MEM_SPOOL (0600, tmp + rename, the gateway's private-json pattern), and main's
 * bridge (memory/vault/rpc.ts) answers `<id>.answer`. The client polls with a 5 -> 100 ms backoff for up to 10 s; no
 * answer means main is not running, so the tool reports memory as read-only.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { MEM_RPC, type MemRpcAnswer, type MemRpcArgs, type MemRpcMethod, type MemRpcRequest } from '../../../shared/memory'
import { readPrivateJson, writePrivateJson } from '../../gateway/files'

export interface SpoolOptions {
  grantId: string
  /** HIVE_COMPANY_ID: the bridge refuses a request whose grant belongs to another company. */
  companyId: string
  timeoutMs?: number
  pollMinMs?: number
  pollMaxMs?: number
}

/** null = no answer in time (main is down or not serving this grant). */
export type SpoolAnswer<M extends MemRpcMethod> = MemRpcAnswer<M> | null

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
  })

const newRequestId = (): string => crypto.randomBytes(12).toString('hex')

function drop(file: string): boolean {
  try {
    fs.unlinkSync(file)
    return true
  } catch {
    return false
  }
}

export class SpoolClient {
  /** Answer files of fire-and-forget requests: main answers them too, so they are swept on later calls. */
  private unread: string[] = []

  constructor(
    readonly dir: string,
    private opts: SpoolOptions
  ) {}

  /** The spool folder exists (main creates it 0700 when the grant opens and removes it when the grant ends). */
  available(): boolean {
    try {
      return fs.statSync(this.dir).isDirectory()
    } catch {
      return false
    }
  }

  /** Drops the answers main left for notify() requests; ones not written yet are kept for the next sweep (max 50). */
  private sweep(): void {
    if (!this.unread.length) return
    this.unread = this.unread.filter((f) => !drop(f) && fs.existsSync(path.dirname(f))).slice(-50)
  }

  private request<M extends MemRpcMethod>(method: M, args: MemRpcArgs[M], callId?: string): { id: string; file: string } | null {
    this.sweep()
    if (!this.available()) return null
    const id = newRequestId()
    const req: MemRpcRequest<M> = { v: MEM_RPC.version, grantId: this.opts.grantId, companyId: this.opts.companyId, method, args, ...(callId ? { callId } : {}) }
    const body = JSON.stringify(req)
    if (Buffer.byteLength(body) > MEM_RPC.maxBytes) throw new Error('Request too large; write fewer items per call')
    const file = path.join(this.dir, `${id}${MEM_RPC.requestSuffix}`)
    try {
      writePrivateJson(file, req)
    } catch {
      return null
    }
    return { id, file }
  }

  /** One round trip. Resolves null when main does not answer within the timeout (the request is withdrawn). */
  async call<M extends MemRpcMethod>(method: M, args: MemRpcArgs[M], opts: { callId?: string; signal?: AbortSignal } = {}): Promise<SpoolAnswer<M>> {
    const sent = this.request(method, args, opts.callId)
    if (!sent) return null
    const answerFile = path.join(this.dir, `${sent.id}${MEM_RPC.answerSuffix}`)
    const deadline = Date.now() + (this.opts.timeoutMs ?? MEM_RPC.timeoutMs)
    let wait = this.opts.pollMinMs ?? MEM_RPC.pollMinMs
    const max = this.opts.pollMaxMs ?? MEM_RPC.pollMaxMs
    for (;;) {
      if (fs.existsSync(answerFile)) {
        try {
          const answer = readPrivateJson(answerFile, MEM_RPC.maxBytes) as MemRpcAnswer<M>
          drop(answerFile)
          if (!answer || typeof answer !== 'object' || typeof answer.ok !== 'boolean') return { ok: false, code: 'internal', error: 'Unreadable memory answer' }
          return answer
        } catch {
          // main renames the answer into place, so a read failure is a transient race; retry until the deadline
        }
      }
      if (Date.now() >= deadline || opts.signal?.aborted) break
      await sleep(Math.min(wait, Math.max(1, deadline - Date.now())), opts.signal)
      wait = Math.min(max, wait * 2)
    }
    // withdraw the request so a main that never picked it up cannot apply it later. If the withdrawal fails, main has
    // claimed it (renamed it to .taking) and is applying it: wait one more timeout for that answer, so an applied write
    // is never reported as "read-only". Any later answer is removed with the spool when the grant ends.
    if (drop(sent.file)) return null
    const grace = Date.now() + (this.opts.timeoutMs ?? MEM_RPC.timeoutMs)
    for (;;) {
      if (fs.existsSync(answerFile)) {
        try {
          const answer = readPrivateJson(answerFile, MEM_RPC.maxBytes) as MemRpcAnswer<M>
          drop(answerFile)
          return answer
        } catch {
          // being renamed into place; retry
        }
      }
      if (Date.now() >= grace || opts.signal?.aborted) return null
      await sleep(Math.min(max, Math.max(1, grace - Date.now())), opts.signal)
    }
  }

  /** Fire and forget (brief_hits): the request is sent, the answer is never read. */
  notify<M extends MemRpcMethod>(method: M, args: MemRpcArgs[M]): boolean {
    try {
      const sent = this.request(method, args)
      if (sent) this.unread.push(path.join(this.dir, `${sent.id}${MEM_RPC.answerSuffix}`))
      return !!sent
    } catch {
      return false
    }
  }
}
