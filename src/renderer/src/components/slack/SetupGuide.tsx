/**
 * Settings › Connections › Slack (SLACK.md §3.2, §12.1, PO-S1): the status card, the 4-step guide in Slack's own page
 * order (Create the app → app-level token → Install + bot token → Connect → say hi), and the connected controls.
 * Token fields never echo a saved value; the renderer only ever sees masked tokens.
 */
import { useEffect, useState } from 'react'
import type { ValidationError } from '@shared/types'
import { Button, Disclosure, RelativeTime, Segmented, Stepper } from '../ui'
import { Icon } from '../Icon'
import { confirmNative, errorMessage, hive } from '../../lib/hive'
import { slackCall } from '../../lib/slackApi'
import { joinablePublic, manifestCreateUrl, syncLine, tokenProblem } from '../../lib/slack'
import { acceptAlertSuggestion, isSetUp, loadSlack, refreshChannels, refreshUsers, setSlack, useSlack } from '../../state/slack'
import { attempt, navigate, toast, updateSettings, useStore } from '../../state/store'
import { SlackStatusPill } from './bits'

type Check = 'idle' | 'running' | 'ok' | 'fail'
interface Checklist {
  app: Check
  bot: Check
  socket: Check
  scopes: Check
  missing: string[]
}
const IDLE: Checklist = { app: 'idle', bot: 'idle', socket: 'idle', scopes: 'idle', missing: [] }

export function SlackConnectionCard(): React.JSX.Element {
  const available = useSlack((s) => s.available)
  const status = useSlack((s) => s.status)
  const setUp = isSetUp(status)
  const [showSetup, setShowSetup] = useState(false)
  useEffect(() => {
    if (available === null) void loadSlack()
  }, [available])

  if (available === false)
    return (
      <div className="sgroup">
        <div className="sgroup__title">Slack</div>
        <div className="srow">
          <div className="srow__text">
            <div>Slack isn’t available in this build yet.</div>
            <div className="srow__desc">Update Principia to connect a Slack workspace.</div>
          </div>
        </div>
      </div>
    )
  return (
    <div className="sgroup slack-conn">
      <div className="sgroup__title">
        Slack
        <span className="flex1" />
        {status?.fake && <span className="pill pill--failed">FAKE SLACK</span>}
        <SlackStatusPill />
      </div>
      {status && setUp && <ConnectedRows />}
      {(!setUp || showSetup) && <SetupSteps replacing={setUp} onDone={() => setShowSetup(false)} />}
      {setUp && !showSetup && (
        <div className="srow">
          <div className="srow__text">
            <div className="srow__desc">Replace the tokens, for example after reinstalling the app with new scopes.</div>
          </div>
          <Button size="sm" onClick={() => setShowSetup(true)}>
            Replace tokens…
          </Button>
        </div>
      )}
    </div>
  )
}

