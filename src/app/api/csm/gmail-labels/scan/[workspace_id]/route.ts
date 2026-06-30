import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { loadCustomers } from "@/lib/data/load-customers";
import {
  loadCustomerLabels,
  saveCustomerLabels,
  setCustomerLabel,
} from "@/lib/data/gmail-customer-labels";
import {
  buildInferenceContext,
  inferCustomerLabel,
  listGmailLabels,
} from "@/lib/integrations/gmail-labels";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/csm/gmail-labels/scan/[workspace_id]
 *
 * Re-runs Gmail-label inference for a single customer. Cheaper than
 * the full-book scan when a CSM corrects one bad inference and wants
 * to try again — say, after fixing the underlying thread labels in
 * Gmail itself.
 *
 * Respects pinned rows: a manual / cleared override returns 409 with
 * the existing row so the UI can warn rather than silently lose the
 * override. (Bulk scan skips them; the per-customer endpoint surfaces
 * the conflict.)
 *
 * Auth: signed-in CSM with `gmail-draft-labels` flag enabled.
 */

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ workspace_id: string }> }
) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!(await isFeatureEnabledFor("gmail-draft-labels", email))) {
    return NextResponse.json(
      { error: "Feature not available for this account" },
      { status: 403 }
    );
  }

  const { workspace_id: workspaceId } = await ctx.params;
  if (!workspaceId) {
    return NextResponse.json(
      { error: "workspace_id is required" },
      { status: 400 }
    );
  }
  const customers = await loadCustomers();
  const customer = customers.find((c) => c.workspace_id === workspaceId);
  if (!customer) {
    return NextResponse.json(
      { error: `Customer ${workspaceId} not found in book` },
      { status: 404 }
    );
  }

  const blob = await loadCustomerLabels();
  const existing = blob.per_csm[email.toLowerCase()]?.rows?.[workspaceId];
  if (existing && (existing.source === "manual" || existing.source === "cleared")) {
    return NextResponse.json(
      {
        error:
          "This row is pinned (manual override or cleared). Reset it from the dropdown before re-scanning.",
        existing,
      },
      { status: 409 }
    );
  }

  let labelsById;
  try {
    const labels = await listGmailLabels(email);
    labelsById = new Map(labels.map((l) => [l.id, l]));
  } catch (e) {
    return NextResponse.json(
      {
        error: `Couldn't list Gmail labels: ${
          e instanceof Error ? e.message : "unknown"
        }`,
        needs_reconsent: true,
      },
      { status: 502 }
    );
  }

  const inferenceCtx = await buildInferenceContext(email);
  const result = await inferCustomerLabel(
    email,
    customer,
    inferenceCtx,
    labelsById
  );
  if (!result.inferred) {
    return NextResponse.json({
      ok: true,
      inferred: null,
      reason: result.reason ?? "no label met thresholds",
    });
  }

  setCustomerLabel(blob, email, workspaceId, {
    label_id: result.inferred.label_id,
    label_name: result.inferred.label_name,
    source: "inferred",
    inferred_at: new Date().toISOString(),
  });
  await saveCustomerLabels(blob);

  return NextResponse.json({
    ok: true,
    inferred: result.inferred,
  });
}
