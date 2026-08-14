import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { Transport } from "@modelcontextprotocol/client";
import type {
  Actor,
  JsonObject,
  JsonValue,
  ToolDefinition,
  ValueSchema,
} from "@langgraph-toolkit/core";

/** A string-only map suitable for HTTP headers or child-process environment values. */
export type McpStringMap = Readonly<Record<string, string>>;

/** Per-request context available to asynchronous credential loaders. */
export interface McpRequestContext {
  readonly actor?: Actor;
  readonly threadId?: string;
  readonly runId?: string;
  readonly tenantId?: string;
  readonly variables?: JsonObject;
  readonly global?: JsonObject;
}

/** Credentials resolved for one MCP connection or request. */
export interface McpCredentials {
  readonly headers?: McpStringMap;
  readonly env?: McpStringMap;
}

/** Async credential loader evaluated at MCP connection time. */
export type McpCredentialLoader = (context: McpRequestContext) => McpCredentials | Promise<McpCredentials>;

/** A credential value or a loader backed by env, a database, a secret manager, or application code. */
export type McpCredentialSource =
  | McpCredentials
  | McpCredentialLoader;

/** Resolve credentials from an explicit async loader without coupling the package to a database driver. */
export function fromMcpCredentials(
  loader: McpCredentialLoader,
): McpCredentialLoader {
  return loader;
}

/** Resolve selected environment variables into MCP headers or process environment values. */
export function fromMcpEnv(
  mapping: Readonly<Record<string, { readonly name: string; readonly target?: "header" | "env" }>>,
): McpCredentialLoader {
  return () => {
    const headers: Record<string, string> = {};
    const env: Record<string, string> = {};
    for (const [targetName, descriptor] of Object.entries(mapping)) {
      const value = process.env[descriptor.name];
      if (value === undefined) continue;
      if (descriptor.target === "env") env[targetName] = value;
      else headers[targetName] = value;
    }
    return { headers, env };
  };
}

/** Built-in transport declarations supported by the official MCP client SDK. */
export type McpTransportDeclaration =
  | {
      readonly kind: "streamable-http";
      readonly url: string;
      readonly headers?: McpStringMap;
    }
  | {
      readonly kind: "sse";
      readonly url: string;
      readonly headers?: McpStringMap;
    }
  | {
      readonly kind: "custom";
      readonly create: (
        credentials: McpCredentials,
        context: McpRequestContext,
      ) => Transport | Promise<Transport>;
    };

/** Declarative MCP server configuration. Credentials are intentionally resolved at connection time. */
export interface McpServerDeclaration {
  readonly name: string;
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly transport: McpTransportDeclaration;
  readonly credentials?: McpCredentialSource;
  /** Optional declarative metadata for adapters and diagnostics. */
  readonly metadata?: JsonObject;
  readonly allowedTools?: readonly string[];
  readonly allowedResources?: readonly string[];
  readonly connectTimeoutMs?: number;
}

/** A normalized tool descriptor independent of the MCP SDK response shape. */
export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

