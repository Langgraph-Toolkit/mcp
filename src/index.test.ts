import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import {
  createMCP,
  createMCPAgent,
  McpError,
  fromMcpCredentials,
  fromMcpEnv,
  useDatabase,
  useStreamableHttp,
  type McpStringMap,
} from "./index.js";
import {
  McpServerRegistry,
  createMcpConnector,
  createMcpGateway,
  type McpConnector,
  type McpGateway,
} from "./advanced.js";
import type { ChatMessage, ChatResult, LLMSession, JsonObject, JsonValue } from "@langgraph-toolkit/core";

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

  it("composes multiple MCP servers without connecting eagerly", async () => {
    let connectionAttempts = 0;
    const connector = createMcpConnector({
      servers: [
        {
          name: "context",
          transport: { kind: "custom", create: async () => { connectionAttempts += 1; throw new Error("lazy"); } },
        },
        {
          name: "search",
          transport: { kind: "custom", create: async () => { connectionAttempts += 1; throw new Error("lazy"); } },
        },
      ],
    });

    expect(connector.list()).toEqual(["context", "search"]);
    expect(connectionAttempts).toBe(0);
    await connector.close();
  });

  it("declares HTTP and database MCP servers without opening a connection", () => {
    const http = useStreamableHttp("https://example.com/mcp", { name: "search" });
    const database = useDatabase("postgres", "postgresql://localhost/app", {
      name: "analytics",
      readOnly: true,
    });

    expect(http).toMatchObject({
      name: "search",
      transport: { kind: "streamable-http", url: "https://example.com/mcp" },
    });
    expect(database).toMatchObject({
      name: "analytics",
      metadata: { type: "postgres", connectionString: "postgresql://localhost/app", readOnly: true },
    });
    expect(database.transport.kind).toBe("custom");
  });

  it("composes named servers and executes a generic MCP tool call", async () => {
    const declaration = useStreamableHttp("https://example.com/mcp", { name: "context" });
    const connector = createMCP({ servers: { context: declaration } });
    expect(connector.list()).toEqual(["context"]);

    const gateway: McpGateway = {
      server: "context",
      connect: async () => ({ lifecycle: "unknown", capabilities: {} }),
      listTools: async () => [{ name: "lookup", description: "Look up a value", inputSchema: { type: "object" } }],
      callTool: async (_name: string, _args: JsonObject) => ({
        isError: false,
        content: { value: "ready" },
      }),
      listResources: async () => [],
      readResource: async (_uri: string): Promise<JsonValue> => null,
      close: async () => undefined,
    };
    const fakeConnector: McpConnector = {
      servers: new McpServerRegistry(),
      list: () => ["context"],
      server: async () => gateway,
      gateway: async () => gateway,
      close: async () => undefined,
    };
    const model: LLMSession = {
      chat: async (messages: readonly ChatMessage[]): Promise<ChatResult> => {
        if (messages.some((message) => message.role === "tool")) return { content: "The value is ready." };
        return {
          content: "",
          toolCalls: [{ id: "call-1", name: "context.lookup", arguments: {} }],
        };
      },
    };

    const agent = createMCPAgent({ model, mcp: fakeConnector });
    await expect(agent.discover()).resolves.toEqual([
      { name: "context.lookup", description: "Look up a value", parameters: { type: "object" } },
    ]);
    await expect(agent.run([{ role: "user", content: "Check it" }])).resolves.toMatchObject({
      message: { content: "The value is ready." },
      rounds: 2,
      toolCalls: [{ name: "context.lookup" }],
    });
  });

});
