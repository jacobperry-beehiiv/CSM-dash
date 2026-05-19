import { TOOLS, TOOLS_BY_NAME, type ToolContext } from "./tools";

/**
 * Minimal MCP-over-HTTP JSON-RPC handler. Implements the subset of
 * the protocol that Claude Code + Claude Desktop need to drive a
 * tool-only server:
 *
 *   - initialize    → server info + capabilities
 *   - tools/list    → enumerate the available tools
 *   - tools/call    → invoke one with arguments
 *   - notifications/initialized + ping → no-ops we acknowledge
 *
 * Resources / prompts / sampling / completions aren't implemented —
 * tools is the only capability we advertise. If we ever want richer
 * surfaces we can swap to @modelcontextprotocol/sdk; for now the
 * hand-rolled handler keeps dependencies lean.
 *
 * Each request is independent (stateless). Auth + the calling user's
 * email is decided BEFORE we get here (in the route handler) and
 * passed in via `ctx`.
 */

const SERVER_INFO = {
  name: "csm-dash",
  title: "beehiiv CSM dashboard",
  version: "1.0.0",
};

/** MCP protocol version we advertise. Clients negotiate; we accept
 *  the client's version if it's a string we recognise, else fall back
 *  to our own. */
const SUPPORTED_PROTOCOL_VERSION = "2025-06-18";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC well-known error codes. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

function makeError(
  id: JsonRpcResponse["id"],
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}

/**
 * Handle one parsed JSON-RPC request. Returns either a response object
 * (for requests with an id) or `null` for notifications.
 */
export async function handleJsonRpc(
  req: JsonRpcRequest,
  ctx: ToolContext
): Promise<JsonRpcResponse | null> {
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return makeError(
      req.id ?? null,
      INVALID_REQUEST,
      "Invalid JSON-RPC 2.0 request"
    );
  }
  const isNotification = req.id == null;

  try {
    switch (req.method) {
      case "initialize": {
        const clientVersion =
          (req.params?.protocolVersion as string | undefined) ?? null;
        return {
          jsonrpc: "2.0",
          id: req.id ?? null,
          result: {
            protocolVersion: clientVersion ?? SUPPORTED_PROTOCOL_VERSION,
            capabilities: {
              // We expose tools only. `listChanged: false` because the
              // tool list is static across the process lifetime.
              tools: { listChanged: false },
            },
            serverInfo: SERVER_INFO,
            instructions:
              "beehiiv CSM dashboard MCP. Read or write customer signals, " +
              "lookup at-risk accounts, post to the team-tasks tracker, " +
              "and a few other operations against the same Postgres-backed " +
              "store the dashboard at csm-dash.vercel.app uses. Every call " +
              "is attributed to the email that owns the API token.",
          },
        };
      }

      case "notifications/initialized":
      case "notifications/cancelled":
      case "notifications/progress":
        // Notifications never get a response.
        return null;

      case "ping": {
        // MCP spec: respond with an empty result object.
        if (isNotification) return null;
        return { jsonrpc: "2.0", id: req.id ?? null, result: {} };
      }

      case "tools/list": {
        return {
          jsonrpc: "2.0",
          id: req.id ?? null,
          result: {
            tools: TOOLS.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        };
      }

      case "tools/call": {
        const params = req.params ?? {};
        const name = params.name;
        const args = (params.arguments as Record<string, unknown>) ?? {};
        if (typeof name !== "string") {
          return makeError(
            req.id ?? null,
            INVALID_PARAMS,
            "`name` is required"
          );
        }
        const tool = TOOLS_BY_NAME.get(name);
        if (!tool) {
          return makeError(
            req.id ?? null,
            METHOD_NOT_FOUND,
            `Unknown tool: ${name}`
          );
        }
        try {
          const result = await tool.handler(args, ctx);
          return { jsonrpc: "2.0", id: req.id ?? null, result };
        } catch (e) {
          // Tool threw — surface as an MCP tool error (NOT a JSON-RPC
          // error), so Claude shows the message back to the user.
          const message =
            e instanceof Error ? e.message : "Unknown tool error";
          return {
            jsonrpc: "2.0",
            id: req.id ?? null,
            result: {
              content: [{ type: "text", text: message }],
              isError: true,
            },
          };
        }
      }

      default: {
        if (isNotification) return null;
        return makeError(
          req.id ?? null,
          METHOD_NOT_FOUND,
          `Method not found: ${req.method}`
        );
      }
    }
  } catch (e) {
    if (isNotification) return null;
    return makeError(
      req.id ?? null,
      INTERNAL_ERROR,
      e instanceof Error ? e.message : "Unknown internal error"
    );
  }
}

/** Re-exports for callers that want to construct error responses
 *  without importing the JSON-RPC constants by hand. */
export const JSON_RPC_ERRORS = {
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
} as const;
