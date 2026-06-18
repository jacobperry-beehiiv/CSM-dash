import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { DB, runNativeQuery } from "@/lib/metabase";
import { isDemoMode } from "@/lib/demo/mode";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/customers/[workspace_id]/publications
 *
 * Returns every non-deleted publication under the given workspace
 * (organization). Used by the expanded customer-detail panel to
 * render a scrollable list with publication IDs — the previous
 * "feature breakdown" grid was static and didn't surface this.
 *
 * Schema: thin slice of public.publications + active-sub counts.
 * Sub counts come from v_active_subscription_counts so we get the
 * same number Stripe/Metabase show on the workspace overview.
 *
 * Auth: session-only. Workspaces aren't a public resource; surfacing
 * pub IDs to anonymous traffic would be a fingerprinting vector.
 */

interface PublicationRow {
  publication_id: string;
  publication_name: string;
  subscribers: number | null;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ workspace_id: string }> }
) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  const { workspace_id } = await ctx.params;
  // Demo mode — return a fake publication so the expanded-row UI has
  // something to render. The workspace id from the fixture isn't a
  // valid UUID, so we can't query Postgres for real pubs.
  if (isDemoMode()) {
    return NextResponse.json({
      publications: [
        {
          publication_id: `pub_demo_${workspace_id}_main`,
          publication_name: "Main publication",
          subscribers: null,
        },
      ],
    });
  }
  const orgId = (workspace_id ?? "").replace(/'/g, "''");
  if (!orgId) {
    return NextResponse.json(
      { error: "workspace_id is required" },
      { status: 400 }
    );
  }

  // ORDER: largest publication first (proxy for "primary"), then name
  // as a tiebreaker. We previously tried to surface a primary flag
  // via organizations.primary_publication_id but that column doesn't
  // exist in this schema — drop the lookup entirely rather than guess
  // at another column. Sub-count sort still puts the workspace's
  // biggest pub at the top of the list, which is what readers wanted.
  const sql = `
    SELECT
      p.id::text AS publication_id,
      p.name AS publication_name,
      coalesce(vasc.total, 0) AS subscribers
    FROM public.publications p
    LEFT JOIN public.v_active_subscription_counts vasc
      ON vasc.publication_id = p.id
    WHERE p.organization_id = '${orgId}'
      AND p.deleted_at IS NULL
    ORDER BY coalesce(vasc.total, 0) DESC, p.name ASC
  `;

  try {
    const rows = (await runNativeQuery(
      DB.POSTGRES,
      sql
    )) as unknown as PublicationRow[];
    return NextResponse.json({ publications: rows });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
