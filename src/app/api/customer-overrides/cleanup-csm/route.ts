import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { invalidateCustomerCache } from "@/lib/data/load-customers";
import { kvGet, kvSet } from "@/lib/storage/kv";
import type { CustomerOverride } from "@/lib/data/customer-overrides";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/customer-overrides/cleanup-csm
 *
 * One-shot cleanup: walks the entire customer-overrides KV and removes
 * the CSM-related fields from every entry, letting the snapshot's
 * (correct) `customer_success_manager` value flow through to the
 * dashboard untouched.
 *
 * Background: the previous /refresh-csm + /refresh-all-csms paths
 * read HubSpot's standard `hubspot_owner_id` (Owner field) and wrote
 * that as the dashboard's `customer_success_manager`. For Enterprise
 * accounts the Owner is often the AE/Sales person, not the actual CSM
 * — so the customer-overrides KV accumulated stale entries that
 * pinned accounts under the wrong CSM. The endpoints have since been
 * rewired to read the `customer_success_manager` custom property
 * instead; this endpoint cleans up the residue from the old behavior.
 *
 * Body: `{ dry_run?: boolean }`
 *   - dry_run = true  →  return the diff without writing.
 *   - dry_run = false →  write the cleaned map back to KV.
 *
 * Auth: signed-in viewer.
 */

const KEY = "customer-overrides";

type OverrideMap = Record<string, CustomerOverride>;

interface PostBody {
  dry_run?: boolean;
}

interface ClearedEntry {
  workspace_id: string;
  removed: {
    customer_success_manager?: string;
    customer_success_manager_email?: string;
    csm_refreshed_at?: string;
    csm_refreshed_by?: string;
  };
  /** True when the entry had ONLY CSM fields and the entire override
   *  was deleted as a result. */
  entry_removed: boolean;
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  let body: PostBody;
  try {
    body = (await req.json().catch(() => ({}))) as PostBody;
  } catch {
    body = {};
  }
  const dryRun = body.dry_run === true;

  const current = (await kvGet<OverrideMap>(KEY)) ?? {};
  const next: OverrideMap = {};
  const cleared: ClearedEntry[] = [];

  for (const [workspaceId, ov] of Object.entries(current)) {
    const removed: ClearedEntry["removed"] = {};
    let hasCsmField = false;
    if (ov.customer_success_manager !== undefined) {
      removed.customer_success_manager = ov.customer_success_manager;
      hasCsmField = true;
    }
    if (ov.customer_success_manager_email !== undefined) {
      removed.customer_success_manager_email = ov.customer_success_manager_email;
      hasCsmField = true;
    }
    if (ov.csm_refreshed_at !== undefined) {
      removed.csm_refreshed_at = ov.csm_refreshed_at;
      hasCsmField = true;
    }
    if (ov.csm_refreshed_by !== undefined) {
      removed.csm_refreshed_by = ov.csm_refreshed_by;
      hasCsmField = true;
    }

    if (!hasCsmField) {
      // Nothing to clean — pass through untouched.
      next[workspaceId] = ov;
      continue;
    }

    // Build the cleaned entry by omitting the CSM fields.
    const cleanedEntry: CustomerOverride = { ...ov };
    delete cleanedEntry.customer_success_manager;
    delete cleanedEntry.customer_success_manager_email;
    delete cleanedEntry.csm_refreshed_at;
    delete cleanedEntry.csm_refreshed_by;

    const entryRemoved = Object.keys(cleanedEntry).length === 0;
    if (!entryRemoved) {
      next[workspaceId] = cleanedEntry;
    }
    cleared.push({ workspace_id: workspaceId, removed, entry_removed: entryRemoved });
  }

  if (!dryRun && cleared.length > 0) {
    await kvSet(KEY, next);
    invalidateCustomerCache();
  }

  return NextResponse.json({
    dry_run: dryRun,
    total_overrides_before: Object.keys(current).length,
    total_overrides_after: Object.keys(next).length,
    cleared_count: cleared.length,
    // Cap the response sample so a portal with hundreds of overrides
    // doesn't blow past Vercel's response-size limit. The full list
    // is in the server logs.
    cleared_sample: cleared.slice(0, 200),
    note:
      "After cleanup, the dashboard sources customer_success_manager directly from the snapshot (which derives from HubSpot's customer_success_manager custom property). Per-row 'Refresh CSM' will write fresh overrides if you need to override on a one-off basis.",
  });
}
