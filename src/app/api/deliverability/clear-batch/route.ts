import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { clearPostsBatch } from "@/lib/data/deliverability-clears";
import { appendActionLog } from "@/lib/data/customer-signals";

export const dynamic = "force-dynamic";

/**
 * POST /api/deliverability/clear-batch
 *   Body: {
 *     post_ids: string[],                          // required, deduped server-side
 *     workspace_id?: string,                       // when present → single action_log entry
 *     workspace_name?: string,                     // for the audit-line summary
 *     alerts?: Array<{                             // enrichment for the audit line
 *       post_id: string,
 *       subject?: string | null,
 *       newsletter?: string | null,
 *       flag_summary?: string | null,
 *     }>,
 *   }
 *
 * Companion to /api/deliverability/clear for the "Clear all for a
 * whole workspace" flow on the panel. Instead of firing N single-
 * post POSTs (which race each other on the read-modify-write KV
 * blob and silently lose most of the writes), this does ONE
 * read-modify-write for the clears blob and ONE action_log append.
 *
 * Auth: signed-in session only. `cleared_by` gets stamped so the
 * "Show cleared" pill can attribute the batch.
 */

interface AlertEnrichment {
  post_id?: string;
  subject?: string | null;
  newsletter?: string | null;
  flag_summary?: string | null;
}

interface Body {
  post_ids?: string[];
  workspace_id?: string;
  workspace_name?: string | null;
  alerts?: AlertEnrichment[];
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const postIds = Array.isArray(body.post_ids)
    ? body.post_ids
        .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        .map((id) => id.trim())
    : [];
  if (postIds.length === 0) {
    return NextResponse.json(
      { error: "post_ids is required (non-empty array)." },
      { status: 400 }
    );
  }
  const workspaceId = (body.workspace_id ?? "").trim();
  const workspaceName = body.workspace_name?.trim() || null;

  // One read-modify-write for the whole batch — the former
  // per-post loop was racy and silently dropped most entries when
  // called in parallel from the client.
  await clearPostsBatch(postIds, {
    clearedBy: session.user.email,
    reason: workspaceName
      ? `Cleared with workspace "${workspaceName}"`
      : "Cleared (bulk)",
  });

  // Action log — best effort, and only when we have a workspace to
  // hang it on. One entry per workspace summarizing the batch,
  // rather than N per-post entries: the per-post detail is still
  // available in the deliverability-clears KV keyed by post_id,
  // and a single line ("Cleared 8 alerts") reads more usefully on
  // the profile Notes surface than 8 near-identical lines.
  let logOk = true;
  let logError: string | null = null;
  if (workspaceId) {
    const enrichmentById = new Map<string, AlertEnrichment>();
    for (const a of body.alerts ?? []) {
      if (a.post_id) enrichmentById.set(a.post_id, a);
    }
    const flagSummaries = postIds
      .map((id) => enrichmentById.get(id)?.flag_summary)
      .filter((s): s is string => Boolean(s));
    const uniqueFlags = [...new Set(flagSummaries)];
    const noteText =
      `Deliverability alerts cleared (bulk, ${postIds.length}` +
      `${postIds.length === 1 ? " send" : " sends"})` +
      (uniqueFlags.length > 0 ? `: ${uniqueFlags.slice(0, 3).join("; ")}${uniqueFlags.length > 3 ? "; …" : ""}` : "");
    try {
      await appendActionLog([
        {
          workspace_id: workspaceId,
          text: noteText,
          created_by: session.user.email.toLowerCase(),
          action_kind: "deliverability_cleared_bulk",
          metadata: {
            post_ids: postIds,
            count: postIds.length,
            flag_summaries: uniqueFlags,
          },
        },
      ]);
    } catch (e) {
      logOk = false;
      logError = e instanceof Error ? e.message : "Unknown error";
      console.warn("[deliverability/clear-batch] action log append failed", e);
    }
  }

  return NextResponse.json({
    ok: true,
    cleared: postIds.length,
    log_ok: logOk,
    log_error: logError,
  });
}
