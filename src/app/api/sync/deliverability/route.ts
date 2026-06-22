import { NextResponse } from "next/server";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/sync/deliverability
 *
 * Dashboard-triggered deliverability snapshot refresh. Vercel functions
 * have a read-only filesystem so we can't pull ClickHouse + encrypt +
 * commit here directly. Instead, we fire workflow_dispatch on
 * .github/workflows/deliverability-data-sync.yml, which:
 *   • runs `npm run sync -- --only=deliverability`
 *   • commits data/deliverability.enc.json back to main
 *   • Vercel auto-redeploys on the new commit (~90s total)
 *
 * Same dispatch shape as /api/sync (which kicks the full sync-data
 * workflow); just targets the lighter-weight deliverability-only one.
 *
 * Required Vercel env vars:
 *   GITHUB_DISPATCH_TOKEN  — PAT with `actions:write` on this repo
 *   GITHUB_REPO            — "jacobperry-beehiiv/CSM-dash" (default)
 *   GITHUB_REF             — "main" (default)
 *
 * Auth: signed-in session only.
 */

const WORKFLOW_FILE = "deliverability-data-sync.yml";

export async function POST() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }

  const token = process.env.GITHUB_DISPATCH_TOKEN;
  const repo = process.env.GITHUB_REPO ?? "jacobperry-beehiiv/CSM-dash";
  const ref = process.env.GITHUB_REF ?? "main";

  if (!token) {
    return NextResponse.json(
      {
        error:
          "Dashboard-driven refresh isn't wired up — set GITHUB_DISPATCH_TOKEN " +
          `in Vercel env, or run the workflow manually at ` +
          `https://github.com/${repo}/actions/workflows/${WORKFLOW_FILE}`,
      },
      { status: 503 }
    );
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ ref }),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `GitHub dispatch failed (${res.status}): ${text}` },
        { status: 502 }
      );
    }

    return NextResponse.json({
      ok: true,
      message:
        "Refresh started. Fresh deliverability data should be live in " +
        "~90 seconds once the workflow finishes and Vercel redeploys.",
      actions_url: `https://github.com/${repo}/actions/workflows/${WORKFLOW_FILE}`,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
