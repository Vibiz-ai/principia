// The spool bridge's claim protocol (PASSPORT.md §7.1): main renames `<id>.request` to `<id>.taking` before applying
// it, so a client that times out can no longer withdraw a write main is already applying, and brief hits get no answer.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MEM_RPC } from '../../../../shared/memory'
import type { VaultGrantRow } from '../../store'
import { MemRpcBridge } from '../rpc'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-rpc-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const GRANT = 'mgr0000000001'
const grantRow = { id: GRANT, company_id: 'co_acme', closed_at: null } as unknown as VaultGrantRow
const request = (id: string, method: string) =>
  fs.writeFileSync(path.join(dir, `${id}${MEM_RPC.requestSuffix}`), JSON.stringify({ v: 1, grantId: GRANT, companyId: 'co_acme', method, args: {} }))

function bridge(handle: () => Promise<unknown>) {
  const discarded: string[] = []
  const b = new MemRpcBridge({
    grant: (id) => (id === GRANT ? grantRow : null),
    hasVault: () => true,
    handle,
    discard: (f) => {
      discarded.push(path.basename(f))
      fs.rmSync(f, { force: true })
    }
  })
  b.open(GRANT, dir)
  return { b, discarded }
}

describe('memory rpc spool: claim before apply', () => {
  it('a request being applied can no longer be withdrawn, and its answer is still written', async () => {
    let release!: () => void
    let withdrawn: boolean | null = null
    const { b, discarded } = bridge(async () => {
      // the client times out now and tries to withdraw its request
      try {
        fs.unlinkSync(path.join(dir, `req00000001${MEM_RPC.requestSuffix}`))
        withdrawn = true
      } catch {
        withdrawn = false
      }
      await new Promise<void>((r) => (release = r))
      return { wrote: 1 }
    })
    request('req00000001', 'write')
    const served = b.pollOnce()
    await new Promise((r) => setTimeout(r, 10))
    expect(fs.existsSync(path.join(dir, `req00000001${MEM_RPC.takingSuffix}`))).toBe(true)
    release()
    expect(await served).toBe(1)
    expect(withdrawn).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(dir, `req00000001${MEM_RPC.answerSuffix}`), 'utf8'))).toEqual({ ok: true, result: { wrote: 1 } })
    expect(discarded).toEqual([`req00000001${MEM_RPC.takingSuffix}`])
  })

  it('a withdrawn request is never applied', async () => {
    let applied = 0
    const { b } = bridge(async () => ++applied)
    request('req00000002', 'write')
    fs.unlinkSync(path.join(dir, `req00000002${MEM_RPC.requestSuffix}`))
    expect(await b.pollOnce()).toBe(0)
    expect(applied).toBe(0)
  })

  it('brief hits (fire and forget) are applied without an answer file', async () => {
    let applied = 0
    const { b } = bridge(async () => ++applied)
    request('req00000003', 'hit')
    expect(await b.pollOnce()).toBe(1)
    expect(applied).toBe(1)
    expect(fs.readdirSync(dir)).toEqual([])
  })
})
