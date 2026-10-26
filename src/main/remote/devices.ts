/**
 * REMOTE.md RA2: where the paired phones live. In memory (tests, a Principia without its database) or in hive.db
 * (`phone_devices`), so a phone stays paired across restarts and updates. Only the SHA-256 of a token is ever written.
 * No Electron imports.
 */
import type { DB } from '../db'
import { DDL_PHONE } from '../db/schema'

export interface StoredDevice {
  id: string
  name: string
  /** sha256(token), hex */
  hash: string
  /** sha256 of the token before the last rotation, accepted until prevUntil (ISO) */
  prevHash: string | null
  prevUntil: string | null
  createdAt: string
  lastSeenAt: string | null
  /** last use + REMOTE_TOKEN_TTL_MS (ISO) */
  expiresAt: string
}

export interface DeviceStore {
  /** every device that is not revoked */
  load(): StoredDevice[]
  /** insert or update (hashes, last seen, expiry) */
  put(d: StoredDevice): void
  /** revoked: the row keeps its name and dates, both hashes go */
  revoke(id: string, at: string): void
}

export class MemoryDeviceStore implements DeviceStore {
  readonly rows = new Map<string, StoredDevice & { revokedAt: string | null }>()
  load(): StoredDevice[] {
    return [...this.rows.values()].filter((r) => !r.revokedAt).map(({ revokedAt: _r, ...d }) => ({ ...d }))
  }
  put(d: StoredDevice): void {
    this.rows.set(d.id, { ...d, revokedAt: null })
  }
  revoke(id: string, at: string): void {
    const r = this.rows.get(id)
    if (r) this.rows.set(id, { ...r, hash: '', prevHash: null, prevUntil: null, revokedAt: at })
  }
}

interface Row {
  id: string
  name: string
  token_hash: string | null
  prev_hash: string | null
  prev_until: string | null
  created_at: string
  last_seen_at: string | null
  expires_at: string
}

export class SqliteDeviceStore implements DeviceStore {
  constructor(private readonly db: DB) {
    // the migration creates it; this keeps a store opened on an older handle working
    db.exec(DDL_PHONE)
  }
  load(): StoredDevice[] {
    const rows = this.db.prepare('SELECT * FROM phone_devices WHERE revoked_at IS NULL AND token_hash IS NOT NULL ORDER BY created_at').all() as Row[]
    return rows.map((r) => ({ id: r.id, name: r.name, hash: r.token_hash!, prevHash: r.prev_hash, prevUntil: r.prev_until, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at }))
  }
  put(d: StoredDevice): void {
    this.db
      .prepare(
        `INSERT INTO phone_devices (id, name, token_hash, prev_hash, prev_until, created_at, last_seen_at, expires_at, revoked_at)
         VALUES (@id, @name, @hash, @prevHash, @prevUntil, @createdAt, @lastSeenAt, @expiresAt, NULL)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, token_hash = excluded.token_hash, prev_hash = excluded.prev_hash,
           prev_until = excluded.prev_until, last_seen_at = excluded.last_seen_at, expires_at = excluded.expires_at
         WHERE phone_devices.revoked_at IS NULL`
      )
      .run(d)
  }
  revoke(id: string, at: string): void {
    this.db.prepare('UPDATE phone_devices SET revoked_at = ?, token_hash = NULL, prev_hash = NULL, prev_until = NULL WHERE id = ? AND revoked_at IS NULL').run(at, id)
  }
}
