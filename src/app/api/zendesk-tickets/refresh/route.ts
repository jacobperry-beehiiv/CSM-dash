import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { filterCustomers, loadCustomers } from "@/lib/data/load-customers";
import { refreshZendeskOverlay } from "@/lib/data/zendesk-tickets";
import { appendActionLog } from "@/lib/data/customer-signals";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/zendesk-tickets/refresh
 *
 * Sweeps the Zendesk-tickets overlay for a scope of workspaces. Two
 * scoping modes:
 *   - `{ workspace_ids: string[] }` — refresh exactly this batch.
 *   - `{ csm?: string }` (default) — refresh every workspace in the
 *     book (or the CSM's book if `csm` is provided). Body params
 *     tolerate the "all book" flow so the daily cron can call with
 *     no body and get the whole overlay refreshed.
 *
 * Auth: signed-in CSM. Not admin-gated because refresh is idempotent
 * and only writes into the shared overlay; a CSM triggering their
 * own book's refresh is the common path.
 *
 * Runs one Metabase Postgres query per scope. On a book of ~1500
 * workspaces this completes well under maxDuration=120s.
 */

interface Body {
  workspace_ids?: string[];
  csm?: string;
  lookback_days?: number;
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    const email = session?.user?.email ?? null;
    if (!email) {
      return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    }

    let body: Body = {};
    try {
      body = (await req.json()) as Body;
    } catch {
      // Empty body — treat as "sweep every workspace in the book"
      // (the cron path). Falls through with body = {}.
    }

    // Every scope path resolves through the customer book so we can
    // pair each workspace_id with its owner_email — the match key
    // the engine uses. Explicit workspace_ids in the body still get
    // filtered against the book; a workspace_id we don't know about
    // has no resolvable email and skips the sweep silently.
    const all = await loadCustomers();
    let targets: Array<{ workspace_id: string; owner_email: string | null }>;
    if (body.workspace_ids && body.workspace_ids.length > 0) {
      const wanted = new Set(body.workspace_ids);
      targets = all
        .filter((c) => c.workspace_id && wanted.has(c.workspace_id))
        .map((c) => ({
          workspace_id: c.workspace_id as string,
          owner_email: c.owner_email ?? null,
        }));
    } else {
      const scoped = body.csm ? filterCustomers(all, { csm: body.csm }) : all;
      targets = scoped
        .filter((c) => !!c.workspace_id)
        .map((c) => ({
          workspace_id: c.workspace_id as string,
          owner_email: c.owner_email ?? null,
        }));
    }
    if (targets.length === 0) {
      return NextResponse.json({
        ok: true,
        refreshed: 0,
        note: "No workspaces in scope — overlay unchanged.",
      });
    }

    const blob = await refreshZendeskOverlay(targets, {
      lookbackDays: body.lookback_days,
    });

    // Best-effort audit — when a CSM triggers a manual refresh for a
    // specific set of workspaces, drop a note on each so the profile
    // Notes surface shows the sweep happened. Skip on the book-wide
    // path (would flood every customer profile).
    if (body.workspace_ids && body.workspace_ids.length <= 25) {
      try {
        await appendActionLog(
          body.workspace_ids.map((id) => ({
            workspace_id: id,
            text: `Zendesk tickets refreshed (30d)`,
            created_by: email.toLowerCase(),
            action_kind: "zendesk_refresh",
          }))
        );
      } catch {
        // Ignore — audit isn't load-bearing.
      }
    }

    return NextResponse.json({
      ok: true,
      refreshed: targets.length,
      fetched_at: blob.fetched_at,
    });
  } catch (e) {
    console.error("[zendesk-tickets/refresh] failed", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
