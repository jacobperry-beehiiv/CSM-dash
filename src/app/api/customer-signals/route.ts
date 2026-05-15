import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  appendSignal,
  deleteSignal,
  listSignals,
  upsertSignalsForWorkspace,
  VALID_SIGNAL_KINDS,
  type AppendInput,
  type SignalKind,
} from "@/lib/data/customer-signals";
import { setRunState } from "@/lib/data/customer-signals-state";
import { findTokenOwner } from "@/lib/auth/api-tokens";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Customer-signal CRUD endpoint. Two auth paths:
 *
 *   • Interactive: the request carries a valid NextAuth session cookie
 *     (logged-in CSM). `created_by` defaults to their email.
 *   • Programmatic: the request carries `Authorization: Bearer <key>`
 *     matching SIGNAL_API_KEY (or CUSTOMER_SIGNALS_API_TOKEN) in env.
 *     Intended for the Claude skill (see ~/.claude/skills/csm-dash-signal/).
 *
 * Two POST shapes are supported:
 *
 *   • Batch (preferred, skill v1.0):
 *       { run_metadata, signals: [...] }
 *       → 207 Multi-Status with per-signal accept/reject + the
 *       persisted run state echoed back.
 *
 *   • Single signal (legacy):
 *       { workspace_id, kind, text, ... }
 *       → 201 with the created CustomerSignal.
 *       Kept so the v1 skill scaffold + ad-hoc curl scripts don't break.
 */

const VALID_KINDS_SET = new Set<SignalKind>(VALID_SIGNAL_KINDS);

async function authorize(req: Request): Promise<
  | { ok: true; mode: "session"; email: string | null }
  | { ok: true; mode: "user_token"; email: string }
  | { ok: true; mode: "skill" }
  | { ok: false; status: number; message: string }
> {
  const auth_header = req.headers.get("authorization");
  if (auth_header?.startsWith("Bearer ")) {
    const candidate = auth_header.slice(7).trim();

    // Path A: per-user token minted at /settings/api-tokens. Preferred
    // path going forward — every request gets attributed to the
    // owning CSM automatically. Looked up by SHA-256 of the bearer so
    // plaintext never lives server-side.
    const owner = await findTokenOwner(candidate);
    if (owner) {
      return { ok: true, mode: "user_token", email: owner.user_email };
    }

    // Path B: legacy shared key in env. Kept so existing Vercel
    // deployments + Claude-skill scaffolds keep working until they
    // migrate to per-user tokens. `created_by` defaults to "skill".
    const sharedKey =
      process.env.SIGNAL_API_KEY ?? process.env.CUSTOMER_SIGNALS_API_TOKEN;
    if (sharedKey && candidate === sharedKey) {
      return { ok: true, mode: "skill" };
    }

    // Nothing matched. If the only configured auth is per-user
    // tokens (no shared key), say that — otherwise the generic
    // 401 reads as "your token is wrong" even when the server
    // simply doesn't have any way to validate anything.
    if (!sharedKey) {
      return {
        ok: false,
        status: 401,
        message:
          "Unknown Bearer token. Mint one at /settings/api-tokens or set SIGNAL_API_KEY for the legacy shared-key flow.",
      };
    }
    return { ok: false, status: 401, message: "invalid bearer token" };
  }

  const session = await auth();
  if (!session?.user?.email) {
    return {
      ok: false,
      status: 401,
      message:
        "Not signed in. Sign in via /login, or pass Authorization: Bearer <token> (mint one at /settings/api-tokens).",
    };
  }
  return { ok: true, mode: "session", email: session.user.email };
}

interface RunMetadata {
  run_id: string;
  csm_email: string;
  csm_name?: string;
  skill_version?: string;
  lookback_start?: string;
  lookback_end?: string;
  active_customers?: number;
  total_book_size?: number;
  started_at?: string;
  completed_at: string;
}

interface BatchSignalInput extends Omit<AppendInput, "kind"> {
  signal_id: string;
  kind: string;
}

interface BatchBody {
  run_metadata: RunMetadata;
  signals: BatchSignalInput[];
}

interface BatchResult {
  signal_id: string;
  status: "accepted" | "rejected";
  action?: "created" | "updated";
  error?: string;
}

function isBatchShape(body: unknown): body is BatchBody {
  return (
    !!body &&
    typeof body === "object" &&
    Array.isArray((body as BatchBody).signals)
  );
}

function validateRunMetadata(meta: unknown): RunMetadata | string {
  if (!meta || typeof meta !== "object") return "run_metadata is required";
  const m = meta as Partial<RunMetadata>;
  if (typeof m.run_id !== "string" || !m.run_id) {
    return "run_metadata.run_id is required";
  }
  if (typeof m.csm_email !== "string" || !m.csm_email) {
    return "run_metadata.csm_email is required";
  }
  if (typeof m.completed_at !== "string" || !m.completed_at) {
    return "run_metadata.completed_at is required";
  }
  return m as RunMetadata;
}

/**
 * Per-signal sanity check. Returns null when the signal is valid, or a
 * human-readable error otherwise. Doesn't mutate the input — the caller
 * passes valid inputs straight into upsertSignalsForWorkspace.
 */
function validateSignal(s: unknown): string | null {
  if (!s || typeof s !== "object") return "signal must be an object";
  const sig = s as Partial<BatchSignalInput>;
  if (typeof sig.signal_id !== "string" || !sig.signal_id) {
    return "signal_id is required";
  }
  if (typeof sig.workspace_id !== "string" || !sig.workspace_id) {
    return "workspace_id is required";
  }
  if (typeof sig.kind !== "string" || !VALID_KINDS_SET.has(sig.kind as SignalKind)) {
    return `kind must be one of: ${VALID_SIGNAL_KINDS.join(", ")}`;
  }
  if (typeof sig.text !== "string" || !sig.text.trim()) {
    return "text is required";
  }
  if (sig.text.length > 5000) return "text exceeds 5000 characters";
  if (typeof sig.event_at !== "string" || !sig.event_at) {
    return "event_at is required";
  }
  return null;
}

