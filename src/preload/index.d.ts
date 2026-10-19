import type { HiveApi } from '../shared/ipc'

declare global {
  interface Window {
    hive: HiveApi
  }
}
export {}
