/**
 * PR-30: "Sign in to Claude" without Terminal. A Claude Desktop or claude.ai sign-in doesn't sign in Claude Code, the
 * part that runs agents; this runs `claude auth login` for the user (main opens the browser on claude.com) and calls
 * `onDone` when it finishes, so the page can read the sign-in again. If the browser didn't open: the sign-in page and
 * a field for the code it shows.
 */
import { useEffect, useRef, useState } from 'react'
import { Button } from './ui'
import { hive } from '../lib/hive'

/** The plain-words reason, said wherever we offer the button. */
export const DESKTOP_SIGN_IN_NOTE = 'Signed in to the Claude app? That sign-in stays in the app: Claude Code, which runs your agents, needs its own. It takes one click.'

type Phase = 'idle' | 'starting' | 'waiting' | 'failed'

export function ClaudeSignInButton({ onDone, size = 'sm' }: { onDone: () => void | Promise<void>; size?: 'sm' | 'md' }): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle')
  const [url, setUrl] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [showCode, setShowCode] = useState(false)
  const [code, setCode] = useState('')
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    []
  )

  const start = async (): Promise<void> => {
    setPhase('starting')
    setMessage(null)
    setShowCode(false)
    setCode('')
    try {
      const s = await hive.providers.claudeSignIn()
      if (!alive.current) return
      if (s.phase !== 'started') {
        setPhase(s.phase === 'failed' ? 'failed' : 'idle')
        setMessage(s.message)
        if (s.phase === 'done') await onDone()
        return
      }
      setUrl(s.url)
      setPhase('waiting')
      const end = await hive.providers.claudeSignInWait()
      if (!alive.current) return
      if (end.phase === 'done') {
        setPhase('idle')
        await onDone()
      } else {
        setPhase(end.phase === 'failed' ? 'failed' : 'idle')
        setMessage(end.message)
      }
    } catch {
      if (!alive.current) return
      setPhase('failed')
      setMessage('Claude Code didn’t start. Try again.')
    }
  }

  const sendCode = async (): Promise<void> => {
    const r = await hive.providers.claudeSignInCode({ code: code.trim() }).catch(() => ({ ok: false }))
    if (!alive.current) return
    if (r.ok) setMessage('Checking the code…')
    else setMessage('That doesn’t look like the code from the page. Copy it again and paste it here.')
  }

  if (phase === 'waiting')
    return (
      <div className="claude-signin is-waiting" role="status">
        <div className="srow__desc">Your browser is open on claude.com. Approve there, then come back: this updates by itself.</div>
        <div className="s5-inline">
          {url && !showCode && (
            <button type="button" className="link-btn" onClick={() => (setShowCode(true), void hive.app.openExternal({ url }).catch(() => undefined))}>
              Browser didn’t open?
            </button>
          )}
          <Button size="sm" variant="ghost" onClick={() => void hive.providers.claudeSignInCancel()}>
            Cancel
          </Button>
        </div>
        {showCode && (
          <form
            className="s5-inline"
            onSubmit={(e) => {
              e.preventDefault()
              void sendCode()
            }}
          >
            <input className="input mono" autoFocus autoComplete="off" placeholder="Paste the code the page shows" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Sign-in code" />
            <Button size="sm" variant="primary" type="submit" disabled={!code.trim()}>
              Use code
            </Button>
          </form>
        )}
        {message && <div className="srow__desc">{message}</div>}
      </div>
    )

  return (
    <span className="claude-signin">
      <Button size={size} variant="primary" disabled={phase === 'starting'} onClick={() => void start()}>
        {phase === 'starting' ? 'Opening claude.com…' : phase === 'failed' ? 'Try signing in again' : 'Sign in to Claude'}
      </Button>
      {message && <span className="srow__desc"> {message}</span>}
    </span>
  )
}
