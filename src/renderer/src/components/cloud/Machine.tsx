/**
 * docs/MACHINES.md and docs/FLEET.md on the Cloud page. Not connected: "Turn on cloud" (the managed cloud, one click),
 * with "Use my own" for a provider token or a server; then the live progress. Connected to a machine made here: a
 * small card with its address, whether it is awake, what still needs you, and Turn off / Delete. Tokens go to main
 * once and never come back.
 */
import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import {
  MACHINE_PHASES,
  MACHINE_PHASE_LABEL,
  MACHINE_PROVIDER_INFO,
  FLEET_URL,
  type MachineBring,
  type MachineInfo,
  type MachineOptions,
  type MachineProvider,
  type MachineView
} from '@shared/machines'
import type { CloudDesktopEvent } from '@shared/types'
import { Button, Segmented, Switch } from '../ui'
import { confirmNative, errorMessage, hive } from '../../lib/hive'
import { toast } from '../../state/store'
import { Tess } from './bits'

/** The machine this Mac made, live (evt:cloud kind 'machine'). `undefined` while loading. */
export function useMachine(): MachineView | null | undefined {
  const [m, set] = useState<MachineView | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    void hive.cloud.machine().then(
      (v) => live && set(v),
      () => live && set(null)
    )
    const off = hive.on('cloud', (e: CloudDesktopEvent) => {
      if (e.kind === 'machine') set(e.machine)
    })
    return () => {
      live = false
      off?.()
    }
  }, [])
  return m
}

/** Whether this build offers the managed cloud: the build's own answer first, main's (with any override) once it arrives. */
export function useMachineInfo(): MachineInfo {
  const [i, set] = useState<MachineInfo>({ managed: FLEET_URL !== null, github: null })
  useEffect(() => {
    let live = true
    void hive.cloud.machineInfo().then(
      (v) => live && set(v),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [])
  return i
}

const DEFAULT_BRING: MachineBring = { github: true, keys: true, claude: true, codex: false }

/**
 * Not connected yet: the managed cloud as one button when this build has it, with everything else (your own
 * provider, your own server, a connect link) under "Use my own". Without it, the form.
 */
export function GetCloud({ own }: { own?: ReactNode }): ReactElement {
  const info = useMachineInfo()
  const [mine, setMine] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!info.managed)
    return (
      <>
        <MakeCloud />
        {own}
      </>
    )
  const turnOn = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await hive.cloud.machineCreate({ provider: 'principia', bring: DEFAULT_BRING })
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <section className="cl-mini cl-make cl-turnon">
        <h3 className="cl-mini__h">Run your agents in the cloud</h3>
        <p className="cl-mini__p">Your chats and workflows keep going when this Mac sleeps, signed in to Claude and GitHub with your keys, and with git, gh, Python and build tools ready. It sleeps when nothing runs and wakes when you start something.</p>
        {error && <p className="cl-error selectable">{error}</p>}
        <div className="cl-row">
          <Button variant="primary" disabled={busy} onClick={() => void turnOn()}>
            {busy ? 'Turning On…' : 'Turn On Cloud'}
          </Button>
          <span className="cl-dim">About two minutes. Claude asks you to sign in once in your browser.</span>
        </div>
        <button type="button" className="cl-link cl-turnon__own" onClick={() => setMine(!mine)}>
          {mine ? 'Hide' : 'Use my own server or provider'}
        </button>
      </section>
      {mine && (
        <>
          <MakeCloud />
          {own}
        </>
      )}
    </>
  )
}

const STEPS = MACHINE_PHASES.filter((p) => p !== 'failed' && p !== 'ready')
const money = (m: { amount: number; currency: string } | null): string => (m ? `${m.currency === 'EUR' ? '€' : '$'}${m.amount % 1 ? m.amount.toFixed(2) : m.amount}/mo` : '')

