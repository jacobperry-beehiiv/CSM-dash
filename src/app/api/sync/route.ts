import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Vercel functions have a read-only filesystem, so we can't run the
 * Metabase pull + encrypt + write here. Instead, we hand off to the
 * sync-data GitHub Action (.github/workflows/sync-data.yml), which:
 *   • pulls q10600,
 *   • encrypts with SNAPSHOT_ENCRYPTION_KEY,
 *   • commits data/snapshot.enc.json back to main, and
 *   • Vercel auto-redeploys on the new commit (~2 min total).
 *
 * To enable in-app trigger, set in Vercel env:
 *   GITHUB_DISPATCH_TOKEN  — PAT with `actions:write` on this repo
 *   GITHUB_REPO            — "jacobperry-beehiiv/CSM-dash" (or whichever)
 *   GITHUB_REF             — "main" (default)
 *
 * Without those vars the route returns a friendly 503 pointing the user
 * at the Actions tab to run the workflow manually.
 */

const WORKFLOW_FILE = "sync-data.yml";

export async function POST() {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  const repo = process.env.GITHUB_REPO ?? "jacobperry-beehiiv/CSM-dash";
  const ref = process.env.GITHUB_REF ?? "main";

  if (!token) {
    return NextResponse.json(
      {
        error:
          "In-app refresh isn't wired up — set GITHUB_DISPATCH_TOKEN in " +
          "Vercel env, or run the sync-data workflow manually at " +
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
        "Sync triggered. Fresh data should be live in ~2 minutes once the " +
        "workflow finishes and Vercel redeploys.",
      actions_url: `https://github.com/${repo}/actions/workflows/${WORKFLOW_FILE}`,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
