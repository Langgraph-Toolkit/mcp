# Contributing to MCP

MCP owns connector declaration, deferred connection, discovery, tool adaptation and safe error boundaries. It must remain usable with any Core model facade and must not pull application policies or framework-specific HTTP code into this package.

| Change | Regression that must be preserved |
| --- | --- |
| Tool binding | Model-facing tool names are provider-safe while execution keeps the original server and tool target. |
| Credential resolver | Credentials are resolved only when needed and the request context is preserved. |
| Discovery cache | Static connectors can reuse discovery without losing connector identity. |
| Tool failure | Public MCP errors retain stable codes and recoverable calls return structured results. |

Run `npm test && npm run build && npm pack --dry-run` before requesting review. Tests must use in-memory transports or fixtures. Do not include credentials, database URLs, external endpoints, or live MCP calls in test or publish workflows.

The repository workflow checks out and builds the current Core source before testing MCP. Do not publish locally; releases are performed only by the tag-triggered workflow after the dependency order is satisfied.
