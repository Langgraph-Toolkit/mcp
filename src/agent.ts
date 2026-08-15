import {
  createAgent,
  type Agent,
  type AgentTextOutput,
  type JsonObject,
  type Model,
  type ModelToolSpec,
} from "@langgraph-toolkit/core";
import type { McpConnector, McpRequestContext } from "./core.js";

/** Options for a generic MCP-aware agent. */
export interface McpAgentOptions {
  readonly model: Model;
  readonly mcp: McpConnector;
  readonly name?: string;
  /** Role policy included in the system message of the built-in Core agent. */
  readonly instructions?: string;
  readonly maxRounds?: number;
}

/** Options for discovering an agent's remote tool schemas. */
export interface McpAgentDiscoverOptions {
  /** Context used only when discovery requires request-scoped credentials. */
  readonly mcpContext?: McpRequestContext;
}

/** A Core-backed agent composed with one or more MCP servers. */
export interface McpAgent extends Agent<JsonObject, AgentTextOutput> {
  readonly model: Model;
  readonly mcp: McpConnector;
  discover(options?: McpAgentDiscoverOptions): Promise<readonly ModelToolSpec[]>;
  close(): Promise<void>;
}

/**
 * Create a generic MCP-aware agent without database, SQL or chat-state
 * assumptions. MCP credentials and graph runtime variables flow through the
 * connector's existing lazy `bindTools` bridge.
 */
export function createMCPAgent(options: McpAgentOptions): McpAgent {
  const discover = async (mcpContext: McpRequestContext) => {
    if (options.mcp.bindTools) return (await options.mcp.bindTools({
      actor: mcpContext.actor,
      threadId: mcpContext.threadId,
      variables: mcpContext.variables,
      global: mcpContext.global,
    })).map((tool) => tool.spec);
    return (await Promise.all(options.mcp.list().map(async (server) => {
      const gateway = await options.mcp.gateway(server, mcpContext);
      return (await gateway.listTools()).map((tool) => ({
        name: `${server}.${tool.name}`,
        description: tool.description,
        parameters: tool.inputSchema,
      }));
    }))).flat();
  };
  let staticTools: ReturnType<typeof discover> | undefined;
  const agent = createAgent<JsonObject, AgentTextOutput>({
    name: options.name ?? "mcp-agent",
    model: options.model,
    tools: [options.mcp],
    instructions: options.instructions,
    maxRounds: options.maxRounds,
  });

  return {
    ...agent,
    model: options.model,
    mcp: options.mcp,
    discover: async ({ mcpContext = {} }: McpAgentDiscoverOptions = {}) => {
      if (Object.keys(mcpContext).length !== 0) return discover(mcpContext);
      staticTools ??= discover({});
      return staticTools;
    },
    close: () => options.mcp.close(),
  };
}
