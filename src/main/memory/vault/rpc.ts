// The main side of the hivemem write spool (PASSPORT.md §7.1). An MCP server never writes SQLite or vault files: each
// write tool call becomes `<id>.request` in its grant's spool dir (`<userData>/mem-rpc/<grantId>/`), and this bridge
// validates it, runs policy then the writer (through `handle`), and answers `<id>.answer`. The spool folder names the
// grant, so a request cannot borrow another grant; a grant whose company differs from the request's company (the
// child's HIVE_COMPANY_ID) is refused before any vault is touched.
//
// This module removes nothing itself (memory/vault/ has no removal calls, writer.test.ts): consumed request files are
// handed to `discard`, which the service implements outside the vault folder.

import fs from 'node:fs'
import path from 'node:path'
import { MEM_RPC, MEM_RPC_METHODS, type MemRpcAnswer, type MemRpcErrorCode, type MemRpcRequest } from '../../../shared/memory'
import { readPrivateJson, writePrivateJson } from '../../gateway/files'
import { MemoryRefusal, type VaultGrantRow } from '../store'

export interface RpcBridgeDeps {
  /** The grant row (any state); null when unknown. */
  grant(grantId: string): VaultGrantRow | null
  /** True when this company's vault is registered and writable here. */
  hasVault(companyId: string): boolean
  /** Policy, then the writer. Throws MemoryRefusal for refusals. */
  handle(grant: VaultGrantRow, req: MemRpcRequest): Promise<unknown>
  /** Drops a consumed request file. */
  discard(file: string): void
  log?: { warn(m: string, meta?: Record<string, unknown>): void }
}

const REQUEST_RE = new RegExp(`^([a-z0-9]{8,64})${MEM_RPC.requestSuffix.replace('.', '\\.')}$`)

const fail = (code: MemRpcErrorCode, error: string): MemRpcAnswer => ({ ok: false, code, error })

function refusalCode(e: MemoryRefusal): MemRpcErrorCode {
  return e.code === 'refused' ? 'refused' : e.code
}

/** Validates one parsed request against the spool's grant and runs it. Never throws. */
export async function answerRequest(deps: RpcBridgeDeps, spoolGrantId: string, raw: unknown): Promise<MemRpcAnswer> {
  if (!raw || typeof raw !== 'object') return fail('validation', 'Malformed memory request')
  const req = raw as Partial<MemRpcRequest>
  if (req.v !== MEM_RPC.version) return fail('validation', 'Unsupported memory request version; restart the agent')
  if (typeof req.method !== 'string' || !(MEM_RPC_METHODS as readonly string[]).includes(req.method)) return fail('validation', 'Unknown memory method')
  if (req.grantId !== spoolGrantId) return fail('refused', 'Refused: this request names another memory grant')
  if (typeof req.companyId !== 'string' || !req.companyId) return fail('company', 'Refused: the request names no company')
  if (!req.args || typeof req.args !== 'object') return fail('validation', 'Missing arguments')
  if (req.callId !== undefined && (typeof req.callId !== 'string' || req.callId.length > 200)) return fail('validation', 'Bad call id')
  const grant = deps.grant(spoolGrantId)
  if (!grant) return fail('refused', 'Refused: unknown memory grant')
  // §7.1 binding: the grant row decides the company, never the arguments
  if (grant.company_id !== req.companyId) return fail('company', "Refused: this memory grant belongs to another company's Passport; memory is read-only here")
  if (grant.closed_at) return fail('refused', 'Refused: this memory grant is closed (the step or session ended)')
  if (!deps.hasVault(grant.company_id)) return fail('internal', 'This company Passport is not available right now; memory is read-only')
  try {
    const result = await deps.handle(grant, req as MemRpcRequest)
    return { ok: true, result } as MemRpcAnswer
  } catch (e) {
    if (e instanceof MemoryRefusal) return fail(refusalCode(e), e.message)
    deps.log?.warn('memory rpc: request failed', { grantId: spoolGrantId, method: req.method, e: String(e) })
    return fail('internal', e instanceof Error ? e.message : String(e))
  }
}

/** Polls the open grants' spool dirs and answers their requests, one at a time per file. */
export class MemRpcBridge {
  private spools = new Map<string, string>()
  private busy = new Set<string>()
  private timer: NodeJS.Timeout | null = null

  constructor(private deps: RpcBridgeDeps) {}

  /** Starts serving a grant's spool (creates the dir 0700). */
  open(grantId: string, dir: string): void {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(dir, 0o700)
    } catch {
      // best effort
    }
    this.spools.set(grantId, dir)
  }

  /** Stops serving a grant (its dir is removed by the service). */
  close(grantId: string): void {
    this.spools.delete(grantId)
  }

  dirOf(grantId: string): string | null {
    return this.spools.get(grantId) ?? null
  }

  start(intervalMs = 40): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.pollOnce(), intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.spools.clear()
  }

  /** Answers every pending request now; resolves with how many were answered. */
  async pollOnce(): Promise<number> {
    const jobs: Promise<boolean>[] = []
    for (const [grantId, dir] of this.spools) {
      let files: string[]
      try {
        files = fs.readdirSync(dir)
      } catch {
        continue
      }
      for (const f of files) {
        const m = REQUEST_RE.exec(f)
        if (!m) continue
        const file = path.join(dir, f)
        if (this.busy.has(file)) continue
        this.busy.add(file)
        jobs.push(this.serve(grantId, file, path.join(dir, `${m[1]}${MEM_RPC.answerSuffix}`)).finally(() => this.busy.delete(file)))
      }
    }
    return (await Promise.all(jobs)).filter(Boolean).length
  }

  private async serve(grantId: string, file: string, answerFile: string): Promise<boolean> {
    // claim the request atomically first: a client that times out can then no longer withdraw a request main is
    // already applying (its withdrawal fails, so it waits for this answer instead of reporting "read-only")
    const taking = file.slice(0, -MEM_RPC.requestSuffix.length) + MEM_RPC.takingSuffix
    try {
      fs.renameSync(file, taking)
    } catch {
      return false // withdrawn by the client (or claimed already)
    }
    file = taking
    let raw: unknown
    let answer: MemRpcAnswer
    try {
      raw = readPrivateJson(file, MEM_RPC.maxBytes)
      answer = await answerRequest(this.deps, grantId, raw)
    } catch (e) {
      answer = fail('validation', /too large/i.test(String(e)) ? 'Request too large' : 'Unreadable memory request')
    }
    // brief hits are fire and forget: the client never reads their answer, so none is written
    if ((raw as { method?: unknown } | undefined)?.method === 'hit' && answer.ok) {
      try {
        this.deps.discard(file)
      } catch {
        // left for the grant's spool cleanup
      }
      return true
    }
    if (Buffer.byteLength(JSON.stringify(answer)) > MEM_RPC.maxBytes) answer = fail('internal', 'The answer was too large; write fewer items per call')
    try {
      writePrivateJson(answerFile, answer)
    } catch (e) {
      this.deps.log?.warn('memory rpc: could not answer', { grantId, e: String(e) })
      return false
    } finally {
      try {
        this.deps.discard(file)
      } catch {
        // the client times out and reports memory as read-only
      }
    }
    return true
  }
}
