import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getActiveEmail } from "@/lib/data/active-user";
import {
  GmailReadScopeError,
  lastEmailWithBatch,
} from "@/lib/integrations/gmail-read";
import { filterCustomers, loadCustomers } from "@/lib/data/load-customers";

export const dynamic = "force-dynamic";
// 8-way concurrent fanout in lastEmailWithBatch × ~250ms per Gmail
// call ⇒ ~32 emails/sec. A 500-customer book = ~16s; 240s headroom
// covers slow days + retries inside the helper.
export const maxDuration = 240;

/**
 * POST /api/last-contact/gmail/refresh-book
 *
 * Full re-sync of Gmail "last contacted" data for every customer in
 * the viewer's CSM scope. Force-busts the 6h cache so every entry
 * gets a live Gmail lookup. Used by the at-risk tab's "Refresh from
 * Gmail" button when a CSM wants the freshest possible signal
 * before deciding who to reach out to.
 *
 * Auth: NextAuth session + an active Gmail connection (csm_active_email
 * cookie). Same dual gate the per-row + per-batch endpoints use.
 *
 * Query: `?csm=<handle>` — scopes the refresh to the named CSM's
 * book. `?csm=all` (or unset) does the team-wide book — typically
 * what an admin viewer would want; matches the convention used by
 * /api/news/sweep.
 *
 * Body (optional): `{ emails?: string[] }` — explicit subset
 * override, takes precedence over the URL scope. Used when the
 * client already has a narrower list in hand.
 *
 * Response:
 *   { ok, processed, succeeded, failed, customers_in_scope,
 *     unique_emails, truncated, generated_at }
 */

interface PostBody {
  emails?: string[];
}

// Hard cap on the number of unique emails refreshed in one request.
// Each Gmail lookup is metered against the viewer's per-user quota
// (250 req/sec) and takes ~250ms; the 8-way fanout means ~32/sec
// throughput. 1000 emails = ~30s at full speed — still well inside
// maxDuration. Larger books should be sliced client-side.
const MAX_EMAILS = 1000;

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  const activeEmail = await getActiveEmail();
  if (!activeEmail) {
    return NextResponse.json(
      {
        error:
          "No Gmail account connected for this browser. Visit /settings/gmail.",
        no_active_gmail: true,
      },
      { status: 401 }
    );
  }

  const url = new URL(req.url);
  const csmParam = (url.searchParams.get("csm") ?? "").trim();
  const csmScope =
    csmParam && csmParam.toLowerCase() !== "all" ? csmParam : null;

  let body: PostBody = {};
  if (req.headers.get("content-length")) {
    try {
      body = (await req.json()) as PostBody;
    } catch {
      // Tolerate empty / malformed bodies — the URL scope is enough.
    }
  }

  let emails: string[];
  let customersInScope = 0;
  if (Array.isArray(body.emails) && body.emails.length > 0) {
    // Explicit override — client already has a curated list.
    emails = body.emails.filter(
      (e): e is string => typeof e === "string" && e.trim().length > 0
    );
    customersInScope = emails.length;
  } else {
    // Resolve scope server-side via the customer book.
    const all = await loadCustomers();
    const scoped = filterCustomers(all, { csm: csmScope });
    customersInScope = scoped.length;
    emails = scoped
      .map((c) => c.owner_email)
      .filter((e): e is string => typeof e === "string" && e.trim().length > 0);
  }

  // Dedupe + cap at the soft limit. lastEmailWithBatch also dedupes
  // internally, but capping here keeps the response counts honest.
  const unique = Array.from(
    new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))
  );
  const truncated = unique.length > MAX_EMAILS;
  const targets = unique.slice(0, MAX_EMAILS);

  if (targets.length === 0) {
    return NextResponse.json({
      ok: true,
      processed: 0,
      succeeded: 0,
      failed: 0,
      customers_in_scope: customersInScope,
      unique_emails: 0,
      truncated: false,
      generated_at: new Date().toISOString(),
      message: "No owner emails to refresh in the active scope.",
    });
  }

  try {
    console.log("[last-contact/gmail/refresh-book]", {
      activeEmail,
      csm: csmScope ?? "(all)",
      customers_in_scope: customersInScope,
      unique_emails: unique.length,
      processing: targets.length,
      truncated,
    });
    const results = await lastEmailWithBatch(activeEmail, targets, {
      forceFresh: true,
    });
    // lastEmailWithBatch returns one entry per target it actually got
    // a result for — failures (Gmail throws non-scope errors per
    // email) silently drop. Compute the failure count as the
    // delta. The helper itself logs the per-email error in the
    // worker fallback.
    const succeeded = Object.keys(results).length;
    const failed = targets.length - succeeded;
    return NextResponse.json({
      ok: true,
      processed: targets.length,
      succeeded,
      failed,
      customers_in_scope: customersInScope,
      unique_emails: unique.length,
      truncated,
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    if (e instanceof GmailReadScopeError) {
      return NextResponse.json(
        {
          error:
            "Gmail token doesn't have the gmail.readonly scope yet. Reconnect at /settings/gmail.",
          needs_reconsent: true,
        },
        { status: 403 }
      );
    }
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[last-contact/gmail/refresh-book] 500", {
      activeEmail,
      csm: csmScope,
      msg,
    });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
