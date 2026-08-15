/**
 * @langgraph-toolkit/mcp
 *
 * Small MCP application surface. Low-level gateway lifecycle, typed tool
 * adaptation, and serialization helpers are available through explicit
 * subpaths.
 */

export { createMCP, useDatabase, useMCPServer, useStreamableHttp } from "./facades.js";
export { createMCPAgent } from "./agent.js";
export { discoverMcpTools, registerMcpTools } from "./tools.js";
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
  McpAgentOptions,
  McpAgentDiscoverOptions,
} from "./agent.js";
export type {
  McpConnector,
  McpConnector as MCP,
  McpConnectorSettings,
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
export type { DiscoverMcpToolsOptions } from "./tools.js";
