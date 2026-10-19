# Principia shared MCP connections

Principia manages company tool connections independently of Claude and Codex. Configure a connection in **Settings → Connections → Shared MCP connections**. Start a new session or workflow step after saving. Switching harnesses keeps the same Principia connection configuration. Harness subscription logins remain separate.

Principia supports local stdio servers and remote Streamable HTTP servers with either browser OAuth or static authentication headers. In the desktop Connections form, add the server URL, select browser sign-in, and click Connect. Principia opens your browser; approve access there. Mobbin is available as a preset at `https://api.mobbin.com/mcp` and requires no API key. Existing Claude credentials are not imported. Interactive browser OAuth is desktop-only; cloud deployments currently use separately provisioned static credentials.

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

The desktop app has no persistent network listener. An explicit browser OAuth sign-in temporarily binds a random loopback callback on `127.0.0.1`; it closes after completion, cancellation, failure, app shutdown, or five minutes. Each permitted spawn gets a stdio `principia` bridge using a random private grant directory. Bridge requests cross bounded JSON files; the main process rechecks the connection's current roots and enabled state on every request, owns upstream MCP clients, and holds decrypted credentials. Disabling/removing a connection revokes calls from existing grants immediately. Directory grants expire after 24 hours and are removed when the bridge closes. Existing sessions must be restarted to discover a newly granted connection. The file bridge is an application boundary, not protection against arbitrary local processes running as the same macOS user.

Configuration and encrypted credential blobs live in `<userData>/mcp-connections.json` (mode 0600). Secrets use the same Keychain-backed Electron safeStorage cipher as the app vault and are never returned by list/edit IPC. There is no plaintext fallback when encryption is unavailable. Decrypted upstream credential values join the app's log redaction table. Bridge configuration contains an opaque grant directory, not upstream credentials. HTTP errors returned to agents are generic so tokens and upstream response bodies are not exposed in diagnostic errors.

## Browser OAuth security and lifecycle

Principia uses the official MCP SDK for OAuth protected-resource and authorization-server discovery, dynamic client registration, PKCE S256, code exchange, and refresh. Authorization callbacks require the exact loopback host/path and a cryptographically random state; callback codes are consumed once. The registered issuer is preserved with both client information and tokens; optional/required callback issuer parameters are verified. Authorization and token endpoints require HTTPS. The OAuth client is named **Principia**.

Client information, discovery state, access tokens, refresh tokens, and token expiry are encrypted using the same platform Cipher as static credentials. PKCE verifiers exist only in memory while connecting. IPC list/edit responses contain status only, never tokens. Refresh happens before token expiry or once after an upstream 401; a background agent cannot trigger a browser sign-in. If consent is revoked, use Connect again in Settings. Disconnect removes Principia's local registration/tokens and cancels outstanding sign-in; it does not promise remote token revocation. You can also revoke access in the provider's account settings.

Saved dynamic registration is reused when its previous loopback port is available; a different callback port requires registration again. Updating a server URL invalidates its OAuth session. Outstanding requests remain bound to their original server and cannot receive a replacement connection's tokens.

The cloud runner is a separate deployment surface; the desktop Keychain file is not portable to a Linux cloud host. Cloud credentials must be provisioned separately in its secret environment.

Choose **All projects** for a desktop connection to grant access in every current and future project. Leave it unchecked to restrict access to selected folders. Existing connections keep their selected-project scope.