/** A normalized resource descriptor independent of the MCP SDK response shape. */
export interface McpResourceDescriptor {
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

/** A structured result from an MCP tool invocation. */
export interface McpToolResult {
  readonly isError: boolean;
  readonly content: JsonValue;
  readonly structuredContent?: JsonObject;
}

/** Server metadata and negotiated connection facts. */
export interface McpDiscovery {
  readonly serverName?: string;
  readonly serverVersion?: string;
  readonly protocolVersion?: string;
  readonly lifecycle: "modern" | "legacy" | "unknown";
  readonly capabilities: JsonObject;
}

/** The framework-agnostic MCP gateway used by graph nodes and resource examples. */
export interface McpGateway {
  readonly server: string;
  connect(): Promise<McpDiscovery>;
  listTools(): Promise<readonly McpToolDescriptor[]>;
  callTool(name: string, args: JsonObject): Promise<McpToolResult>;
  listResources(): Promise<readonly McpResourceDescriptor[]>;
  readResource(uri: string): Promise<JsonValue>;
  close(): Promise<void>;
}

/** Options for adapting one MCP descriptor into a typed graph tool. */
export interface McpToolAdapterOptions<TArgs extends JsonObject, TResult extends JsonValue> {
  readonly gateway: McpGateway;
  readonly descriptor: McpToolDescriptor;
  readonly input?: ValueSchema<TArgs>;
  readonly output: (result: McpToolResult) => TResult;
}

/** A typed MCP tool that preserves gateway errors and emits core tool lifecycle events when called by a node. */
export function createMcpTool<TArgs extends JsonObject, TResult extends JsonValue>(
  options: McpToolAdapterOptions<TArgs, TResult>,
): ToolDefinition<TArgs, TResult> {
  const input: ValueSchema<TArgs> = options.input ?? {
    name: `${options.descriptor.name}.input`,
    parse: (value) => {
      if (!isJsonObject(value)) {
        throw new McpError(
          `MCP tool "${options.descriptor.name}" expects an object input.`,
          "MCP_PROTOCOL_ERROR",
          options.gateway.server,
        );
      }
      return value as TArgs;
    },
  };
  return {
    name: options.descriptor.name,
    description: options.descriptor.description,
    input,
    execute: async (args) => {
      const result = await options.gateway.callTool(options.descriptor.name, args);
      if (result.isError) {
        throw new McpError(
          `MCP tool "${options.descriptor.name}" returned an error.`,
          "MCP_TOOL_ERROR",
          options.gateway.server,
        );
      }
      return options.output(result);
    },
  };
}

/** Convert structured MCP output into bounded prompt context without app-specific JSON handling. */
export function formatMcpContext(result: McpToolResult, maxChars = 12_000): string {
  return formatValue(result.structuredContent ?? result.content, maxChars);
}

/** Convert a typed MCP tool value into bounded prompt context. */
export function formatValue(value: JsonValue, maxChars = 12_000): string {
  const encoded = JSON.stringify(value);
  return (encoded ?? "").slice(0, Math.max(1, maxChars));
}

/** MCP integration errors with stable codes for graph policies and HTTP adapters. */
export class McpError extends Error {
  constructor(
    message: string,
    public readonly code: "MCP_CONFIG_ERROR" | "MCP_CONNECT_ERROR" | "MCP_PERMISSION_ERROR" | "MCP_PROTOCOL_ERROR" | "MCP_TOOL_ERROR",
    public readonly server: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "McpError";
  }
}

function asExternalObject(value: object | string | number | boolean | null | undefined): JsonValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => asExternalObject(item as object | string | number | boolean | null | undefined));
  const record = value as Readonly<Record<string, object | string | number | boolean | null | undefined>>;
  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(record)) output[key] = asExternalObject(item);
  return output;
}

