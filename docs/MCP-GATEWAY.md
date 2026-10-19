# Principia shared MCP connections

Principia manages company tool connections independently of Claude and Codex. Configure a connection in **Settings → Connections → Shared MCP connections**. Start a new session or workflow step after saving. Switching harnesses keeps the same Principia connection configuration. Harness subscription logins remain separate.

The first version supports local stdio MCP servers and remote Streamable HTTP MCP servers with static authentication headers. Browser OAuth registration/login/refresh is not implemented. A server that only supports OAuth must be connected using a supported local authenticated stdio wrapper, or wait for managed OAuth support. Existing Claude credentials are not imported.

## Configuration

Local server (the executable must be available in the app's login-shell PATH):

```json
{
  "id": "company-tools",
  "name": "Company tools",
  "transport": "stdio",
  "command": "your-mcp-server",
  "args": [],
  "enabled": true,
  "roots": ["/absolute/path/to/project"],
  "credentials": { "SERVICE_API_KEY": "your-key" }
}
```

Remote server:

```json
{
  "id": "remote-tools",
  "name": "Remote tools",
  "transport": "http",
  "url": "https://example.com/mcp",
  "enabled": true,
  "roots": ["/absolute/path/to/project"],
  "credentials": { "Authorization": "Bearer your-token" }
}
```

These are example servers, not bundled integrations. Only run stdio commands you trust: they execute code as your user. The gateway supports MCP tools; upstream resources, prompts, sampling, elicitation and subscriptions are not proxied. Tools are discovered through `principia_list_tools` and invoked through `principia_call_tool`, preserving the upstream argument schemas in discovery output. Native harness approval policies remain in effect; this feature does not automatically approve external tools. Headless workflows may require the profile's existing permission policy to permit MCP use.

`roots` contains existing absolute project folders. Access includes descendants, with symlinks resolved before comparison. An empty list grants no sessions access. These are connection access scopes, not an operating-system sandbox on what a trusted MCP server can do. Shell steps and restricted Slack-driven agents receive no shared MCP attachment. Claude and Codex are the currently supported consumers.

Omit `credentials` when editing to retain the saved credentials; use `{}` to clear them. HTTP uses these values as headers; stdio uses them as environment variables. HTTP requires HTTPS except loopback for local MCP servers, and redirects are refused. Do not put credentials in command arguments or URLs.

## Architecture and lifecycle

The desktop app still has no network listener. Each permitted spawn gets a stdio `principia` bridge using a random private grant directory. Bridge requests cross bounded JSON files; the main process rechecks the connection's current roots and enabled state on every request, owns upstream MCP clients, and holds decrypted credentials. Disabling/removing a connection revokes calls from existing grants immediately. Directory grants expire after 24 hours and are removed when the bridge closes. Existing sessions must be restarted to discover a newly granted connection. The file bridge is an application boundary, not protection against arbitrary local processes running as the same macOS user.

Configuration and encrypted credential blobs live in `<userData>/mcp-connections.json` (mode 0600). Secrets use the same Keychain-backed Electron safeStorage cipher as the app vault and are never returned by list/edit IPC. There is no plaintext fallback when encryption is unavailable. Decrypted upstream credential values join the app's log redaction table. Bridge configuration contains an opaque grant directory, not upstream credentials. HTTP errors returned to agents are generic so tokens and upstream response bodies are not exposed in diagnostic errors.

The cloud runner is a separate deployment surface; the desktop Keychain file is not portable to a Linux cloud host. Cloud credentials must be provisioned separately in its secret environment.
