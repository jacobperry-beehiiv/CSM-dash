import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  loadPropertyOptions,
  refreshPropertyOptions,
  type HubspotObjectType,
} from "@/lib/data/hubspot-property-options";

export const dynamic = "force-dynamic";

/**
 * GET /api/hubspot/property-options?object=companies&property=customer_goals
 *
 * Returns the cached enum options for a HubSpot property — used by
 * `MappedFieldEditor` to populate dropdowns whose valid values are
 * managed in HubSpot rather than hardcoded in the dashboard.
 *
 * `?refresh=1` forces a fresh fetch from HubSpot (admin can use this
 * after editing the property's option list there).
 *
 * Auth: signed-in only. No write path.
 */

const ALLOWED_OBJECTS: ReadonlySet<HubspotObjectType> = new Set([
  "companies",
  "contacts",
]);

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  const url = new URL(req.url);
  const objectParam = (url.searchParams.get("object") ?? "").trim();
  const property = (url.searchParams.get("property") ?? "").trim();
  const refresh = url.searchParams.get("refresh") === "1";
  if (!ALLOWED_OBJECTS.has(objectParam as HubspotObjectType)) {
    return NextResponse.json(
      { error: "object must be one of: companies, contacts" },
      { status: 400 }
    );
  }
  if (!property) {
    return NextResponse.json(
      { error: "property is required" },
      { status: 400 }
    );
  }
  try {
    const options = refresh
      ? await refreshPropertyOptions(
          objectParam as HubspotObjectType,
          property
        )
      : await loadPropertyOptions(
          objectParam as HubspotObjectType,
          property
        );
    return NextResponse.json({ options });
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "Property-options fetch failed",
      },
      { status: 502 }
    );
  }
}
