/**
 * Typed access to `window.hive` (the only bridge to main). No fallbacks, no mocks:
 * if a main handler is not implemented yet, the call rejects with its real error.
 */
import { useEffect, useRef } from 'react'
import type { ConfirmRequest, EventMap, EventName, HiveApi, NativeMenuItem } from '@shared/ipc'
import type { HiveErrorCode, ValidationError } from '@shared/types'

export const hive: HiveApi = window.hive

export interface RendererHiveError extends Error {
  code?: HiveErrorCode
  errors?: ValidationError[]
}

export function errorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as Error).message)
  return String(e)
}
export function errorCode(e: unknown): HiveErrorCode | undefined {
  return (e as RendererHiveError | undefined)?.code
}

/** Subscribe to a main-process event for the lifetime of the component. Latest callback wins. */
export function useHiveEvent<E extends EventName>(event: E, cb: (payload: EventMap[E]) => void): void {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => hive.on(event, (p) => ref.current(p)), [event])
}

/** Native context menu (Menu.popup in main). Resolves the clicked id, or null when dismissed. */
export async function nativeMenu(items: NativeMenuItem[]): Promise<string | null> {
  try {
    return await hive.ui.contextMenu({ items })
  } catch {
    return null
  }
}

/** Native confirm sheet (dialog.showMessageBox). Never an HTML dialog. */
export function confirmNative(req: ConfirmRequest): Promise<boolean> {
  return hive.ui.confirm(req)
}
