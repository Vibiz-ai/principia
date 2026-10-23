/** VOICE.md §0: Settings.tone and Settings.personas (schema, defaults, round trip). */
import { describe, expect, it } from 'vitest'
import { openDatabase } from './db'
import { DEFAULT_SETTINGS, Store } from './db/store'
import { REQUEST_SCHEMAS } from './ipcSchemas'

const ok = (v: unknown) => REQUEST_SCHEMAS['settings:update'].safeParse(v).success

describe('settings:update tone and personas', () => {
  it('accepts the two tones and a boolean', () => {
    expect(ok({ tone: 'playful' })).toBe(true)
    expect(ok({ tone: 'plain' })).toBe(true)
    expect(ok({ personas: true })).toBe(true)
    expect(ok({ personas: false })).toBe(true)
    expect(ok({ tone: 'plain', personas: false })).toBe(true)
  })
  it('rejects other values', () => {
    expect(ok({ tone: 'roman' })).toBe(false)
    expect(ok({ tone: '' })).toBe(false)
    expect(ok({ tone: null })).toBe(false)
    expect(ok({ personas: 'yes' })).toBe(false)
    expect(ok({ personas: 1 })).toBe(false)
    expect(ok({ personas: null })).toBe(false)
  })
  it('defaults to playful with personas on', () => {
    expect(DEFAULT_SETTINGS.tone).toBe('playful')
    expect(DEFAULT_SETTINGS.personas).toBe(true)
  })
})

let nativeOk = true
try {
  openDatabase(':memory:').close()
} catch {
  nativeOk = false // better-sqlite3 built for Electron only: covered by `npm run smoke`
}
;(nativeOk ? describe : describe.skip)('store round trip', () => {
  it('resolves the defaults and persists a patch', () => {
    const db = openDatabase(':memory:')
    const store = new Store(db)
    expect(store.getSettings()).toMatchObject({ tone: 'playful', personas: true })
    expect(store.updateSettings({ tone: 'plain', personas: false })).toMatchObject({ tone: 'plain', personas: false })
    expect(new Store(db).getSettings()).toMatchObject({ tone: 'plain', personas: false })
    db.close()
  })
})
