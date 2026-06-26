import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isCsmTeamMember } from "@/lib/auth/csm-team";
import { loadCustomers } from "@/lib/data/load-customers";
import {
  loadAssociationLabels,
  resolveLabelTypeIds,
} from "@/lib/data/hubspot-association-labels";
import { setContactCompanyLabels } from "@/lib/integrations/hubspot";
import { appendActionLog } from "@/lib/data/customer-signals";

export const dynamic = "force-dynamic";

/**
 * PUT /api/customers/[workspace_id]/contacts/[contact_id]/labels
 *
 * Body: { labels: string[] } — the full new label set for the
 * contact-company association. HubSpot's v4 association PUT
 * replaces the existing set, so this endpoint expects a complete
 * list (not a diff).
 *
 * Auth: CSM team only.
 *
 * Side effects beyond the HubSpot write:
 *   • Logs an action_log entry against the customer's Notes feed
 *     so there's a paper trail of who changed what.
 *
 * NOT side-effect: the in-memory customer snapshot. Updating the
 * snapshot from a request handler would mean the next page-load
 * still sees stale labels until the daily sync runs — which is
 * confusing. The client refreshes its own row after the request
 * lands (response includes the canonical new labels).
 */

interface PutBody {
  labels?: string[];
  /** Default true. Pass false to remove the contact's primary-company
   *  association with this company in HubSpot. Contact will no longer
   *  surface on this customer in the dashboard after the next sync /
   *  resync. */
  primary?: boolean;
}

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ workspace_id: string; contact_id: string }> }
) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!(await isCsmTeamMember(email))) {
    return NextResponse.json(
      { error: "CSM team only" },
      { status: 403 }
    );
  }
  const { workspace_id: workspaceId, contact_id: contactId } = await ctx.params;
  if (!workspaceId || !contactId) {
    return NextResponse.json(
      { error: "workspace_id and contact_id are required" },
      { status: 400 }
    );
  }
  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const labels = Array.isArray(body.labels)
    ? body.labels.filter((s): s is string => typeof s === "string")
    : null;
  if (!labels) {
    return NextResponse.json(
      { error: "Body must include `labels: string[]`" },
      { status: 400 }
    );
  }
  // Default true — when omitted, callers want existing semantics
  // (always keep the contact as Primary on this company).
  const primary = body.primary !== false;

  // Resolve customer + contact to get the HubSpot company id (we
  // need the company side of the association to PUT).
  const customers = await loadCustomers();
  const customer = customers.find((c) => c.workspace_id === workspaceId);
  if (!customer) {
    return NextResponse.json(
      { error: "Customer not found" },
      { status: 404 }
    );
  }
  if (!customer.hubspot_company_id) {
    return NextResponse.json(
      {
        error:
          "This customer has no linked HubSpot company — labels can only be edited on customers with a HubSpot link.",
      },
      { status: 400 }
    );
  }
  const contact = (customer.hubspot_contacts ?? []).find(
    (c) => c.id === contactId
  );
  if (!contact) {
    return NextResponse.json(
      { error: "Contact not found on this customer" },
      { status: 404 }
    );
  }

  // Map human-readable labels → numeric typeIds via the cached
  // schema. Unknown labels are a 400 with the recognized set
  // surfaced so the UI can show what HubSpot actually accepts.
  const { resolved, unknown } = await resolveLabelTypeIds(labels);
  if (unknown.length > 0) {
    const all = await loadAssociationLabels();
    const known = all
      .filter((l) => l.category === "USER_DEFINED")
      .map((l) => l.label);
    return NextResponse.json(
      {
        error: `HubSpot doesn't recognize ${unknown
          .map((l) => `"${l}"`)
          .join(", ")} — admin needs to create it in HubSpot first.`,
        unknown,
        known,
      },
      { status: 400 }
    );
  }

  try {
    await setContactCompanyLabels(
      customer.hubspot_company_id,
      contactId,
      resolved,
      { includePrimary: primary }
    );
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "HubSpot write failed",
      },
      { status: 502 }
    );
  }

  // Audit log — non-fatal if it fails.
  const contactName = contact.name ?? contact.email ?? `contact ${contactId}`;
  const labelSummary = labels.length === 0 ? "(none)" : labels.join(", ");
  const primarySuffix = primary
    ? ""
    : " — removed Primary Company association (contact will drop off this customer on next sync)";
  await appendActionLog([
    {
      workspace_id: workspaceId,
      text: `Updated ${contactName}'s HubSpot labels → ${labelSummary}${primarySuffix}`,
      created_by: email,
      action_kind: "hubspot_labels_update",
      metadata: { contact_id: contactId, labels, primary },
    },
  ]);

  return NextResponse.json({
    ok: true,
    contact_id: contactId,
    labels,
    primary,
  });
}
