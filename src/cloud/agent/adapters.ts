/** Agent adapters as the cloud runs them (CLOUD.md §7.8). Shared by the runtime and the legacy runner (src/cloud/workflows.ts). */
import { claudeAdapter, type Adapter } from '../../main/engine/adapters'

/**
 * Claude headless for a box nobody watches: no permission prompt tool, and the `default` mode becomes `dontAsk`
 * (anything that would prompt is refused, never left waiting). A bypass profile keeps its flag. `bin` replaces the
 * executable (fake CLIs in tests).
 */
export function cloudClaudeAdapter(bin?: string): Adapter {
  return {
    ...claudeAdapter,
    ...(bin ? { bin } : {}),
    headless: (request) => {
      const invocation = claudeAdapter.headless(request)
      const permission = invocation.args.indexOf('--permission-prompt-tool')
      if (permission >= 0) invocation.args.splice(permission, 2)
      const mode = invocation.args.indexOf('--permission-mode')
      if (mode >= 0 && invocation.args[mode + 1] === 'default') invocation.args[mode + 1] = 'dontAsk'
      return invocation
    }
  }
}