function asJsonObject(value: object | undefined): JsonObject {
  const normalized = asExternalObject(value);
  return isJsonObject(normalized) ? normalized : {};
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeHeaders(base: McpStringMap | undefined, credentials: McpCredentials): McpStringMap {
  return { ...(base ?? {}), ...(credentials.headers ?? {}) };
}

function enforceAllowList(name: string, allowed: readonly string[] | undefined, kind: "tool" | "resource", server: string): void {
  if (allowed !== undefined && !allowed.includes(name)) {
    throw new McpError(`${kind} "${name}" is not allowed by server policy.`, "MCP_PERMISSION_ERROR", server);
  }
}

/** Official SDK backed gateway supporting Streamable HTTP, legacy SSE, or a custom transport factory. */
export class SdkMcpGateway implements McpGateway {
  readonly server: string;
  private readonly client: Client;
  private transport?: Transport;
  private connected = false;

  constructor(
    private readonly declaration: McpServerDeclaration,
    private readonly context: McpRequestContext = {},
    private readonly credentials: McpCredentials = {},
  ) {
    this.server = declaration.name;
    this.client = new Client({
      name: declaration.clientName ?? "langgraph-toolkit",
      version: declaration.clientVersion ?? "0.1.0",
    });
  }

  async connect(): Promise<McpDiscovery> {
    if (this.connected) return this.discovery();
    try {
      this.transport = await this.createTransport();
      await this.client.connect(this.transport);
      this.connected = true;
      return this.discovery();
    } catch (error) {
      throw new McpError(`Failed to connect to MCP server "${this.declaration.name}".`, "MCP_CONNECT_ERROR", this.declaration.name, error instanceof Error ? error : undefined);
    }
  }

  async listTools(): Promise<readonly McpToolDescriptor[]> {
    await this.ensureConnected();
    try {
      const result = await this.client.listTools();
      return result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: asJsonObject(tool.inputSchema as object | undefined),
      }));
    } catch (error) {
      throw this.toolError("Failed to list MCP tools.", error instanceof Error ? error : undefined);
    }
  }

  async callTool(name: string, args: JsonObject): Promise<McpToolResult> {
    await this.ensureConnected();
    enforceAllowList(name, this.declaration.allowedTools, "tool", this.declaration.name);
    try {
      const result = await this.client.callTool({ name, arguments: args });
      const content = asExternalObject(result.content as object | string | number | boolean | null | undefined);
      const structured = result.structuredContent as object | undefined;
      return {
        isError: result.isError === true,
        content,
        ...(structured === undefined ? {} : { structuredContent: asJsonObject(structured) }),
      };
    } catch (error) {
      throw this.toolError(`MCP tool "${name}" failed.`, error instanceof Error ? error : undefined);
    }
  }

  async listResources(): Promise<readonly McpResourceDescriptor[]> {
    await this.ensureConnected();
    try {
      const result = await this.client.listResources();
      return result.resources.map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      }));
    } catch (error) {
      throw this.toolError("Failed to list MCP resources.", error instanceof Error ? error : undefined);
    }
  }

  async readResource(uri: string): Promise<JsonValue> {
    await this.ensureConnected();
    enforceAllowList(uri, this.declaration.allowedResources, "resource", this.declaration.name);
    try {
      const result = await this.client.readResource({ uri });
      return asExternalObject(result.contents as object | string | number | boolean | null | undefined);
    } catch (error) {
      throw this.toolError(`MCP resource "${uri}" failed.`, error instanceof Error ? error : undefined);
    }
  }

  async close(): Promise<void> {
    if (!this.transport) return;
    await this.client.close();
    this.connected = false;
    this.transport = undefined;
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) await this.connect();
  }

  private async createTransport(): Promise<Transport> {
    const declaration = this.declaration.transport;
    if (declaration.kind === "custom") return declaration.create(this.credentials, this.context);
    const headers = mergeHeaders(declaration.headers, this.credentials);
    const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;
    if (declaration.kind === "sse") return new SSEClientTransport(new URL(declaration.url), requestInit === undefined ? undefined : { requestInit });
    return new StreamableHTTPClientTransport(new URL(declaration.url), requestInit === undefined ? undefined : { requestInit });
  }

  private discovery(): McpDiscovery {
    const serverVersion = this.client.getServerVersion();
    return {
      serverName: serverVersion?.name,
      serverVersion: serverVersion?.version,
      lifecycle: "unknown",
      capabilities: asJsonObject(this.client.getServerCapabilities()),
    };
  }

  private toolError(message: string, error: Error | undefined): McpError {
    return new McpError(message, "MCP_TOOL_ERROR", this.declaration.name, error);
  }
}

/** Resolve credentials, instantiate a gateway, and connect it in one explicit async operation. */
export async function createMcpGateway(
  declaration: McpServerDeclaration,
  context: McpRequestContext = {},
): Promise<McpGateway> {
  const credentials = typeof declaration.credentials === "function" ? await declaration.credentials(context) : declaration.credentials ?? {};
  const gateway = new SdkMcpGateway(declaration, context, credentials);
  await gateway.connect();
  return gateway;
}

