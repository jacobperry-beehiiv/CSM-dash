import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import {
  filterCustomers,
  findCsmHandleForViewer,
  loadCustomers,
} from "@/lib/data/load-customers";
import {
  loadCustomerLabels,
  saveCustomerLabels,
  setCustomerLabel,
  stampScanCompletion,
} from "@/lib/data/gmail-customer-labels";
import {
  buildInferenceContext,
  inferCustomerLabel,
  listGmailLabels,
  type GmailLabel,
} from "@/lib/integrations/gmail-labels";

export const dynamic = "force-dynamic";
export const maxDuration = 240;

/**
 * POST /api/csm/gmail-labels/scan
 *
 * Walks the viewer's customer book and infers a Gmail label per
 * customer from their thread history. Skips rows the CSM has
 * manually overridden or cleared. Persists the resulting mapping
 * to the per-CSM KV row.
 *
 * Body: optional `{ csm: string | null }`. Admins can pass `?csm=`
 * to scan another CSM's book, but the credentials still come from
 * the requester's Gmail — so the only useful use case is "scan my
 * own book" (the param is mostly here for parity with other
 * endpoints; in practice ignore it and use the viewer's book).
 *
 * Response shape:
 *   {
 *     ok, scanned, inferred, skipped_pinned, no_history,
 *     reasons: Array<{ workspace_id, reason }>,
 *     generated_at,
 *   }
 *
 * Auth: signed-in CSM with `gmail-draft-labels` flag enabled.
 */

const PER_CUSTOMER_CONCURRENCY = 4;

interface PostBody {
  /** Reserved — see note above. Currently ignored. */
  csm?: string | null;
}

export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!(await isFeatureEnabledFor("gmail-draft-labels", email))) {
    return NextResponse.json(
      { error: "Feature not available for this account" },
      { status: 403 }
    );
  }

  let body: PostBody | null = null;
  try {
    body = req.headers.get("content-type")?.includes("application/json")
      ? ((await req.json()) as PostBody)
      : null;
  } catch {
    body = null;
  }
  void body; // currently unused — see endpoint note above.

  const all = await loadCustomers();
  const csmHandle = findCsmHandleForViewer(all, email);
  const book = filterCustomers(all, { csm: csmHandle });
  // We only have meaningful inference signals for customers with a
  // workspace_id and at least one resolvable contact email/domain.
  const candidates = book.filter(
    (c): c is typeof c & { workspace_id: string } =>
      Boolean(c.workspace_id) && (Boolean(c.owner_email) || (c.hubspot_contacts?.length ?? 0) > 0)
  );

  // Pre-fetch the Gmail label list once — every inference run needs
  // it to translate labelId → human name. Soft-fail (empty) bubbles
  // up as "no inference possible" downstream.
  let labels: GmailLabel[];
  try {
    labels = await listGmailLabels(email);
  } catch (e) {
    return NextResponse.json(
      {
        error: `Couldn't list Gmail labels: ${
          e instanceof Error ? e.message : "unknown"
        }`,
        needs_reconsent: true,
      },
      { status: 502 }
    );
  }
  const labelsById = new Map(labels.map((l) => [l.id, l]));

  // One global "broad-label" frequency pass, reused for every
  // customer inference call.
  const ctx = await buildInferenceContext(email);

  const blob = await loadCustomerLabels();

  const reasons: Array<{ workspace_id: string; reason: string }> = [];
  let inferred = 0;
  let skipped_pinned = 0;
  let no_history = 0;

  // Bound a non-null local so the worker closure doesn't lose the
  // null-narrowing from the early-return guard above.
  const viewerEmail: string = email;
  // Bounded concurrency: don't burn Gmail quota on a 150-customer scan.
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < candidates.length) {
      const my = cursor++;
      const c = candidates[my];
      const existing = blob.per_csm[viewerEmail.toLowerCase()]?.rows?.[c.workspace_id];
      if (existing && (existing.source === "manual" || existing.source === "cleared")) {
        skipped_pinned++;
        continue;
      }
      const result = await inferCustomerLabel(viewerEmail, c, ctx, labelsById);
      if (result.inferred) {
        setCustomerLabel(blob, viewerEmail, c.workspace_id, {
          label_id: result.inferred.label_id,
          label_name: result.inferred.label_name,
          source: "inferred",
          inferred_at: new Date().toISOString(),
        });
        inferred++;
      } else {
        no_history++;
        if (result.reason) {
          reasons.push({
            workspace_id: c.workspace_id,
            reason: result.reason,
          });
        }
      }
    }
  }
  await Promise.all(
    Array.from({ length: PER_CUSTOMER_CONCURRENCY }, () => worker())
  );

  stampScanCompletion(blob, email);
  await saveCustomerLabels(blob);

  return NextResponse.json({
    ok: true,
    scanned: candidates.length,
    inferred,
    skipped_pinned,
    no_history,
    // Cap the reasons array so the response stays small on big books.
    reasons: reasons.slice(0, 50),
    generated_at: new Date().toISOString(),
  });
}
