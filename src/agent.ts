import type {
  ChatMessage,
  ChatResult,
  ChatStreamChunk,
  ChatStreamOptions,
  JsonObject,
  JsonValue,
  LLMSession,
  ModelToolCall,
  ModelToolSpec,
  TokenUsage,
} from "@langgraph-toolkit/core";
import type { McpConnector, McpGateway, McpToolDescriptor } from "./core.js";
import { McpError, formatValue } from "./core.js";

/** A local tool that can be composed with discovered MCP tools. */
export interface McpAgentTool {
  readonly spec: ModelToolSpec;
  execute(args: JsonObject): JsonValue | Promise<JsonValue>;
}

/** Options for the generic MCP-aware tool-calling agent. */
export interface McpAgentOptions {
  readonly model: LLMSession;
  readonly mcp: McpConnector;
  readonly tools?: readonly McpAgentTool[];
  readonly name?: string;
  readonly maxRounds?: number;
}

/** Per-run options for an MCP agent. */
export interface McpAgentRunOptions extends ChatStreamOptions {
  readonly maxRounds?: number;
}

/** The normalized result returned after the model and MCP tools settle. */
export interface McpAgentResult {
  readonly message: ChatMessage;
  readonly rounds: number;
  readonly toolCalls: readonly ModelToolCall[];
  readonly usage?: TokenUsage;
}

/** Additional lifecycle chunks emitted while an MCP agent executes tools. */
export type McpAgentChunk =
  | ChatStreamChunk
  | { readonly type: "tool_start"; readonly name: string; readonly arguments: JsonObject }
  | { readonly type: "tool_end"; readonly name: string; readonly result: JsonValue };

/** A generic agent that combines one model with zero or more MCP servers. */
export interface McpAgent {
  readonly name: string;
  readonly model: LLMSession;
  readonly mcp: McpConnector;
  discover(): Promise<readonly ModelToolSpec[]>;
  run(messages: readonly ChatMessage[], options?: McpAgentRunOptions): Promise<McpAgentResult>;
  stream(messages: readonly ChatMessage[], options?: McpAgentRunOptions): AsyncIterable<McpAgentChunk>;
  close(): Promise<void>;
}

interface BoundTool {
  readonly spec: ModelToolSpec;
  invoke(args: JsonObject): Promise<JsonValue>;
}

interface DiscoveredTool {
  readonly server: string;
  readonly descriptor: McpToolDescriptor;
}