/** A small registry for applications that route different graph steps to different MCP servers. */
export class McpServerRegistry {
  private readonly declarations = new Map<string, McpServerDeclaration>();

  add(declaration: McpServerDeclaration): this {
    if (this.declarations.has(declaration.name)) throw new McpError(`MCP server "${declaration.name}" is already registered.`, "MCP_CONFIG_ERROR", declaration.name);
    this.declarations.set(declaration.name, declaration);
    return this;
  }

  get(name: string): McpServerDeclaration {
    const declaration = this.declarations.get(name);
    if (declaration === undefined) throw new McpError(`MCP server "${name}" is not registered.`, "MCP_CONFIG_ERROR", name);
    return declaration;
  }

  /** Return the names of all declaratively registered MCP servers. */
  list(): readonly string[] {
    return Array.from(this.declarations.keys());
  }

  async connect(name: string, context: McpRequestContext = {}): Promise<McpGateway> {
    return createMcpGateway(this.get(name), context);
  }
}

/** Configuration for an application-level, multi-server MCP connector. */
export interface McpConnectorOptions {
  /** Declarative servers available to graph resources. Connections are lazy. */
  readonly servers: readonly McpServerDeclaration[];
  /** Base context merged into every connection request. */
  readonly context?: McpRequestContext;
  /** Cache static-credential gateways; dynamic credential declarations are always request-scoped. */
  readonly cache?: "shared" | "none";
}

/** Cached MCP gateways and their lifecycle boundary for one host process. */
export interface McpConnector {
  readonly servers: McpServerRegistry;
  readonly list: () => readonly string[];
  readonly server: (name: string, context?: McpRequestContext) => Promise<McpGateway>;
  readonly gateway: (name: string, context?: McpRequestContext) => Promise<McpGateway>;
  readonly close: () => Promise<void>;
}

function mergeRequestContext(base: McpRequestContext, next: McpRequestContext): McpRequestContext {
  return {
    actor: next.actor ?? base.actor,
    threadId: next.threadId ?? base.threadId,
    runId: next.runId ?? base.runId,
    tenantId: next.tenantId ?? base.tenantId,
    variables: { ...(base.variables ?? {}), ...(next.variables ?? {}) },
    global: { ...(base.global ?? {}), ...(next.global ?? {}) },
  };
}

/**
 * Compose multiple MCP declarations into one lazy, cached connector.
 *
 * This is the recommended boundary for examples and host applications. It
 * keeps credential resolution asynchronous, avoids one connection per tool
 * call, and gives the host one close operation for graceful shutdown.
 */
export function createMcpConnector(options: McpConnectorOptions): McpConnector {
  const servers = new McpServerRegistry();
  for (const declaration of options.servers) servers.add(declaration);

  const gateways = new Map<string, Promise<McpGateway>>();
  const scopedGateways = new Set<Promise<McpGateway>>();
  const gateway = (name: string, context: McpRequestContext = {}): Promise<McpGateway> => {
    const mergedContext = mergeRequestContext(options.context ?? {}, context);
    const declaration = servers.get(name);
    const dynamicCredentials = typeof declaration.credentials === "function";
    const cacheable = options.cache !== "none" && !dynamicCredentials;
    const current = cacheable ? gateways.get(name) : undefined;
    if (current !== undefined) return current;
    const connection = servers.connect(name, mergedContext);
    if (cacheable) gateways.set(name, connection);
    else scopedGateways.add(connection);
    return connection;
  };

  return {
    servers,
    list: () => servers.list(),
    server: gateway,
    gateway,
    close: async () => {
      const connections = await Promise.allSettled([...gateways.values(), ...scopedGateways]);
      for (const connection of connections) {
        if (connection.status === "fulfilled") await connection.value.close();
      }
      gateways.clear();
      scopedGateways.clear();
    },
  };
}
