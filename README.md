# @langgraph-toolkit/mcp

Typed MCP gateway and database-agent composition for Langgraph-Toolkit. The package is framework agnostic. It can be used from a worker, a CLI, an HTTP server, or a graph adapter without importing Express, Fastify, NestJS, or StruxJS.

## Install

```bash
npm install @langgraph-toolkit/mcp
```

MCP uses `@langgraph-toolkit/core` for graph contracts. It does not install community providers or host-framework adapters. Those are optional application packages.

## Gateway with async credentials

Credentials can come from environment variables, a database, a secret manager, or an application-owned resolver. The resolver is asynchronous and receives request context.

```ts
import {
  createMcpGateway,
  fromMcpCredentials,
} from "@langgraph-toolkit/mcp";

const gateway = await createMcpGateway({
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
}, { tenantId: "public" });

const tools = await gateway.listTools();
const result = await gateway.callTool("execute_query", {
  sql: "select count(*) from users",
});

await gateway.close();
```

Use `fromMcpEnv` when a process-level environment variable is enough. Do not pass secrets through graph input or client requests.

## Database MCP agent

`createDatabaseMcpAgent` composes schema discovery, read-only query execution, policy checks, approval interrupts, and typed stream events. A developer supplies the MCP gateway and can leave policy values empty when the gateway itself defines its allowed surface.

```ts
import {
  createDatabaseMcpAgent,
  createDatabaseMcpDefinition,
} from "@langgraph-toolkit/mcp";

const agent = await createDatabaseMcpAgent({
  mcp: gateway,
  policy: {
    allowedTables: ["users", "courses"],
  },
});

const answer = await agent.run({
  question: "How many users are there?",
});

for await (const event of agent.stream({
  question: "How many courses are there?",
})) {
  console.log(event.type, event);
}

const definition = createDatabaseMcpDefinition({
  mcp: gateway,
});
```

The definition bridge is synchronous so scanner-based adapters can register it without hiding asynchronous gateway initialization inside framework bootstrap code.

## Transport boundary

The gateway supports `streamable-http`, legacy `sse`, and application-owned `custom` transports. A custom transport is useful for an in-memory test gateway, process transport, or framework-specific authenticated channel.

The gateway owns protocol normalization and tool/resource errors. The graph or host application owns actor authorization, tenant isolation, SQL classification, and data retention rules.

## Package boundary

```text
core
└── mcp
    ├── gateway and transport contracts
    ├── database tools and memory gateway
    └── optional database graph agent
```

MCP can be installed without the community package. It can run with a custom gateway and a mock model or with an application-owned model resolver. Community providers are a separate package and are not required for gateway-only use.

## Testing

```bash
npm install
npm run build
npm test
```

Contributor tests should cover tool listing, schema discovery, query rejection, approval interrupt, resume, final stream event preservation, async credential resolution, and gateway close behavior.

## License

MIT