function ConnectedRows(): React.JSX.Element {
  const status = useSlack((s) => s.status)!
  const channels = useSlack((s) => s.channels)
  const backfillDays = useStore((s) => s.settings?.slackBackfillDays ?? 7)
  const alertUser = useStore((s) => s.settings?.slackAlertUserId ?? null)
  const [busy, setBusy] = useState<string | null>(null)
  const sync = syncLine(status)
  const joinable = joinablePublic(channels)
  const retry = async (): Promise<void> => {
    setBusy('retry')
    const r = await attempt(() => slackCall('slack:retry'), 'Retry')
    if (r) setSlack({ status: r })
    setBusy(null)
  }
  const disconnect = async (): Promise<void> => {
    const ok = await confirmNative({
      message: `Disconnect ${status.workspace?.name ?? 'Slack'}?`,
      detail: 'Principia stops reading Slack and its Slack triggers turn off. This does not uninstall the app: remove it in Slack › Manage apps to revoke it there.',
      confirmLabel: 'Disconnect',
      destructive: true
    }).catch(() => false)
    if (!ok) return
    const purge = await confirmNative({
      message: 'Also delete Principia’s copy of the messages?',
      detail: 'Triggers are kept (turned off). Keep the copy if you plan to reconnect the same workspace.',
      confirmLabel: 'Delete Messages',
      destructive: true
    }).catch(() => false)
    setBusy('disconnect')
    const r = await attempt(() => slackCall('slack:disconnect', { purge }), 'Disconnect')
    setBusy(null)
    if (r) {
      setSlack({ status: r, channels: purge ? [] : channels })
      toast(purge ? 'Slack disconnected; local messages deleted' : 'Slack disconnected')
    }
  }
  const syncNow = async (): Promise<void> => {
    setBusy('sync')
    const r = await attempt(() => slackCall('slack:backfill', { days: backfillDays }), 'Sync')
    if (r) setSlack({ status: r })
    setBusy(null)
  }
  return (
    <>
      {status.alertSuggestion && !alertUser && (
        <div className="srow slack-suggest">
          <Icon name="chat" size={14} />
          <div className="srow__text">
            <div>
              Got it from <strong>{status.alertSuggestion.name}</strong>. Send your alerts here?
            </div>
            <div className="srow__desc">Notify steps and (if you turn it on) Needs-you alerts DM this person on Slack.</div>
          </div>
          <Button size="sm" variant="primary" onClick={() => void acceptAlertSuggestion()}>
            Yes
          </Button>
        </div>
      )}
      {status.error && (
        <div className="srow">
          <div className="srow__text">
            <div className="text-failed selectable">{status.error}</div>
          </div>
          <Button size="sm" onClick={() => void retry()} disabled={busy === 'retry'}>
            Retry now
          </Button>
        </div>
      )}
      {[...status.warnings, ...(status.missingScopes.length ? [`Reinstall the app: missing ${status.missingScopes.join(', ')}`] : [])].map((w) => (
        <div key={w} className="srow">
          <div className="srow__text">
            <div className="text-warning selectable">⚠ {w}</div>
          </div>
        </div>
      ))}
      <div className="srow">
        <div className="srow__text">
          <div>{status.workspace ? `${status.workspace.name} · @${status.workspace.botName}` : 'Workspace'}</div>
          <div className="srow__desc mono">
            {status.tokens.app ?? 'xapp-…'} · {status.tokens.bot ?? 'xoxb-…'}
          </div>
          <div className="srow__desc">
            {status.lastEventAt ? (
              <>
                Last event <RelativeTime iso={status.lastEventAt} />
              </>
            ) : (
              'No events yet'
            )}
            {sync && ` · ${sync}`}
            {status.sync.rateLimitedUntil && (
              <>
                {' · '}Slack is rate-limiting history reads; resuming <RelativeTime iso={status.sync.rateLimitedUntil} />
              </>
            )}
          </div>
        </div>
        {status.state === 'reconnecting' && (
          <Button size="sm" onClick={() => void retry()} disabled={busy === 'retry'}>
            Retry now
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => void navigate({ name: 'slack' })}>
          Open Slack
        </Button>
        <Button size="sm" onClick={() => void disconnect()} disabled={busy === 'disconnect'}>
          Disconnect…
        </Button>
      </div>
      {joinable.length > 0 && <JoinAllRow count={joinable.length} />}
      <div className="srow">
        <div className="srow__text">
          <div>Keep the last {backfillDays} days</div>
          <div className="srow__desc">How far back Principia copies history when it joins a channel. Older pages load on request.</div>
        </div>
        <Stepper value={backfillDays} min={0} max={90} onChange={(v) => void updateSettings({ slackBackfillDays: v })} label="Backfill days" />
        <Button size="sm" onClick={() => void syncNow()} disabled={busy === 'sync' || status.state !== 'connected'}>
          Sync now
        </Button>
      </div>
    </>
  )
}

/** PO-S2: explicit click only, with the count in the confirm. Principia never joins on its own. */
export function JoinAllRow({ count, compact = false }: { count: number; compact?: boolean }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const joinAll = async (): Promise<void> => {
    const ok = await confirmNative({
      message: `Join ${count} public channel${count === 1 ? '' : 's'}?`,
      detail: 'Principia will read them; it posts only where you allow. Private channels still need /invite @hive in Slack.',
      confirmLabel: 'Join All'
    }).catch(() => false)
    if (!ok) return
    setBusy(true)
    const r = await attempt(() => slackCall('slack:joinAll'), 'Join channels')
    setBusy(false)
    if (r) toast(`Joined ${r.joined} channel${r.joined === 1 ? '' : 's'}${r.failed ? ` · ${r.failed} failed` : ''}`)
    void refreshChannels()
  }
  if (compact)
    return (
      <Button size="sm" onClick={() => void joinAll()} disabled={busy}>
        {busy ? 'Joining…' : `Join all public channels (${count})`}
      </Button>
    )
  return (
    <div className="srow">
      <div className="srow__text">
        <div>{count} public channel{count === 1 ? '' : 's'} Principia can’t see yet</div>
        <div className="srow__desc">Join them to read them in Principia. Principia posts only where you allow.</div>
      </div>
      <Button size="sm" onClick={() => void joinAll()} disabled={busy}>
        {busy ? 'Joining…' : 'Join all public channels'}
      </Button>
    </div>
  )
}

function SetupSteps({ replacing, onDone }: { replacing: boolean; onDone: () => void }): React.JSX.Element {
  const status = useSlack((s) => s.status)
  const [manifest, setManifest] = useState<{ json: string; yaml: string; createUrl?: string } | null>(null)
  const [manifestErr, setManifestErr] = useState<string | null>(null)
  const [fmt, setFmt] = useState<'json' | 'yaml'>('json')
  const [appName, setAppName] = useState('Principia')
  const [appToken, setAppToken] = useState('')
  const [botToken, setBotToken] = useState('')
  const [errs, setErrs] = useState<{ appToken?: string; botToken?: string; other?: string }>({})
  const [check, setCheck] = useState<Checklist>(IDLE)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => {
      slackCall('slack:manifest', { name: appName.trim() || 'Principia' }).then(
        (m) => {
          setManifest(m)
          setManifestErr(null)
        },
        (e) => setManifestErr(errorMessage(e))
      )
    }, 200)
    return () => clearTimeout(t)
  }, [appName])

  const createUrl = manifest ? (manifest.createUrl ?? manifestCreateUrl(manifest.json)) : null
  const appProblem = tokenProblem('app', appToken)
  const botProblem = tokenProblem('bot', botToken)
  const ready = !!appToken.trim() && !!botToken.trim() && !appProblem && !botProblem && !busy

  const connect = async (): Promise<void> => {
    if (!ready) return
    setBusy(true)
    setErrs({})
    setCheck({ ...IDLE, app: 'running', bot: 'running', socket: 'running', scopes: 'running' })
    try {
      const st = await slackCall('slack:connect', { botToken: botToken.trim(), appToken: appToken.trim() })
      setSlack({ status: st })
      setCheck({ app: 'ok', bot: 'ok', socket: st.state === 'connected' || st.state === 'connecting' ? 'ok' : 'fail', scopes: st.missingScopes.length ? 'fail' : 'ok', missing: st.missingScopes })
      setAppToken('')
      setBotToken('')
      void refreshChannels()
      void refreshUsers()
      toast(st.workspace ? `Connected to ${st.workspace.name}` : 'Slack connected')
      if (replacing) onDone()
    } catch (e) {
      const list = ((e as { errors?: ValidationError[] }).errors ?? []) as ValidationError[]
      const byPath = Object.fromEntries(list.map((x) => [x.path, x.message])) as Record<string, string>
      const code = (e as { code?: string }).code
      setErrs({
        appToken: byPath.appToken,
        botToken: byPath.botToken,
        other: list.length ? undefined : code === 'vault_unavailable' ? 'macOS Keychain encryption isn’t available, so Principia can’t store the tokens safely.' : errorMessage(e)
      })
      setCheck({ app: byPath.appToken ? 'fail' : list.length ? 'ok' : 'fail', bot: byPath.botToken ? 'fail' : list.length ? 'ok' : 'fail', socket: 'idle', scopes: 'idle', missing: [] })
    } finally {
      setBusy(false)
    }
  }
  const copyManifest = async (): Promise<void> => {
    if (!manifest) return
    await attempt(() => hive.clipboard.writeText({ text: fmt === 'json' ? manifest.json : manifest.yaml }), 'Copy')
    toast('Manifest copied')
  }
  const connected = status?.state === 'connected'

  return (
    <div className="slack-setup">
      <ol className="slack-steps">
        <li className="slack-step">
          <div className="slack-step__title">Create the app</div>
          <div className="slack-step__body">
            <div className="srow__desc">Slack opens with Principia’s settings filled in. Pick your workspace, then Next › Create.</div>
            <div className="slack-step__actions">
              <Button variant="primary" size="sm" icon="external" disabled={!createUrl} onClick={() => createUrl && void attempt(() => hive.app.openExternal({ url: createUrl }), 'Open Slack')} title={manifestErr ?? undefined}>
                Create the Slack app
              </Button>
              <label className="slack-step__name">
                <span className="text-tertiary">App name</span>
                <input className="input input--sm" value={appName} maxLength={35} onChange={(e) => setAppName(e.target.value)} aria-label="Slack app name" />
              </label>
            </div>
            {manifestErr && <div className="field__error">{manifestErr}</div>}
            <Disclosure label="Paste it yourself">
              <div className="slack-manifest">
                <div className="slack-step__actions">
                  <Segmented
                    size="sm"
                    items={[
                      { value: 'json', label: 'JSON' },
                      { value: 'yaml', label: 'YAML' }
                    ]}
                    value={fmt}
                    onChange={setFmt}
                  />
                  <Button size="sm" icon="copy" onClick={() => void copyManifest()} disabled={!manifest}>
                    Copy manifest
                  </Button>
                  <Button size="sm" variant="ghost" icon="external" onClick={() => void attempt(() => hive.app.openExternal({ url: 'https://api.slack.com/apps' }))}>
                    api.slack.com/apps
                  </Button>
                </div>
                <div className="srow__desc">Create New App › From a manifest › pick your workspace › paste › Create.</div>
                {manifest && <pre className="slack-manifest__pre selectable">{fmt === 'json' ? manifest.json : manifest.yaml}</pre>}
              </div>
            </Disclosure>
          </div>
        </li>
        <li className="slack-step">
          <div className="slack-step__title">App-level token</div>
          <div className="slack-step__body">
            <div className="srow__desc">
              You land on <b>Basic Information</b>. Under <b>App-Level Tokens</b>, click <b>Generate Token and Scopes</b>, name it “hive”, add <span className="mono">connections:write</span>, then <b>Generate</b>.
            </div>
            <TokenField value={appToken} onChange={setAppToken} placeholder="xapp-…" label="App-level token" problem={errs.appToken ?? appProblem} />
          </div>
        </li>
        <li className="slack-step">
          <div className="slack-step__title">Install</div>
          <div className="slack-step__body">
            <div className="srow__desc">
              In the left menu, open <b>Install App › Install to Workspace › Allow</b>. Copy the <b>Bot User OAuth Token</b>.
            </div>
            <TokenField value={botToken} onChange={setBotToken} placeholder="xoxb-…" label="Bot token" problem={errs.botToken ?? botProblem} onEnter={() => void connect()} />
            <div className="slack-step__actions">
              <Button variant="primary" size="sm" disabled={!ready} onClick={() => void connect()}>
                {busy ? 'Connecting…' : replacing ? 'Replace & connect' : 'Connect'}
              </Button>
              {check.app !== 'idle' && <CheckRow c={check} />}
            </div>
            {errs.other && <div className="field__error selectable">{errs.other}</div>}
          </div>
        </li>
        <li className={`slack-step ${connected ? '' : 'is-later'}`}>
          <div className="slack-step__title">Say hi</div>
          <div className="slack-step__body">
            <div className="srow__desc">
              In Slack, DM <b>@{status?.workspace?.botName ?? 'hive'}</b> “hi”. Principia offers to send your alerts there. Then join channels on the Slack page (private ones need <span className="mono">/invite @{status?.workspace?.botName ?? 'hive'}</span> in Slack).
            </div>
            {connected && (
              <div className="slack-step__actions">
                <Button size="sm" onClick={() => void navigate({ name: 'slack' })}>
                  Open the Slack page
                </Button>
              </div>
            )}
          </div>
        </li>
      </ol>
    </div>
  )
}

