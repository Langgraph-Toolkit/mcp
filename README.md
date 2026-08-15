# @langgraph-toolkit/mcp

**Connect a resource once, let the graph use it from any host.** MCP provides a typed gateway boundary for tools, resources, schema discovery, async credentials, and structured errors. It can be used from Core, a worker, a CLI, an HTTP server, or any framework adapter without importing Express, Fastify, NestJS, or StruxJS.

## Install the MCP gateway

```bash
npm install @langgraph-toolkit/core @langgraph-toolkit/mcp
```

MCP does not install model providers, framework adapters, or database clients. Add only the optional boundary your application uses. When an application needs a provider, install Community and declare its model configuration explicitly:

```bash
npm install @langgraph-toolkit/community
```

## Canonical composition facade

The root package keeps the common path small. `useStreamableHttp()` declares a lazy remote server, `useMCPServer()` declares an application-owned or asynchronous server, `createMCP()` composes one or more named servers, and `createMCPAgent()` provides a generic model-plus-tools loop. None of these APIs knows about SQL, rows, approval terminology, or a framework host.

```ts
import { createMCP, createMCPAgent, useStreamableHttp } from "@langgraph-toolkit/mcp";
import { createModelRegistry } from "@langgraph-toolkit/community";

const models = createModelRegistry({
  tiers: { smart: { fromEnvironment: true, temperature: 0.1 } },
});

const mcp = createMCP({
  servers: {
    search: useStreamableHttp(undefined, { name: "search" }),
  },
  discover: true,
  discoverTools: true,
  routing: "semantic",
});

const agent = createMCPAgent({
  model: models.model("smart"),
  mcp,
  name: "research-agent",
});

const result = await agent.run({ query: "Find the latest release notes." });
await agent.close();
```

`fromEnvironment: true` retains explicit provider ownership while removing application parsing helpers: it reads `MODEL_DRIVER`, `MODEL_NAME`, `MODEL_API_KEY`, and optionally `MODEL_BASE_URL`. `useStreamableHttp(undefined)` reads `MCP_SERVER_URL`. Missing model configuration fails at bootstrap rather than selecting a hidden default.

The aggregate `MCPClient` contract exposes `discover`, `callTool`, `readResource`, and `getPrompt` across named servers. `MCPDiscovery`, `MCPDiscoveryServer`, and `McpPromptDescriptor` describe discovery and prompt lifecycle without forcing a specific transport.

## Async credentials with no graph pollution

Credentials may come from environment variables, a database, a secret manager, or an application-owned resolver. Resolution is asynchronous and happens at the gateway boundary. Secrets never need to become graph input.

```ts
import { fromMcpCredentials } from "@langgraph-toolkit/mcp";
import { createMCP, useStreamableHttp } from "@langgraph-toolkit/mcp";

type SecretStore = {
  tokenForTenant(tenantId: string): Promise<string>;
};

declare const secretStore: SecretStore;

const mcp = createMCP({
  servers: {
    analytics: useStreamableHttp(
      process.env.ANALYTICS_MCP_URL ?? "http://localhost:8811/mcp",
      {
        credentials: fromMcpCredentials(async ({ tenantId }) => ({
          headers: {
            Authorization: `Bearer ${await secretStore.tokenForTenant(tenantId ?? "public")}`,
          },
        })),
      },
    ),
  },
  context: { tenantId: "public" },
});

const gateway = await mcp.server("analytics");

const tools = await gateway.listTools();
const result = await gateway.callTool("execute_query", {
  sql: "select count(*) from users",
});

await gateway.close();
```

For credentials that depend on a request or tenant, the resolver receives typed request context. The resulting connector can be closed once by the owning resource; a controller should not rebuild it for each request.

## Wrap one discovered tool once

`createMcpTool` keeps the tool name, typed argument boundary, default object validation, gateway error propagation, and context formatting outside graph nodes. The graph receives a callable typed tool instead of repeating `callTool()` and result parsing.

