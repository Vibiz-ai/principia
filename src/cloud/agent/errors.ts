/** Errors the runtime throws to the control plane. `error` follows CloudErrorCode, so the router maps it 1:1 (CLOUD.md §6). */
import type { CloudError, CloudErrorCode } from '../../shared/cloud'

export class CloudRuntimeError extends Error implements CloudError {
  constructor(readonly error: CloudErrorCode, message: string) {
    super(message)
    this.name = 'CloudRuntimeError'
  }
}

/** CLOUD.md §14: kept on the contract, shipped later. The control plane answers 501 `{error: 'not_in_v1'}`. */
export const notInV1 = (what: string): CloudRuntimeError => new CloudRuntimeError('not_in_v1', `${what} is not in Principia Cloud v1`)
