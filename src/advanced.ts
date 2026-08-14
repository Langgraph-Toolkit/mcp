/** Advanced MCP lifecycle APIs for implementers and custom transports. */
export { createMcpGateway, createMcpConnector, McpServerRegistry, SdkMcpGateway } from "./core.js";
export type {
  McpConnector,
  McpConnectorOptions,
  McpGateway,
  McpDiscovery,
  McpResourceDescriptor,
  McpServerDeclaration,
  McpToolDescriptor,
  McpToolResult,
  McpTransportDeclaration,
  McpRequestContext,
} from "./core.js";
