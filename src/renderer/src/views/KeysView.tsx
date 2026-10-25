import { useEffect, useMemo, useRef, useState } from 'react'
import type { EnvImportEntry, Id, SecretMeta } from '@shared/types'
import { SECRET_PRESETS } from '@shared/types'
import { Icon } from '../components/Icon'
import { Button, EmptyState, ErrorState, Field, IconButton, Loading, Pill, RelativeTime, Segmented, Sheet, Toolbar } from '../components/ui'
import { CompanyChip, useScope } from '../components/CompanyChip'
import { confirmNative, errorCode, errorMessage, hive, nativeMenu, useHiveEvent } from '../lib/hive'
import { SECRET_NAME_RE, isLiveKey, looksLikeEnvBlob, profilesReferencing, subscriptionNote } from '../lib/secrets'
import { companyLabel } from '../lib/companyModel'
import { isWriteOnlyKey } from '@shared/linear'
import { keyId, keySections, overriddenShared, type KeySection } from '../lib/scope'
import { CompanyAvatar } from '../shell/CompanyRail'
import { attempt, companyName, enterCompany, toast, useStore } from '../state/store'

/** COMPANY.md §4: where a key lives. null = Shared (every company's agents); an id = that company only. */
type Space = Id | null
const space = (k: Pick<SecretMeta, 'companyId'>): Space => k.companyId ?? null

/**
 * Keys (COMPANY.md §4, §8.4). Focused: "This company" then "Shared"; a company key overrides a shared one of the same
 * name for that company's agents. All mode: Shared, then every company's keys (added from inside the company).
 * "Move to company…" and "Make shared" move a key without its plaintext ever crossing IPC.
 */
