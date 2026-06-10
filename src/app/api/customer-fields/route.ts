import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  invalidateCustomerCache,
  loadCustomers,
} from "@/lib/data/load-customers";
import { setOverride } from "@/lib/data/customer-overrides";
import {
  loadFieldMappings,
  MAPPABLE_DASHBOARD_FIELDS,
} from "@/lib/data/field-mappings";
import { patchHubspotCompanyProperties } from "@/lib/integrations/hubspot";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/customer-fields
 *
 * Edit a single mapped Customer field from the detail panel.
 *
 *   1. Validate field_id against MAPPABLE_DASHBOARD_FIELDS so a
 *      typo or removed field can't poison the override KV.
 *   2. Write to customer-overrides field_overrides bag — UI updates
 *      immediately via applyOverride() on the next render.
 *   3. If the field's mapping in /settings/hubspot-fields has
 *      direction "push" or "both", PATCH the corresponding HubSpot
 *      property too. The HubSpot call is *blocking* (within this
 *      request) so the response surfaces failures inline; the KV
 *      write already landed regardless, so the dashboard stays
 *      consistent with itself even when HubSpot's slow / down.
 *
 * Body:
 *   { workspace_id: string, field_id: string,
 *     value: string | null }
 *
 * Response:
 *   200 { ok: true, hubspot_pushed: bool, hubspot_error?: string }
 *   400 invalid body / unknown field / no value handler
 *   422 customer has no workspace / no hubspot_company_id when push
 *       is required
 *   502 HubSpot push failed (KV write still landed; client decides
 *       whether to surface the error or proceed)
 *
 * Auth: NextAuth session. Viewer email is stamped on the override
 * for audit.
 */

interface PostBody {
  workspace_id?: string;
  field_id?: string;
  value?: string | null;
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  const viewer = session.user.email.toLowerCase();

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const workspaceId = (body.workspace_id ?? "").trim();
  const fieldId = (body.field_id ?? "").trim();
  if (!workspaceId || !fieldId) {
    return NextResponse.json(
      { error: "workspace_id and field_id are required" },
      { status: 400 }
    );
  }
  const fieldDef = MAPPABLE_DASHBOARD_FIELDS.find((f) => f.id === fieldId);
  if (!fieldDef) {
    return NextResponse.json(
      { error: `Unknown field_id: ${fieldId}` },
      { status: 400 }
    );
  }
  // Normalize value — empty string clears; trim leading/trailing
  // whitespace for tidy storage. null is preserved (explicit clear).
  let value: string | null;
  if (body.value === null) {
    value = null;
  } else if (typeof body.value === "string") {
    const trimmed = body.value.trim();
    value = trimmed === "" ? null : trimmed;
  } else {
    return NextResponse.json(
      { error: "value must be string or null" },
      { status: 400 }
    );
  }
  // Enum validation — when the field has an enum_values list, reject
  // any value outside it so a typo'd dropdown can't slip through.
  if (
    fieldDef.enum_values &&
    value != null &&
    !fieldDef.enum_values.includes(value)
  ) {
    return NextResponse.json(
      {
        error: `Value "${value}" not in allowed list for ${fieldId}: [${fieldDef.enum_values.join(", ")}]`,
      },
      { status: 400 }
    );
  }

  // ─── Step 1: write the override (always) ────────────────────────
  // KV write is the source-of-truth for the dashboard. Happens even
  // if the HubSpot push later fails — keeps the UI consistent with
  // itself and lets the next sync retry the propagation.
  const now = new Date().toISOString();
  await setOverride(workspaceId, {
    field_overrides: {
      [fieldId]: {
        value,
        updated_at: now,
        updated_by: viewer,
      },
    },
  });
  invalidateCustomerCache();

  // ─── Step 2: HubSpot push (when mapping says push/both) ─────────
  const mappings = await loadFieldMappings();
  const mapping = mappings.mappings[fieldId];
  const shouldPush =
    mapping &&
    mapping.hubspot_property &&
    (mapping.direction === "push" || mapping.direction === "both");
  if (!shouldPush) {
    return NextResponse.json({
      ok: true,
      hubspot_pushed: false,
    });
  }
  // Resolve the customer's hubspot_company_id so we know where to
  // PATCH. loadCustomers() applies overrides, so the re-resolved
  // company ID from the Stripe-ID resolver shows up here too.
  const customers = await loadCustomers();
  const customer = customers.find((c) => c.workspace_id === workspaceId);
  if (!customer) {
    return NextResponse.json(
      {
        ok: true,
        hubspot_pushed: false,
        hubspot_error: `Customer not found for workspace_id=${workspaceId} — KV override saved but no HubSpot link to push through.`,
      },
      { status: 422 }
    );
  }
  if (!customer.hubspot_company_id) {
    return NextResponse.json(
      {
        ok: true,
        hubspot_pushed: false,
        hubspot_error:
          "Customer has no hubspot_company_id — KV override saved but HubSpot push skipped. Re-resolve via Stripe ID on the detail panel to fix the link.",
      },
      { status: 422 }
    );
  }
  try {
    await patchHubspotCompanyProperties(customer.hubspot_company_id, {
      [mapping.hubspot_property]: value ?? "",
    });
    return NextResponse.json({
      ok: true,
      hubspot_pushed: true,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    console.error("[customer-fields POST] HubSpot push failed", {
      workspace_id: workspaceId,
      field_id: fieldId,
      hubspot_company_id: customer.hubspot_company_id,
      hubspot_property: mapping.hubspot_property,
      error: msg,
    });
    return NextResponse.json(
      {
        ok: true,
        hubspot_pushed: false,
        hubspot_error: `HubSpot push failed: ${msg}. KV override saved; the next sync run will retry the propagation.`,
      },
      { status: 502 }
    );
  }
}
