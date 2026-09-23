import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { loadCustomers } from "@/lib/data/load-customers";
import { customerEmailSignals } from "@/lib/data/customer-domains";
import { GmailReadScopeError } from "@/lib/integrations/gmail-read";
import type { CustomerSignals } from "@/lib/integrations/gmail-read";
import {
  responsivenessBatch,
  type ResponsivenessBatchEntry,
} from "@/lib/integrations/gmail-responsiveness";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/last-contact/responsiveness
 *
 * "Responsive to outreach" for a set of customers — the Risk Level
 * Definitions criterion that a last-contact timestamp can't answer.
 * Returns the unanswered-outbound streak per customer.
 *
 * Body: `{ workspace_ids: string[], force?: boolean }`
 *
 * Each customer is measured against their OWN assigned CSM's Gmail
 * token, not the viewer's — responsiveness to the person who actually
 * owns the relationship is the thing the risk doc means, and scoping
 * it to the viewer would make the same account read differently
 * depending on who opened the page. Same rule PR #251 established for
 * the at-risk staleness flag.
 *
 * Customers are therefore bucketed by assigned CSM and run one bucket
 * at a time. A CSM with no connected Gmail is reported in
 * `skipped_no_token` rather than failing the request — a half-
 * connected team should still get answers for the half that works.
 *
 * Session-auth; no admin gate (the data is already visible per-row on
 * the customer surfaces this feeds).
 */

interface Body {
  workspace_ids?: unknown;
  force?: unknown;
}

export async function POST(req: Request): Promise<NextResponse> {
  const session = await auth();
  const viewerEmail = session?.user?.email ?? null;
  if (!viewerEmail) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const workspaceIds = Array.isArray(body.workspace_ids)
    ? body.workspace_ids.filter((w): w is string => typeof w === "string")
    : [];
  if (workspaceIds.length === 0) {
    return NextResponse.json(
      { error: "workspace_ids (non-empty array) required" },
      { status: 400 }
    );
  }
  const force = body.force === true;

  const customers = await loadCustomers();
  const wanted = new Set(workspaceIds);

  // Bucket by assigned CSM so each bucket runs against that CSM's own
  // token. Customers with no assigned CSM can't be measured — there's
  // no mailbox that would hold the conversation.
  const byCsm = new Map<string, CustomerSignals[]>();
  const skippedNoCsm: string[] = [];
  for (const c of customers) {
    if (!c.workspace_id || !wanted.has(c.workspace_id)) continue;
    const csmEmail = (c.customer_success_manager_email ?? "")
      .trim()
      .toLowerCase();
    if (!csmEmail) {
      skippedNoCsm.push(c.workspace_id);
      continue;
    }
    const signals = customerEmailSignals(c);
    if (signals.emails.length === 0 && signals.domains.length === 0) {
      skippedNoCsm.push(c.workspace_id);
      continue;
    }
    // Key the cache row on workspace_id rather than owner_email so the
    // response comes back keyed the same way the caller asked.
    const bucket = byCsm.get(csmEmail) ?? [];
    bucket.push({
      key: c.workspace_id,
      emails: signals.emails,
      domains: signals.domains,
    });
    byCsm.set(csmEmail, bucket);
  }

  const results: Record<string, ResponsivenessBatchEntry> = {};
  const errors: Array<{ workspace_id: string; error: string }> = [];
  const skippedNoToken: string[] = [];

  for (const [csmEmail, rows] of byCsm) {
    try {
      const { results: batch, errors: batchErrors } = await responsivenessBatch(
        csmEmail,
        rows,
        { forceFresh: force }
      );
      Object.assign(results, batch);
      for (const e of batchErrors) {
        errors.push({ workspace_id: e.key, error: e.error });
      }
    } catch (e) {
      // A scope error or missing token is a property of the CSM, not
      // of any one customer — report it once per CSM and move on so
      // the rest of the team's rows still resolve.
      if (
        e instanceof GmailReadScopeError ||
        (e instanceof Error && /No valid Gmail token/.test(e.message))
      ) {
        skippedNoToken.push(csmEmail);
        continue;
      }
      errors.push({
        workspace_id: `(csm:${csmEmail})`,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    results,
    resolved: Object.keys(results).length,
    skipped_no_csm: skippedNoCsm,
    skipped_no_token: skippedNoToken,
    errors: errors.slice(0, 20),
    ran_at: new Date().toISOString(),
  });
}
