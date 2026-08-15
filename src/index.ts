/**
 * @langgraph-toolkit/mcp
 *
 * Small MCP application surface. Low-level gateway lifecycle, typed tool
 * adaptation, and serialization helpers are available through explicit
 * subpaths.
 */

export { createMCP, useDatabase, useMCPServer, useStreamableHttp } from "./facades.js";
export { createMCPAgent } from "./agent.js";
export { fromMcpCredentials, fromMcpEnv, McpError } from "./core.js";

export type {
  MCPOptions,
  MCPServerOptions,
  DatabaseOptions,
  DatabaseType,
  StreamableHttpOptions,
} from "./facades.js";
export type {
  McpAgent,
  McpAgentChunk,
  McpAgentOptions,
  McpAgentResult,
  McpAgentRunOptions,
  McpAgentTool,
} from "./agent.js";
export type {
  McpConnector as MCP,
  DiscoverOptions,
  MCPClient,
  MCPDiscovery,
  MCPDiscoveryServer,
  McpCredentials,
  McpCredentialLoader,
  McpCredentialSource,
  McpGateway,
  McpPromptDescriptor,
  McpRequestContext,
  McpServerDeclaration,
  McpStringMap,
} from "./core.js";
