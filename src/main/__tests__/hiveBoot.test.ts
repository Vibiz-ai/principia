/**
 * Boot order (index.ts): the engine's boot recovery fails interrupted runs before the window manager exists. Hive's
 * run:updated handling must not touch the (not yet created) window while it records the failure.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { dock: { setBadge: vi.fn() } },
  dialog: {},
  powerSaveBlocker: { start: vi.fn(), stop: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  Notification: { isSupported: () => false }
}))

import type { Run } from '../../shared/types'
import { Hive } from '../hive'

const run = (p: Partial<Run>): Run =>
  ({ id: 'r_boot', title: 'nightly', status: 'failed', reason: 'Hive quit during run', artifactsDir: '/tmp/a/', endedAt: new Date().toISOString(), ...p }) as Run

describe('Hive before the window exists', () => {
  it('recording a failed run from boot recovery does not throw (no window yet)', () => {
    const store = {
      getRun: (id: string) => run({ id }),
      getSettings: () => ({ notifyOnFailure: true, notifyOnSuccess: 'never', notificationSound: false })
    }
    const h = new Hive({} as never, store as never, { redact: (s: string) => s } as never, {} as never)
    h.indexer = { rescan: vi.fn() } as never
    h.statusChanged = vi.fn()
    expect(h.windows).toBeUndefined()
    expect(h.windowFocused()).toBe(false)
    expect(() => (h as unknown as { onRunUpdated(r: Run): void }).onRunUpdated(run({}))).not.toThrow()
    expect(h.statusChanged).toHaveBeenCalled()
    // counted as an unseen failure for the status bar once the window comes up
    expect((h as unknown as { unseenFailures: number }).unseenFailures).toBe(1)
  })
})
