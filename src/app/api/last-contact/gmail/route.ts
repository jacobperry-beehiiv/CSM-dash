import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getActiveEmail } from "@/lib/data/active-user";
import {
  GmailReadScopeError,
  lastEmailForCustomerBatch,
  lastEmailForCustomerCached,
  lastEmailWithBatch,
  lastEmailWithCached,
  type CustomerSignals,
} from "@/lib/integrations/gmail-read";
import { loadCustomers } from "@/lib/data/load-customers";
import { customerEmailSignals } from "@/lib/data/customer-domains";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * "Last contacted via Gmail" lookup.
 *
 *   GET  /api/last-contact/gmail?email=foo@acme.com[&csm_email=…] → single
 *   POST /api/last-contact/gmail                                  → batch
 *
 * Batch body accepts either shape:
 *   • { targets: [{ email, csm_email? }, …], forceFresh? }  — new; per-
 *     target CSM overrides so each row uses its ASSIGNED CSM's token
 *     (Jacob viewing Olivia's book sees Olivia's Gmail dates, not his).
 *   • { emails: string[], forceFresh? }  — legacy; treats every target
 *     as belonging to the viewer's active Gmail connection.
 *
 * Auth: NextAuth session. When a target's `csm_email` names a CSM
 * OTHER than the viewer, we use that CSM's stored OAuth token via
 * getValidAccessTokenFor(). Any signed-in dashboard user can request
 * a lookup under any known CSM — matches the "everyone sees the whole
 * book" posture of the rest of the app. Targets whose csm_email has
 * no valid token are simply skipped (row falls back to HubSpot-only).
 *
 * When no csm_email is set on a target (or the legacy `emails` shape
 * is used), the endpoint falls back to the viewer's active Gmail
 * cookie — preserves the pre-change behavior for callers that
 * haven't migrated.
 *
 * Three failure modes the UI should distinguish:
 *
 *   401 → no NextAuth session. If EVERY target routes to the viewer
 *         fallback and the viewer has no active Gmail cookie, we
 *         return { error, no_active_gmail: true } so the UI can
 *         point them at /settings/gmail. When at least one target
 *         has a csm_email override, we don't require the viewer's
 *         own connection.
 *   403 → Gmail token doesn't have gmail.readonly scope (surfaced
 *         from at least one lookup in the batch).
 *         Body: { error, needs_reconsent: true }.
 *   200 → results map (POST) or single result (GET). Missing entries
 *         mean either "no matching email" or "CSM token not
 *         available"; caller can distinguish by falling back to
 *         HubSpot data for the missing rows.
 */

interface BatchTarget {
  email: string;
  csm_email?: string | null;
}

