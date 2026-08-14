# @langgraph-toolkit/mcp

**Connect a resource once, let the graph use it from any host.** MCP provides a typed gateway boundary for tools, resources, schema discovery, async credentials, and structured errors. It can be used from Core, a worker, a CLI, an HTTP server, or any framework adapter without importing Express, Fastify, NestJS, or StruxJS.

## Install only the MCP boundary

```bash
npm install @langgraph-toolkit/core @langgraph-toolkit/mcp
```

MCP does not install community providers, framework adapters, or database clients. The application decides which optional boundary to add.

## Async credentials with no graph pollution

Credentials may come from environment variables, a database, a secret manager, or an application-owned resolver. Resolution is asynchronous and happens at the gateway boundary. Secrets never need to become graph input.

```ts
import {
  createMcpGateway,
  fromMcpCredentials,
} from "@langgraph-toolkit/mcp";

const gateway = await createMcpGateway(
  {
    name: "analytics",
    transport: {
      kind: "streamable-http",
      url: process.env.ANALYTICS_MCP_URL ?? "http://localhost:8811/mcp",
    },
    credentials: fromMcpCredentials(async ({ tenantId }) => ({
      headers: {
        Authorization: `Bearer ${await secretStore.tokenForTenant(tenantId ?? "public")}`,
      },
    })),
  },
  { tenantId: "public" },
);

const tools = await gateway.listTools();
const result = await gateway.callTool("execute_query", {
  sql: "select count(*) from users",
});

await gateway.close();
```

## Wrap one discovered tool once

`createMcpTool` keeps the tool name, typed argument boundary, default object validation, gateway error propagation, and context formatting outside graph nodes. The graph receives a callable typed tool instead of repeating `callTool()` and result parsing.

```ts
import {
  createMcpTool,
  formatMcpContext,
} from "@langgraph-toolkit/mcp";

type SearchArgs = { query: string; limit?: number };

const search = createMcpTool<SearchArgs, JsonValue>({
  gateway,
  name: "search_courses",
});

const context = await search({ query: "testing", limit: 3 });
const promptContext = formatMcpContext(context);
```

`createMcpApplication` is the process-level composition boundary when an application owns several lazily-created gateways. It caches the gateway, exposes one close hook for framework lifecycle, and keeps credential resolution out of graph code.

```ts
const application = await createMcpApplication({
  servers: [analyticsDeclaration],
});

const analytics = await application.gateway("analytics");
await application.close();
```

Use `fromMcpEnv` when process-level environment variables are enough. Use the async resolver when credentials depend on tenant, actor, secret-manager, or database state.

## Zero-config database agent

`createDatabaseMcpAgent` composes schema discovery, read-only query execution, policy checks, LLM intent analysis, approval interrupts, typed stream events, and grounded answers. The common path supplies the gateway and the business question only.

```ts
import { createDatabaseMcpAgent } from "@langgraph-toolkit/mcp";

const agent = await createDatabaseMcpAgent({
  mcp: gateway,
});

const answer = await agent.run({
  question: "How many users are there?",
});

for await (const event of agent.stream({
  question: "How many courses are there?",
})) {
  console.log(event.type, event);
}
```

Add `policy`, `modelRegistry`, `actor`, or `mcpServer` only when the deployment needs a different default. The graph resource keeps those values in one place instead of repeating them in every host route.

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
    ├── gateway and transport contracts
    ├── database tools and memory gateway
    └── optional database graph agent
```

MCP is independently useful with a custom gateway and deterministic model fallback. Community providers are optional.

## Development

```bash
npm install
npm run build
npm test
```

Contributor tests should cover tool listing, schema discovery, query rejection, async credential resolution, approval interrupt, resume, final stream event preservation, and gateway close behavior.

## License

MIT
