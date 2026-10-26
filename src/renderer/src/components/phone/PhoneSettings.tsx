/**
 * Settings › App › Phone (REMOTE.md): one switch for the server on this Mac, one button for the tunnel, a QR code with
 * a one-time link, and the paired phones with Revoke. Plain words about what it opens and what it never does.
 */
import { useEffect, useState } from 'react'
import type { RemotePairLink } from '@shared/remote'
import { Button, RelativeTime, Switch } from '../ui'
import { QrCode } from '../cloud/bits'
import { hive } from '../../lib/hive'
import { attempt, toast } from '../../state/store'
import { setRemote, useRemote } from '../../state/remote'
import '../../styles/cloud.css'
import '../../styles/phone.css'

export function PhoneSettings(): React.JSX.Element {
  const st = useRemote()
  const on = !!st?.enabled
  const tunnel = st?.tunnel ?? { state: 'off' as const, url: null, message: null }
  const [link, setLink] = useState<RemotePairLink | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  // a link made before the tunnel came up (or went away) points at the wrong address: make a new one
  useEffect(() => {
    if (!on) setLink(null)
    else if (link && link.public !== (tunnel.state === 'on')) void fresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, tunnel.state])
  const expired = !!link && Date.parse(link.expiresAt) <= now
  const fresh = async (): Promise<void> => {
    const l = await attempt(() => hive.remote.pairLink(), 'Phone')
    if (l) setLink(l)
  }
  const run = async (f: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    await attempt(async () => {
      const s = (await f()) as Awaited<ReturnType<typeof hive.remote.state>>
      setRemote(s)
    }, 'Phone')
    setBusy(false)
  }
  const toggle = (v: boolean): Promise<void> =>
    run(async () => {
      const s = await hive.remote.setEnabled({ on: v })
      if (v) setLink(await hive.remote.pairLink())
      return s
    })
  const secs = link ? Math.max(0, Math.round((Date.parse(link.expiresAt) - now) / 1000)) : 0
  return (
    <>
      <div className="s5">
        <h2 className="s5__title">Phone</h2>
        <p className="s5__lede">See what your agents are doing from your phone, answer what needs you, and keep a chat or the team room going. Settings, keys, terminals and repositories stay on this Mac.</p>
      </div>
      <div className="sgroup">
        <div className="srow">
          <div className="srow__text">
            <div>Phone</div>
            <div className="srow__desc">{on ? `On. A small server runs on this Mac only (${st?.localUrl ?? ''}).` : 'Off. Nothing on this Mac listens for your phone.'}</div>
          </div>
          <div className="srow__ctl">
            <Switch checked={on} disabled={busy} onChange={(v) => void toggle(v)} label="Phone" />
          </div>
        </div>
        {on && (
          <div className="srow">
            <div className="srow__text">
              <div>Reach it from anywhere</div>
              <div className="srow__desc">
                {tunnel.state === 'on'
                  ? `Shared through a private tunnel: ${tunnel.url}`
                  : tunnel.state === 'starting'
                    ? 'Opening the tunnel…'
                    : tunnel.message ?? 'Opens a private tunnel (cloudflared) so your phone can reach this Mac over the internet. Only paired phones get in.'}
              </div>
            </div>
            <div className="srow__ctl">
              {tunnel.state === 'on' || tunnel.state === 'starting' ? (
                <Button size="sm" disabled={busy} onClick={() => void run(() => hive.remote.tunnel({ on: false }))}>
                  Stop sharing
                </Button>
              ) : (
                <Button size="sm" variant="primary" disabled={busy} onClick={() => void run(() => hive.remote.tunnel({ on: true }))}>
                  {tunnel.state === 'error' || tunnel.state === 'missing' ? 'Try again' : 'Share over the internet'}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      {on && (
        <div className="sgroup">
          <div className="sgroup__title">Pair a phone</div>
          <div className="phone-pair">
            {/* a phone cannot open a 127.0.0.1 link: no QR until the tunnel gives a real address */}
            {link?.public && !expired ? <QrCode text={link.link} size={176} /> : <div className="phone-pair__qr-empty">{expired ? 'This code expired.' : tunnel.state !== 'on' ? 'Share over the internet first' : 'No code yet.'}</div>}
            <div className="phone-pair__text">
              <p>{tunnel.state === 'on' ? 'Scan with your phone’s camera. The code works once, for 5 minutes, and a new code cancels the old one.' : 'Your phone reaches this Mac through the tunnel. Tap Share over the internet above, then scan the code that shows here.'}</p>
              {link && !expired && <p className="text-tertiary">Expires in {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</p>}
              <div className="phone-pair__btns">
                {tunnel.state === 'on' && (
                  <Button size="sm" variant={link && !expired ? undefined : 'primary'} onClick={() => void fresh()}>
                    New code
                  </Button>
                )}
                {link && !expired && (
                  <Button
                    size="sm"
                    onClick={() =>
                      void attempt(async () => {
                        await hive.clipboard.writeText({ text: link.link })
                        toast(link.public ? 'Link copied. It works once.' : 'Link copied. It opens on this Mac only.')
                      })
                    }
                  >
                    {link.public ? 'Copy link' : 'Copy a link for this Mac'}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {on && (
        <div className="sgroup">
          <div className="sgroup__title">Paired phones</div>
          {!st?.devices.length ? (
            <div className="srow">
              <div className="srow__text">
                <div className="srow__desc">No phone yet.</div>
              </div>
            </div>
          ) : (
            st.devices.map((d) => (
              <div className="srow" key={d.id}>
                <div className="srow__text">
                  <div>
                    <span className={`phone-dot ${d.online ? 'is-on' : ''}`} aria-hidden /> {d.name}
                  </div>
                  <div className="srow__desc">
                    {d.online ? 'Connected now' : d.lastSeenAt ? <>Last seen <RelativeTime iso={d.lastSeenAt} /></> : 'Paired'}
                  </div>
                </div>
                <div className="srow__ctl">
                  <Button size="sm" onClick={() => void run(() => hive.remote.revoke({ id: d.id }))}>
                    Revoke
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      <div className="sgroup phone-facts">
        <div className="sgroup__title">What it opens</div>
        <ul>
          <li>Off by default, and off again every time Principia starts. Turning it off signs every phone out.</li>
          <li>The server listens on this Mac only (127.0.0.1). The tunnel is outbound, and only while it is on.</li>
          <li>From the phone: watch, answer, approve, send back, pause a company, chat. Never settings, keys, shell commands, repositories, workflows, deleting or spending.</li>
        </ul>
      </div>
    </>
  )
}