export function KeysView(): React.JSX.Element {
  const info = useStore((s) => s.info)
  const profiles = useStore((s) => s.profiles)
  const { active, scope, company, companies, multi, nonce } = useScope()
  const [list, setList] = useState<SecretMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [vaultDown, setVaultDown] = useState(false)
  const [adding, setAdding] = useState<{ name?: string; label?: string; edit?: boolean; space: Space } | null>(null)
  const [importing, setImporting] = useState<{ text: string; entries: EnvImportEntry[]; source: string; space: Space } | null>(null)
  const [revealed, setRevealed] = useState<{ id: string; value: string } | null>(null)
  const [drop, setDrop] = useState(false)
  const [sel, setSel] = useState<string | null>(null)
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // new keys and .env imports go to the focused company; All mode (and a Personal-only user) adds Shared keys
  const home: Space = multi && scope ? scope : null

  const load = (): void => {
    hive.secrets.list(scope ? { companyId: scope } : undefined).then(
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [nonce])
  useHiveEvent('data:changed', ({ domain }) => domain === 'secrets' && load())
  useEffect(() => () => {
    if (revealTimer.current) clearTimeout(revealTimer.current)
  }, [])

  const sections = useMemo(() => keySections(list ?? [], active, companies), [list, active, companies])
  const overridden = useMemo(() => overriddenShared(list ?? [], scope), [list, scope])

  const reveal = async (s: SecretMeta): Promise<void> => {
    const id = keyId(s)
    if (revealed?.id === id) return setRevealed(null)
    const r = await attempt(() => hive.secrets.reveal({ name: s.name, companyId: space(s) }), 'Reveal')
    if (!r) return
    setRevealed({ id, value: r.value })
    if (revealTimer.current) clearTimeout(revealTimer.current)
    revealTimer.current = setTimeout(() => setRevealed(null), 10_000)
  }
  const copy = async (s: SecretMeta): Promise<void> => {
    await attempt(() => hive.secrets.copy({ name: s.name, companyId: space(s) }), 'Copy')
    toast(`${s.name} copied — clipboard clears in 60 s`)
  }
  const remove = async (s: SecretMeta): Promise<void> => {
    const refs = profilesReferencing(s.name, profiles)
    const where = space(s) ? ` from ${companyName(space(s))}` : multi ? ' from Shared' : ''
    const ok = await confirmNative({
      message: `Delete ${s.name}${where}?`,
      detail: refs.length ? `Profiles that list it by name: ${refs.map((p) => p.name).join(', ')}.` : space(s) ? `${companyName(space(s))}’s agents will no longer receive it.` : 'Agents will no longer receive it.',
      confirmLabel: 'Delete Key',
      destructive: true
    }).catch(() => false)
    if (!ok) return
    await attempt(() => hive.secrets.remove({ name: s.name, companyId: space(s) }), 'Delete')
    load()
  }
  const move = async (s: SecretMeta, to: Space): Promise<void> => {
    const r = await attempt(() => hive.secrets.move({ name: s.name, from: space(s), to }), to ? 'Move to company' : 'Make shared')
    if (!r) return
    toast(to ? `Moved ${s.name} to ${companyName(to)}` : `${s.name} is now shared by every company`)
    setRevealed(null)
    load()
  }
  const menu = async (s: SecretMeta): Promise<void> => {
    const from = space(s)
    const id = await nativeMenu([
      // the Linear sync key is write-only (LINEAR.md §6)
      ...(isWriteOnlyKey(s.name, s.companyId) ? [] : [{ id: 'reveal', label: revealed?.id === keyId(s) ? 'Hide' : 'Reveal for 10 s' }, { id: 'copy', label: 'Copy Value' }]),
      { id: 'copyName', label: 'Copy Name' },
      { id: 'edit', label: 'Replace Value…' },
      ...(multi
        ? [
            { type: 'separator' as const },
            ...(from ? [{ id: 'shared', label: 'Make Shared' }] : []),
            { label: 'Move to Company', submenu: companies.map((c) => ({ id: `move:${c.id}`, label: companyLabel(c, true), enabled: c.id !== from })) }
          ]
        : []),
      { type: 'separator' },
      { id: 'delete', label: 'Delete' }
    ])
    if (id === 'reveal') void reveal(s)
    if (id === 'copy') void copy(s)
    if (id === 'copyName') void attempt(() => hive.clipboard.writeText({ text: s.name })).then(() => toast('Name copied'))
    if (id === 'edit') setAdding({ name: s.name, label: s.label, edit: true, space: from })
    if (id === 'shared') void move(s, null)
    if (id?.startsWith('move:')) void move(s, id.slice(5))
    if (id === 'delete') void remove(s)
  }

  const startImport = async (text: string, source: string, to: Space = home): Promise<void> => {
    const entries = await attempt(() => hive.secrets.parseEnv({ text, companyId: to }), 'Read .env')
    if (!entries) return
    if (!entries.length) return toast('No KEY=VALUE lines found', 'error')
    setImporting({ text, entries, source, space: to })
  }
  const pickEnv = async (): Promise<void> => {
    const r = await attempt(() => hive.secrets.pickEnvFile({ companyId: home }), 'Import .env')
    if (r) setImporting({ text: r.text, entries: r.entries, source: r.path.split('/').pop() ?? '.env', space: home })
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
        <Toolbar title="Keys & secrets" />
        <EmptyState icon="lock" text="macOS Keychain encryption is unavailable, so Principia won’t store keys.">
          <Button onClick={() => void attempt(() => hive.app.showItemInFolder({ path: '/System/Applications/Utilities/Keychain Access.app' }))}>Show Keychain Access</Button>
        </EmptyState>
      </div>
    )
  }

  const row = (s: SecretMeta, section: KeySection): React.JSX.Element => {
    const id = keyId(s)
    const note = subscriptionNote(s.name, profiles)
    const shown = revealed?.id === id
    const shadowed = section.companyId === null && overridden.has(s.name)
    return (
      <div
        key={id}
        className={`tr key-cols ${sel === id ? 'is-selected' : ''} ${shadowed ? 'is-dim' : ''}`}
        onClick={() => setSel(id)}
        onContextMenu={(e) => {
          e.preventDefault()
          setSel(id)
          void menu(s)
        }}
      >
        <span className="td mono td--main">
          {s.name}
          {shadowed && <div className="key-note">{company?.name ?? 'This company'} has its own {s.name}; its agents get that one</div>}
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
          {!isWriteOnlyKey(s.name, s.companyId) && <>
            <IconButton icon="eye" label={shown ? 'Hide' : 'Reveal for 10 s'} onClick={(e) => (e.stopPropagation(), void reveal(s))} />
            <IconButton icon="copy" label="Copy (clears in 60 s)" onClick={(e) => (e.stopPropagation(), void copy(s))} />
          </>}
          <IconButton icon="more" label="More" onClick={(e) => (e.stopPropagation(), void menu(s))} />
        </span>
      </div>
    )
  }
  const sectionHead = (section: KeySection): React.JSX.Element | null => {
    if (section.title === null) return null
    const isCompany = section.companyId !== null
    const focusedCompany = isCompany && section.companyId === scope
    const hint = !isCompany
      ? 'Every company’s agents get these. A company key with the same name wins for that company.'
      : focusedCompany
        ? `Only ${company?.name ?? 'this company'}’s agents get these.`
        : `Only ${section.company?.name ?? 'this company'}’s agents get these. Enter the company to add more.`
    return (
      <div className="keys-section">
        {isCompany ? <CompanyAvatar company={section.company ?? company ?? { name: section.title, color: 'var(--series-other)' }} size={18} /> : <Icon name="link" size={14} />}
        <span className="keys-section__title">{section.title}</span>
        <span className="keys-section__count text-tertiary">{section.keys.length}</span>
        <span className="keys-section__hint text-tertiary">{hint}</span>
        <span className="flex1" />
        {isCompany && !focusedCompany && section.company ? (
          <Button size="sm" variant="ghost" onClick={() => void enterCompany(section.companyId!, { view: { name: 'keys' } })}>
            Enter →
          </Button>
        ) : (
          <Button size="sm" variant="ghost" icon="plus" onClick={() => setAdding({ space: section.companyId })}>
            Add
          </Button>
        )}
      </div>
    )
  }
  const total = list?.length ?? 0

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
      <Toolbar
        title="Keys & secrets"
        sub={multi && scope ? <CompanyChip companyId={scope} always className="toolbar-company" /> : multi ? <span className="company-toolbar-meta">All companies · new keys here are Shared</span> : undefined}
      >
        {/* All companies: say where a key goes (Shared = every company); a client's own key is added from its section */}
        <Button icon="download" onClick={() => void pickEnv()} title={home ? `Import into ${company?.name ?? 'this company'}` : multi ? 'Import as Shared keys (every company gets them)' : undefined}>
          {multi && !home ? 'Import Shared .env…' : 'Import .env…'}
        </Button>
        <Button variant="primary" icon="plus" onClick={() => setAdding({ space: home })} title={multi && !home ? 'A Shared key: every company’s agents get it. To add one for a single company, use + in its section.' : undefined}>
          {multi && !home ? 'Add Shared Key' : 'Add Key'}
        </Button>
      </Toolbar>
      <div className="keys-note">
        <Icon name="lock" size={14} /> Encrypted with your macOS Keychain. Keys never leave this Mac. Agents get them as environment variables{multi ? ': Shared keys plus their own company’s, never another company’s.' : '.'}
      </div>
      {error && !list ? (
        <ErrorState error={error} onRetry={load} />
      ) : !list ? (
        <Loading />
      ) : total === 0 ? (
        <EmptyState icon="keys" text={home ? `Add API keys once; ${company?.name ?? 'this company'}’s agents get them as env vars.` : 'Add API keys once; agents get them as env vars.'}>
          <Button variant="primary" icon="plus" onClick={() => setAdding({ space: home })}>
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
          {sections.map((section) => (
            <section key={section.key} className="keys-group" aria-label={section.title ?? 'Keys'}>
              {sectionHead(section)}
              {section.keys.map((s) => row(s, section))}
              {section.title !== null && section.keys.length === 0 && (
                <div className="keys-section__empty text-tertiary">{section.companyId ? 'No keys only this company gets yet.' : 'No shared keys.'}</div>
              )}
            </section>
          ))}
        </div>
      )}
      {adding && (
        <AddKeySheet
          initial={adding}
          existing={list ?? []}
          spaces={home ? [home, null] : [null]}
          onClose={() => setAdding(null)}
          onSaved={() => {
            setAdding(null)
            load()
          }}
          onEnvBlob={(text, to) => {
            setAdding(null)
            void startImport(text, 'pasted text', to)
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

/** "This company" / "Shared" for the Add and Import sheets; null = Shared. */
function spaceLabel(s: Space): string {
  return s ? `Only ${companyName(s)}` : 'Shared (every company)'
}

function AddKeySheet({
  initial,
  existing,
  spaces,
  onClose,
  onSaved,
  onEnvBlob
}: {
  initial: { name?: string; label?: string; edit?: boolean; space: Space }
  existing: SecretMeta[]
  /** where a new key may go (focused: this company, Shared; else Shared only) */
  spaces: Space[]
  onClose: () => void
  onSaved: () => void
  onEnvBlob: (text: string, to: Space) => void
}): React.JSX.Element {
  const [to, setTo] = useState<Space>(initial.space)
  const [preset, setPreset] = useState<string | null>(initial.name ? (SECRET_PRESETS.find((p) => p.envName === initial.name)?.id ?? 'custom') : null)
  const [name, setName] = useState(initial.name ?? '')
  const [label, setLabel] = useState(initial.label ?? '')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const nameOk = SECRET_NAME_RE.test(name)
  const exists = !initial.edit && existing.some((s) => s.name === name && space(s) === to)
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
    const r = await attempt(() => hive.secrets.set({ name, value, label: label || undefined, companyId: to }), 'Save key')
    setBusy(false)
    if (r) {
      toast(to ? `${name} saved for ${companyName(to)}` : `${name} saved`)
      onSaved()
    }
  }
  return (
    <Sheet title={initial.edit ? `Replace ${initial.name}${to ? ` in ${companyName(to)}` : ''}` : 'Add Key'} onCancel={onClose} onPrimary={() => void save()} primaryDisabled={!nameOk || !value || busy} primaryLabel={exists ? 'Replace' : 'Save'}>
      {!initial.edit && spaces.length > 1 && (
        <Field label="Who gets it">
          <Segmented size="sm" items={spaces.map((x) => ({ value: x ?? '', label: x ? 'This company' : 'Shared', title: spaceLabel(x) }))} value={to ?? ''} onChange={(v) => setTo(v || null)} />
        </Field>
      )}
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
                  onEnvBlob(t, to)
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

function EnvImportSheet({ data, onClose, onDone }: { data: { text: string; entries: EnvImportEntry[]; source: string; space: Space }; onClose: () => void; onDone: () => void }): React.JSX.Element {
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
    const r = await attempt(() => hive.secrets.importEnv({ text: data.text, names: [...checked], companyId: data.space }), 'Import')
    setBusy(false)
    if (r) {
      toast(`Imported ${r.length} key${r.length === 1 ? '' : 's'}`)
      onDone()
    }
  }
  return (
    <Sheet title={`Import from ${data.source}${data.space ? ` into ${companyName(data.space)}` : ''}`} onCancel={onClose} onPrimary={() => void doImport()} primaryDisabled={checked.size === 0 || busy} primaryLabel={`Import ${checked.size}`}>
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
