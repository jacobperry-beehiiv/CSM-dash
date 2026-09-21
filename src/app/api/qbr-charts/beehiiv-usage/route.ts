import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { computeBeehiivUsage } from "@/lib/qbr-charts/beehiiv-usage";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/qbr-charts/beehiiv-usage?workspace_id=<uuid>&publication_id=<uuid>
 *
 * Returns the beehiiv Usage Y/N feature-adoption report for one
 * workspace, plus the primary-publication metadata (id, name, logo
 * filename) used to render the header logo.
 *
 * `publication_id` is optional — when set, that publication wins
 * (matches whatever the QBR tab's PublicationPicker resolved to);
 * otherwise the engine picks the earliest-created publication in
 * the workspace with a non-null logo.
 *
 * Signed-in users only; no admin gate — every CSM reads their own
 * book's usage picture. Two Postgres round-trips (usage EXISTS
 * batch + publication pick, in parallel).
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  const url = new URL(req.url);
  const workspaceId = (url.searchParams.get("workspace_id") ?? "").trim();
  const publicationId =
    (url.searchParams.get("publication_id") ?? "").trim() || null;
  if (!workspaceId) {
    return NextResponse.json(
      { error: "Missing workspace_id" },
      { status: 400 }
    );
  }
  try {
    const report = await computeBeehiivUsage(workspaceId, publicationId);
    return NextResponse.json(report);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
