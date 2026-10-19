# Security

Principia is an experimental release. Run cloud workers as a single trusted operator in an isolated environment. Agent tasks and stdio MCP servers execute code with the worker's permissions; project roots are not an operating-system sandbox.

Report vulnerabilities privately through [GitHub security advisories](https://github.com/Vibiz-ai/principia/security/advisories/new). Do not put tokens, private transcripts, local databases or customer data into public issues. Include the affected commit, reproduction steps using synthetic data, expected impact and any suggested fix.

Only the latest main branch is currently maintained. There is no guaranteed response-time or security-support commitment yet.

Desktop MCP credentials are encrypted with the OS-backed vault. Cloud MCP credentials use a separately provisioned encryption key; keep it outside Git, preserve it securely and rotate affected credentials if it is exposed. Do not expose the cloud API directly to the public Internet: use a private network or an authenticated HTTPS proxy.
