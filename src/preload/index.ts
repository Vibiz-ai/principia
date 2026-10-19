import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { EVENT_NAMES, INVOKE_CHANNELS, SEND_CHANNELS, eventChannel, type EventMap, type EventName, type HiveApi, type IpcResult, type SendChannel, type SendMap } from '../shared/ipc'

/**
 * contextBridge copies only `message` from Error objects (name, code and errors are dropped), so a rejected Error
 * would arrive in the renderer without `code`. Reject with a plain cloneable object instead: it carries
 * `name === 'HiveError'`, `code`, `message`, optional `errors`, and a `toString()` for logging.
 */
function toError(e: { code: string; message: string; errors?: unknown }) {
  const text = `HiveError(${e.code}): ${e.message}`
  return {
    name: 'HiveError',
    code: e.code,
    message: e.message,
    ...(e.errors ? { errors: e.errors } : {}),
    stack: text,
    toString: () => text
  }
}

const api: Record<string, unknown> = {}
for (const channel of INVOKE_CHANNELS) {
  const [domain, method] = channel.split(':') as [string, string]
  const ns = (api[domain] ??= {}) as Record<string, unknown>
  ns[method] = async (req?: unknown) => {
    const res = (await ipcRenderer.invoke(channel, req)) as IpcResult<unknown>
    if (res.ok) return res.data
    throw toError(res.error)
  }
}

const sendable = new Set<string>(SEND_CHANNELS)
const events = new Set<string>(EVENT_NAMES)

api.send = <C extends SendChannel>(channel: C, payload: SendMap[C]) => {
  if (!sendable.has(channel)) throw new Error(`unknown send channel ${channel}`)
  ipcRenderer.send(channel, payload)
}
api.on = <E extends EventName>(event: E, cb: (payload: EventMap[E]) => void) => {
  if (!events.has(event)) throw new Error(`unknown event ${event}`)
  const ch = eventChannel(event)
  const listener = (_e: Electron.IpcRendererEvent, payload: EventMap[E]) => cb(payload)
  ipcRenderer.on(ch, listener)
  return () => ipcRenderer.removeListener(ch, listener)
}
api.pathForFile = (file: File) => webUtils.getPathForFile(file)
api.platform = 'darwin'

contextBridge.exposeInMainWorld('hive', api as unknown as HiveApi)