/** "Make my cloud": the form. */
export function MakeCloud(): ReactElement {
  const [provider, setProvider] = useState<Exclude<MachineProvider, 'principia'>>('hetzner')
  const [token, setToken] = useState('')
  const [opts, setOpts] = useState<MachineOptions | null>(null)
  const [region, setRegion] = useState('')
  const [size, setSize] = useState('')
  const [host, setHost] = useState('')
  const [user, setUser] = useState('root')
  const [bring, setBring] = useState<MachineBring>({ github: true, keys: true, claude: true, codex: false })
  const [busy, setBusy] = useState<'check' | 'create' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const info = MACHINE_PROVIDER_INFO[provider]
  const sizes = useMemo(() => (opts?.sizes ?? []).filter((s) => !region || !s.regions.length || s.regions.includes(region)), [opts, region])

  const pick = (p: Exclude<MachineProvider, 'principia'>): void => {
    setProvider(p)
    setOpts(null)
    setError(null)
  }
  const check = async (): Promise<void> => {
    if (provider === 'ssh') return
    setBusy('check')
    setError(null)
    try {
      const o = await hive.cloud.machineOptions({ provider, token: token.trim() })
      setOpts(o)
      setRegion(o.defaultRegion ?? o.regions[0]?.id ?? '')
      setSize(o.defaultSize ?? o.sizes[0]?.id ?? '')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  const create = async (): Promise<void> => {
    setBusy('create')
    setError(null)
    try {
      await hive.cloud.machineCreate(provider === 'ssh' ? { provider, ssh: { host: host.trim(), user: user.trim() || 'root' }, bring } : { provider, token: token.trim(), region, size, bring })
      setToken('')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  const ready = provider === 'ssh' ? !!host.trim() : !!opts && !!region && !!size
  const chosen = sizes.find((s) => s.id === size)

  return (
    <section className="cl-mini cl-make">
      <h3 className="cl-mini__h">Make my cloud</h3>
      <p className="cl-mini__p">One machine of your own, set up for you: Principia Cloud with an https address, your agents’ CLIs, git, gh, Python and build tools. You sign in here once and every agent there is signed in.</p>
      <Segmented<Exclude<MachineProvider, 'principia'>>
        className="cl-make__seg"
        value={provider}
        onChange={pick}
        items={(['hetzner', 'digitalocean', 'ssh'] as const).map((p) => ({ value: p, label: MACHINE_PROVIDER_INFO[p].label }))}
      />
      <p className="cl-dim cl-make__note">{info.note}</p>

      {provider === 'ssh' ? (
        <div className="cl-make__grid">
          <label className="cl-field">
            <span>Server address</span>
            <input className="input cl-mono" placeholder="203.0.113.7 or box.example.com" value={host} spellCheck={false} onChange={(e) => setHost(e.target.value)} />
          </label>
          <label className="cl-field">
            <span>User</span>
            <input className="input cl-mono" value={user} spellCheck={false} onChange={(e) => setUser(e.target.value)} />
          </label>
          <p className="cl-dim">Principia connects with this Mac’s SSH keys and installs as root (or with sudo). Ports 80 and 443 must be open.</p>
        </div>
      ) : (
        <>
          <label className="cl-field">
            <span>{info.label} API token</span>
            <div className="cl-make__tok">
              <input
                className="input cl-mono"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={token}
                placeholder="Paste a read and write token"
                onChange={(e) => {
                  setToken(e.target.value)
                  setOpts(null)
                }}
              />
              <Button variant={opts ? 'ghost' : 'secondary'} disabled={!token.trim() || busy !== null} onClick={() => void check()}>
                {busy === 'check' ? 'Checking…' : opts ? 'Checked' : 'Check'}
              </Button>
            </div>
          </label>
          {!opts && info.tokenUrl && (
            <p className="cl-dim">
              <button type="button" className="cl-link" onClick={() => void hive.app.openExternal({ url: info.tokenUrl! })}>
                Get a token
              </button>{' '}
              · {info.tokenHint}. It stays on this Mac, encrypted, so you can delete the machine later.
            </p>
          )}
          {opts && (
            <div className="cl-make__grid">
              <label className="cl-field">
                <span>Region</span>
                <select className="input" value={region} onChange={(e) => setRegion(e.target.value)}>
                  {opts.regions.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="cl-field">
                <span>Size</span>
                <select className="input" value={size} onChange={(e) => setSize(e.target.value)}>
                  {sizes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                      {s.monthly ? ` · ${money(s.monthly)}` : ''}
                    </option>
                  ))}
                </select>
              </label>
              {chosen && chosen.cores < 4 && <p className="cl-dim">Agents with a build and a browser want 4 vCPU and 8 GB. Smaller works for light schedules.</p>}
            </div>
          )}
        </>
      )}

      <div className="cl-make__bring">
        <div className="cl-ctitle">Sign it in with</div>
        <BringRow label="GitHub" hint="This Mac’s gh sign-in: clone, push and gh in every run" on={bring.github} set={(v) => setBring({ ...bring, github: v })} />
        <BringRow label="Shared keys" hint="The ones switched to “In the cloud” on Keys" on={bring.keys} set={(v) => setBring({ ...bring, keys: v })} />
        <BringRow label="Claude" hint="A sign-in just for the cloud (opens your browser once)" on={bring.claude} set={(v) => setBring({ ...bring, claude: v })} />
        <BringRow label="Codex" hint="A ChatGPT sign-in just for the cloud (opens your browser once)" on={bring.codex} set={(v) => setBring({ ...bring, codex: v })} />
      </div>

      {error && <p className="cl-error selectable">{error}</p>}
      <div className="cl-row">
        <Button variant="primary" disabled={!ready || busy !== null} onClick={() => void create()}>
          {busy === 'create' ? 'Starting…' : provider === 'ssh' ? 'Install on my server' : `Create${chosen?.monthly ? ` · ${money(chosen.monthly)}` : ''}`}
        </Button>
        <span className="cl-dim">About 5 minutes. You can keep working.</span>
      </div>
    </section>
  )
}

function BringRow({ label, hint, on, set }: { label: string; hint: string; on: boolean; set: (v: boolean) => void }): ReactElement {
  return (
    <div className="cl-make__row">
      <div>
        <b>{label}</b>
        <span className="cl-dim">{hint}</span>
      </div>
      <Switch checked={on} onChange={set} label={label} />
    </div>
  )
}

async function deleteMachine(m: MachineView): Promise<void> {
  const own = m.provider === 'ssh'
  if (m.provider === 'principia') {
    const off = await confirmNative({
      message: 'Turn off your cloud?',
      detail: 'Your cloud machine is deleted with everything on it: runs, logs and the accounts it was signed in with. Your Mac keeps all of its own. You can turn it on again anytime.',
      confirmLabel: 'Turn Off Cloud',
      destructive: true
    }).catch(() => false)
    if (!off) return
    try {
      await hive.cloud.machineDelete()
      toast('Cloud turned off.')
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
    return
  }
  const ok = await confirmNative({
    message: own ? 'Forget this server?' : `Delete ${m.name}?`,
    detail: own
      ? 'This Mac disconnects from it. Principia Cloud keeps running on your server until you stop it there.'
      : `This Mac disconnects and ${MACHINE_PROVIDER_INFO[m.provider].label} deletes the server with everything on it: runs, logs and the accounts it was signed in with. Billing stops.`,
    confirmLabel: own ? 'Forget' : 'Delete Machine',
    destructive: true
  }).catch(() => false)
  if (!ok) return
  try {
    await hive.cloud.machineDelete()
    toast(own ? 'Server forgotten.' : 'Machine deleted.')
  } catch (e) {
    toast(errorMessage(e), 'error')
  }
}

/** While it is being made, or when it stopped: the steps, what it is doing now, and Retry / Delete. */
export function MachineProgress({ m }: { m: MachineView }): ReactElement {
  const failed = m.phase === 'failed'
  const at = failed ? (m.failedAt ?? 'creating') : m.phase
  const steps = m.provider === 'ssh' ? STEPS.filter((p) => p !== 'creating' && p !== 'booting') : STEPS
  const idx = steps.indexOf(at as (typeof STEPS)[number])
  const managed = m.provider === 'principia'
  return (
    <section className="cl-mini cl-make">
      <h3 className="cl-mini__h">{failed ? (managed ? 'Your cloud didn’t turn on' : 'Your cloud stopped while being made') : managed ? 'Turning on your cloud' : 'Making your cloud'}</h3>
      <p className="cl-mini__p">
        {MACHINE_PROVIDER_INFO[m.provider].label}
        {!managed && m.size ? ` · ${m.size}` : ''}
        {m.region ? ` · ${m.region}` : ''}
        {!managed && m.ip ? ` · ${m.ip}` : ''}
      </p>
      <ol className="cl-msteps">
        {steps.map((p, i) => {
          const kind = i < idx ? 'ok' : i === idx ? (failed ? 'fail' : 'running') : 'q'
          return (
            <li key={p} className={`cl-mstep cl-mstep--${kind}`}>
              <Tess kind={kind} />
              <span>{MACHINE_PHASE_LABEL[p]}</span>
              {i === idx && !failed && m.detail && <span className="cl-dim">{m.detail}</span>}
            </li>
          )
        })}
      </ol>
      {failed && m.error && <p className="cl-error selectable">{m.error}</p>}
      <div className="cl-row">
        {failed && (
          <Button variant="primary" onClick={() => void hive.cloud.machineRetry().catch((e) => toast(errorMessage(e), 'error'))}>
            Try Again
          </Button>
        )}
        <Button variant="ghost" onClick={() => void deleteMachine(m)}>
          {managed ? 'Cancel' : m.provider === 'ssh' ? 'Forget Server' : failed ? 'Delete Machine' : 'Stop and Delete'}
        </Button>
        {!failed && <span className="cl-dim">You can leave this page. It keeps going, also after a restart.</span>}
      </div>
    </section>
  )
}

const SLEEP_REASON: Record<string, string> = {
  idle: 'nothing ran for a while',
  limit: 'it used this month’s hours',
  'no heartbeat': 'it stopped answering',
  'stopped at AWS': 'it was stopped'
}

/** A managed machine: awake, asleep (and why, and when it wakes on its own), the hours this month, Wake. */
function Power({ m }: { m: MachineView }): ReactElement | null {
  const [waking, setWaking] = useState(false)
  if (m.provider !== 'principia' || m.phase !== 'ready') return null
  const p = waking ? 'waking' : (m.power ?? 'awake')
  const wake = async (): Promise<void> => {
    setWaking(true)
    try {
      await hive.cloud.machineWake()
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setWaking(false)
    }
  }
  const why = m.sleep?.reason ? (SLEEP_REASON[m.sleep.reason] ?? m.sleep.reason) : null
  const at = m.sleep?.wakeAt ? new Date(m.sleep.wakeAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : null
  return (
    <div className="cl-power">
      <div className="cl-acct">
        <Tess kind={p === 'awake' ? 'ok' : p === 'waking' ? 'running' : 'q'} />
        <div className="cl-ai">
          <b>{p === 'awake' ? 'Awake' : p === 'waking' ? 'Waking up…' : 'Asleep'}</b>
          <span>
            {p === 'awake'
              ? `Sleeps after ${m.sleep?.idleMinutes ?? 20} minutes with nothing running.`
              : p === 'waking'
                ? 'About a minute.'
                : `${why ? `Since ${why}. ` : ''}Wakes when you start something${at ? `, and at ${at} for a schedule` : ''}.`}
          </span>
        </div>
        {p === 'asleep' && (
          <Button size="sm" variant="secondary" onClick={() => void wake()}>
            Wake
          </Button>
        )}
      </div>
      {m.usage && (
        <p className="cl-dim cl-make__notes">
          {m.usage.hours} of {m.usage.limitHours} hours this month
        </p>
      )}
    </div>
  )
}

/** Connected to a machine made here: where it is, what still needs you, Delete. */
export function MachineCard({ m }: { m: MachineView }): ReactElement {
  const managed = m.provider === 'principia'
  return (
    <section className="cl-card">
      <div className="cl-ctitle">
        Machine <span className="cl-dim">{MACHINE_PROVIDER_INFO[m.provider].label}</span>
      </div>
      <div className="cl-acct">
        <Tess kind={m.phase === 'ready' ? (m.notes.length ? 'needs' : 'ok') : m.phase === 'failed' ? 'fail' : 'running'} />
        <div className="cl-ai">
          <b className={managed ? undefined : 'cl-mono selectable'}>{managed ? 'Your cloud' : (m.url?.replace(/^https:\/\//, '') ?? m.name)}</b>
          <span>{managed ? 'Run by Principia' : [m.size, m.region, m.ip].filter(Boolean).join(' · ') || MACHINE_PHASE_LABEL[m.phase]}</span>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void deleteMachine(m)}>
          {managed ? 'Turn Off' : m.provider === 'ssh' ? 'Forget' : 'Delete'}
        </Button>
      </div>
      <Power m={m} />
      {m.notes.map((n) => (
        <p key={n} className="cl-dim cl-make__notes">
          {n}
        </p>
      ))}
      <p className="cl-dim cl-make__notes">Agents there run as their own user in a hardened container, with git, gh, Python and build tools, and the accounts you signed in with.</p>
    </section>
  )
}
