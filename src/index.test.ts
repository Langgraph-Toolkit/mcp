import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import {
  createMCP,
  createMCPAgent,
  discoverMcpTools,
  McpError,
  fromMcpCredentials,
  fromMcpEnv,
  useDatabase,
  useMCPServer,
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
import { createToolRegistry, type ChatMessage, type ChatResult, type JsonObject, type JsonValue, type Model } from "@langgraph-toolkit/core";

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

  it("declares a generic MCP server with prompt permissions", () => {
    const declaration = useMCPServer({
      name: "assistant",
      url: "https://example.com/mcp",
      allowedTools: ["search"],
      allowedResources: ["docs://guide"],
      allowedPrompts: ["summarize"],
    });

    expect(declaration).toMatchObject({
      name: "assistant",
      transport: { kind: "streamable-http", url: "https://example.com/mcp" },
      allowedTools: ["search"],
      allowedResources: ["docs://guide"],
      allowedPrompts: ["summarize"],
    });
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
    const declaredServers = new McpServerRegistry();
    declaredServers.add({
      name: "context",
      transport: { kind: "custom", create: async () => new FailingTransport() },
    });
    const fakeConnector: McpConnector = {
      client: {
        discover: async () => ({ servers: [] }),
        callTool: async <TArgs extends object, TResult extends JsonValue>(_name: string, _args: TArgs): Promise<TResult> => {
          return (await gateway.callTool("lookup", {})).content as TResult;
        },
        readResource: async <TValue extends JsonValue>(_uri: string): Promise<TValue> => await gateway.readResource("context://empty") as TValue,
        getPrompt: async <TInput extends object, TValue extends JsonValue>(_name: string, _input: TInput): Promise<TValue> => null as TValue,
      },
      servers: declaredServers,
      list: () => ["context"],
      server: async () => gateway,
      gateway: async () => gateway,
      bindTools: async () => [{
        spec: { name: "context.lookup", description: "Look up a value", parameters: { type: "object" } },
        execute: async () => (await gateway.callTool("lookup", {})).content,
      }],
      close: async () => undefined,
    };
    const model: Model = {
      name: "test-model",
      generate: async (request): Promise<ChatResult> => {
        const messages = request.messages;
        if (messages.some((message) => message.role === "tool")) return { content: "The value is ready." };
        return {
          content: "",
          toolCalls: [{ id: "call-1", name: "context.lookup", arguments: {} }],
        };
      },
      async *stream(request) {
        const result = await this.generate(request);
        if (result.content) yield { type: "token", value: result.content };
        for (const [index, call] of (result.toolCalls ?? []).entries()) {
          yield { type: "tool_call", value: { id: call.id, index, name: call.name, arguments: JSON.stringify(call.arguments) } };
        }
      },
      structured: <TValue extends object>() => ({ generate: async (): Promise<TValue> => ({} as TValue) }),
    };

    const agent = createMCPAgent({ model, mcp: fakeConnector });
    await expect(agent.discover()).resolves.toEqual([
      { name: "context.lookup", description: "Look up a value", parameters: { type: "object" } },
    ]);
    await expect(agent.run({ query: "Check it" })).resolves.toMatchObject({
      output: { content: "The value is ready.", toolCalls: [{ name: "context.lookup" }] },
    });
  });

  it("caches static-credential schemas and preserves server-qualified MCP tools", async () => {
    let discoveryCount = 0;
    const gateway: McpGateway = {
      server: "reference",
      connect: async () => ({ lifecycle: "unknown", capabilities: {} }),
      listTools: async () => {
        discoveryCount += 1;
        return [{ name: "lookup", description: "Look up a value", inputSchema: { type: "object" } }];
      },
      callTool: async () => ({ isError: false, content: { value: "ready" } }),
      listResources: async () => [],
      readResource: async (): Promise<JsonValue> => null,
      close: async () => undefined,
    };
    const servers = new McpServerRegistry();
    servers.add({ name: "reference", transport: { kind: "custom", create: async () => new FailingTransport() } });
    const connector: McpConnector = {
      client: {
        discover: async () => ({ servers: [{ name: "reference", discovery: { lifecycle: "unknown", capabilities: {} }, tools: await gateway.listTools(), resources: [], prompts: [] }] }),
        callTool: async <TArgs extends object, TResult extends JsonValue>(_name: string, _args: TArgs): Promise<TResult> => (await gateway.callTool("lookup", {})).content as TResult,
        readResource: async <TValue extends JsonValue>(_uri: string): Promise<TValue> => null as TValue,
        getPrompt: async <TInput extends object, TValue extends JsonValue>(_name: string, _input: TInput): Promise<TValue> => null as TValue,
      },
      servers,
      list: () => ["reference"],
      server: async () => gateway,
      gateway: async () => gateway,
      close: async () => undefined,
    };
    const model: Model = {
      name: "test-model",
      generate: async (): Promise<ChatResult> => ({ content: "ready" }),
      async *stream() { yield { type: "token", value: "ready" }; },
      structured: <TValue extends object>() => ({ generate: async (): Promise<TValue> => ({} as TValue) }),
    };
    const agent = createMCPAgent({ model, mcp: connector });

    await agent.discover();
    await agent.discover();
    expect(discoveryCount).toBe(1);

    const tools = await discoverMcpTools(connector);
    const registry = createToolRegistry();
    for (const tool of tools) registry.register(tool);
    await expect(registry.execute("reference.lookup", {}, { threadId: "thread-1", runId: "run-1", variables: {}, global: {} })).resolves.toEqual({ value: "ready" });
  });

});
