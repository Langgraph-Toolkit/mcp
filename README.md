# @langgraph-toolkit/mcp

Typed, framework-agnostic MCP client integration for Langgraph-Toolkit. The package keeps MCP transport and credential resolution outside the core graph runtime while exposing a small gateway contract that graph nodes can call.

## Async credentials

Credentials may come from environment variables, a database-backed loader, a secret manager, or application code. The loader receives request context for tenant, actor, thread, variables, and global configuration.

```ts
import { createMcpGateway, fromMcpCredentials } from "@langgraph-toolkit/mcp";

const gateway = await createMcpGateway({
  name: "analytics",
  transport: { kind: "streamable-http", url: "https://mcp.example.com/mcp" },
  credentials: fromMcpCredentials(async ({ tenantId }) => ({
    headers: {
      Authorization: `Bearer ${await secretStore.tokenForTenant(tenantId ?? "public")}`,
    },
  })),
}, { actor, tenantId, threadId });

const tools = await gateway.listTools();
const result = await gateway.callTool("execute_query", { sql: "SELECT 1" });
await gateway.close();
```

For environment-backed credentials, use `fromMcpEnv`. No database driver is required by this package.

## Transport declarations

`streamable-http` is the preferred transport for modern MCP servers. `sse` is available for legacy servers. Use `custom` when the application owns a transport, such as a process transport, in-memory test transport, or a framework-specific authenticated channel.

## Policy boundary

`allowedTools` and `allowedResources` are enforced before calls leave the gateway. Application code should still enforce actor, tenant, SQL, and data classification policy in the graph or MCP server. The gateway normalizes tool and resource responses to the toolkit JSON contracts and wraps connection, protocol, permission, and tool failures in `McpError`.
