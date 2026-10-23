/** The CloudRuntime every control plane test uses: nothing runs; tests finish runs by hand (or auto with autoComplete). */
import type { ControlPorts } from '../../contract'
import { createDevRuntime, type DevRuntime } from '../devRuntime'

export type FakeRuntime = DevRuntime
export const createFakeRuntime = (ports: ControlPorts, opts: { autoComplete?: boolean } = {}): FakeRuntime => createDevRuntime(ports, opts)
