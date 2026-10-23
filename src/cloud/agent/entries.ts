/**
 * Extra bundles of the cloud agent runtime (CLOUD.md §15 build seams). BE's vite.cloud.config.ts spreads this next
 * to its own entries ('control', 'mcp-gateway'), all into out-cloud/ as `<name>.mjs`. Paths are repo-relative.
 */
export const CLOUD_AGENT_ENTRIES: Record<string, string> = {
  /** FORUM.md §4.1: the `forum` CLI plus the principia-forum stdio MCP server, spawned by agent steps */
  'forum-cli': 'src/main/forum/cli/main.ts',
  /** the runtime on its own (createCloudRuntime), for cloud/agent.smoke.mjs and a later worker process (CLOUD.md §14) */
  agent: 'src/cloud/agent/index.ts'
}
