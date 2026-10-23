/**
 * Connected header (docs/CLOUD.md §13.1): workspace name, one status (Online, or Offline since 03:12; runtime version,
 * sandbox, passport host and the last 24 h on hover only), Pause cloud with a confirm, and the Workspace ▾ menu
 * (usage, Devices with Revoke, Copy URL, Open on your phone as a QR of a fresh login link plus Copy, Disconnect). The
 * cloud's address lives in that menu, never as raw text in the header. There is no setup strip: the Accounts card and
 * the Companies card hold the only Connect and Run in the cloud buttons.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { CloudDevice, LoginLinkResponse } from '@shared/cloud'
import { Button, Popover, Switch } from '../ui'
import { statusLine, usageLine } from '../../lib/cloud'
import { confirmNative, errorMessage, hive } from '../../lib/hive'
import { toast } from '../../state/store'
import { refreshCloud, setCloudState, useCloud } from '../../state/cloud'
import { QrCode, Tess } from './bits'

export function CloudHeader(): ReactElement {
  const state = useCloud((s) => s.state)
  const summary = useCloud((s) => s.summary)
  const [menu, setMenu] = useState<DOMRect | null>(null)
  const wsBtn = useRef<HTMLButtonElement>(null)
  const st = statusLine({ online: !!state?.online, offlineSince: state?.offlineSince ?? null })
  const paused = !!summary?.workspace.paused
  const usage = usageLine(summary?.usage24h)
  const detail = summary ? `Runtime ${summary.runtime.version} · ${summary.runtime.sandbox} sandbox${summary.runtime.detail ? ` · ${summary.runtime.detail}` : ''}\nPassport host ${summary.passportHost.status === 'ok' ? 'up' : 'down'}${usage ? `\nLast ${usage}` : ''}` : undefined
  const pause = async (next: boolean): Promise<void> => {
    const ok = await confirmNative(
      next
        ? { message: 'Pause your cloud?', detail: 'Running cloud runs are canceled, no new runs start and schedules wait until you resume.', confirmLabel: 'Pause Cloud', destructive: true }
        : { message: 'Resume your cloud?', detail: 'Schedules fire again from their next slot.', confirmLabel: 'Resume' }
    )
    if (!ok) return
    try {
      await hive.cloud.pause({ paused: next })
      await refreshCloud()
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }
  return (
    <header className="cl-head drag">
      <div className="cl-head__id">
        <div className="cl-plabel">CLOUD</div>
        <div className="cl-pws">{state?.workspace?.name ?? 'Cloud'}</div>
      </div>
      <div className="cl-pstat" title={detail}>
        <Tess kind={st.tone === 'ok' ? 'ok' : 'fail'} />
        {st.label}
        {paused && <span className="cl-paused">Paused</span>}
      </div>
      {state?.error && <div className="cl-pstat cl-pstat--err">{state.error}</div>}
      <div className="cl-head__end no-drag">
        <button ref={wsBtn} type="button" className="cl-ws" aria-haspopup="dialog" onClick={() => setMenu(menu ? null : (wsBtn.current?.getBoundingClientRect() ?? null))}>
          Workspace ▾
        </button>
        <span className="cl-pause">Pause cloud</span>
        <Switch checked={paused} onChange={(v) => void pause(v)} label="Pause cloud" disabled={!summary} />
      </div>
      {menu && <WorkspaceMenu anchor={menu} onClose={() => setMenu(null)} />}
    </header>
  )
}

function WorkspaceMenu({ anchor, onClose }: { anchor: DOMRect; onClose: () => void }): ReactElement {
  const state = useCloud((s) => s.state)
  const usage = useCloud((s) => usageLine(s.summary?.usage24h))
  const [devices, setDevices] = useState<CloudDevice[] | null>(null)
  const [phone, setPhone] = useState<LoginLinkResponse | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void hive.cloud
      .devices()
      .catch(() => [])
      .then(setDevices)
  }, [])
  const openPhone = async (): Promise<void> => {
    setBusy(true)
    try {
      setPhone(await hive.cloud.loginLink())
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  const revoke = async (d: CloudDevice): Promise<void> => {
    if (!(await confirmNative({ message: `Remove ${d.name}?`, detail: 'It can no longer reach your cloud. Pair it again with a new connect link.', confirmLabel: 'Revoke', destructive: true }))) return
    try {
      setDevices(await hive.cloud.revokeDevice({ id: d.id }))
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }
  const disconnect = async (): Promise<void> => {
    if (!(await confirmNative({ message: 'Disconnect this Mac from your cloud?', detail: 'Companies keep working on this Mac. Schedules placed in the cloud keep firing there until you bring them back.', confirmLabel: 'Disconnect', destructive: true }))) return
    try {
      setCloudState(await hive.cloud.unlink())
      onClose()
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }
  return (
    <Popover anchor={anchor} onClose={onClose} width={300}>
      <div className="cl-menu">
        {usage && <div className="cl-menu__note">Last {usage}</div>}
        <div className="cl-menu__sect">Devices</div>
        {(devices ?? []).map((d) => (
          <div key={d.id} className="cl-dev">
            <span className="cl-dev__name">{d.name}</span>
            <span className="cl-dim">{d.id === state?.deviceId ? 'this Mac' : d.platform}</span>
            {d.id !== state?.deviceId && (
              <button type="button" className="cl-link" onClick={() => void revoke(d)}>
                Revoke
              </button>
            )}
          </div>
        ))}
        <div className="cl-menu__sep" />
        <button type="button" className="cl-menu__item" onClick={() => void hive.clipboard.writeText({ text: state?.url ?? '' }).then(() => toast('Cloud URL copied'))}>
          Copy URL
        </button>
        <button type="button" className="cl-menu__item" disabled={busy} onClick={() => void openPhone()}>
          Open on your phone
        </button>
        {phone && (
          <div className="cl-phone">
            <QrCode text={phone.url} />
            <p className="cl-dim">Scan with your phone's camera. The link works once, for 10 minutes.</p>
            <Button size="sm" onClick={() => void hive.clipboard.writeText({ text: phone.url }).then(() => toast('Sign-in link copied'))}>
              Copy link
            </Button>
          </div>
        )}
        <div className="cl-menu__sep" />
        <button type="button" className="cl-menu__item cl-menu__item--danger" onClick={() => void disconnect()}>
          Disconnect
        </button>
      </div>
    </Popover>
  )
}