```ts
import type { JsonValue } from "@langgraph-toolkit/core";
import { createMcpTool } from "@langgraph-toolkit/mcp/tools";
import { formatMcpContext } from "@langgraph-toolkit/mcp/context";

type SearchArgs = { query: string; limit?: number };

const gateway = await mcp.server("search");
const [descriptor] = await gateway.listTools();
if (descriptor === undefined) throw new Error("search tool is not available");

const search = createMcpTool<SearchArgs, JsonValue>({
  gateway,
  descriptor,
  output: (result) => result.structuredContent ?? result.content,
});

const context = await search({ query: "testing", limit: 3 });
const promptContext = formatMcpContext(context);
```

`createMCP` is the process-level composition boundary when an application owns several lazily-created MCP servers. It exposes a named server lookup, caches safe shared-credential gateways, keeps dynamic credential connections request-scoped, and provides one close hook for framework lifecycle.

```ts
const connector = createMCP({
  servers: {
    analytics: analyticsDeclaration,
    search: searchDeclaration,
  },
});

const analytics = await connector.server("analytics");
const search = await connector.server("search");
await connector.close();
```

Use `fromMcpEnv` when process-level environment variables are enough. Use the async resolver when credentials depend on tenant, actor, secret-manager, or database state.

## Database declarations stay transport-neutral

MCP does not ship a database agent, SQL policy, prompt, or domain-specific state. `useDatabase()` records the database family and connection metadata while keeping the transport explicit. Pass `mcpUrl` when the database capability is exposed by a remote MCP server, or pass an application-owned `transport` when the server is created locally.

```ts
import { createMCP, useDatabase } from "@langgraph-toolkit/mcp";

const databaseUrl = process.env.DATABASE_URL;
const databaseMcpUrl = process.env.DATABASE_MCP_URL;
if (!databaseUrl || !databaseMcpUrl) throw new Error("DATABASE_URL and DATABASE_MCP_URL are required");

const mcp = createMCP({
  servers: {
    database: useDatabase("postgres", databaseUrl, {
      mcpUrl: databaseMcpUrl,
      readOnly: true,
    }),
  },
});
```

`useDatabase()` is only a transport declaration. Applications that need data chat, retrieval, background tasks, classification, or custom agents compose their own visible Core graph and MCP-aware role agents. Neither MCP nor Community ships a database workflow preset.

## Same gateway, any host

| Host | Host code owns | MCP code owns |
|---|---|---|
| Express | Router and response lifecycle | Credentials, tools, schema, and resource errors |
| Fastify | Plugin registration and reply lifecycle | Credentials, tools, schema, and resource errors |
| NestJS | Module and controller binding | Credentials, tools, schema, and resource errors |
| StruxJS | Provider lifecycle and agent scanning | Credentials, tools, schema, and resource errors |
| Worker or CLI | Process bootstrap | Credentials, tools, schema, and resource errors |

The gateway contract is the portable seam. A framework adapter should not learn how a database table or prompt works.

## Transport and package boundary

The gateway supports `streamable-http`, legacy `sse`, and application-owned `custom` transports. MCP normalizes protocol and tool errors. The graph or host owns actor authorization, tenant isolation, SQL classification, and retention policy.

```text
core
└── mcp
    ├── root facades: createMCP, useStreamableHttp, useDatabase, createMCPAgent
    ├── advanced: gateway registry and legacy connector construction
    ├── tools: typed MCP tool adaptation
    └── context: MCP value and prompt formatting
```

MCP is independently useful with a custom gateway and a caller-supplied model. Community providers are optional, and no provider or fallback model is selected implicitly.

## Development

```bash
npm install
npm run build
npm test
```

Contributor tests should cover tool listing, schema discovery, query rejection, async credential resolution, approval interrupt, resume, final stream event preservation, and gateway close behavior.

## License

MIT
