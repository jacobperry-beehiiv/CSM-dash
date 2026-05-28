import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { DB, runNativeQuery } from "@/lib/metabase";

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
  is_primary: boolean;
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
  const orgId = (workspace_id ?? "").replace(/'/g, "''");
  if (!orgId) {
    return NextResponse.json(
      { error: "workspace_id is required" },
      { status: 400 }
    );
  }

  // ORDER: primary first, then subscriber count desc, name as tiebreaker.
  // Primary lives on organizations.primary_publication_id.
  const sql = `
    SELECT
      p.id::text AS publication_id,
      p.name AS publication_name,
      coalesce(vasc.total, 0) AS subscribers,
      (p.id = o.primary_publication_id) AS is_primary
    FROM public.publications p
    JOIN public.organizations o ON o.id = p.organization_id
    LEFT JOIN public.v_active_subscription_counts vasc
      ON vasc.publication_id = p.id
    WHERE p.organization_id = '${orgId}'
      AND p.deleted_at IS NULL
    ORDER BY is_primary DESC, coalesce(vasc.total, 0) DESC, p.name ASC
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