interface PartialCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** Create a generic MCP-aware agent without database, SQL, or chat state assumptions. */
export function createMCPAgent(options: McpAgentOptions): McpAgent {
  const maxRounds = options.maxRounds ?? 8;

  const discover = async (): Promise<readonly DiscoveredTool[]> => {
    const found: DiscoveredTool[] = [];
    for (const server of options.mcp.list()) {
      const gateway = await options.mcp.server(server);
      const tools = await gateway.listTools();
      for (const descriptor of tools) found.push({ server, descriptor });
    }
    return found;
  };

  const bindTools = async (): Promise<readonly BoundTool[]> => {
    const discovered = await discover();
    const remote = discovered.map(({ server, descriptor }) => ({
      spec: {
        name: `${server}.${descriptor.name}`,
        description: descriptor.description,
        parameters: descriptor.inputSchema,
      },
      invoke: async (args: JsonObject): Promise<JsonValue> => {
        const gateway = await options.mcp.server(server);
        const result = await gateway.callTool(descriptor.name, args);
        if (result.isError) {
          throw new McpError(`MCP tool "${descriptor.name}" returned an error.`, "MCP_TOOL_ERROR", server);
        }
        return result.structuredContent ?? result.content;
      },
    } satisfies BoundTool));
    const local = (options.tools ?? []).map((tool) => ({
      spec: tool.spec,
      invoke: async (args: JsonObject): Promise<JsonValue> => tool.execute(args),
    } satisfies BoundTool));
    return [...remote, ...local];
  };

  const findTool = (tools: readonly BoundTool[], name: string): BoundTool => {
    const match = tools.find((tool) => tool.spec.name === name);
    if (match === undefined) {
      throw new McpError(`Tool "${name}" is not available to this MCP agent.`, "MCP_PERMISSION_ERROR", name);
    }
    return match;
  };

  const run = async (
    messages: readonly ChatMessage[],
    runOptions: McpAgentRunOptions = {},
  ): Promise<McpAgentResult> => {
    const tools = await bindTools();
    const conversation = [...messages];
    const calls: ModelToolCall[] = [];
    let usage: TokenUsage | undefined;
    const rounds = runOptions.maxRounds ?? maxRounds;

    for (let round = 1; round <= rounds; round += 1) {
      const result = await options.model.chat(conversation, {
        ...runOptions,
        tools: tools.map((tool) => tool.spec),
      });
      usage = result.usage;
      const assistant: ChatMessage = {
        role: "assistant",
        content: result.content,
        ...(result.toolCalls === undefined ? {} : { toolCalls: result.toolCalls }),
      };
      conversation.push(assistant);
      if (result.toolCalls === undefined || result.toolCalls.length === 0) {
        return { message: assistant, rounds: round, toolCalls: calls, usage };
      }

      for (const call of result.toolCalls) {
        calls.push(call);
        const tool = findTool(tools, call.name);
        const value = await tool.invoke(call.arguments);
        conversation.push({
          role: "tool",
          content: formatValue(value),
          name: call.name,
          toolCallId: call.id,
        });
      }
    }

    throw new McpError(`MCP agent exceeded its ${rounds}-round tool limit.`, "MCP_TOOL_ERROR", options.name ?? "mcp-agent");
  };

  const stream = async function* (
    messages: readonly ChatMessage[],
    runOptions: McpAgentRunOptions = {},
  ): AsyncIterable<McpAgentChunk> {
    const tools = await bindTools();
    const conversation = [...messages];
    const rounds = runOptions.maxRounds ?? maxRounds;

    for (let round = 0; round < rounds; round += 1) {
      const detailed = options.model.streamDetailed?.(conversation, {
        ...runOptions,
        tools: tools.map((tool) => tool.spec),
      });
      if (detailed === undefined) {
        const result = await options.model.chat(conversation, {
          ...runOptions,
          tools: tools.map((tool) => tool.spec),
        });
        yield { type: "token", value: result.content };
        if (result.toolCalls === undefined || result.toolCalls.length === 0) return;
        conversation.push({ role: "assistant", content: result.content, toolCalls: result.toolCalls });
        for (const call of result.toolCalls) {
          const tool = findTool(tools, call.name);
          yield { type: "tool_start", name: call.name, arguments: call.arguments };
          const value = await tool.invoke(call.arguments);
          yield { type: "tool_end", name: call.name, result: value };
          conversation.push({ role: "tool", content: formatValue(value), name: call.name, toolCallId: call.id });
        }
        continue;
      }

      let content = "";
      const calls = new Map<number, PartialCall>();
      for await (const chunk of detailed) {
        yield chunk;
        if (chunk.type === "token") content += chunk.value;
        if (chunk.type === "tool_call") {
          const current = calls.get(chunk.value.index);
          const name = chunk.value.name ?? current?.name ?? "";
          const args = `${current?.arguments ?? ""}${chunk.value.arguments}`;
          calls.set(chunk.value.index, {
            id: chunk.value.id ?? current?.id ?? `${chunk.value.index}`,
            name,
            arguments: args,
          });
        }
      }

      const toolCalls: ModelToolCall[] = [...calls.values()].map((call) => ({
        id: call.id,
        name: call.name,
        arguments: parseArguments(call.arguments, call.name),
      }));
      conversation.push({
        role: "assistant",
        content,
        ...(toolCalls.length === 0 ? {} : { toolCalls }),
      });
      if (toolCalls.length === 0) return;
      for (const call of toolCalls) {
        const tool = findTool(tools, call.name);
        yield { type: "tool_start", name: call.name, arguments: call.arguments };
        const value = await tool.invoke(call.arguments);
        yield { type: "tool_end", name: call.name, result: value };
        conversation.push({ role: "tool", content: formatValue(value), name: call.name, toolCallId: call.id });
      }
    }

    throw new McpError(`MCP agent exceeded its ${rounds}-round tool limit.`, "MCP_TOOL_ERROR", options.name ?? "mcp-agent");
  };

  return {
    name: options.name ?? "mcp-agent",
    model: options.model,
    mcp: options.mcp,
    discover: async () => (await discover()).map(({ server, descriptor }) => ({
      name: `${server}.${descriptor.name}`,
      description: descriptor.description,
      parameters: descriptor.inputSchema,
    })),
    run,
    stream,
    close: () => options.mcp.close(),
  };
}

function parseArguments(value: string, name: string): JsonObject {
  if (value.trim() === "") return {};
  try {
    const parsed: JsonValue = JSON.parse(value) as JsonValue;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonObject;
  } catch {
    throw new McpError(`MCP model returned invalid arguments for tool "${name}".`, "MCP_PROTOCOL_ERROR", name);
  }
  throw new McpError(`MCP model arguments for tool "${name}" must be an object.`, "MCP_PROTOCOL_ERROR", name);
}
