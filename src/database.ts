import { schema, tool, type JsonObject, type JsonValue } from "@langgraph-toolkit/core";
import type { McpDiscovery, McpGateway, McpResourceDescriptor, McpToolDescriptor, McpToolResult } from "./index.js";

/** A normalized row shape for database-oriented MCP integrations. */
export type McpDatabaseRow = JsonObject & {
  readonly id: string;
  readonly table: string;
};

/** A normalized database schema returned by an MCP server. */
export type McpDatabaseSchemaColumn = JsonObject & {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
};

export type McpDatabaseSchemaTable = JsonObject & {
  readonly name: string;
  readonly columns: readonly McpDatabaseSchemaColumn[];
};

export type McpDatabaseSchema = JsonObject & {
  readonly dialect: "memory" | "postgres" | "mysql" | "sqlite" | "mongodb";
  readonly tables: readonly McpDatabaseSchemaTable[];
};

/** A normalized read-only query result returned by a database MCP server. */
export type McpDatabaseQueryResult = JsonObject & {
  readonly queryId: string;
  readonly datasource: string;
  readonly rows: readonly McpDatabaseRow[];
  readonly columns: readonly string[];
  readonly rowCount: number;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly warnings: readonly string[];
};

/** Configuration shared by the typed schema and query tool wrappers. */
export interface McpDatabaseToolOptions {
  readonly server: string;
  readonly dialect?: McpDatabaseSchema["dialect"];
  readonly allowedTables: readonly string[];
  readonly maxRows: number;
}

export interface McpDatabaseSchemaArgs {
  readonly includeViews?: boolean;
}

export interface McpDatabaseQueryArgs {
  readonly queryId: string;
  readonly query: string;
  readonly table?: string;
  readonly limit: number;
  readonly sql: string;
}

function asObject(value: JsonValue, name: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const object: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) object[key] = item;
  return object;
}

