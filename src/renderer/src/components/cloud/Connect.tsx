/**
 * Not connected (docs/CLOUD.md §13.1, §12.1): the arch-and-cloud line drawing, one field ("Paste your connect link")
 * and Connect. The connect link is the one string; URL plus code appears only after a paste fails. Below: no cloud
 * yet? One button (Render: an always-on cloud with its own https address, no tunnel), or one downloaded compose file
 * on a machine you own.
 */
import { useState, type ReactElement } from 'react'
import { parseConnectLink } from '@shared/cloud'
import { Button } from '../ui'
import { CLOUD_SETUP_URL, COMPOSE_COMMANDS, RENDER_DEPLOY_URL } from '../../lib/cloud'
import { errorMessage, hive } from '../../lib/hive'
import { setCloudState, useCloud } from '../../state/cloud'

/** @deprecated kept for older imports: the one-file path is COMPOSE_COMMANDS (lib/cloud) */
export const COMPOSE_COMMAND = COMPOSE_COMMANDS

/** The arch with a cloud under it (VOICE.md §5: white hairlines, opacity tiers). */
export function ArchCloud({ width = 150 }: { width?: number }): ReactElement {
  return (
    <svg className="cl-arch rm-la" width={width} height={(width * 110) / 160} viewBox="0 0 160 110" fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path strokeOpacity={0.9} d="M14 104h132M24 104V54a56 56 0 0 1 112 0v50" />
      <path strokeOpacity={0.5} d="M38 104V56a42 42 0 0 1 84 0v48" />
      <path strokeOpacity={0.5} d="M58 80h44a12 12 0 0 0 1-24 18 18 0 0 0-34-4 13 13 0 0 0-11 28z" />
      <path strokeOpacity={0.2} d="M80 2v8M66 5l3 7M94 5l-3 7" />
    </svg>
  )
}

export function NotConnected(): ReactElement {
  const encryption = useCloud((s) => s.state?.encryption !== false)
  const [link, setLink] = useState('')
  const [manual, setManual] = useState(false)
  const [url, setUrl] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = manual ? !!url.trim() && code.replace(/[^0-9a-z]/gi, '').length === 8 : !!parseConnectLink(link)
  const connect = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setCloudState(await hive.cloud.pair(manual ? { url: url.trim(), code: code.trim() } : { link: link.trim() }))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="cl-connect">
      <div className="cl-mini">
        <ArchCloud />
        <h3 className="cl-mini__h">Keep your agents working while your Mac sleeps</h3>
        <p className="cl-mini__p">Schedules, connectors and your Passport keep running in your cloud. You answer from your phone.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (ready && !busy) void connect()
          }}
        >
          {!manual ? (
            <label className="cl-field">
              <span>Paste your connect link</span>
              <input className="input cl-mono" placeholder="https://cloud.example.com/pair#K7QM-4XWD" value={link} spellCheck={false} autoFocus onChange={(e) => setLink(e.target.value)} />
            </label>
          ) : (
            <>
              <label className="cl-field">
                <span>Cloud URL</span>
                <input className="input cl-mono" placeholder="https://cloud.example.com" value={url} spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
              </label>
              <label className="cl-field">
                <span>Pairing code</span>
                <input className="input cl-mono" placeholder="K7QM-4XWD" value={code} maxLength={9} spellCheck={false} onChange={(e) => setCode(e.target.value.toUpperCase())} />
              </label>
            </>
          )}
          {error && <p className="cl-error selectable">{error}</p>}
          {!encryption && <p className="cl-error">macOS Keychain encryption is unavailable, so Principia can't store a cloud token on this Mac.</p>}
          <div className="cl-row">
            <Button variant="primary" disabled={!ready || busy || !encryption} onClick={() => void connect()}>
              {busy ? 'Connecting…' : 'Connect'}
            </Button>
            {(manual || error) && (
              <button type="button" className="cl-link" onClick={() => setManual(!manual)}>
                {manual ? 'Paste a connect link' : 'Enter URL and code instead'}
              </button>
            )}
          </div>
        </form>
        <div className="cl-start">
          <p className="cl-dim cl-mini__gap">No cloud yet? One button gives you an always-on cloud with its own https address. Its log shows your connect link.</p>
          <div className="cl-row">
            <Button onClick={() => void hive.app.openExternal({ url: RENDER_DEPLOY_URL })}>Deploy on Render</Button>
            <button type="button" className="cl-link" onClick={() => void hive.app.openExternal({ url: CLOUD_SETUP_URL })}>
              Other ways
            </button>
          </div>
          <p className="cl-dim">Or on an always-on machine you own (one file, no clone):</p>
          <pre className="cl-pre selectable">{COMPOSE_COMMANDS}</pre>
          <p className="cl-dim">Managed Principia Cloud is coming. Self-hosting is free forever.</p>
        </div>
      </div>
    </div>
  )
}
