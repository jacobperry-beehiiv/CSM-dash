import { NextResponse } from "next/server";
import { findTokenOwner } from "@/lib/auth/api-tokens";
import {
  handleJsonRpc,
  JSON_RPC_ERRORS,
  type JsonRpcRequest,
} from "@/lib/mcp/handler";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * HTTP transport for the dashboard's MCP server. Claude Code / Claude
 * Desktop POST JSON-RPC requests here; we authenticate via Bearer
 * token (per-user, minted at /settings/api-tokens), dispatch the
 * request, and return the JSON-RPC response.
 *
 * Stateless transport — every request is independent. No SSE, no
 * session id headers, which keeps the implementation cooperating
 * with Vercel's serverless model. Claude's stateless-HTTP client
 * mode is happy with this.
 *
 * Auth-only-on-write would be nice in theory but the protocol's
 * tools/list reveals our API surface, so we require auth on every
 * call — including initialize and ping. Reject early.
 */

interface RpcResponseShape {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): RpcResponseShape {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

export async function POST(req: Request) {
  // ── Auth ──────────────────────────────────────────────────────
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json(
      errorResponse(
        null,
        JSON_RPC_ERRORS.INVALID_REQUEST,
        "Missing Bearer token. Mint one at /settings/api-tokens and add it as `Authorization: Bearer …`."
      ),
      { status: 401 }
    );
  }
  const owner = await findTokenOwner(authHeader.slice(7).trim());
  if (!owner) {
    return NextResponse.json(
      errorResponse(
        null,
        JSON_RPC_ERRORS.INVALID_REQUEST,
        "Unknown or revoked token. Re-mint at /settings/api-tokens."
      ),
      { status: 401 }
    );
  }
  const ctx = { user_email: owner.user_email };

  // ── Parse ─────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      errorResponse(null, JSON_RPC_ERRORS.PARSE_ERROR, "Body must be valid JSON"),
      { status: 400 }
    );
  }

  // ── Dispatch (single or batch) ────────────────────────────────
  // JSON-RPC 2.0 batch: an array of requests, return an array of
  // responses (notifications omitted). Single request: one object,
  // one response.
  if (Array.isArray(body)) {
    const responses: RpcResponseShape[] = [];
    for (const item of body) {
      const r = await handleJsonRpc(item as JsonRpcRequest, ctx);
      if (r) responses.push(r);
    }
    // An all-notification batch returns 204.
    if (responses.length === 0) {
      return new NextResponse(null, { status: 204 });
    }
    return NextResponse.json(responses);
  }

  const response = await handleJsonRpc(body as JsonRpcRequest, ctx);
  if (!response) {
    // Notification — no body, 204.
    return new NextResponse(null, { status: 204 });
  }
  return NextResponse.json(response);
}

/**
 * GET on /api/mcp returns a small JSON pointer so anyone hitting the
 * URL in a browser sees a useful "here's what this is" rather than a
 * 405. Not part of the MCP protocol — just a developer affordance.
 */
export async function GET() {
  return NextResponse.json({
    name: "beehiiv CSM dashboard MCP",
    transport: "http-jsonrpc",
    docs: "/settings/mcp",
    auth: "Bearer token from /settings/api-tokens",
    methods: ["POST"],
  });
}
