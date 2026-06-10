import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  loadFieldMappings,
  saveFieldMappings,
  MAPPABLE_DASHBOARD_FIELDS,
  type FieldMappingsState,
} from "@/lib/data/field-mappings";

export const dynamic = "force-dynamic";

/**
 * GET    /api/settings/field-mappings
 *   → { mappings, available_fields }
 *     `available_fields` is the canonical MAPPABLE_DASHBOARD_FIELDS
 *     list so the UI can render rows for fields that haven't been
 *     mapped yet (mappings[id] === undefined) alongside ones that
 *     have.
 *
 * PUT    /api/settings/field-mappings
 *   body: { mappings: Record<dashboard_field_id, { hubspot_property,
 *           direction }> }
 *   → the persisted state. Stamps `updated_at` + `updated_by` on
 *   every mapping that changed.
 *
 * Auth: signed-in viewer. The endpoint doesn't gate on admin role
 * yet — open to every @beehiiv.com viewer, mirroring the other
 * settings endpoints. If we add roles later, gate here.
 */

interface PutBody {
  mappings?: FieldMappingsState["mappings"];
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  const state = await loadFieldMappings();
  return NextResponse.json({
    mappings: state.mappings,
    available_fields: MAPPABLE_DASHBOARD_FIELDS,
  });
}

export async function PUT(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  const viewer = session.user.email.toLowerCase();
  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const incoming = body.mappings ?? {};

  // Validate every dashboard_field_id against the canonical list —
  // a typo'd or removed field shouldn't persist into the KV row.
  const validIds = new Set(MAPPABLE_DASHBOARD_FIELDS.map((f) => f.id));
  const now = new Date().toISOString();

  // Load existing so we can detect which mappings actually changed
  // (only those get a fresh updated_at/by stamp; untouched mappings
  // keep their prior audit timestamps).
  const before = await loadFieldMappings();
  const next: FieldMappingsState = { mappings: {} };
  for (const [fieldId, mapping] of Object.entries(incoming)) {
    if (!validIds.has(fieldId)) {
      console.warn(
        "[field-mappings PUT] dropping unknown dashboard field id",
        { fieldId }
      );
      continue;
    }
    if (!mapping || typeof mapping !== "object") continue;
    const property = (mapping.hubspot_property ?? "").trim();
    const direction = mapping.direction;
    if (
      !property ||
      (direction !== "off" &&
        direction !== "pull" &&
        direction !== "push" &&
        direction !== "both")
    ) {
      continue;
    }
    const prior = before.mappings[fieldId];
    const changed =
      !prior ||
      prior.hubspot_property !== property ||
      prior.direction !== direction;
    next.mappings[fieldId] = {
      hubspot_property: property,
      direction,
      updated_at: changed ? now : prior?.updated_at,
      updated_by: changed ? viewer : prior?.updated_by,
    };
  }
  const persisted = await saveFieldMappings(next);
  return NextResponse.json({
    mappings: persisted.mappings,
    available_fields: MAPPABLE_DASHBOARD_FIELDS,
  });
}
