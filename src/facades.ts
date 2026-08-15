import type { JsonObject } from "@langgraph-toolkit/core";
import type {
  McpConnector,
  McpCredentialSource,
  McpServerDeclaration,
  McpStringMap,
  McpTransportDeclaration,
} from "./core.js";
import { createMcpConnector, McpError } from "./core.js";

type CustomTransportFactory = Extract<McpTransportDeclaration, { readonly kind: "custom" }>["create"];

const unsupportedDatabaseTransport: CustomTransportFactory = async (_credentials, _context) => {
  throw new McpError(
    "A database MCP transport requires options.mcpUrl or options.transport.",
    "MCP_CONFIG_ERROR",
    "database",
  );
};

/** Options shared by the common Streamable HTTP declaration. */
export interface StreamableHttpOptions {
  readonly name?: string;
  readonly headers?: McpStringMap;
  readonly credentials?: McpCredentialSource;
  readonly allowedTools?: readonly string[];
  readonly allowedResources?: readonly string[];
  readonly allowedPrompts?: readonly string[];
  readonly clientName?: string;
  readonly clientVersion?: string;
}

/** Declare a Streamable HTTP MCP server without constructing a client eagerly. */
export function useStreamableHttp(url: string, options: StreamableHttpOptions = {}): McpServerDeclaration {
  return {
    name: options.name ?? "mcp-server",
    clientName: options.clientName,
    clientVersion: options.clientVersion,
    transport: { kind: "streamable-http", url, headers: options.headers },
    credentials: options.credentials,
    allowedTools: options.allowedTools,
    allowedResources: options.allowedResources,
    allowedPrompts: options.allowedPrompts,
  };
}

/** Generic options for declaring one MCP server without constructing a transport client. */
export interface MCPServerOptions {
  readonly name?: string;
  readonly url?: string;
  readonly transport?: McpTransportDeclaration;
  readonly headers?: McpStringMap;
  readonly credentials?: McpCredentialSource;
  readonly allowedTools?: readonly string[];
  readonly allowedResources?: readonly string[];
  readonly allowedPrompts?: readonly string[];
  readonly clientName?: string;
  readonly clientVersion?: string;
}

/** Declare a generic MCP server using Streamable HTTP or an explicitly supplied transport. */
export function useMCPServer(options: MCPServerOptions): McpServerDeclaration {
  if (options.transport === undefined && options.url === undefined) {
    throw new McpError("useMCPServer requires options.url or options.transport.", "MCP_CONFIG_ERROR", options.name ?? "mcp-server");
  }
  const transport = options.transport ?? {
    kind: "streamable-http" as const,
    url: options.url as string,
    headers: options.headers,
  };
  return {
    name: options.name ?? "mcp-server",
    clientName: options.clientName,
    clientVersion: options.clientVersion,
    transport,
    credentials: options.credentials,
    allowedTools: options.allowedTools,
    allowedResources: options.allowedResources,
    allowedPrompts: options.allowedPrompts,
  };
}

/** Supported database families for a database-backed MCP server declaration. */
export type DatabaseType = "postgres" | "mysql" | "mssql" | "sqlite" | "redis" | "mongo";

/** Options for exposing a database connection through an MCP server boundary. */
export interface DatabaseOptions {
  readonly name?: string;
  readonly readOnly?: boolean;
  readonly mcpUrl?: string;
  readonly headers?: McpStringMap;
  readonly credentials?: McpCredentialSource;
  readonly transport?: McpTransportDeclaration;
  readonly allowedTools?: readonly string[];
  readonly allowedResources?: readonly string[];
  readonly allowedPrompts?: readonly string[];
}

/**
 * Declare a database MCP capability without importing a database driver.
 *
 * If `mcpUrl` is supplied, the declaration uses Streamable HTTP immediately.
 * Direct connection strings remain metadata until an MCP database transport
 * is supplied, which keeps SQL and storage semantics outside this package.
 */
export function useDatabase(
  type: DatabaseType,
  connectionString: string,
  options: DatabaseOptions = {},
): McpServerDeclaration {
  const transport = options.transport ?? (options.mcpUrl === undefined ? {
    kind: "custom" as const,
    create: unsupportedDatabaseTransport,
  } : {
    kind: "streamable-http" as const,
    url: options.mcpUrl,
    headers: options.headers,
  });
  return {
    name: options.name ?? "database",
    transport,
    credentials: options.credentials,
    allowedTools: options.allowedTools,
    allowedResources: options.allowedResources,
    allowedPrompts: options.allowedPrompts,
    metadata: {
      type,
      connectionString,
      readOnly: options.readOnly ?? true,
    } satisfies JsonObject,
  };
}

/** Public MCP connector options with named server map ergonomics. */
export interface MCPOptions {
  readonly servers: Readonly<Record<string, McpServerDeclaration>>;
  readonly context?: import("./core.js").McpRequestContext;
  readonly cache?: "shared" | "none";
  /** Enable discovery-oriented composition for agents and host diagnostics. */
  readonly discover?: boolean;
  readonly discoverTools?: boolean;
  readonly discoverResources?: boolean;
  readonly discoverPrompts?: boolean;
  readonly routing?: "semantic" | "explicit";
  readonly permissions?: boolean;
  readonly session?: boolean;
}

/** The canonical MCP connector factory for one or more named servers. */
export function createMCP(options: MCPOptions): McpConnector {
  const servers = Object.entries(options.servers).map(([name, declaration]) => ({
    ...declaration,
    name,
  }));
  return createMcpConnector({
    servers,
    context: options.context,
    cache: options.cache,
  });
}
