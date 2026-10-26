/**
 * Settings › App › Phone (REMOTE.md): one switch for the server on this Mac, one button for the tunnel, a QR code with
 * a one-time link, and the paired phones (kept across restarts) with Revoke and Sign out all phones. RA8: "Turn Phone
 * on when Principia starts", and the Mac's new address for phones that are already paired. Plain words about what it
 * opens and what it never does.
 */
import { useEffect, useState } from 'react'
import { moveLinkFor, PHONE_SITE_URL, phoneSiteOrigin, siteOrigin, tunnelWords, type RemotePairLink } from '@shared/remote'
import { Button, RelativeTime, Switch } from '../ui'
import { QrCode } from '../cloud/bits'
import { confirmNative, hive } from '../../lib/hive'
import { attempt, toast, updateSettings, useStore } from '../../state/store'
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
  const site = phoneSiteOrigin(useStore((x) => x.settings?.phoneSiteUrl))
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  // a link made before the tunnel came up (or went away) points at the wrong address: make a new one
  useEffect(() => {
    if (!on) setLink(null)
    else if (link && (link.public !== (tunnel.state === 'on') || (link.site ?? null) !== site)) void fresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, tunnel.state, site])
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
  const devices = st?.devices ?? []
  const signOutAll = async (): Promise<void> => {
    const ok = await confirmNative({ message: `Sign out ${devices.length === 1 ? 'your phone' : `all ${devices.length} phones`}?`, detail: 'Each phone has to scan a new code to get back in.', confirmLabel: 'Sign Out', destructive: true })
    if (ok) await run(() => hive.remote.signOutAll())
  }
  const setAutoStart = (v: boolean): Promise<void> =>
    run(async () => {
      await updateSettings({ phoneAutoStart: v })
      return hive.remote.state()
    })
  // RA8: a paired phone whose Mac moved (a new quick-tunnel address after a restart) takes these words or this link
  const words = tunnel.state === 'on' ? tunnelWords(tunnel.url) : null
  const moveLink = tunnel.state === 'on' && tunnel.url && site ? moveLinkFor({ site, mac: tunnel.url }) : null
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
            <div className="srow__desc">{on ? `On. A small server runs on this Mac only (${st?.localUrl ?? ''}).` : `Off. Nothing on this Mac listens for your phone.${devices.length ? ' Paired phones stay paired and get back in when Phone is on again.' : ''}`}</div>
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
        <div className="srow">
          <div className="srow__text">
            <div>Turn Phone on when Principia starts</div>
            <div className="srow__desc">Phone and its tunnel come back by themselves after a restart or an update, so paired phones get back in without a new code. On by default once a phone is paired.</div>
          </div>
          <div className="srow__ctl">
            <Switch checked={!!st?.autoStart} disabled={busy} onChange={(v) => void setAutoStart(v)} label="Turn Phone on when Principia starts" />
          </div>
        </div>
        <PhoneSiteRow />
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

      {(on || devices.length > 0) && (
        <div className="sgroup">
          <div className="sgroup__title">Paired phones</div>
          {!devices.length ? (
            <div className="srow">
              <div className="srow__text">
                <div className="srow__desc">No phone yet.</div>
              </div>
            </div>
          ) : (
            devices.map((d) => (
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
          {devices.length > 0 && words && (
            <div className="phone-pair">
              {moveLink ? <QrCode text={moveLink} size={132} /> : null}
              <div className="phone-pair__text">
                <p>A phone that says it cannot reach this Mac (its address changes when Principia restarts): type these words in it, or scan this with its camera. No new code: it is still paired.</p>
                <p>
                  <strong className="selectable">{words}</strong>
                </p>
                {moveLink && (
                  <div className="phone-pair__btns">
                    <Button
                      size="sm"
                      onClick={() =>
                        void attempt(async () => {
                          await hive.clipboard.writeText({ text: moveLink })
                          toast('Link copied. Only a phone paired with this Mac can use it.')
                        })
                      }
                    >
                      Copy the new address
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}
          {devices.length > 0 && (
            <div className="srow">
              <div className="srow__text">
                <div className="srow__desc">Signs every phone out. Each has to scan a new code to get back in.</div>
              </div>
              <div className="srow__ctl">
                <Button size="sm" disabled={busy} onClick={() => void signOutAll()}>
                  Sign out all phones
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="sgroup phone-facts">
        <div className="sgroup__title">What it opens</div>
        <ul>
          <li>Off until you turn it on. Once a phone is paired, it comes back on when Principia starts (you can turn that off above).</li>
          <li>Paired phones stay paired across restarts and updates. This Mac keeps only a fingerprint of each phone’s key, never the key. A phone unused for 90 days is signed out; Revoke or Sign out all phones signs out at once.</li>
          <li>The server listens on this Mac only (127.0.0.1). The tunnel is outbound, and only while it is on.</li>
          <li>From the phone: watch, answer, approve, send back, pause a company, chat. Never settings, keys, shell commands, repositories, workflows, deleting or spending.</li>
          <li>The phone app address is only a page: it keeps no data. Everything it shows comes from this Mac, and only a paired phone gets in.</li>
        </ul>
      </div>
    </>
  )
}

/**
 * REMOTE.md RA6: "Phone app address", the hosted phone app the code opens, and the one origin this Mac accepts from a
 * browser on another site. Empty: the code opens this Mac's own page through the tunnel.
 */
function PhoneSiteRow(): React.JSX.Element {
  const saved = useStore((x) => x.settings?.phoneSiteUrl)
  const shown = saved === '' ? '' : (saved ?? PHONE_SITE_URL ?? '')
  const [v, setV] = useState(shown)
  const [bad, setBad] = useState(false)
  useEffect(() => setV(shown), [shown])
  const commit = (): void => {
    const url = v.trim().replace(/\/+$/, '')
    if (url === shown) return setBad(false)
    if (url && siteOrigin(url) !== url) return setBad(true)
    setBad(false)
    // the official address again = null (follows the default if it ever moves)
    void updateSettings({ phoneSiteUrl: url === (PHONE_SITE_URL ?? '') && url ? null : url })
  }
  const official = saved == null
  return (
    <div className="srow">
      <div className="srow__text">
        <div>Phone app address</div>
        <div className="srow__desc">
          {bad
            ? 'Use the site address only, like https://phone.example.com.'
            : v.trim()
              ? `The code opens this page, which then talks to this Mac directly. It keeps no data.${official && PHONE_SITE_URL ? ' (the official address)' : ''}`
              : 'Empty: the code opens this Mac’s own page through the tunnel.'}
        </div>
      </div>
      <div className="srow__ctl" style={{ gap: 8 }}>
        <input
          className="input"
          style={{ width: 260 }}
          placeholder="https://…"
          aria-label="Phone app address"
          value={v}
          spellCheck={false}
          onChange={(e) => setV(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
        />
        {!official && PHONE_SITE_URL && (
          <Button size="sm" onClick={() => void updateSettings({ phoneSiteUrl: null })}>
            Use official
          </Button>
        )}
      </div>
    </div>
  )
}