function TokenField({ value, onChange, placeholder, label, problem, onEnter }: { value: string; onChange: (v: string) => void; placeholder: string; label: string; problem: string | null | undefined; onEnter?: () => void }): React.JSX.Element {
  return (
    <div className="slack-token">
      <input
        className={`input input--sm mono ${problem ? 'is-invalid' : ''}`}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        maxLength={300}
        onChange={(e) => onChange(e.target.value.trim())}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') onEnter?.()
        }}
        aria-label={label}
        aria-invalid={!!problem}
      />
      {problem && <div className="field__error">{problem}</div>}
    </div>
  )
}

function CheckRow({ c }: { c: Checklist }): React.JSX.Element {
  const g = (x: Check): string => (x === 'ok' ? '✓' : x === 'fail' ? '✕' : x === 'running' ? '…' : '·')
  return (
    <span className="slack-check text-secondary" aria-live="polite">
      <span className={`slack-check--${c.app}`}>app token {g(c.app)}</span> · <span className={`slack-check--${c.bot}`}>bot token {g(c.bot)}</span> · <span className={`slack-check--${c.socket}`}>socket {g(c.socket)}</span> ·{' '}
      <span className={`slack-check--${c.scopes}`}>{c.missing.length ? `missing ${c.missing.join(', ')}` : `scopes ${g(c.scopes)}`}</span>
    </span>
  )
}
