import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import {
  buildLabelLookup,
  getCsmLabelBook,
  loadCustomerLabels,
  saveCustomerLabels,
  setCustomerLabel,
  type CustomerLabelRow,
  type LabelMappingSource,
} from "@/lib/data/gmail-customer-labels";
import { listGmailLabels, type GmailLabel } from "@/lib/integrations/gmail-labels";

export const dynamic = "force-dynamic";

/**
 * GET  /api/csm/gmail-labels
 *   → { mapping: { workspace_id → row }, last_full_scan, labels: GmailLabel[] }
 *
 * PUT  /api/csm/gmail-labels
 *   body: { workspace_id, label_id?, label_name?, action: "set" | "clear" }
 *   → { ok, row }
 *
 * Auth: signed-in user only. Each user reads / writes their own CSM
 * mapping — there's no admin-overrides-someone-else path because the
 * labels live on each CSM's own Gmail.
 *
 * Feature-flag gated: returns 403 when the viewer doesn't have
 * `gmail-draft-labels` enabled. Drafts continue to work normally for
 * gated-out users (they just hit /api/drafts/bulk-create directly).
 */

interface PutBody {
  workspace_id?: string;
  label_id?: string | null;
  label_name?: string | null;
  action?: "set" | "clear";
}

export async function GET() {
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

  const blob = await loadCustomerLabels();
  const book = getCsmLabelBook(blob, email);
  // Gmail label list is what the dropdown picker renders against.
  // Soft-fail when the CSM hasn't re-consented for gmail.modify —
  // the picker UI degrades to "Re-consent required" without
  // breaking the page render.
  let labels: GmailLabel[] = [];
  let labels_error: string | null = null;
  try {
    labels = await listGmailLabels(email);
  } catch (e) {
    labels_error = e instanceof Error ? e.message : "unknown";
  }
  return NextResponse.json({
    mapping: book.rows,
    last_full_scan: book.last_full_scan ?? null,
    labels: labels.filter((l) => l.type === "user"),
    labels_error,
  });
}

export async function PUT(req: Request) {
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

  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const workspaceId = body.workspace_id?.trim();
  if (!workspaceId) {
    return NextResponse.json(
      { error: "workspace_id is required" },
      { status: 400 }
    );
  }
  const action: "set" | "clear" = body.action === "clear" ? "clear" : "set";

  let row: CustomerLabelRow;
  if (action === "clear") {
    row = {
      label_id: null,
      label_name: null,
      source: "cleared",
      updated_at: new Date().toISOString(),
    };
  } else {
    const labelId = body.label_id?.trim();
    if (!labelId) {
      return NextResponse.json(
        { error: "label_id is required for action=set" },
        { status: 400 }
      );
    }
    row = {
      label_id: labelId,
      label_name: body.label_name?.trim() || null,
      source: "manual" satisfies LabelMappingSource,
      updated_at: new Date().toISOString(),
    };
  }

  const blob = await loadCustomerLabels();
  setCustomerLabel(blob, email, workspaceId, row);
  await saveCustomerLabels(blob);

  // Return the updated lookup so the client can mirror it.
  const lookup = buildLabelLookup(blob, email);
  return NextResponse.json({
    ok: true,
    row,
    mapping_size: lookup.size,
  });
}
