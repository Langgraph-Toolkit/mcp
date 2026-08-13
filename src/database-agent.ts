import {
  ToolkitModelRegistry,
  conditional,
  converge,
  defineGraph,
  edge,
  gate,
  messagesValue,
  node,
  reducedValue,
  schema,
  createToolkitRuntime,
} from "@langgraph-toolkit/core";
import type {
  Actor,
  ChatMessage,
  GraphContracts,
  CompiledGraph,
  GraphDefinition,
  IntentContext,
  JsonObject,
  JsonValue,
  ModelRegistry,
  NodeContext,
  RunOptions,
  RunResult,
  StepEvent,
  ToolkitRuntime,
} from "@langgraph-toolkit/core";
import {
  createMcpGateway,
  createDatabaseMcpTools,
  createMemoryDatabaseMcpGateway,
} from "./index.js";
import type {
  McpDatabaseQueryResult,
  McpDatabaseRow,
  McpDatabaseSchema,
  McpGateway,
  McpServerDeclaration,
} from "./index.js";

/** Intent categories understood by the built-in database workflow. */
export type DatabaseMcpIntent =
  | "lookup"
  | "aggregate"
  | "compare"
  | "trend"
  | "drilldown"
  | "metadata"
  | "follow_up"
  | "explain"
  | "unsupported";

/** Structured, multilingual intent details produced by the LLM analyzer. */
export interface DatabaseMcpIntentDetails extends JsonObject {
  readonly kind: DatabaseMcpIntent;
  readonly entities: readonly string[];
  readonly metrics: readonly string[];
  readonly dimensions: readonly string[];
  readonly timeRange: string | null;
  readonly datasource: string | null;
  readonly tableHint: string | null;
  readonly confidence: number;
  readonly language: string;
  readonly needsClarification: boolean;
}

/** Input accepted by the built-in database MCP agent. */
export interface DatabaseMcpInput {
  readonly question: string;
  readonly conversation?: readonly ChatMessage[];
}

/** Grounded final answer returned by the built-in database MCP agent. */
export interface DatabaseMcpAnswer extends JsonObject {
  readonly text: string;
  readonly citations: readonly string[];
  readonly intent: DatabaseMcpIntent;
  readonly grounded: boolean;
  readonly rowCount: number;
}

/** Policy overrides. Omitted values are inferred from the MCP schema or safe defaults. */
export interface DatabaseMcpPolicyOverrides {
  readonly allowedTables?: readonly string[];
  readonly allowedColumns?: readonly string[];
  readonly sensitiveColumns?: readonly string[];
  readonly approvalRequired?: boolean;
  readonly maxRows?: number;
  readonly maxQueryCost?: number;
  readonly maxRepairAttempts?: number;
  readonly queryTimeoutMs?: number;
}

/** Options for the zero-config MCP database agent preset. */
export interface DatabaseMcpAgentOptions {
  /** An already managed gateway. The agent does not close externally owned gateways. */
  readonly mcp?: McpGateway;
  /** Rows used to create a deterministic in-memory MCP gateway when `mcp` is omitted. */
  readonly rows?: readonly McpDatabaseRow[];
  /** An async credential-aware MCP declaration used when `mcp` and `rows` are omitted. */
  readonly mcpServer?: McpServerDeclaration;
  /** Optional dialect hint used only when the MCP schema does not provide one. */
  readonly dialect?: McpDatabaseSchema["dialect"];
  /** Optional model registry. Without one, the agent uses deterministic mock tiers. */
  readonly modelRegistry?: ModelRegistry;
  /** Actor inherited by runs unless the run options provide another actor. */
  readonly actor?: Actor;
  /** Only deployment-specific policy changes belong here. */
  readonly policy?: DatabaseMcpPolicyOverrides;
  /** Graph name override for hosts that register more than one database agent. */
  readonly name?: string;
}

/** Typed contracts emitted by the database MCP graph. */
export interface DatabaseMcpContracts extends GraphContracts {
  readonly input: DatabaseMcpInput;
  readonly output: DatabaseMcpAnswer;
  readonly interrupt: DatabaseMcpInterrupt;
  readonly answer: DatabaseMcpHumanAnswer;
  readonly thinking: DatabaseMcpThinking;
  readonly toolCall: DatabaseMcpToolCall;
  readonly intent: DatabaseMcpIntent;
}

