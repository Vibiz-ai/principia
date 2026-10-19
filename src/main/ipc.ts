import { ipcMain, type WebContents } from 'electron'
import {
  INVOKE_CHANNELS,
  eventChannel,
  type EventMap,
  type EventName,
  type InvokeChannel,
  type InvokeReq,
  type InvokeRes,
  type IpcResult,
  type SendChannel,
  type SendMap
} from '../shared/ipc'
import { HiveError } from '../shared/errors'
import { REQUEST_SCHEMAS, SEND_SCHEMAS, zodErrors } from './ipcSchemas'
import { log } from './log'

type Handler<C extends InvokeChannel> = (req: InvokeReq<C>, sender: WebContents) => InvokeRes<C> | Promise<InvokeRes<C>>
const registered = new Set<InvokeChannel>()
let isTrustedSender: (wc: WebContents) => boolean = () => true

/** Only the main window's webContents may call in (defense in depth; there is no other renderer). */
export function setTrustedSender(fn: (wc: WebContents) => boolean): void {
  isTrustedSender = fn
}

/** Validates a request against its zod schema. Throws HiveError('bad_request', ..., errors). */
export function parseRequest<C extends InvokeChannel>(channel: C, raw: unknown): InvokeReq<C> {
  const schema = REQUEST_SCHEMAS[channel]
  const r = schema.safeParse(raw)
  if (!r.success) {
    const errors = zodErrors(r.error)
    throw new HiveError('bad_request', `${channel}: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, errors)
  }
  return r.data as InvokeReq<C>
}

/** Register a typed invoke handler. Requests are zod-validated; errors return { ok:false, error } (preload rethrows). */
export function handle<C extends InvokeChannel>(channel: C, fn: Handler<C>): void {
  registered.add(channel)
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, async (event, raw): Promise<IpcResult<InvokeRes<C>>> => {
    try {
      if (!isTrustedSender(event.sender)) throw new HiveError('forbidden', 'Unknown sender')
      const req = parseRequest(channel, raw)
      return { ok: true, data: await fn(req, event.sender) }
    } catch (e) {
      const err = HiveError.from(e)
      if (err.code === 'internal') log.error(`[ipc] ${channel}: ${err.message}`, { stack: e instanceof Error ? e.stack : undefined })
      return { ok: false, error: err.toJSON() }
    }
  })
}

export function onSend<C extends SendChannel>(channel: C, fn: (payload: SendMap[C], sender: WebContents) => void): void {
  ipcMain.removeAllListeners(channel)
  ipcMain.on(channel, (event, raw) => {
    if (!isTrustedSender(event.sender)) return
    const r = SEND_SCHEMAS[channel].safeParse(raw)
    if (!r.success) return
    try {
      fn(r.data as SendMap[C], event.sender)
    } catch (e) {
      log.error(`[ipc] send ${channel}: ${e instanceof Error ? e.message : String(e)}`)
    }
  })
}

/** Channels in the contract without a handler answer with a clear error instead of hanging. */
export function registerMissingAsNotImplemented(): InvokeChannel[] {
  const missing = INVOKE_CHANNELS.filter((c) => !registered.has(c))
  for (const c of missing) {
    ipcMain.handle(c, async (): Promise<IpcResult<never>> => ({
      ok: false,
      error: { code: 'internal', message: `${c} not implemented yet` }
    }))
  }
  return missing
}

let targets: () => WebContents[] = () => []
export function setEventTargets(fn: () => WebContents[]): void {
  targets = fn
}
export function emit<E extends EventName>(event: E, payload: EventMap[E]): void {
  for (const wc of targets()) if (!wc.isDestroyed()) wc.send(eventChannel(event), payload)
}
