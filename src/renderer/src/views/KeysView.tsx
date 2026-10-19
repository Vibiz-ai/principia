import { useEffect, useRef, useState } from 'react'
import type { EnvImportEntry, SecretMeta } from '@shared/types'
import { SECRET_PRESETS } from '@shared/types'
import { Icon } from '../components/Icon'
import { Button, EmptyState, ErrorState, Field, IconButton, Loading, Pill, RelativeTime, Sheet, Toolbar } from '../components/ui'
import { confirmNative, errorCode, errorMessage, hive, nativeMenu, useHiveEvent } from '../lib/hive'
import { SECRET_NAME_RE, isLiveKey, looksLikeEnvBlob, profilesReferencing, subscriptionNote } from '../lib/secrets'
import { attempt, toast, useStore } from '../state/store'

export function KeysView(): React.JSX.Element {
  const info = useStore((s) => s.info)
  const profiles = useStore((s) => s.profiles)
  const [list, setList] = useState<SecretMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [vaultDown, setVaultDown] = useState(false)
  const [adding, setAdding] = useState<{ name?: string; label?: string; edit?: boolean } | null>(null)
  const [importing, setImporting] = useState<{ text: string; entries: EnvImportEntry[]; source: string } | null>(null)
  const [revealed, setRevealed] = useState<{ name: string; value: string } | null>(null)
  const [drop, setDrop] = useState(false)
  const [sel, setSel] = useState<string | null>(null)
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = (): void => {
    hive.secrets.list().then(
      (l) => {
        setList(l)
        setError(null)
      },
      (e) => {
        if (errorCode(e) === 'vault_unavailable') setVaultDown(true)
        setError(errorMessage(e))
      }
    )
  }
  useEffect(load, [])
  useHiveEvent('data:changed', ({ domain }) => domain === 'secrets' && load())
  useEffect(() => () => {
    if (revealTimer.current) clearTimeout(revealTimer.current)
  }, [])

  const reveal = async (name: string): Promise<void> => {
    if (revealed?.name === name) return setRevealed(null)
    const r = await attempt(() => hive.secrets.reveal({ name }), 'Reveal')
    if (!r) return
    setRevealed({ name, value: r.value })
    if (revealTimer.current) clearTimeout(revealTimer.current)
    revealTimer.current = setTimeout(() => setRevealed(null), 10_000)
  }
  const copy = async (name: string): Promise<void> => {
    await attempt(() => hive.secrets.copy({ name }), 'Copy')
    toast(`${name} copied — clipboard clears in 60 s`)
  }
  const remove = async (s: SecretMeta): Promise<void> => {
    const refs = profilesReferencing(s.name, profiles)
    const ok = await confirmNative({
      message: `Delete ${s.name}?`,
      detail: refs.length ? `Profiles that list it by name: ${refs.map((p) => p.name).join(', ')}.` : 'Agents will no longer receive it.',
      confirmLabel: 'Delete Key',
      destructive: true
    }).catch(() => false)
    if (!ok) return
    await attempt(() => hive.secrets.remove({ name: s.name }), 'Delete')
    load()
  }
  const menu = async (s: SecretMeta): Promise<void> => {
    const id = await nativeMenu([
      { id: 'reveal', label: revealed?.name === s.name ? 'Hide' : 'Reveal for 10 s' },
      { id: 'copy', label: 'Copy Value' },
      { id: 'copyName', label: 'Copy Name' },
      { id: 'edit', label: 'Replace Value…' },
      { type: 'separator' },
      { id: 'delete', label: 'Delete' }
    ])
    if (id === 'reveal') void reveal(s.name)
    if (id === 'copy') void copy(s.name)
    if (id === 'copyName') void attempt(() => hive.clipboard.writeText({ text: s.name })).then(() => toast('Name copied'))
    if (id === 'edit') setAdding({ name: s.name, label: s.label, edit: true })
    if (id === 'delete') void remove(s)
  }

  const startImport = async (text: string, source: string): Promise<void> => {
    const entries = await attempt(() => hive.secrets.parseEnv({ text }), 'Read .env')
    if (!entries) return
    if (!entries.length) return toast('No KEY=VALUE lines found', 'error')
    setImporting({ text, entries, source })
  }
  const pickEnv = async (): Promise<void> => {
    const r = await attempt(() => hive.secrets.pickEnvFile(), 'Import .env')
    if (r) setImporting({ text: r.text, entries: r.entries, source: r.path.split('/').pop() ?? '.env' })
  }
  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    setDrop(false)
    const f = e.dataTransfer.files[0]
    if (!f) return
    if (f.size > 256 * 1024) return toast('That file is too large for a .env', 'error')
    await startImport(await f.text(), f.name)
  }

  if (vaultDown || (info && !info.safeStorageAvailable)) {
    return (
      <div className="view">
        <Toolbar title="Keys" />
        <EmptyState icon="lock" text="macOS Keychain encryption is unavailable, so Principia won’t store keys.">
          <Button onClick={() => void attempt(() => hive.app.showItemInFolder({ path: '/System/Applications/Utilities/Keychain Access.app' }))}>Show Keychain Access</Button>
        </EmptyState>
      </div>
    )
  }

  return (
    <div
      className={`view ${drop ? 'is-drop' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDrop(true)
        }
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDrop(false)}
      onDrop={(e) => void onDrop(e)}
    >
      <Toolbar title="Keys">
        <Button icon="download" onClick={() => void pickEnv()}>
          Import .env…
        </Button>
        <Button variant="primary" icon="plus" onClick={() => setAdding({})}>
          Add Key
        </Button>
      </Toolbar>
      <div className="keys-note">
        <Icon name="lock" size={14} /> Encrypted with your macOS Keychain. Keys never leave this Mac. Agents get them as environment variables.
      </div>
      {error && !list ? (
        <ErrorState error={error} onRetry={load} />
      ) : !list ? (
        <Loading />
      ) : list.length === 0 ? (
        <EmptyState icon="keys" text="Add API keys once; agents get them as env vars.">
          <Button variant="primary" icon="plus" onClick={() => setAdding({})}>
            Add Key
          </Button>
          <Button onClick={() => void pickEnv()}>Import .env…</Button>
          <div className="text-tertiary">or drop a .env file here</div>
        </EmptyState>
      ) : (
        <div className="table scroll">
          <div className="tr tr--head key-cols">
            <span className="th">Name</span>
            <span className="th">Label</span>
            <span className="th">Value</span>
            <span className="th">Last used</span>
            <span />
          </div>
          {list.map((s) => {
            const note = subscriptionNote(s.name, profiles)
            const shown = revealed?.name === s.name
            return (
              <div
                key={s.name}
                className={`tr key-cols ${sel === s.name ? 'is-selected' : ''}`}
                onClick={() => setSel(s.name)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setSel(s.name)
                  void menu(s)
                }}
              >
                <span className="td mono td--main">
                  {s.name}
                  {note && <div className="key-note">{note}</div>}
                </span>
                <span className="td text-secondary">{s.label}</span>
                <span className={`td mono ${shown ? 'selectable key-revealed' : 'text-secondary'}`}>
                  {shown ? revealed!.value : s.masked}
                  {isLiveKey(s.masked) && (
                    <>
                      {' '}
                      <Pill tone="warning">LIVE</Pill>
                    </>
                  )}
                </span>
                <span className="td text-tertiary">{s.lastUsedAt ? <RelativeTime iso={s.lastUsedAt} /> : 'never'}</span>
                <span className="td td--actions td--always">
                  <IconButton icon="eye" label={shown ? 'Hide' : 'Reveal for 10 s'} onClick={(e) => (e.stopPropagation(), void reveal(s.name))} />
                  <IconButton icon="copy" label="Copy (clears in 60 s)" onClick={(e) => (e.stopPropagation(), void copy(s.name))} />
                  <IconButton icon="more" label="More" onClick={(e) => (e.stopPropagation(), void menu(s))} />
                </span>
              </div>
            )
          })}
        </div>
      )}
      {adding && (
        <AddKeySheet
          initial={adding}
          existing={list ?? []}
          onClose={() => setAdding(null)}
          onSaved={() => {
            setAdding(null)
            load()
          }}
          onEnvBlob={(text) => {
            setAdding(null)
            void startImport(text, 'pasted text')
          }}
        />
      )}
      {importing && (
        <EnvImportSheet
          data={importing}
          onClose={() => setImporting(null)}
          onDone={() => {
            setImporting(null)
            load()
          }}
        />
      )}
    </div>
  )
}

function AddKeySheet({
  initial,
  existing,
  onClose,
  onSaved,
  onEnvBlob
}: {
  initial: { name?: string; label?: string; edit?: boolean }
  existing: SecretMeta[]
  onClose: () => void
  onSaved: () => void
  onEnvBlob: (text: string) => void
}): React.JSX.Element {
  const [preset, setPreset] = useState<string | null>(initial.name ? (SECRET_PRESETS.find((p) => p.envName === initial.name)?.id ?? 'custom') : null)
  const [name, setName] = useState(initial.name ?? '')
  const [label, setLabel] = useState(initial.label ?? '')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const nameOk = SECRET_NAME_RE.test(name)
  const exists = !initial.edit && existing.some((s) => s.name === name)
  const choose = (id: string): void => {
    setPreset(id)
    const p = SECRET_PRESETS.find((x) => x.id === id)
    if (p) {
      setName(p.envName)
      setLabel(p.label)
    } else {
      setName('')
      setLabel('')
    }
  }
  const save = async (): Promise<void> => {
    if (!nameOk || !value) return
    setBusy(true)
    const r = await attempt(() => hive.secrets.set({ name, value, label: label || undefined }), 'Save key')
    setBusy(false)
    if (r) {
      toast(`${name} saved`)
      onSaved()
    }
  }
  return (
    <Sheet title={initial.edit ? `Replace ${initial.name}` : 'Add Key'} onCancel={onClose} onPrimary={() => void save()} primaryDisabled={!nameOk || !value || busy} primaryLabel={exists ? 'Replace' : 'Save'}>
      {!initial.edit && (
        <div className="preset-grid">
          {[...SECRET_PRESETS, { id: 'custom', label: 'Custom', envName: 'KEY=VALUE' }].map((p) => (
            <button key={p.id} type="button" className={`preset ${preset === p.id ? 'is-on' : ''}`} onClick={() => choose(p.id)}>
              <span className="preset__label">{p.label}</span>
              <span className="preset__env mono">{p.envName}</span>
            </button>
          ))}
        </div>
      )}
      {(preset || initial.edit) && (
        <>
          <Field label="Name" error={name && !nameOk ? 'Use A–Z, 0–9 and _ (start with a letter or _)' : exists ? 'Exists — saving replaces its value' : undefined}>
            <input className="input mono" value={name} disabled={initial.edit} placeholder="MY_API_KEY" onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))} spellCheck={false} />
          </Field>
          <Field label="Value" hint="Paste the key. Pasting several KEY=VALUE lines imports them all.">
            <input
              className="input mono"
              type="password"
              data-autofocus
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onPaste={(e) => {
                const t = e.clipboardData.getData('text')
                if (looksLikeEnvBlob(t)) {
                  e.preventDefault()
                  onEnvBlob(t)
                }
              }}
            />
          </Field>
          <Field label="Label">
            <input className="input" value={label} placeholder="Optional" onChange={(e) => setLabel(e.target.value)} />
          </Field>
        </>
      )}
    </Sheet>
  )
}

function EnvImportSheet({ data, onClose, onDone }: { data: { text: string; entries: EnvImportEntry[]; source: string }; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const [checked, setChecked] = useState<Set<string>>(() => new Set(data.entries.filter((e) => e.valid).map((e) => e.name)))
  const [busy, setBusy] = useState(false)
  const toggle = (n: string): void =>
    setChecked((s) => {
      const x = new Set(s)
      if (x.has(n)) x.delete(n)
      else x.add(n)
      return x
    })
  const doImport = async (): Promise<void> => {
    setBusy(true)
    const r = await attempt(() => hive.secrets.importEnv({ text: data.text, names: [...checked] }), 'Import')
    setBusy(false)
    if (r) {
      toast(`Imported ${r.length} key${r.length === 1 ? '' : 's'}`)
      onDone()
    }
  }
  return (
    <Sheet title={`Import from ${data.source}`} onCancel={onClose} onPrimary={() => void doImport()} primaryDisabled={checked.size === 0 || busy} primaryLabel={`Import ${checked.size}`}>
      <div className="env-list">
        {data.entries.map((e) => (
          <label key={e.name} className={`env-row ${e.valid ? '' : 'is-dim'}`}>
            <input type="checkbox" disabled={!e.valid} checked={checked.has(e.name)} onChange={() => toggle(e.name)} />
            <span className="mono env-row__name">{e.name}</span>
            <span className="mono text-secondary">{e.masked}</span>
            <span className="flex1" />
            {e.error ? <span className="text-failed">{e.error}</span> : e.exists ? <span className="text-warning">replaces existing</span> : null}
          </label>
        ))}
      </div>
    </Sheet>
  )
}