/** Human approval payload for an answer that must be reviewed before return. */
export interface DatabaseMcpApprovalRequest extends JsonObject {
  readonly kind: "database-answer-review";
  readonly question: string;
  readonly citations: readonly string[];
}

/** Clarification payload emitted when the LLM cannot identify a supported intent. */
export interface DatabaseMcpClarificationRequest extends JsonObject {
  readonly kind: "database-clarification";
  readonly question: string;
  readonly missing: readonly string[];
}

/** Interrupt union used by the MCP database workflow. */
export type DatabaseMcpInterrupt = DatabaseMcpApprovalRequest | DatabaseMcpClarificationRequest;

/** Typed answer supplied when resuming an approval interrupt. */
export interface DatabaseMcpHumanAnswer extends JsonObject {
  readonly approved: boolean;
  readonly note: string | null;
}

/** Thinking event payload emitted by workflow steps. */
export interface DatabaseMcpThinking extends JsonObject {
  readonly phase: "intent" | "schema" | "planning" | "validation" | "retrieval" | "repair" | "synthesis";
  readonly detail: string;
}

/** Tool event payload emitted when the graph calls an MCP database tool. */
export interface DatabaseMcpToolCall extends JsonObject {
  readonly server: string;
  readonly name: "get_schema" | "execute_query" | "analyze_query_cost";
  readonly arguments: JsonObject;
}

export interface DatabaseMcpPermission extends JsonObject {
  readonly actorId: string;
  readonly tenantId: string | null;
  readonly roles: readonly string[];
  readonly allowedTables: readonly string[];
  readonly allowedColumns: readonly string[];
  readonly sensitiveColumns: readonly string[];
}

export interface DatabaseMcpPlan extends JsonObject {
  readonly queryId: string;
  readonly table: string;
  readonly question: string;
  readonly sql: string;
  readonly parameters: JsonObject;
  readonly expectedColumns: readonly string[];
  readonly datasource: string;
  readonly dialect: McpDatabaseSchema["dialect"];
  readonly repairAttempt: number;
}

export interface DatabaseMcpValidation extends JsonObject {
  readonly allowed: boolean;
  readonly normalizedSql: string;
  readonly reasons: readonly string[];
  readonly policyDecision: "allow" | "deny";
  readonly estimatedCost: number;
  readonly allowedColumns: readonly string[];
  readonly tenantPredicatePresent: boolean;
}

export interface DatabaseMcpError extends JsonObject {
  readonly queryId: string;
  readonly code: "MCP_ERROR" | "POLICY";
  readonly message: string;
  readonly retryable: boolean;
}

export interface DatabaseMcpAudit extends JsonObject {
  readonly queryId: string;
  readonly actorId: string;
  readonly datasource: string;
  readonly question: string;
  readonly sql: string | null;
  readonly policyDecision: "allow" | "deny";
  readonly rowCount: number;
  readonly durationMs: number;
  readonly retryCount: number;
}

export interface DatabaseMcpGlobal extends JsonObject {
  readonly allowedTables: readonly string[];
  readonly allowedColumns: readonly string[];
  readonly sensitiveColumns: readonly string[];
  readonly approvalRequired: boolean;
  readonly maxRows: number;
  readonly mcpServer: string;
  readonly dialect: McpDatabaseSchema["dialect"];
  readonly maxQueryCost: number;
  readonly maxRepairAttempts: number;
  readonly queryTimeoutMs: number;
}

