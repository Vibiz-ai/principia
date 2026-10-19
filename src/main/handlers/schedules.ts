import type { ScheduleInput } from '../../shared/types'
import { HiveError } from '../../shared/errors'
import type { Hive } from '../hive'
import { emit, handle } from '../ipc'
import { checkTarget } from './runs'

function validateInput(h: Hive, input: ScheduleInput): void {
  const p = h.engine.scheduler.preview(input.when)
  if (!p.ok) throw new HiveError('validation', p.error ?? 'Invalid schedule', [{ path: 'when', message: p.error ?? 'Invalid schedule' }])
  try {
    checkTarget(h, input.target)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new HiveError('validation', msg, [{ path: 'target', message: msg }])
  }
}

export function registerScheduleHandlers(h: Hive): void {
  const afterWrite = (id: string) => {
    const s = h.safe(() => h.engine.scheduler.upsert(id), null) ?? h.store.getSchedule(id)
    if (!s) throw new HiveError('not_found', 'Schedule not found')
    const fresh = h.store.getSchedule(id) ?? s
    emit('schedule:updated', fresh)
    emit('data:changed', { domain: 'schedules' })
    h.statusChanged()
    return fresh
  }
  handle('schedules:list', () => h.store.listSchedules())
  handle('schedules:create', (input) => {
    validateInput(h, input as ScheduleInput)
    const id = h.store.insertSchedule(input as ScheduleInput)
    return afterWrite(id)
  })
  handle('schedules:update', ({ id, input }) => {
    if (!h.store.getSchedule(id)) throw new HiveError('not_found', 'Schedule not found')
    validateInput(h, input as ScheduleInput)
    h.store.updateScheduleConfig(id, input as ScheduleInput)
    return afterWrite(id)
  })
  handle('schedules:remove', ({ id }) => {
    if (!h.store.getSchedule(id)) throw new HiveError('not_found', 'Schedule not found')
    h.safe(() => h.engine.scheduler.remove(id), undefined)
    h.store.deleteSchedule(id)
    emit('data:changed', { domain: 'schedules' })
    h.statusChanged()
  })
  handle('schedules:setEnabled', ({ id, enabled }) => {
    h.store.setScheduleEnabled(id, enabled)
    return afterWrite(id)
  })
  handle('schedules:runNow', ({ id }) => {
    if (!h.store.getSchedule(id)) throw new HiveError('not_found', 'Schedule not found')
    const run = h.engine.scheduler.runNow(id)
    h.statusChanged()
    return run
  })
  handle('schedules:preview', ({ when }) => h.engine.scheduler.preview(when))
  // LIVE.md §8 "Skip": the engine records skip_slot_at, logs 'skipped' and emits schedule.updated
  handle('schedules:skipNext', ({ id }) => {
    if (!h.store.getSchedule(id)) throw new HiveError('not_found', 'Schedule not found')
    if (!h.engine.scheduler.skipNext) throw new HiveError('internal', 'Skipping a schedule is not available yet')
    h.engine.scheduler.skipNext(id)
    const fresh = h.store.getSchedule(id)!
    emit('schedule:updated', fresh)
    h.statusChanged()
    return fresh
  })
  handle('schedules:events', ({ scheduleId, limit }) => h.store.scheduleEvents(scheduleId, limit ?? 50))
  handle('schedules:pauseAll', ({ paused }) => {
    h.updateSettings({ schedulesPaused: paused })
    return h.status()
  })
}