function asString(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function asBoolean(value: JsonValue | undefined, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function asNumber(value: JsonValue | undefined, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function parseSchema(value: JsonObject, dialect: McpDatabaseSchema["dialect"]): McpDatabaseSchema {
  if (!Array.isArray(value.tables)) throw new Error("MCP schema result did not include tables");
  const tables = value.tables.map((tableValue, tableIndex) => {
    const table = asObject(tableValue, `tables[${tableIndex}]`);
    if (!Array.isArray(table.columns)) throw new Error(`tables[${tableIndex}].columns must be an array`);
    const columns = table.columns.map((columnValue, columnIndex) => {
      const column = asObject(columnValue, `tables[${tableIndex}].columns[${columnIndex}]`);
      return {
        name: asString(column.name, "column.name"),
        type: asString(column.type, "column.type"),
        nullable: asBoolean(column.nullable, "column.nullable"),
      } satisfies McpDatabaseSchemaColumn;
    });
    return { name: asString(table.name, "table.name"), columns } satisfies McpDatabaseSchemaTable;
  });
  return { dialect: isDialect(value.dialect) ? value.dialect : dialect, tables };
}

function isDialect(value: JsonValue): value is McpDatabaseSchema["dialect"] {
  return value === "memory" || value === "postgres" || value === "mysql" || value === "sqlite" || value === "mongodb";
}

function parseRow(value: JsonValue, index: number): McpDatabaseRow {
  const row = asObject(value, `rows[${index}]`);
  return {
    ...row,
    id: asString(row.id, "row.id"),
    table: asString(row.table, "row.table"),
  };
}

function jsonType(value: JsonValue | undefined): string {
  if (value === null || Array.isArray(value)) return "json";
  if (typeof value === "string") return "text";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "json";
}

function inferColumns(rows: readonly McpDatabaseRow[]): readonly McpDatabaseSchemaColumn[] {
  const names = new Set(rows.flatMap((row) => Object.keys(row)));
  return [...names].map((name) => {
    const values = rows.map((row) => row[name]);
    const firstValue = values.find((value) => value !== undefined && value !== null);
    return {
      name,
      type: jsonType(firstValue),
      nullable: values.some((value) => value === undefined || value === null),
    } satisfies McpDatabaseSchemaColumn;
  });
}

function parseQueryResult(value: JsonObject, queryId: string, datasource: string): McpDatabaseQueryResult {
  if (!Array.isArray(value.rows) || !Array.isArray(value.columns) || !Array.isArray(value.warnings)) {
    throw new Error("MCP query result is not structured");
  }
  const columns = value.columns.map((column, index) => asString(column, `columns[${index}]`));
  const warnings = value.warnings.map((warning, index) => asString(warning, `warnings[${index}]`));
  return {
    queryId,
    datasource,
    rows: value.rows.map(parseRow),
    columns,
    rowCount: asNumber(value.rowCount, "rowCount"),
    truncated: asBoolean(value.truncated, "truncated"),
    durationMs: asNumber(value.durationMs, "durationMs"),
    warnings,
  };
}

function result(value: JsonObject): McpToolResult {
  return { isError: false, content: value, structuredContent: value };
}

/** Create typed schema and read-only query tools backed by any MCP gateway. */
export function createDatabaseMcpTools(gateway: McpGateway, options: McpDatabaseToolOptions): {
  readonly schemaTool: ReturnType<typeof tool<McpDatabaseSchemaArgs, McpDatabaseSchema>>;
  readonly executeQueryTool: ReturnType<typeof tool<McpDatabaseQueryArgs, McpDatabaseQueryResult>>;
} {
  const schemaTool = tool<McpDatabaseSchemaArgs, McpDatabaseSchema>({
    name: "get_schema",
    description: "Discover the schema through the configured MCP database server.",
    input: schema<McpDatabaseSchemaArgs>("McpDatabaseSchemaArgs", (value) => {
      const object = asObject(value, "schema arguments");
      return { includeViews: object.includeViews === true };
    }),
    async execute(args) {
      const response = await gateway.callTool("get_schema", args.includeViews === true ? { includeViews: true } : {});
      if (response.isError || response.structuredContent === undefined) {
        throw new Error(`MCP schema discovery failed on ${options.server}`);
      }
      return parseSchema(response.structuredContent, options.dialect ?? "memory");
    },
  });

  const executeQueryTool = tool<McpDatabaseQueryArgs, McpDatabaseQueryResult>({
    name: "execute_query",
    description: "Execute a validated read-only query through the configured MCP database server.",
    input: schema<McpDatabaseQueryArgs>("McpDatabaseQueryArgs", (value) => {
      const object = asObject(value, "query arguments");
      if (typeof object.queryId !== "string" || typeof object.query !== "string" || typeof object.sql !== "string") {
        throw new Error("queryId, query and sql are required");
      }
      if (typeof object.limit !== "number" || !Number.isInteger(object.limit) || object.limit < 1) {
        throw new Error("limit must be a positive integer");
      }
      if (object.table !== undefined && typeof object.table !== "string") throw new Error("table must be a string");
      return {
        queryId: object.queryId,
        query: object.query,
        ...(typeof object.table === "string" ? { table: object.table } : {}),
        limit: Math.min(object.limit, options.maxRows),
        sql: object.sql,
      };
    }),
    async execute(args) {
      if (args.table !== undefined && options.allowedTables.length > 0 && !options.allowedTables.includes(args.table)) {
        throw new Error(`Table is not allowed: ${args.table}`);
      }
      const response = await gateway.callTool("execute_query", {
        queryId: args.queryId,
        query: args.query,
        ...(args.table === undefined ? {} : { table: args.table }),
        limit: args.limit,
        sql: args.sql,
      });
      if (response.isError || response.structuredContent === undefined) {
        throw new Error(`MCP query execution failed on ${options.server}`);
      }
      return parseQueryResult(response.structuredContent, args.queryId, options.server);
    },
  });

  return { schemaTool, executeQueryTool };
}

export interface MemoryDatabaseMcpOptions {
  readonly dialect?: McpDatabaseSchema["dialect"];
  readonly serverName?: string;
}

/** A deterministic in-memory database gateway for examples and contributor tests. */
export function createMemoryDatabaseMcpGateway(rows: readonly McpDatabaseRow[], options: MemoryDatabaseMcpOptions = {}): McpGateway {
  const server = options.serverName ?? "database";
  const dialect = options.dialect ?? "memory";
  const tables = [...new Set(rows.map((row) => row.table))].map((name) => {
    const tableRows = rows.filter((row) => row.table === name);
    return { name, columns: inferColumns(tableRows) } satisfies McpDatabaseSchemaTable;
  });
  let connected = false;
  const discovery: McpDiscovery = {
    serverName: server,
    serverVersion: "memory-mcp-1.0.0",
    protocolVersion: undefined,
    lifecycle: "unknown",
    capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
  };
  const tools: readonly McpToolDescriptor[] = [
    { name: "get_schema", description: "Return the database schema.", inputSchema: { type: "object" } },
    { name: "execute_query", description: "Execute a bounded read-only query.", inputSchema: { type: "object" } },
  ];

  return {
    server,
    async connect() {
      connected = true;
      return discovery;
    },
    async listTools() {
      if (!connected) await this.connect();
      return tools;
    },
    async callTool(name, args) {
      if (!connected) await this.connect();
      if (name === "get_schema") return result({ dialect, tables });
      if (name !== "execute_query") return { isError: true, content: { message: `Unsupported tool: ${name}` } };
      const queryId = asString(args.queryId, "queryId");
      const query = asString(args.query, "query");
      const table = args.table === undefined ? undefined : asString(args.table, "table");
      const limit = asNumber(args.limit, "limit");
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be an integer between 1 and 100");
      const needle = query.toLowerCase();
      const filtered = rows.filter((row) => {
        const matchesTable = table === undefined || row.table === table;
        const haystack = JSON.stringify(row).toLowerCase();
        return matchesTable && haystack.includes(needle);
      }).slice(0, limit);
      const columns = [...new Set(filtered.flatMap((row) => Object.keys(row)))];
      return result({
        queryId,
        datasource: server,
        rows: filtered,
        columns,
        rowCount: filtered.length,
        truncated: filtered.length === limit,
        durationMs: 0,
        warnings: filtered.length === limit ? ["Result may be truncated by the configured row limit."] : [],
      });
    },
    async listResources(): Promise<readonly McpResourceDescriptor[]> {
      if (!connected) await this.connect();
      return [{ uri: `mcp://${server}/schema`, name: "schema", description: "Database schema", mimeType: "application/json" }];
    },
    async readResource(uri) {
      if (!connected) await this.connect();
      if (uri !== `mcp://${server}/schema`) throw new Error(`Unknown resource: ${uri}`);
      return { dialect, tables };
    },
    async close() {
      connected = false;
    },
  };
}