export interface DatabaseMcpState {
  readonly question: string;
  readonly conversation: readonly ChatMessage[];
  readonly messages: readonly ChatMessage[];
  readonly actorId: string;
  readonly intent: DatabaseMcpIntent;
  readonly intentDetails: DatabaseMcpIntentDetails;
  readonly permission: DatabaseMcpPermission;
  readonly rows: readonly McpDatabaseRow[];
  readonly citations: readonly string[];
  readonly schema?: McpDatabaseSchema;
  readonly plan?: DatabaseMcpPlan;
  readonly validation?: DatabaseMcpValidation;
  readonly queryResult?: McpDatabaseQueryResult;
  readonly queryErrors: readonly DatabaseMcpError[];
  readonly repairAttempts: number;
  readonly audit: readonly DatabaseMcpAudit[];
  readonly clarification?: DatabaseMcpClarificationRequest;
  readonly status: "received" | "schema_ready" | "planned" | "validated" | "retrieved" | "composed" | "completed" | "need_clarification" | "failed" | "unauthorized" | "datasource_unavailable";
  readonly answer?: DatabaseMcpAnswer;
  readonly approved: boolean;
  readonly approvalNote: string | null;
}

type DatabaseMcpContext = NodeContext<DatabaseMcpState, DatabaseMcpContracts, JsonObject, DatabaseMcpGlobal>;

/** A ready-to-run graph resource with MCP and host lifecycle ownership made explicit. */
export interface DatabaseMcpAgent {
  readonly name: string;
  readonly gateway: McpGateway;
  readonly runtime: ToolkitRuntime;
  readonly graph: CompiledGraph<DatabaseMcpState, DatabaseMcpInput, DatabaseMcpAnswer, DatabaseMcpContracts, JsonObject, DatabaseMcpGlobal>;
  readonly run: (input: DatabaseMcpInput, options?: RunOptions<DatabaseMcpContracts, JsonObject, DatabaseMcpGlobal>) => Promise<RunResult<DatabaseMcpState, DatabaseMcpAnswer, DatabaseMcpInterrupt, JsonObject>>;
  readonly stream: (input: DatabaseMcpInput, options?: RunOptions<DatabaseMcpContracts, JsonObject, DatabaseMcpGlobal>) => AsyncIterable<StepEvent<DatabaseMcpState, DatabaseMcpContracts>>;
  readonly close: () => Promise<void>;
}

const DATABASE_INTENTS: readonly DatabaseMcpIntent[] = ["lookup", "aggregate", "compare", "trend", "drilldown", "metadata", "follow_up", "explain", "unsupported"];

function asObject(value: JsonValue | undefined, name: string): JsonObject {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const object: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) object[key] = item;
  return object;
}

function asString(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function readStringList(value: JsonValue | undefined): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

function parseConversation(value: JsonValue | undefined): readonly ChatMessage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("conversation must be an array");
  return value.map((item, index) => {
    const object = asObject(item, `conversation[${index}]`);
    const role = asString(object.role, `conversation[${index}].role`);
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") throw new Error(`conversation[${index}].role is invalid`);
    return { role, content: asString(object.content, `conversation[${index}].content`) } satisfies ChatMessage;
  });
}

function parseJsonObject(text: string): JsonObject {
  const lines = text.trim().split("\n");
  const body = lines[0]?.trim().startsWith("```") && lines.at(-1)?.trim() === "```" ? lines.slice(1, -1).join("\n") : text.trim();
  try {
    const parsed = JSON.parse(body) as JsonValue;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const object: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(parsed)) object[key] = item;
    return object;
  } catch {
    return {};
  }
}