interface BatchBody {
  /** New per-target shape. Preferred. */
  targets?: BatchTarget[];
  /** Legacy flat email list. Every entry routes to the viewer's
   *  active Gmail cookie (pre-change behavior). */
  emails?: string[];
  forceFresh?: boolean;
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  const url = new URL(req.url);
  const target = (url.searchParams.get("email") ?? "").trim();
  const forceFresh = url.searchParams.get("forceFresh") === "1";
  // Optional: fetch under a specific CSM's Gmail token rather than
  // the viewer's active-Gmail cookie. Threaded from the at-risk +
  // customer tables so each row's "Last contacted" reflects the
  // ASSIGNED CSM's inbox regardless of who's viewing.
  const csmEmailParam = (url.searchParams.get("csm_email") ?? "").trim();
  if (!target) {
    return NextResponse.json(
      { error: "Missing required query param: email" },
      { status: 400 }
    );
  }
  // Resolve the CSM whose token we'll use. Explicit param wins; else
  // fall back to the viewer's active-Gmail cookie so pre-migration
  // callers keep working.
  const csmEmail = csmEmailParam || (await getActiveEmail());
  if (!csmEmail) {
    return NextResponse.json(
      {
        error:
          "No Gmail account connected for this browser. Visit /settings/gmail.",
        no_active_gmail: true,
      },
      { status: 401 }
    );
  }
  try {
    // Try the per-customer path first — match the target email
    // against the customer book to find which customer (and
    // therefore which contact set + domains) it belongs to. Fall
    // back to the per-email path when there's no match (caller
    // passed a bare email outside the book).
    const customers = await loadCustomers();
    const targetLc = target.toLowerCase();
    const cust = customers.find(
      (c) => (c.owner_email ?? "").toLowerCase() === targetLc
    );
    if (cust) {
      const sig = customerEmailSignals(cust);
      if (sig.emails.length > 0 || sig.domains.length > 0) {
        const entry = await lastEmailForCustomerCached(
          csmEmail,
          { key: targetLc, emails: sig.emails, domains: sig.domains },
          { forceFresh }
        );
        return NextResponse.json({
          date: entry.date,
          subject: entry.subject,
          from: entry.from,
          matched_email: entry.matched_email,
          source: "gmail",
          fetched_at: entry.fetched_at,
          cached: entry.cached,
        });
      }
    }
    const entry = await lastEmailWithCached(csmEmail, target, {
      forceFresh,
    });
    return NextResponse.json({
      date: entry.date,
      subject: entry.subject,
      from: entry.from,
      source: "gmail",
      fetched_at: entry.fetched_at,
      cached: entry.cached,
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
    console.error("[last-contact/gmail GET]", { csmEmail, target, msg });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  let body: BatchBody;
  try {
    body = (await req.json()) as BatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  // Normalize legacy `emails: string[]` shape into `targets` with no
  // csm_email override. Legacy callers keep routing through the
  // viewer's active-Gmail cookie exactly as before.
  const rawTargets: BatchTarget[] = Array.isArray(body.targets)
    ? body.targets
    : Array.isArray(body.emails)
      ? body.emails.map((e) => ({ email: e }))
      : [];
  if (rawTargets.length === 0) {
    return NextResponse.json(
      {
        error:
          "Body must include a non-empty `targets` array (or legacy `emails`)",
      },
      { status: 400 }
    );
  }
  // Soft cap so a runaway client (or a customer book with thousands
  // of unique owner emails) doesn't burn through Gmail quota in one
  // request. The customer book is small in practice; 500 is generous.
  const MAX_PER_BATCH = 500;
  const truncated = rawTargets.slice(0, MAX_PER_BATCH);

  // Bucket targets by which CSM token to use. Unspecified csm_email
  // falls through to the viewer's active cookie. Empty-string CSM
  // emails from the client (`csmEmail: ""` on some rows) treat as
  // unspecified so we never try to look up a token for "".
  const activeEmailForFallback = await getActiveEmail();
  const buckets = new Map<string, BatchTarget[]>();
  const missingTokenTargets: BatchTarget[] = [];
  for (const t of truncated) {
    const em = (t.email ?? "").trim().toLowerCase();
    if (!em) continue;
    const csm = (t.csm_email ?? "").trim().toLowerCase();
    const bucketKey = csm || activeEmailForFallback || "";
    if (!bucketKey) {
      // No CSM specified AND viewer has no active Gmail → we can't
      // resolve this row. Skip; caller falls back to HubSpot values.
      missingTokenTargets.push(t);
      continue;
    }
    const existing = buckets.get(bucketKey) ?? [];
    existing.push({ email: em, csm_email: csm || null });
    buckets.set(bucketKey, existing);
  }

  // If EVERY target routes to the viewer fallback and the viewer has
  // no active connection, surface the same 401 shape the old handler
  // returned so existing UI banners keep working. If at least one
  // target has an explicit csm_email, we let the request proceed and
  // just skip the viewer-scoped rows.
  const allNeedViewer = truncated.every(
    (t) => !((t.csm_email ?? "").trim())
  );
  if (allNeedViewer && !activeEmailForFallback) {
    return NextResponse.json(
      {
        error:
          "No Gmail account connected for this browser. Visit /settings/gmail.",
        no_active_gmail: true,
      },
      { status: 401 }
    );
  }

  try {
    console.log("[last-contact/gmail POST]", {
      viewer: session.user.email,
      requested: rawTargets.length,
      processed: truncated.length,
      buckets: buckets.size,
      viewer_fallback: activeEmailForFallback ?? null,
      force_fresh: Boolean(body.forceFresh),
    });
    const customers = await loadCustomers();
    const byOwner = new Map<string, (typeof customers)[number]>();
    for (const c of customers) {
      const e = c.owner_email?.trim().toLowerCase();
      if (e) byOwner.set(e, c);
    }

    // Fan out one lookup per CSM bucket in parallel. Each bucket
    // splits into per-customer targets (multi-contact match) and
    // legacy fall-throughs (bare email).
    const perBucketResults = await Promise.all(
      Array.from(buckets.entries()).map(async ([csmEmail, bucketTargets]) => {
        const customerSignals: CustomerSignals[] = [];
        const fallbackEmails: string[] = [];
        for (const t of bucketTargets) {
          const c = byOwner.get(t.email);
          if (!c) {
            fallbackEmails.push(t.email);
            continue;
          }
          const sig = customerEmailSignals(c);
          if (sig.emails.length === 0 && sig.domains.length === 0) {
            fallbackEmails.push(t.email);
            continue;
          }
          customerSignals.push({
            key: t.email,
            emails: sig.emails,
            domains: sig.domains,
          });
        }
        const merged: Record<
          string,
          {
            date: string | null;
            subject: string | null;
            from: string | null;
            matched_email?: string | null;
            fetched_at: string;
            cached: boolean;
          }
        > = {};
        try {
          if (customerSignals.length > 0) {
            const r = await lastEmailForCustomerBatch(
              csmEmail,
              customerSignals,
              { forceFresh: Boolean(body.forceFresh) }
            );
            Object.assign(merged, r);
          }
          if (fallbackEmails.length > 0) {
            const r = await lastEmailWithBatch(csmEmail, fallbackEmails, {
              forceFresh: Boolean(body.forceFresh),
            });
            Object.assign(merged, r);
          }
        } catch (e) {
          // A single CSM's token failing (revoked, missing scope,
          // expired refresh) shouldn't kill the whole batch —
          // other CSMs' rows still resolve. Bubble scope errors
          // up to the caller only when the viewer's OWN bucket
          // fails; other CSMs' scope issues are logged silently
          // (they don't have a fix path from the viewer's UI).
          if (
            e instanceof GmailReadScopeError &&
            csmEmail === activeEmailForFallback
          ) {
            throw e;
          }
          console.warn("[last-contact/gmail POST] bucket failed", {
            csmEmail,
            msg: e instanceof Error ? e.message : e,
          });
        }
        return merged;
      })
    );

    const results: Record<
      string,
      {
        date: string | null;
        subject: string | null;
        from: string | null;
        matched_email?: string | null;
        fetched_at: string;
        cached: boolean;
      }
    > = {};
    for (const r of perBucketResults) Object.assign(results, r);

    return NextResponse.json({
      results,
      count: Object.keys(results).length,
      truncated: rawTargets.length > truncated.length,
      skipped_no_token: missingTokenTargets.length,
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
    console.error("[last-contact/gmail POST]", {
      viewer: session.user.email,
      msg,
    });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
