import { NextResponse } from "next/server";
import { findOrganization, runAdGapAnalysis } from "@/lib/engines/ad-gap";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function daysAgoUtc(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const orgId = url.searchParams.get("organization_id");
    const query = url.searchParams.get("q");
    const start = url.searchParams.get("start") ?? daysAgoUtc(90);
    const end = url.searchParams.get("end") ?? daysAgoUtc(0);

    if (!orgId && !query) {
      return NextResponse.json(
        { error: "Pass either organization_id or q (org name fragment)" },
        { status: 400 }
      );
    }

    let resolvedOrgId = orgId ?? "";
    if (!resolvedOrgId && query) {
      const matches = await findOrganization(query);
      if (matches.length === 0) {
        return NextResponse.json({ matches: [], report: null });
      }
      if (matches.length > 1) {
        return NextResponse.json({ matches, report: null });
      }
      resolvedOrgId = matches[0].id;
    }

    const report = await runAdGapAnalysis({
      organizationId: resolvedOrgId,
      startDate: start,
      endDate: end,
    });
    return NextResponse.json({ matches: [], report });
  } catch (error) {
    console.error("Ad gap run failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
