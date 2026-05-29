import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { DB, runNativeQuery } from "@/lib/metabase";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/customers/publications-index
 *
 * Returns a flat `{ publication_id → organization_id }` map of every
 * non-deleted publication in the platform. Used by the dashboard's
 * search inputs so a CSM/AM can paste a publication ID (or an
 * organization/workspace ID) into the search field and find the
 * matching company instantly — no need to know which kind of ID they
 * have on hand.
 *
 * Volume: at beehiiv scale this is ~thousands to low-tens-of-thousands
 * of rows. Two-UUID JSON pairs are tiny — the encoded response sits in
 * the 200KB-1MB range. Acceptable for a one-time fetch on a heavy
 * dashboard page; the client-side hook caches it for the lifetime of
 * the tab so subsequent panels (Past Due → Approaching → CSM) share
 * the same payload.
 *
 * Auth: session-only. Pub IDs are a fingerprint vector — surfacing the
 * whole publications table to anonymous traffic would let anyone
 * enumerate every newsletter beehiiv hosts.
 */

interface IndexRow {
  publication_id: string;
  organization_id: string;
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }

  try {
    const rows = await runNativeQuery(
      DB.POSTGRES,
      `SELECT
         id::text            AS publication_id,
         organization_id::text AS organization_id
       FROM public.publications
       WHERE deleted_at IS NULL
         AND organization_id IS NOT NULL`
    );

    // Use a plain object rather than a Map so it serializes to JSON
    // cleanly. The client only needs string→string lookups.
    const pub2ws: Record<string, string> = {};
    for (const raw of rows) {
      const r = raw as Partial<IndexRow>;
      if (
        typeof r.publication_id === "string" &&
        typeof r.organization_id === "string"
      ) {
        pub2ws[r.publication_id] = r.organization_id;
      }
    }

    // Tell the browser/CDN it can hold the response briefly so a quick
    // tab-switch doesn't redo the query. Page-level state still wins
    // for in-session reuse — this just smooths the cold-load case.
    return NextResponse.json(
      { pub2ws, count: Object.keys(pub2ws).length },
      {
        headers: {
          "Cache-Control":
            "private, max-age=300, stale-while-revalidate=900",
        },
      }
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
