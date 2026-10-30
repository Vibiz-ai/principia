import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '../index'

let nativeOk = true
try {
  new Database(':memory:').close()
} catch {
  nativeOk = false // better-sqlite3 built for Electron only: covered by `npm run smoke`
}
const d = nativeOk ? describe : describe.skip

d('PR-69: limits saved before agents ran without one', () => {
  it('go once: the global one and every company one; other company data stays, and a limit set later survives', () => {
    const db = openDatabase(':memory:')
    db.prepare("DELETE FROM meta WHERE key = 'agent_limits_removed'").run()
    const company = (id: string, data: unknown): void => {
      db.prepare('INSERT INTO company_passports (id, data) VALUES (?, ?)').run(id, JSON.stringify(data))
    }
    company('co_onboarded', { autopilot: true, maxInFlight: 2 })
    company('co_plain', { autopilot: false })
    db.prepare("INSERT INTO settings (key, value) VALUES ('concurrency', '4') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run()
    db.prepare("INSERT INTO settings (key, value) VALUES ('stallMinutes', '7') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run()

    migrate(db)
    const data = (id: string): unknown => JSON.parse((db.prepare('SELECT data FROM company_passports WHERE id = ?').get(id) as { data: string }).data)
    expect(data('co_onboarded')).toEqual({ autopilot: true })
    expect(data('co_plain')).toEqual({ autopilot: false })
    expect(db.prepare("SELECT 1 FROM settings WHERE key = 'concurrency'").get()).toBeUndefined()
    expect(db.prepare("SELECT value FROM settings WHERE key = 'stallMinutes'").get()).toEqual({ value: '7' })

    // the founder sets a limit afterwards: later boots leave it alone
    db.prepare("INSERT INTO settings (key, value) VALUES ('concurrency', '8')").run()
    db.prepare("UPDATE company_passports SET data = json_set(data, '$.maxInFlight', 5) WHERE id = 'co_onboarded'").run()
    migrate(db)
    expect(data('co_onboarded')).toEqual({ autopilot: true, maxInFlight: 5 })
    expect(db.prepare("SELECT value FROM settings WHERE key = 'concurrency'").get()).toEqual({ value: '8' })
    db.close()
  })
})
