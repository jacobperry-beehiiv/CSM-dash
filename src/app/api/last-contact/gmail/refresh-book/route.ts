import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getActiveEmail } from "@/lib/data/active-user";
import {
  GmailReadScopeError,
  lastEmailForCustomerBatch,
  lastEmailWithBatch,
  type CustomerSignals,
} from "@/lib/integrations/gmail-read";
import { filterCustomers, loadCustomers } from "@/lib/data/load-customers";
import { customerEmailSignals } from "@/lib/data/customer-domains";

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

  let customersInScope = 0;
  let signals: CustomerSignals[] = [];
  let explicitEmails: string[] | null = null;
  if (Array.isArray(body.emails) && body.emails.length > 0) {
    // Explicit override — the client handed us a curated list. We
    // can't derive per-customer signals here (no customer context
    // for each email), so fall back to the legacy per-email path
    // for these. The sweep gap fix only kicks in when the route
    // resolves the scope server-side.
    explicitEmails = body.emails.filter(
      (e): e is string => typeof e === "string" && e.trim().length > 0
    );
    customersInScope = explicitEmails.length;
  } else {
    // Resolve scope server-side via the customer book. For each
    // customer in scope, derive the full signal set (owner_email +
    // every hubspot_contacts[].email + business domains) so the
    // Gmail query catches conversations with anyone at the company
    // — not just the recorded primary contact.
    const all = await loadCustomers();
    const scoped = filterCustomers(all, { csm: csmScope });
    customersInScope = scoped.length;
    for (const c of scoped) {
      const s = customerEmailSignals(c);
      if (s.emails.length === 0 && s.domains.length === 0) continue;
      // Cache key prefers owner_email (stable, what the read path
      // looks up) and falls back to workspace_id when missing.
      const key =
        c.owner_email?.trim().toLowerCase() ||
        (c.workspace_id ? `workspace:${c.workspace_id}` : null);
      if (!key) continue;
      signals.push({ key, emails: s.emails, domains: s.domains });
    }
  }

  const totalKnown = signals.length + (explicitEmails?.length ?? 0);
  if (totalKnown === 0) {
    return NextResponse.json({
      ok: true,
      processed: 0,
      succeeded: 0,
      failed: 0,
      customers_in_scope: customersInScope,
      unique_emails: 0,
      truncated: false,
      generated_at: new Date().toISOString(),
      message: "No customers with known contacts in the active scope.",
    });
  }

  // Cap on processed customers per request — same shape as the old
  // per-email cap, now applied per-customer (one Gmail query each).
  const truncated = signals.length > MAX_EMAILS;
  signals = signals.slice(0, MAX_EMAILS);

  try {
    console.log("[last-contact/gmail/refresh-book]", {
      activeEmail,
      csm: csmScope ?? "(all)",
      customers_in_scope: customersInScope,
      processing_customers: signals.length,
      processing_explicit: explicitEmails?.length ?? 0,
      truncated,
    });
    let succeeded = 0;
    let attempted = 0;
    if (signals.length > 0) {
      const results = await lastEmailForCustomerBatch(activeEmail, signals, {
        forceFresh: true,
      });
      attempted += signals.length;
      succeeded += Object.keys(results).length;
    }
    if (explicitEmails && explicitEmails.length > 0) {
      // Legacy path — explicit per-email refresh. No domain match.
      const legacyTargets = explicitEmails.slice(0, MAX_EMAILS);
      const results = await lastEmailWithBatch(activeEmail, legacyTargets, {
        forceFresh: true,
      });
      attempted += legacyTargets.length;
      succeeded += Object.keys(results).length;
    }
    const failed = attempted - succeeded;
    return NextResponse.json({
      ok: true,
      processed: attempted,
      succeeded,
      failed,
      customers_in_scope: customersInScope,
      unique_emails: attempted,
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
