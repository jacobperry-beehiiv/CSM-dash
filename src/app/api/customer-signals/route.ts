import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  appendSignal,
  deleteSignal,
  listSignals,
  type SignalKind,
  type AppendInput,
} from "@/lib/data/customer-signals";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Customer-signal CRUD endpoint. Two auth paths:
 *
 *   • Interactive: the request carries a valid NextAuth session cookie
 *     (logged-in CSM). `created_by` defaults to their email.
 *   • Programmatic: the request carries `Authorization: Bearer <key>`
 *     matching SIGNAL_API_KEY in the env. Intended for the Claude
 *     skill (see ~/.claude/skills/csm-dash-signal/). `created_by` must
 *     be supplied by the caller in this mode.
 *
 * Both paths read/write the same KV-backed array per workspace.
 */

const VALID_KINDS: SignalKind[] = [
  "note",
  "risk_signal",
  "win",
  "context",
  "action_item",
  "meeting",
];

async function authorize(req: Request): Promise<
  | { ok: true; mode: "session"; email: string | null }
  | { ok: true; mode: "skill" }
  | { ok: false; status: number; message: string }
> {
  // Skill path: Bearer token in Authorization header
  const auth_header = req.headers.get("authorization");
  if (auth_header?.startsWith("Bearer ")) {
    const expected = process.env.SIGNAL_API_KEY;
    if (!expected) {
      return {
        ok: false,
        status: 503,
        message:
          "SIGNAL_API_KEY env var is not configured on the server — bearer auth disabled.",
      };
    }
    if (auth_header.slice(7).trim() !== expected) {
      return { ok: false, status: 401, message: "invalid bearer token" };
    }
    return { ok: true, mode: "skill" };
  }

  // Interactive path: NextAuth session
  const session = await auth();
  if (!session?.user?.email) {
    return {
      ok: false,
      status: 401,
      message:
        "Not signed in. Sign in via /login, or pass Authorization: Bearer <SIGNAL_API_KEY>.",
    };
  }
  return { ok: true, mode: "session", email: session.user.email };
}

export async function GET(req: Request) {
  const a = await authorize(req);
  if (!a.ok) return NextResponse.json({ error: a.message }, { status: a.status });

  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspace_id");
  if (!workspaceId) {
    return NextResponse.json(
      { error: "workspace_id query param is required" },
      { status: 400 }
    );
  }
  try {
    const signals = await listSignals(workspaceId);
    return NextResponse.json({ workspace_id: workspaceId, signals });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const a = await authorize(req);
  if (!a.ok) return NextResponse.json({ error: a.message }, { status: a.status });

  let body: Partial<AppendInput>;
  try {
    body = (await req.json()) as Partial<AppendInput>;
  } catch {
    return NextResponse.json(
      { error: "Body must be valid JSON" },
      { status: 400 }
    );
  }

  if (!body.workspace_id || typeof body.workspace_id !== "string") {
    return NextResponse.json(
      { error: "workspace_id is required" },
      { status: 400 }
    );
  }
  if (!body.kind || !VALID_KINDS.includes(body.kind)) {
    return NextResponse.json(
      {
        error: `kind must be one of: ${VALID_KINDS.join(", ")}`,
      },
      { status: 400 }
    );
  }
  if (!body.text || typeof body.text !== "string" || body.text.trim() === "") {
    return NextResponse.json(
      { error: "text is required and must be non-empty" },
      { status: 400 }
    );
  }
  if (body.text.length > 5000) {
    return NextResponse.json(
      { error: "text exceeds 5000 characters" },
      { status: 400 }
    );
  }

  // Stamp created_by from the session when no explicit value supplied
  const createdBy =
    body.created_by ?? (a.mode === "session" ? a.email : "skill");

  try {
    const signal = await appendSignal({
      workspace_id: body.workspace_id,
      kind: body.kind,
      text: body.text.trim(),
      source: body.source ?? (a.mode === "skill" ? "claude-skill" : "dashboard"),
      created_by: createdBy ?? undefined,
      created_at: body.created_at,
      expires_at: body.expires_at,
      metadata: body.metadata,
    });
    return NextResponse.json(signal, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  const a = await authorize(req);
  if (!a.ok) return NextResponse.json({ error: a.message }, { status: a.status });

  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspace_id");
  const id = url.searchParams.get("id");
  if (!workspaceId || !id) {
    return NextResponse.json(
      { error: "workspace_id and id query params are required" },
      { status: 400 }
    );
  }
  try {
    const deleted = await deleteSignal(workspaceId, id);
    if (!deleted) {
      return NextResponse.json(
        { error: "signal not found" },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
