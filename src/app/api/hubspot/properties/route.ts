import { NextResponse } from "next/server";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * GET /api/hubspot/properties
 *
 * Returns the full list of HubSpot company properties so the
 * /settings/hubspot-fields page can populate its property-picker
 * dropdowns with the actual internal names admins need to map
 * against.
 *
 * Optional `?contains=<substring>` filter narrows by substring
 * match on either the internal name or display label (case-
 * insensitive). When omitted, returns every property — the page
 * dedupes + sorts client-side.
 *
 * Caching: HubSpot's properties endpoint returns up to a few hundred
 * rows; not huge, but we don't want to re-fetch on every keystroke.
 * The endpoint adds Cache-Control: max-age=300 so the browser holds
 * the response for 5 minutes; the underlying token mint is cached at
 * the integration layer for the same window.
 *
 * Auth: NextAuth session. Token stays server-side.
 */

interface HubspotProperty {
  name: string;
  label: string;
  type: string;
  groupName?: string;
  hubspotDefined?: boolean;
  calculated?: boolean;
  description?: string;
  options?: Array<{ label: string; value: string }>;
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  const token = process.env.HUBSPOT_ACCESS_TOKEN ?? null;
  if (!token) {
    return NextResponse.json(
      {
        error:
          "HUBSPOT_ACCESS_TOKEN not set on this deployment. Add the Private App token to Vercel env vars.",
      },
      { status: 500 }
    );
  }

  const url = new URL(req.url);
  const contains = (url.searchParams.get("contains") ?? "").trim().toLowerCase();

  let res: Response;
  try {
    res = await fetch(
      "https://api.hubapi.com/crm/v3/properties/companies",
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
  } catch (e) {
    return NextResponse.json(
      {
        error: `HubSpot fetch failed: ${e instanceof Error ? e.message : "unknown"}`,
      },
      { status: 502 }
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `HubSpot HTTP ${res.status}: ${body.slice(0, 600)}` },
      { status: res.status }
    );
  }
  const json = (await res.json()) as { results?: HubspotProperty[] };
  let properties = json.results ?? [];
  if (contains) {
    properties = properties.filter((p) => {
      const haystack = `${p.name} ${p.label}`.toLowerCase();
      return haystack.includes(contains);
    });
  }
  // Stable sort by display label for the picker UI.
  properties.sort((a, b) =>
    (a.label ?? a.name).localeCompare(b.label ?? b.name)
  );

  return NextResponse.json(
    { properties, total: properties.length },
    {
      headers: {
        "Cache-Control": "private, max-age=300",
      },
    }
  );
}
