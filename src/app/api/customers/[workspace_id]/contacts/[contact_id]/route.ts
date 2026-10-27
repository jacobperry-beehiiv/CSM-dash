import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isCsmTeamMember } from "@/lib/auth/csm-team";
import { loadCustomers } from "@/lib/data/load-customers";
import {
  fetchHubspotOverlayBatch,
  patchHubspotContactProperties,
  splitContactName,
} from "@/lib/integrations/hubspot";
import {
  loadHubspotOverlay,
  saveHubspotOverlay,
  type HubSpotOverlayRow,
} from "@/lib/data/hubspot-overlay";
import { appendActionLog } from "@/lib/data/customer-signals";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/customers/[workspace_id]/contacts/[contact_id]
 *
 * Body: `{ name: string }` — the contact's display name.
 *
 * HubSpot stores `firstname` and `lastname`; the dashboard shows one
 * field because that's what a CSM thinks they're editing. The split
 * rule lives in `splitContactName` so this route and anything else
 * that needs it agree.
 *
 * Auth: CSM team only, same gate as the sibling labels route.
 *
 * Side effects beyond the HubSpot write, both mirroring that route:
 *   • action_log entry so there's a trail of who renamed whom —
 *     contact names are the sort of thing that gets "corrected" in
 *     two directions by two people.
 *   • read-side overlay refresh for this company, so the new name
 *     shows on the next render rather than after the twice-daily
 *     sync. Best-effort: a failed refresh doesn't roll back the
 *     HubSpot write, it just means the panel lags.
 */

interface PatchBody {
  name?: string;
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ workspace_id: string; contact_id: string }> }
) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!(await isCsmTeamMember(email))) {
    return NextResponse.json({ error: "CSM team only" }, { status: 403 });
  }
  const { workspace_id: workspaceId, contact_id: contactId } = await ctx.params;
  if (!workspaceId || !contactId) {
    return NextResponse.json(
      { error: "workspace_id and contact_id are required" },
      { status: 400 }
    );
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const name = (body.name ?? "").trim();
  if (!name) {
    // Refused rather than treated as "clear the name". Blanking a
    // contact in HubSpot is a destructive edit that should be done
    // there deliberately, not fall out of an empty input here.
    return NextResponse.json(
      { error: "Name can't be empty." },
      { status: 400 }
    );
  }
  if (name.length > 200) {
    return NextResponse.json(
      { error: "Name is too long (200 characters max)." },
      { status: 400 }
    );
  }

  const customers = await loadCustomers();
  const customer = customers.find((c) => c.workspace_id === workspaceId);
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }
  // The contact has to already be associated with this customer. Without
  // this check the route would happily rename ANY contact in the portal
  // given its id, which is a much wider write than the UI implies.
  const contact = (customer.hubspot_contacts ?? []).find(
    (c) => c.id === contactId
  );
  if (!contact) {
    return NextResponse.json(
      { error: "Contact not found on this customer" },
      { status: 404 }
    );
  }

  const { firstname, lastname } = splitContactName(name);
  try {
    await patchHubspotContactProperties(contactId, { firstname, lastname });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    console.error("[contacts PATCH] HubSpot write failed", {
      workspaceId,
      contactId,
      msg,
    });
    return NextResponse.json(
      { error: `HubSpot rejected the update: ${msg}` },
      { status: 502 }
    );
  }

  try {
    await appendActionLog([
      {
        workspace_id: workspaceId,
        text: `Renamed contact "${contact.name ?? contact.email ?? contactId}" to "${name}"`,
        created_by: email.toLowerCase(),
        action_kind: "contact_renamed",
        metadata: { contact_id: contactId, firstname, lastname },
      },
    ]);
  } catch (e) {
    console.warn("[contacts PATCH] action log failed", e);
  }

  // Refresh this company's overlay so the panel shows the new name on
  // the next render instead of the pre-edit one.
  if (customer.hubspot_company_id) {
    try {
      const result = await fetchHubspotOverlayBatch([
        customer.hubspot_company_id,
      ]);
      const row = result.get(customer.hubspot_company_id);
      if (row) {
        const overlay = await loadHubspotOverlay();
        const overlayRow: HubSpotOverlayRow = {
          hubspot_contacts: row.contacts ?? null,
          last_activity_at: row.last_activity_at ?? null,
          last_activity_source: row.source ?? null,
          property_customer_folder: row.customer_folder ?? null,
          company_engagement: row.company_engagement ?? null,
          property_risk_level: row.property_risk_level ?? null,
          property_main_contact: row.property_main_contact ?? null,
          fetched_at: new Date().toISOString(),
        };
        overlay.rows[workspaceId] = overlayRow;
        overlay.fetched_at = new Date().toISOString();
        await saveHubspotOverlay(overlay);
      }
    } catch (e) {
      console.warn("[contacts PATCH] overlay refresh failed", e);
    }
  }

  return NextResponse.json({ ok: true, name, firstname, lastname });
}