function databaseIntent(input: DatabaseMcpInput, ctx: IntentContext): Promise<{
  readonly value: DatabaseMcpIntent;
  readonly details: DatabaseMcpIntentDetails;
  readonly analysis: { readonly confidence: number; readonly language: string; readonly tableHint?: string; readonly needsClarification: boolean };
}> {
  const messages: readonly ChatMessage[] = [
    { role: "system", content: "You are a multilingual database intent classifier. Understand spelling mistakes and any user language. Return JSON only with kind, entities, metrics, dimensions, timeRange, datasource, tableHint, confidence, language, needsClarification. Choose aggregate for count or total requests. Never invent a table name." },
    ...(input.conversation ?? []).slice(-8),
    { role: "user", content: input.question },
  ];
  return (async () => {
    let text = "";
    let tokenIndex = 0;
    let reasoningIndex = 0;
    if (ctx.model.streamDetailed) {
      for await (const chunk of ctx.model.streamDetailed(messages)) {
        if (chunk.type === "token") {
          text += chunk.value;
          ctx.emitToken(chunk.value, tokenIndex++);
        } else if (chunk.type === "reasoning") {
          ctx.emitReasoning(chunk.value, reasoningIndex++);
        } else {
          ctx.emitUsage(chunk.value);
        }
      }
    } else {
      text = (await ctx.model.chat(messages)).content;
    }
    const raw = parseJsonObject(text);
    const rawKind = typeof raw.kind === "string" ? raw.kind : "unsupported";
    const kind = DATABASE_INTENTS.includes(rawKind as DatabaseMcpIntent) ? rawKind as DatabaseMcpIntent : "unsupported";
    const confidence = typeof raw.confidence === "number" && Number.isFinite(raw.confidence) ? Math.max(0, Math.min(1, raw.confidence)) : 0;
    const details: DatabaseMcpIntentDetails = {
      kind,
      entities: readStringList(raw.entities),
      metrics: readStringList(raw.metrics),
      dimensions: readStringList(raw.dimensions),
      timeRange: typeof raw.timeRange === "string" ? raw.timeRange : null,
      datasource: typeof raw.datasource === "string" ? raw.datasource : null,
      tableHint: typeof raw.tableHint === "string" ? raw.tableHint : null,
      confidence,
      language: typeof raw.language === "string" ? raw.language : "unknown",
      needsClarification: raw.needsClarification === true || kind === "unsupported",
    };
    const analysis = { confidence, language: details.language, ...(details.tableHint === null ? {} : { tableHint: details.tableHint }), needsClarification: details.needsClarification };
    ctx.emitAnalysis(analysis);
    return { value: kind, details, analysis };
  })();
}

function claimString(claims: JsonObject | undefined, name: string): string | null {
  const value = claims?.[name];
  return typeof value === "string" ? value : null;
}

function permissionFor(state: DatabaseMcpState, ctx: DatabaseMcpContext): DatabaseMcpPermission {
  return {
    actorId: ctx.actor?.id ?? state.actorId,
    tenantId: claimString(ctx.actor?.claims, "tenantId"),
    roles: ctx.actor?.roles ?? [],
    allowedTables: ctx.global.allowedTables,
    allowedColumns: ctx.global.allowedColumns,
    sensitiveColumns: ctx.global.sensitiveColumns,
  };
}

function columnsFor(state: DatabaseMcpState, global: DatabaseMcpGlobal): readonly string[] {
  const table = state.schema?.tables.find((item) => global.allowedTables.length === 0 || global.allowedTables.includes(item.name));
  const discovered = table?.columns.map((column) => column.name) ?? [];
  const available = global.allowedColumns.length === 0 ? discovered : discovered.filter((column) => global.allowedColumns.includes(column));
  return available.filter((column) => !global.sensitiveColumns.includes(column));
}

function validationFor(state: DatabaseMcpState, global: DatabaseMcpGlobal): DatabaseMcpValidation {
  if (state.plan === undefined) return { allowed: false, normalizedSql: "", reasons: ["No query plan exists"], policyDecision: "deny", estimatedCost: 0, allowedColumns: [], tenantPredicatePresent: true };
  const sql = state.plan.sql.trim().replace(/\s+/g, " ");
  const reasons: string[] = [];
  if (!/^select\s/i.test(sql)) reasons.push("Only SELECT statements are allowed");
  if (/\b(insert|update|delete|drop|alter|truncate|grant|revoke|create)\b/i.test(sql)) reasons.push("Mutation keywords are not allowed");
  if (global.allowedTables.length > 0 && !global.allowedTables.includes(state.plan.table)) reasons.push(`Table ${state.plan.table} is not allowed`);
  if (sql.length > 1000) reasons.push("Query exceeds the policy length budget");
  const selectMatch = sql.match(/^select\s+(.+?)\s+from\s+/i);
  const selectedColumns = selectMatch?.[1].split(",").map((column) => column.trim().split(/\s+as\s+/i)[0].trim()).filter((column) => column !== "*") ?? [];
  const deniedColumns = selectedColumns.filter((column) => (global.allowedColumns.length > 0 && !global.allowedColumns.includes(column)) || global.sensitiveColumns.includes(column));
  if (deniedColumns.length > 0) reasons.push(`Columns are not allowed: ${deniedColumns.join(", ")}`);
  const tenantPredicatePresent = state.permission.tenantId === null || /\btenant_id\b/i.test(sql);
  if (!tenantPredicatePresent) reasons.push("Tenant predicate is required for this actor");
  const estimatedCost = Math.max(1, Math.ceil(sql.length / 180) + (sql.includes("*") ? 2 : 0));
  if (estimatedCost > global.maxQueryCost) reasons.push(`Estimated query cost ${estimatedCost} exceeds budget ${global.maxQueryCost}`);
  return { allowed: reasons.length === 0, normalizedSql: sql, reasons, policyDecision: reasons.length === 0 ? "allow" : "deny", estimatedCost, allowedColumns: selectedColumns.length === 0 ? columnsFor(state, global) : selectedColumns, tenantPredicatePresent };
}

