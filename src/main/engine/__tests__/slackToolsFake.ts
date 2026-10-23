import type { FakeCtx } from './fakes'
import { fakeBridge } from './liveFakes'

/** Connected tool transport only; it never contacts Slack or posts a message. */
export function attachFakeSlackTools(ctx: FakeCtx): void {
  ctx.live = fakeBridge(ctx.root)
  ctx.slack = {
    connected: () => true,
    onMessage: () => () => {},
    threadTranscript: () => '',
    permalink: async () => '',
    resolveUserName: (id) => id,
    reply: async () => ({ status: 'drafted' }),
    repliesForRun: () => 0,
    toolServer: () => ({ name: 'hive', command: process.execPath, args: ['/fake/slack-mcp.js'], env: { HIVE_TOOLSETS: 'slack' } })
  }
}
