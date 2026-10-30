/**
 * REMOTE.md: Phone inside Principia's main process. The host is the desktop's own IPC handlers (invokeLocal, on the
 * fixed PHONE_CHANNELS list) and its event stream (onEmit); the bundle is out/phone next to out/main.
 */
import path from 'node:path'
import type { Hive } from '../hive'
import { emit, handle, invokeLocal, onEmit } from '../ipc'
import { log } from '../log'
import { HiveError } from '../../shared/errors'
import type { InvokeReq, InvokeRes } from '../../shared/ipc'
import { phoneSiteOrigin, type RemoteState } from '../../shared/remote'
import { PHONE_CHANNELS, type PhoneChannel, type PhoneHost } from './api'
import type { PhoneTerminalHost } from './terminalFeed'
import type { DB } from '../db'
import { SqliteDeviceStore } from './devices'
import { RemoteService } from './service'
import { fileKeep, findCloudflared } from './tunnel'

const allowed = new Set<string>(PHONE_CHANNELS)

export function createRemote(o: { mainDir: string; envPath: () => string | undefined; dataDir: string; siteSetting?: () => string | null | undefined; db?: DB | null; autoStartSetting?: () => boolean | null | undefined; terminal?: PhoneTerminalHost }): RemoteService {
  const host: PhoneHost = {
    invoke: <C extends PhoneChannel>(channel: C, req: InvokeReq<C>): Promise<InvokeRes<C>> => {
      // defense in depth: the type already limits the list
      if (!allowed.has(channel)) return Promise.reject(new HiveError('forbidden', 'Not from the phone'))
      return invokeLocal(channel, req)
    },
    onEvent: (fn) => onEmit(fn),
    // the Mac's New conversation › Claude directly (TeamComposer): no folder, Claude, the first message
    newChat: ({ companyId, text, title }) => invokeLocal('sessions:create', { companyId, adapter: 'claude', repoId: null, cols: 120, rows: 32, initialPrompt: text, title }),
    ...(o.terminal ? { terminal: o.terminal, redact: (t: string) => o.terminal!.redact(t) } : {}),
    log
  }
  return new RemoteService({
    host,
    bundleDir: path.join(o.mainDir, '..', 'phone'),
    emit: (s) => emit('remote:changed', s),
    // RA8: the tunnel outlives a Quit, so its address does
    tunnel: { bin: () => findCloudflared(o.envPath()), keep: fileKeep(path.join(o.dataDir, 'phone-tunnel.json'), path.join(o.dataDir, 'logs', 'phone-tunnel.log')) },
    // RA6: read each time, so a new Phone app address applies to the next code and request
    site: () => phoneSiteOrigin(o.siteSetting?.()),
    // RA2: paired phones survive restarts (token hashes only)
    devices: o.db ? new SqliteDeviceStore(o.db) : undefined,
    autoStart: o.autoStartSetting,
    log
  })
}

export function registerRemoteHandlers(h: Hive): void {
  const svc = (): RemoteService => {
    if (!h.remote) throw new HiveError('internal', 'Phone is not available in this Principia')
    return h.remote
  }
  const wrap = async <T>(f: () => Promise<T> | T): Promise<T> => {
    try {
      return await f()
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === 'conflict') throw new HiveError('conflict', (e as Error).message)
      throw e
    }
  }
  handle('remote:state', (): RemoteState => (h.remote ? h.remote.state() : { enabled: false, localUrl: null, tunnel: { state: 'off', url: null, message: null }, devices: [], autoStart: false }))
  handle('remote:setEnabled', ({ on }) => wrap(() => svc().setEnabled(on)))
  handle('remote:tunnel', ({ on }) => wrap(() => svc().setTunnel(on)))
  handle('remote:pairLink', () => wrap(() => svc().pairLink()))
  handle('remote:revoke', ({ id }) => svc().revoke(id))
  handle('remote:signOutAll', () => svc().signOutAll())
}
