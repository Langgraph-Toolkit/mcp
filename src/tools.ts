/** Typed adaptation of discovered MCP tools into Core tool contracts. */
import type {
  JsonObject,
  JsonValue,
  ToolDefinition,
  ToolRegistry,
  ValueSchema,
} from "@langgraph-toolkit/core";
import type { McpConnector, McpRequestContext, McpToolDescriptor } from "./core.js";
import { createMcpTool, McpError } from "./core.js";

/** Controls which MCP servers are included when translating remote tools. */
export interface DiscoverMcpToolsOptions {
  readonly servers?: readonly string[];
  /** Context passed to request-scoped MCP credential loaders. */
  readonly mcpContext?: McpRequestContext;
}

/** Discover remote tools and expose them as server-qualified Core tool definitions. */
export async function discoverMcpTools(
  mcp: McpConnector,
  options: DiscoverMcpToolsOptions = {},
): Promise<readonly ToolDefinition<JsonObject, JsonValue>[]> {
  const discovery = await mcp.client.discover({
    ...(options.servers === undefined ? {} : { servers: options.servers }),
    tools: true,
    resources: false,
    prompts: false,
  });
  const tools: ToolDefinition<JsonObject, JsonValue>[] = [];
  for (const server of discovery.servers) {
    for (const descriptor of server.tools) {
      tools.push(toCoreTool(mcp, server.name, descriptor, options.mcpContext));
    }
  }
  return tools;
}

/** Register server-qualified MCP tools into a Core ToolRegistry after discovery. */
export async function registerMcpTools(
  registry: ToolRegistry,
  mcp: McpConnector,
  options: DiscoverMcpToolsOptions = {},
): Promise<readonly string[]> {
  const tools = await discoverMcpTools(mcp, options);
  for (const tool of tools) registry.register(tool);
  return tools.map((tool) => tool.name);
}

function toCoreTool(
  mcp: McpConnector,
  server: string,
  descriptor: McpToolDescriptor,
  mcpContext: McpRequestContext | undefined,
): ToolDefinition<JsonObject, JsonValue> {
  return {
    name: `${server}.${descriptor.name}`,
    description: descriptor.description,
    input: objectSchema(`${server}.${descriptor.name}.input`, server),
    execute: async (args, context) => {
      const gateway = await mcp.server(server, {
        ...(mcpContext ?? {}),
        actor: context.actor ?? mcpContext?.actor,
        threadId: context.threadId,
        runId: context.runId,
        variables: context.variables,
        global: context.global,
      });
      const result = await gateway.callTool(descriptor.name, args);
      if (result.isError) {
        throw new McpError(`MCP tool "${descriptor.name}" returned an error.`, "MCP_TOOL_ERROR", server);
      }
      return result.structuredContent ?? result.content;
    },
  };
}

function objectSchema(name: string, server: string): ValueSchema<JsonObject> {
  return {
    name,
    parse: (value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new McpError("MCP tools require an object input.", "MCP_PROTOCOL_ERROR", server);
      }
      return value as JsonObject;
    },
  };
}

export { createMcpTool };
export type { McpToolAdapterOptions } from "./core.js";