async function handleBatch(
  body: BatchBody,
  defaults: { source: string; created_by: string | null }
) {
  const metaCheck = validateRunMetadata(body.run_metadata);
  if (typeof metaCheck === "string") {
    return NextResponse.json({ error: metaCheck }, { status: 400 });
  }
  const meta = metaCheck;

  // Validate every signal up front so the response can include reject
  // entries even if zero signals end up persisted.
  const results: BatchResult[] = [];
  const valid: BatchSignalInput[] = [];
  for (const s of body.signals) {
    const err = validateSignal(s);
    if (err) {
      results.push({
        signal_id:
          typeof (s as { signal_id?: string }).signal_id === "string"
            ? (s as { signal_id: string }).signal_id
            : "<missing>",
        status: "rejected",
        error: err,
      });
      continue;
    }
    valid.push(s);
  }

  // Group by workspace so we do one KV read-modify-write per customer
  // rather than one per signal. Order within a group is preserved so
  // last-write-wins behaves intuitively for duplicate signal_ids in
  // the same batch.
  const byWorkspace = new Map<string, BatchSignalInput[]>();
  for (const sig of valid) {
    const arr = byWorkspace.get(sig.workspace_id) ?? [];
    arr.push(sig);
    byWorkspace.set(sig.workspace_id, arr);
  }

  for (const [workspaceId, group] of byWorkspace) {
    const inputs: AppendInput[] = group.map((s) => ({
      signal_id: s.signal_id,
      workspace_id: workspaceId,
      kind: s.kind as SignalKind,
      text: s.text!.trim(),
      source: s.source ?? defaults.source,
      created_by: s.created_by ?? defaults.created_by ?? "skill",
      created_at: s.created_at,
      event_at: s.event_at,
      expires_at: s.expires_at,
      metadata: s.metadata,
    }));
    try {
      const groupResults = await upsertSignalsForWorkspace(workspaceId, inputs);
      groupResults.forEach((r, i) => {
        results.push({
          signal_id: group[i].signal_id,
          status: "accepted",
          action: r.action,
        });
      });
    } catch (e) {
      // Hard failure on a whole workspace write — mark every signal in
      // that group as rejected. Continue with other workspaces.
      const message = e instanceof Error ? e.message : "kv write failed";
      for (const sig of group) {
        results.push({
          signal_id: sig.signal_id,
          status: "rejected",
          error: message,
        });
      }
    }
  }

  const accepted = results.filter((r) => r.status === "accepted").length;
  const rejected = results.length - accepted;

  // Persist run state only if at least one signal landed. A 0-accepted
  // run is treated like a no-op so the next run still picks up the
  // original lookback start.
  let lastSuccessfulRun: string | null = null;
  if (accepted > 0) {
    try {
      await setRunState({
        csm_email: meta.csm_email,
        last_successful_run: meta.completed_at,
        last_run_id: meta.run_id,
      });
      lastSuccessfulRun = meta.completed_at;
    } catch (e) {
      console.error(
        "[customer-signals] run state persist failed:",
        e instanceof Error ? e.message : e
      );
    }
  }

  return NextResponse.json(
    {
      run_id: meta.run_id,
      accepted,
      rejected,
      results,
      state: lastSuccessfulRun
        ? {
            csm_email: meta.csm_email,
            last_successful_run: lastSuccessfulRun,
          }
        : null,
    },
    { status: 207 }
  );
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Body must be valid JSON" },
      { status: 400 }
    );
  }

  // Defaults applied when the request body doesn't supply `source` /
  // `created_by`. Per-user tokens credit the owning email so signals
  // posted from "Jacob's Claude skill" show up as Jacob's edits on the
  // profile page automatically.
  const defaults = {
    source:
      a.mode === "skill" || a.mode === "user_token" ? "claude-skill" : "dashboard",
    created_by:
      a.mode === "session" || a.mode === "user_token" ? a.email : null,
  };

  // Batch shape: { run_metadata, signals[] }
  if (isBatchShape(body)) {
    return handleBatch(body, defaults);
  }

  // Legacy single-signal shape — kept for the v1 skill + curl scripts.
  // Same validation as before this rewrite.
  const single = body as Partial<AppendInput> & { kind?: string };
  if (!single.workspace_id || typeof single.workspace_id !== "string") {
    return NextResponse.json(
      { error: "workspace_id is required" },
      { status: 400 }
    );
  }
  if (!single.kind || !VALID_KINDS_SET.has(single.kind as SignalKind)) {
    return NextResponse.json(
      { error: `kind must be one of: ${VALID_SIGNAL_KINDS.join(", ")}` },
      { status: 400 }
    );
  }
  if (
    !single.text ||
    typeof single.text !== "string" ||
    single.text.trim() === ""
  ) {
    return NextResponse.json(
      { error: "text is required and must be non-empty" },
      { status: 400 }
    );
  }
  if (single.text.length > 5000) {
    return NextResponse.json(
      { error: "text exceeds 5000 characters" },
      { status: 400 }
    );
  }

  try {
    const signal = await appendSignal({
      signal_id: single.signal_id,
      workspace_id: single.workspace_id,
      kind: single.kind as SignalKind,
      text: single.text.trim(),
      source: single.source ?? defaults.source,
      created_by:
        single.created_by ?? defaults.created_by ?? "skill",
      created_at: single.created_at,
      event_at: single.event_at,
      expires_at: single.expires_at,
      metadata: single.metadata,
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
