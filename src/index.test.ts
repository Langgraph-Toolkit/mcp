import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import {
  McpError,
  McpServerRegistry,
  createDatabaseMcpTools,
  createMcpGateway,
  createMemoryDatabaseMcpGateway,
  fromMcpCredentials,
  fromMcpEnv,
  type McpStringMap,
} from "./index.js";

class FailingTransport implements Transport {
  onclose?: () => void;

  async start(): Promise<void> {
    throw new Error("transport unavailable");
  }

  async send(_message: JSONRPCMessage): Promise<void> {
    return;
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

describe("MCP declarations", () => {
  it("resolves credentials asynchronously with request context", async () => {
    const seen: { tenantId?: string; headers?: McpStringMap } = {};
    const source = fromMcpCredentials(async ({ tenantId }) => {
      seen.tenantId = tenantId;
      return { headers: { Authorization: "Bearer database-token" } };
    });

    const credentials = await source({ tenantId: "tenant-a" });
    seen.headers = credentials.headers;

    expect(seen).toEqual({
      tenantId: "tenant-a",
      headers: { Authorization: "Bearer database-token" },
    });
  });

  it("maps selected environment values to headers or env", async () => {
    process.env.LANGGRAPH_TOOLKIT_TEST_TOKEN = "env-token";
    const source = fromMcpEnv({
      Authorization: { name: "LANGGRAPH_TOOLKIT_TEST_TOKEN", target: "header" },
      MCP_CHILD_TOKEN: { name: "LANGGRAPH_TOOLKIT_TEST_TOKEN", target: "env" },
    });

    expect(source({})).toEqual({
      headers: { Authorization: "env-token" },
      env: { MCP_CHILD_TOKEN: "env-token" },
    });
    delete process.env.LANGGRAPH_TOOLKIT_TEST_TOKEN;
  });

  it("wraps custom transport connection failures with a stable MCP error", async () => {
    const gatewayPromise = createMcpGateway({
      name: "failing-server",
      transport: {
        kind: "custom",
        create: async () => new FailingTransport(),
      },
    });

    await expect(gatewayPromise).rejects.toMatchObject({
      name: "McpError",
      code: "MCP_CONNECT_ERROR",
      server: "failing-server",
    } satisfies Partial<McpError>);
  });

  it("keeps duplicate registration and missing server errors explicit", async () => {
    const registry = new McpServerRegistry();
    const declaration = {
      name: "analytics",
      transport: { kind: "streamable-http" as const, url: "https://example.com/mcp" },
    };

    registry.add(declaration);
    expect(() => registry.add(declaration)).toThrowError(/already registered/);
    expect(() => registry.get("missing")).toThrowError(/not registered/);
  });

  it("normalizes generic database rows and enforces query boundaries", async () => {
    const gateway = createMemoryDatabaseMcpGateway([
      { id: "doc-1", table: "documents", title: "Refund policy", category: "billing" },
      { id: "doc-2", table: "documents", title: "Returns", category: "billing" },
    ]);
    const tools = createDatabaseMcpTools(gateway, {
      server: "database",
      dialect: "memory",
      allowedTables: ["documents"],
      maxRows: 1,
    });
    const toolContext = { threadId: "test-thread", runId: "test-run", variables: {}, global: {} };

    const discovered = await tools.schemaTool.execute({}, toolContext);
    expect(discovered.tables[0]?.columns.map((column) => column.name)).toEqual([
      "id",
      "table",
      "title",
      "category",
    ]);

    const result = await tools.executeQueryTool.execute({
      queryId: "query-1",
      query: "refund",
      table: "documents",
      limit: 10,
      sql: "select * from documents",
    }, toolContext);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.title).toBe("Refund policy");
    await expect(tools.executeQueryTool.execute({
      queryId: "query-2",
      query: "refund",
      table: "users",
      limit: 1,
      sql: "select * from users",
    }, toolContext)).rejects.toThrowError(/not allowed/);
  });
});
