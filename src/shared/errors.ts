import type { HiveErrorCode, HiveErrorShape, ValidationError } from './types'

/** Thrown in main/engine; serialized over IPC as IpcResult error; rethrown in the renderer by preload. */
export class HiveError extends Error {
  readonly code: HiveErrorCode
  readonly errors?: ValidationError[]
  constructor(code: HiveErrorCode, message: string, errors?: ValidationError[]) {
    super(message)
    this.name = 'HiveError'
    this.code = code
    this.errors = errors
  }
  toJSON(): HiveErrorShape {
    return { code: this.code, message: this.message, ...(this.errors ? { errors: this.errors } : {}) }
  }
  static from(e: unknown): HiveError {
    if (e instanceof HiveError) return e
    if (e && typeof e === 'object' && 'code' in e && 'message' in e && typeof (e as HiveErrorShape).code === 'string') {
      const s = e as HiveErrorShape
      return new HiveError(s.code, s.message, s.errors)
    }
    return new HiveError('internal', e instanceof Error ? e.message : String(e))
  }
}

export const isHiveError = (e: unknown): e is HiveError =>
  e instanceof HiveError || (e instanceof Error && e.name === 'HiveError')
