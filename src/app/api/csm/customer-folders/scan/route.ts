import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { getActiveEmail } from "@/lib/data/active-user";
import { loadCustomers } from "@/lib/data/load-customers";
import { listChildFolders } from "@/lib/integrations/google-drive";
import { matchFolderToCustomers } from "@/lib/data/folder-match";
import {
  loadSweepState,
  saveSweepState,
} from "@/lib/data/customer-folders-sweep-state";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

/**
 * POST /api/csm/customer-folders/scan
 *
 * Lists every child folder of the shared "Customer Folders" Drive
 * parent, scores each against the customer book with the fuzzy
 * matcher, and populates the review queue in KV.
 *
 * Skips folders that would map to a customer whose `customer_folder`
 * property is ALREADY set — sweep only backfills BLANK fields, per
 * the design decision to never overwrite a CSM's intentional choice.
 *
 * Auth: signed-in viewer + `customer-folders-sweep` feature flag +
 * connected Gmail account (needed for the Drive token). Uses the
 * ACTIVE browser's Gmail account (getActiveEmail) rather than the
 * viewer session, so the sweep uses whatever Google identity the
 * admin has connected — same convention as the @bot assign flow.
 *
 * Response: { ok, ran_at, folders_scanned, folders_new,
 *   folders_auto_matched, folders_needs_review, folders_no_candidate,
 *   folders_skipped_already_set, truncated, queue_size }
 */

const DRIVE_PARENT_FOLDER_ID =
  process.env.DRIVE_ASSIGN_PARENT_FOLDER_ID ??
  "1_8XXke1lzPqnw_qC0uzGp5hdDMbxJAHc";

