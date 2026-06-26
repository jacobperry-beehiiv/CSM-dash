import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isCsmTeamMember } from "@/lib/auth/csm-team";
import {
  loadAssociationLabels,
  refreshAssociationLabels,
} from "@/lib/data/hubspot-association-labels";

export const dynamic = "force-dynamic";

/**
 * GET  /api/admin/hubspot-labels
 *   → { labels: AssociationLabel[] }
 *   Lazy-cached schema of every HubSpot company-contact association
 *   label this portal recognizes. Used by the detail-panel label
 *   editor to populate its multi-select.
 *
 * POST /api/admin/hubspot-labels
 *   → { labels: AssociationLabel[] }
 *   Force-refresh from HubSpot. Surfaces newly-created labels
 *   immediately rather than waiting for the 24h TTL.
 *
 * Auth: CSM team member only. The schema doesn't leak anything
 * sensitive, but the write is a HubSpot API call we don't want
 * unauthenticated requests triggering.
 */

export async function GET() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!(await isCsmTeamMember(email))) {
    return NextResponse.json({ error: "CSM team only" }, { status: 403 });
  }
  try {
    const labels = await loadAssociationLabels();
    return NextResponse.json({ labels });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function POST() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!(await isCsmTeamMember(email))) {
    return NextResponse.json({ error: "CSM team only" }, { status: 403 });
  }
  try {
    const labels = await refreshAssociationLabels();
    return NextResponse.json({ labels });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
