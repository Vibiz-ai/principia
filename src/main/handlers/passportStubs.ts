/**
 * PASSPORT.md §11: the Passport channels are declared (schemas in ipcSchemas.ts, types in shared/passport.ts) before
 * P3 implements them. Until then each one validates its request and answers `not_implemented`, so the renderer can be
 * built against the contract. Registered before the memory handlers, which replace these by registering the same
 * channels (ipc.ts `handle` swaps the handler).
 */
import type { InvokeChannel } from '../../shared/ipc'
import { HiveError } from '../../shared/errors'
import { handle } from '../ipc'

export const PASSPORT_CHANNELS = ['memory:note', 'memory:links', 'memory:proposals', 'memory:vault'] as const satisfies readonly InvokeChannel[]

export function notImplemented(channel: string, op?: string): never {
  throw new HiveError('not_implemented', `${channel}${op ? ` ${op}` : ''} is not available yet (the Passport vault ships behind experimental.vault)`)
}

export function registerPassportStubs(): void {
  for (const c of PASSPORT_CHANNELS) handle(c, (req) => notImplemented(c, req.op))
}