export async function POST() {
  const session = await auth();
  const viewerEmail = session?.user?.email ?? null;
  if (!viewerEmail) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!(await isFeatureEnabledFor("customer-folders-sweep", viewerEmail))) {
    return NextResponse.json(
      { error: "Feature not available for this account" },
      { status: 403 }
    );
  }
  const activeEmail = await getActiveEmail();
  if (!activeEmail) {
    return NextResponse.json(
      {
        error:
          "No Gmail account connected for this browser. Visit /settings/gmail — the sweep needs your Drive token.",
      },
      { status: 401 }
    );
  }

  const ran_at = new Date().toISOString();

  let listing;
  try {
    listing = await listChildFolders(activeEmail, DRIVE_PARENT_FOLDER_ID);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    console.error("[customer-folders/scan] Drive list failed", {
      activeEmail,
      msg,
    });
    return NextResponse.json(
      {
        error: msg,
        needs_reconsent: /drive\.readonly/i.test(msg),
      },
      { status: 502 }
    );
  }
  const { folders, truncated } = listing;

  const customers = await loadCustomers();
  // Index customers with an already-set folder URL by workspace_id so
  // we can skip pre-filled rows. Also index by the folder URL itself
  // so the sweep can recognize a folder that's already the linked one.
  const filledWorkspaceIds = new Set<string>();
  const urlToWorkspaceId = new Map<string, string>();
  for (const c of customers) {
    if (!c.workspace_id) continue;
    if (
      typeof c.property_customer_folder === "string" &&
      c.property_customer_folder.trim().length > 0
    ) {
      filledWorkspaceIds.add(c.workspace_id);
      urlToWorkspaceId.set(
        c.property_customer_folder.trim(),
        c.workspace_id
      );
    }
  }

  const state = await loadSweepState();
  let folders_new = 0;
  let folders_auto_matched = 0;
  let folders_needs_review = 0;
  let folders_no_candidate = 0;
  let folders_skipped_already_set = 0;

  for (const folder of folders) {
    // If this exact URL is already linked to a customer somewhere in
    // the book, the sweep has nothing new to do here — record the
    // match at "applied" state so the row displays as resolved.
    const alreadyLinkedWorkspace = urlToWorkspaceId.get(folder.webViewLink);
    if (alreadyLinkedWorkspace) {
      folders_skipped_already_set++;
      const existing = state.queue[folder.id];
      state.queue[folder.id] = {
        folder_id: folder.id,
        folder_name: folder.name,
        folder_url: folder.webViewLink,
        candidates: [],
        selection: { kind: "approved", workspace_id: alreadyLinkedWorkspace },
        first_seen_at: existing?.first_seen_at ?? ran_at,
        applied_at: existing?.applied_at ?? ran_at,
        applied_workspace_id: alreadyLinkedWorkspace,
      };
      continue;
    }

    // Score against every workspace, then drop matches whose target
    // workspace already has customer_folder set (design decision:
    // sweep never overwrites; leave those alone).
    const candidates = matchFolderToCustomers(folder.name, customers).filter(
      (m) => !filledWorkspaceIds.has(m.workspace_id)
    );

    const existing = state.queue[folder.id];
    // Sticky selections carry through re-scans: if the CSM already
    // skipped or approved this folder, don't reset.
    const selection =
      existing?.selection && existing.selection.kind !== "pending"
        ? existing.selection
        : ({ kind: "pending" } as const);

    if (!existing) folders_new++;
    if (candidates.length === 0) folders_no_candidate++;
    else if (candidates[0].confidence === "high" && candidates.length === 1)
      folders_auto_matched++;
    else folders_needs_review++;

    state.queue[folder.id] = {
      folder_id: folder.id,
      folder_name: folder.name,
      folder_url: folder.webViewLink,
      candidates,
      selection: existing?.selection?.kind === "skipped"
        ? existing.selection
        : existing?.selection?.kind === "approved"
          ? existing.selection
          // Auto-approve slam-dunk high-confidence single matches so
          // the CSM only has to click "Apply" — no per-row approval.
          : candidates.length === 1 && candidates[0].confidence === "high"
            ? { kind: "approved", workspace_id: candidates[0].workspace_id }
            : selection,
      first_seen_at: existing?.first_seen_at ?? ran_at,
      applied_at: existing?.applied_at,
      applied_workspace_id: existing?.applied_workspace_id,
    };
  }

  state.last_scan_at = ran_at;
  state.last_scan_summary = {
    ran_at,
    folders_scanned: folders.length,
    folders_new,
    folders_auto_matched,
    folders_needs_review,
    folders_no_candidate,
    folders_skipped_already_set,
    truncated,
  };
  await saveSweepState(state);

  return NextResponse.json({
    ok: true,
    ran_at,
    folders_scanned: folders.length,
    folders_new,
    folders_auto_matched,
    folders_needs_review,
    folders_no_candidate,
    folders_skipped_already_set,
    truncated,
    queue_size: Object.keys(state.queue).length,
  });
}

/** GET returns the current review queue for the settings page. */
export async function GET() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!(await isFeatureEnabledFor("customer-folders-sweep", email))) {
    return NextResponse.json(
      { error: "Feature not available for this account" },
      { status: 403 }
    );
  }
  const state = await loadSweepState();
  // Sort: needs-review first (pending + candidates), then approved-
  // unapplied, then applied, then skipped. Within each bucket by
  // folder name for stable UI.
  const rows = Object.values(state.queue);
  const priority = (r: (typeof rows)[number]): number => {
    if (r.selection.kind === "skipped") return 4;
    if (r.applied_at) return 3;
    if (r.selection.kind === "approved") return 2;
    if (r.candidates.length > 0) return 1;
    return 0;
  };
  rows.sort((a, b) => {
    const pa = priority(a);
    const pb = priority(b);
    if (pa !== pb) return pa - pb;
    return a.folder_name.localeCompare(b.folder_name);
  });
  return NextResponse.json({
    last_scan_at: state.last_scan_at ?? null,
    last_scan_summary: state.last_scan_summary ?? null,
    queue: rows,
  });
}