function rowText(row: McpDatabaseRow): string {
  const values = Object.entries(row).filter(([key]) => key !== "id" && key !== "table").map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`).join("; ");
  return `${row.id}${values.length === 0 ? "" : `: ${values}`}`;
}

function createDatabaseGraph(gateway: McpGateway, global: DatabaseMcpGlobal, name: string) {
  const { schemaTool, executeQueryTool } = createDatabaseMcpTools(gateway, {
    server: global.mcpServer,
    dialect: global.dialect,
    allowedTables: global.allowedTables,
    maxRows: global.maxRows,
  });
  type C = DatabaseMcpContracts;
  type Context = NodeContext<DatabaseMcpState, C, JsonObject, DatabaseMcpGlobal>;

  const nodes = {
    intake: async (state: DatabaseMcpState, ctx: Context): Promise<Partial<DatabaseMcpState>> => {
      ctx.think({ phase: "intent", detail: "Classifying intent with the configured LLM" }, "Classify intent");
      const classification = await ctx.analyzeIntent({ name: "database-intent", analyze: databaseIntent }, { question: state.question, conversation: state.conversation });
      const permission = permissionFor(state, ctx);
      return { actorId: permission.actorId, intent: classification.value, intentDetails: classification.details, permission, status: "received" };
    },
    discover: async (state: DatabaseMcpState, ctx: Context): Promise<Partial<DatabaseMcpState>> => {
      if (state.intent === "unsupported") return { status: "need_clarification", clarification: { kind: "database-clarification", question: state.question, missing: ["supported database entity or intent"] } };
      ctx.think({ phase: "schema", detail: "Discovering the approved schema through MCP" }, "Discover schema");
      try {
        const result = await ctx.callTool(schemaTool, {});
        const tables = global.allowedTables.length === 0 ? result.tables : result.tables.filter((table) => global.allowedTables.includes(table.name));
        const permission = { ...state.permission, allowedTables: tables.map((table) => table.name) };
        return { schema: { ...result, tables }, permission, status: "schema_ready" };
      } catch (error) {
        return { queryErrors: [{ queryId: "unplanned", code: "MCP_ERROR", message: error instanceof Error ? error.message : "Schema discovery failed", retryable: true }], status: "datasource_unavailable" };
      }
    },
    plan: async (state: DatabaseMcpState, ctx: Context): Promise<Partial<DatabaseMcpState>> => {
      if (state.status === "need_clarification" || state.schema === undefined) return { status: state.status };
      ctx.think({ phase: "planning", detail: "Building a bounded read-only query plan" }, "Plan query");
      const table = state.schema.tables[0]?.name;
      if (table === undefined) return { status: "unauthorized", queryErrors: [{ queryId: "unplanned", code: "POLICY", message: "No approved table is available for this actor.", retryable: false }] };
      const columns = columnsFor(state, global);
      const selected = columns.length > 0 ? columns : ["id"];
      const queryId = `${ctx.runId}:query-1`;
      return {
        plan: { queryId, table, question: state.question, sql: `SELECT ${selected.join(", ")} FROM ${table} LIMIT :limit`, parameters: { query: state.question, limit: global.maxRows }, expectedColumns: selected, datasource: global.mcpServer, dialect: global.dialect, repairAttempt: state.repairAttempts },
        status: "planned",
      };
    },
    validate: async (state: DatabaseMcpState, ctx: Context): Promise<Partial<DatabaseMcpState>> => {
      ctx.think({ phase: "validation", detail: "Applying read-only, table, column, tenant and cost policy" }, "Validate query");
      const validation = validationFor(state, global);
      return { validation, status: validation.allowed ? "validated" : "failed" };
    },
    repair: async (state: DatabaseMcpState, ctx: Context): Promise<Partial<DatabaseMcpState>> => {
      if (state.plan === undefined || state.repairAttempts >= global.maxRepairAttempts) return { status: "failed" };
      ctx.think({ phase: "repair", detail: "Rewriting a rejected query within the retry budget" }, "Repair query");
      const columns = columnsFor(state, global);
      const selected = columns.length > 0 ? columns : ["id"];
      return { plan: { ...state.plan, sql: `SELECT ${selected.join(", ")} FROM ${state.plan.table} LIMIT :limit`, expectedColumns: selected, repairAttempt: state.repairAttempts + 1 }, repairAttempts: state.repairAttempts + 1, status: "planned" };
    },
    retrieve: async (state: DatabaseMcpState, ctx: Context): Promise<Partial<DatabaseMcpState>> => {
      if (state.plan === undefined || state.validation?.allowed !== true) return { status: "failed" };
      ctx.think({ phase: "retrieval", detail: "Executing one validated read-only query through MCP" }, "Execute MCP query");
      try {
        const queryHint = state.intentDetails.entities.length > 0 ? state.intentDetails.entities.join(" ") : state.intentDetails.tableHint ?? state.plan.table;
        const result = await ctx.callTool(executeQueryTool, { queryId: state.plan.queryId, query: queryHint, table: state.plan.table, limit: global.maxRows, sql: state.validation.normalizedSql });
        return { queryResult: result, rows: result.rows, citations: result.rows.map((row) => `${result.datasource}:${result.queryId}:${row.id}`), audit: [{ queryId: state.plan.queryId, actorId: state.actorId, datasource: result.datasource, question: state.question, sql: state.plan.sql, policyDecision: "allow", rowCount: result.rowCount, durationMs: result.durationMs, retryCount: state.repairAttempts }], status: "retrieved" };
      } catch (error) {
        return { queryErrors: [{ queryId: state.plan.queryId, code: "MCP_ERROR", message: error instanceof Error ? error.message : "MCP query execution failed", retryable: true }], status: "datasource_unavailable" };
      }
    },
    compose: async (state: DatabaseMcpState, ctx: Context): Promise<Partial<DatabaseMcpState>> => {
      ctx.think({ phase: "synthesis", detail: "Preparing a grounded answer from MCP query results" }, "Compose answer");
      const answer = state.status === "need_clarification"
        ? { text: "Please clarify the database entity, metric, or time range you want to inspect.", citations: [], intent: state.intent, grounded: false, rowCount: 0 }
        : state.status === "unauthorized"
          ? { text: "This actor is not authorized to query the requested database scope.", citations: [], intent: state.intent, grounded: false, rowCount: 0 }
          : state.status === "datasource_unavailable" || state.queryResult === undefined
            ? { text: "The approved database source is temporarily unavailable. No unverified answer was produced.", citations: [], intent: state.intent, grounded: false, rowCount: 0 }
            : { text: state.rows.length === 0 ? "I could not find an approved database record for that question." : state.rows.map(rowText).join("\n"), citations: state.citations, intent: state.intent, grounded: state.rows.length > 0, rowCount: state.rows.length };
      return { answer, status: "composed" };
    },
    approval: async (state: DatabaseMcpState, ctx: Context): Promise<Partial<DatabaseMcpState>> => {
      if (!global.approvalRequired || state.answer === undefined) return { approved: true, status: "completed" };
      if (ctx.answer?.approved === true) return { approved: true, approvalNote: ctx.answer.note, status: "completed" };
      ctx.ask({ kind: "database-answer-review", prompt: "Approve this database answer before returning it.", payload: { kind: "database-answer-review", question: state.question, citations: state.citations } });
    },
    respond: async (state: DatabaseMcpState): Promise<Partial<DatabaseMcpState>> => ({ status: state.answer === undefined ? "failed" : "completed" }),
  };

  const approvalGate = gate<DatabaseMcpState, DatabaseMcpInterrupt>("database-answer-approval", async (state) => state.answer === undefined ? { kind: "deny", reason: "No answer exists to approve." } : { kind: "allow" });
  return defineGraph<DatabaseMcpState, DatabaseMcpInput, DatabaseMcpAnswer, DatabaseMcpContracts, JsonObject, DatabaseMcpGlobal>({
    name,
    state: {
      question: "",
      conversation: messagesValue(),
      messages: messagesValue(),
      actorId: "anonymous",
      intent: "unsupported",
      intentDetails: { kind: "unsupported", entities: [], metrics: [], dimensions: [], timeRange: null, datasource: global.mcpServer, tableHint: null, confidence: 0, language: "unknown", needsClarification: true },
      permission: { actorId: "anonymous", tenantId: null, roles: [], allowedTables: global.allowedTables, allowedColumns: global.allowedColumns, sensitiveColumns: global.sensitiveColumns },
      rows: reducedValue<readonly McpDatabaseRow[]>([], (previous, next) => [...previous, ...next]),
      citations: reducedValue<readonly string[]>([], (previous, next) => [...new Set([...previous, ...next])]),
      schema: undefined as never,
      plan: undefined as never,
      validation: undefined as never,
      queryResult: undefined as never,
      queryErrors: [],
      repairAttempts: 0,
      audit: [],
      clarification: undefined as never,
      status: "received",
      answer: undefined as never,
      approved: false,
      approvalNote: null,
    },
    schemas: {
      input: schema<DatabaseMcpInput>("DatabaseMcpInput", (value) => {
        const object = asObject(value, "database input");
        return { question: asString(object.question, "question"), conversation: parseConversation(object.conversation) };
      }),
      output: schema<DatabaseMcpAnswer>("DatabaseMcpAnswer", (value) => {
        const state = asObject(value, "database state");
        return asObject(state.answer, "database answer") as DatabaseMcpAnswer;
      }),
    },
    nodes: {
      intake: node(nodes.intake, { tier: "cheap", label: "Classify intent", stepLabel: "Classify intent" }),
      discover: node(nodes.discover, { tier: "cheap", label: "Discover MCP schema", stepLabel: "Discover MCP schema" }),
      plan: node(nodes.plan, { tier: "cheap", label: "Plan read-only query", stepLabel: "Plan query" }),
      validate: node(nodes.validate, { tier: "cheap", label: "Validate query policy", stepLabel: "Validate query" }),
      repair: node(nodes.repair, { tier: "cheap", label: "Repair query", stepLabel: "Repair query" }),
      retrieve: node(nodes.retrieve, { tier: "cheap", label: "Execute MCP query", stepLabel: "Execute MCP query" }),
      compose: node(nodes.compose, { tier: "strong", label: "Compose grounded answer", stepLabel: "Compose answer" }),
      approval: node(nodes.approval, { label: "Human approval", stepLabel: "Human approval", gate: approvalGate, risk: "write" }),
      respond: node(nodes.respond, { label: "Return answer", stepLabel: "Return answer" }),
    },
    edges: [
      edge("intake", "discover", "Intent classified"),
      edge("discover", "plan", "MCP schema discovered"),
      edge("plan", "validate", "Query planned"),
      conditional("validate", (state) => state.validation?.allowed === true ? "retrieve" : state.repairAttempts < global.maxRepairAttempts ? "repair" : "compose", ["retrieve", "repair", "compose"], "Validation decision"),
      edge("repair", "validate", "Retry repaired query"),
      edge("retrieve", "compose", "MCP rows retrieved"),
      edge("compose", "approval", "Answer ready"),
      edge("approval", "respond", "Approved"),
      conditional("respond", () => "END", ["END"], "Complete"),
    ],
    variables: { queryCount: 0 },
    global,
    converge: converge("repairAttempts", global.maxRepairAttempts + 1),
  });
}

function defaultRegistry(): ToolkitModelRegistry {
  return new ToolkitModelRegistry({
    tiers: {
      cheap: { driver: "mock", model: "database-mcp-cheap", mockResponse: '{"kind":"lookup","entities":[],"metrics":[],"dimensions":[],"timeRange":null,"datasource":null,"tableHint":null,"confidence":0.5,"language":"en","needsClarification":false}' },
      strong: { driver: "mock", model: "database-mcp-strong", mockResponse: '{"kind":"lookup","entities":[],"metrics":[],"dimensions":[],"timeRange":null,"datasource":null,"tableHint":null,"confidence":0.5,"language":"en","needsClarification":false}' },
    },
  });
}

function databaseGlobal(gateway: McpGateway, policy: DatabaseMcpPolicyOverrides, dialect: McpDatabaseSchema["dialect"]): DatabaseMcpGlobal {
  return {
    allowedTables: policy.allowedTables ?? [],
    allowedColumns: policy.allowedColumns ?? [],
    sensitiveColumns: policy.sensitiveColumns ?? [],
    // Database answers are gated by default. Deployments may explicitly opt
    // out when their own authorization and review layer is authoritative.
    approvalRequired: policy.approvalRequired ?? true,
    maxRows: policy.maxRows ?? 20,
    mcpServer: gateway.server,
    dialect,
    maxQueryCost: policy.maxQueryCost ?? 20,
    maxRepairAttempts: policy.maxRepairAttempts ?? 1,
    queryTimeoutMs: policy.queryTimeoutMs ?? 10_000,
  };
}

/** Create a reusable graph definition backed by a memory or already-managed MCP gateway. */
export function createDatabaseMcpDefinition(
  options: Omit<DatabaseMcpAgentOptions, "mcpServer" | "modelRegistry"> = {},
): GraphDefinition<DatabaseMcpState, DatabaseMcpInput, DatabaseMcpAnswer, DatabaseMcpContracts, JsonObject, DatabaseMcpGlobal> {
  const gateway = options.mcp ?? createMemoryDatabaseMcpGateway(options.rows ?? []);
  return createDatabaseGraph(gateway, databaseGlobal(gateway, options.policy ?? {}, options.dialect ?? "memory"), options.name ?? "database-mcp-agent");
}

/** Create a zero-config, typed database agent whose schema and query flow run through MCP. */
export async function createDatabaseMcpAgent(options: DatabaseMcpAgentOptions = {}): Promise<DatabaseMcpAgent> {
  let ownsGateway = false;
  let gateway = options.mcp;
  if (gateway === undefined && options.mcpServer !== undefined) {
    gateway = await createMcpGateway(options.mcpServer, { actor: options.actor });
    ownsGateway = true;
  }
  if (gateway === undefined) {
    gateway = createMemoryDatabaseMcpGateway(options.rows ?? []);
    ownsGateway = true;
  }
  const policy = options.policy ?? {};
  const global = databaseGlobal(gateway, policy, options.dialect ?? "memory");
  const modelRegistry = options.modelRegistry ?? defaultRegistry();
  const runtime = createToolkitRuntime({ modelRegistry, actor: options.actor });
  const name = options.name ?? "database-mcp-agent";
  const graph = runtime.register(createDatabaseGraph(gateway, global, name));
  return {
    name,
    gateway,
    runtime,
    graph,
    run: (input, runOptions) => graph.run(input, { ...runOptions, modelRegistry: runOptions?.modelRegistry ?? modelRegistry, actor: runOptions?.actor ?? options.actor }),
    stream: (input, streamOptions) => graph.stream(input, { ...streamOptions, modelRegistry: streamOptions?.modelRegistry ?? modelRegistry, actor: streamOptions?.actor ?? options.actor }),
    close: async () => { if (ownsGateway) await gateway.close(); },
  };
}
