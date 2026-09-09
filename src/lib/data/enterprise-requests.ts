import { kvGet, kvSet } from "../storage/kv";
import type {
  DigestSentBlob,
  EnterpriseRequestsBlob,
  ManualMap,
  NotifiedBlob,
  NotifiedEntry,
  OrphanedShipmentsBlob,
  OrphanedShipment,
  ShippedCursorBlob,
  SlackIntakeCursorBlob,
} from "./enterprise-requests-types";

/**
 * Enterprise Request Loop — server-side KV stores.
 *
 * Six separate KV rows, all keyed under `csm:enterprise-requests-*`.
 * Split rather than one mega-blob so a busy save on one (e.g. a
 * per-CSM notify) doesn't read-modify-write the multi-MB snapshot
 * every time. See [[hubspot-overlay]] for the "one row for the
 * whole book" pattern this generalizes.
 *
 * Storage keys:
 *   • `csm:enterprise-requests:v1`             — snapshot (nightly)
 *   • `csm:enterprise-requests-notified:v1`    — CSM-editable notify state
 *   • `csm:enterprise-requests-manual-map:v1`  — admin-approved matches
 *   • `csm:enterprise-requests-shipped-cursor:v1` — Slack sweep cursors
 *   • `csm:enterprise-requests-orphans:v1`     — shipped hits >14d old
 *   • `csm:enterprise-requests-dm-sent:v1`     — weekly digest dedupe
 *
 * No module caches — every read hits KV. Matches the mutable-store
 * convention (see [[customer-overrides]] ADR-0004).
 */

// ─── Snapshot (nightly Linear sync) ─────────────────────────────────

const SNAPSHOT_KEY = "csm:enterprise-requests:v1";

const EMPTY_SNAPSHOT: EnterpriseRequestsBlob = {
  rows: {},
  unmatched: [],
  fetched_at: new Date(0).toISOString(),
  last_run: null,
};

export async function loadEnterpriseRequestsSnapshot(): Promise<EnterpriseRequestsBlob> {
  return (
    (await kvGet<EnterpriseRequestsBlob>(SNAPSHOT_KEY)) ?? EMPTY_SNAPSHOT
  );
}

export async function saveEnterpriseRequestsSnapshot(
  blob: EnterpriseRequestsBlob
): Promise<void> {
  await kvSet<EnterpriseRequestsBlob>(SNAPSHOT_KEY, blob);
}

// ─── Notified overrides (CSM-editable per-row state) ────────────────

const NOTIFIED_KEY = "csm:enterprise-requests-notified:v1";

const EMPTY_NOTIFIED: NotifiedBlob = {
  rows: {},
  updated_at: new Date(0).toISOString(),
};

export async function loadNotifiedOverlay(): Promise<NotifiedBlob> {
  return (await kvGet<NotifiedBlob>(NOTIFIED_KEY)) ?? EMPTY_NOTIFIED;
}

async function saveNotifiedOverlay(blob: NotifiedBlob): Promise<void> {
  await kvSet<NotifiedBlob>(NOTIFIED_KEY, blob);
}

/** Idempotent read-modify-write for one (workspace, issue) row. Merges
 *  the patch onto whatever's stored — a fresh `drafted_at` doesn't
 *  clobber an existing `notified_at`. Concurrent writers to the same
 *  row can still stomp each other per the ADR-0004 warning; the row
 *  size is small enough (one issue's worth) that the window is
 *  narrow in practice. */
async function patchNotifiedEntry(
  workspaceId: string,
  linearIssueId: string,
  patch: Partial<NotifiedEntry>
): Promise<NotifiedEntry> {
  const blob = await loadNotifiedOverlay();
  const bucket = blob.rows[workspaceId] ?? {};
  const current = bucket[linearIssueId] ?? {};
  const merged: NotifiedEntry = { ...current, ...patch };
  const nextRows = {
    ...blob.rows,
    [workspaceId]: { ...bucket, [linearIssueId]: merged },
  };
  await saveNotifiedOverlay({
    rows: nextRows,
    updated_at: new Date().toISOString(),
  });
  return merged;
}

export async function markRequestDrafted(
  workspaceId: string,
  linearIssueId: string,
  by: string
): Promise<NotifiedEntry> {
  return patchNotifiedEntry(workspaceId, linearIssueId, {
    drafted_at: new Date().toISOString(),
    drafted_by: by.toLowerCase(),
  });
}

export async function markRequestNotified(
  workspaceId: string,
  linearIssueId: string,
  by: string
): Promise<NotifiedEntry> {
  return patchNotifiedEntry(workspaceId, linearIssueId, {
    notified_at: new Date().toISOString(),
    notified_by: by.toLowerCase(),
  });
}

export async function clearRequestNotified(
  workspaceId: string,
  linearIssueId: string
): Promise<void> {
  const blob = await loadNotifiedOverlay();
  const bucket = blob.rows[workspaceId];
  if (!bucket || !bucket[linearIssueId]) return;
  const { ...rest } = bucket;
  delete rest[linearIssueId];
  const nextRows = { ...blob.rows };
  if (Object.keys(rest).length === 0) {
    delete nextRows[workspaceId];
  } else {
    nextRows[workspaceId] = rest;
  }
  await saveNotifiedOverlay({
    rows: nextRows,
    updated_at: new Date().toISOString(),
  });
}

// ─── Manual mapping (admin-approved unmatched → workspace) ──────────

const MANUAL_MAP_KEY = "csm:enterprise-requests-manual-map:v1";

const EMPTY_MANUAL_MAP: ManualMap = {
  by_linear_customer_id: {},
  updated_at: new Date(0).toISOString(),
};

export async function loadManualMap(): Promise<ManualMap> {
  return (await kvGet<ManualMap>(MANUAL_MAP_KEY)) ?? EMPTY_MANUAL_MAP;
}

export async function saveManualMapping(
  linearCustomerId: string,
  workspaceIdOrSkipped: string
): Promise<ManualMap> {
  const map = await loadManualMap();
  const next: ManualMap = {
    by_linear_customer_id: {
      ...map.by_linear_customer_id,
      [linearCustomerId]: workspaceIdOrSkipped,
    },
    updated_at: new Date().toISOString(),
  };
  await kvSet<ManualMap>(MANUAL_MAP_KEY, next);
  return next;
}

export async function clearManualMapping(
  linearCustomerId: string
): Promise<void> {
  const map = await loadManualMap();
  if (!(linearCustomerId in map.by_linear_customer_id)) return;
  const { [linearCustomerId]: _dropped, ...rest } = map.by_linear_customer_id;
  await kvSet<ManualMap>(MANUAL_MAP_KEY, {
    by_linear_customer_id: rest,
    updated_at: new Date().toISOString(),
  });
}

// ─── Shipped-sweep cursor (per-channel) ─────────────────────────────

const SHIPPED_CURSOR_KEY = "csm:enterprise-requests-shipped-cursor:v1";

const EMPTY_SHIPPED_CURSOR: ShippedCursorBlob = {
  devs_shipped_ts: null,
  changelog_ts: null,
  updated_at: new Date(0).toISOString(),
};

export async function loadShippedCursor(): Promise<ShippedCursorBlob> {
  return (
    (await kvGet<ShippedCursorBlob>(SHIPPED_CURSOR_KEY)) ?? EMPTY_SHIPPED_CURSOR
  );
}

export async function saveShippedCursor(
  patch: Partial<Omit<ShippedCursorBlob, "updated_at">>
): Promise<ShippedCursorBlob> {
  const current = await loadShippedCursor();
  const next: ShippedCursorBlob = {
    ...current,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  await kvSet<ShippedCursorBlob>(SHIPPED_CURSOR_KEY, next);
  return next;
}

// ─── Slack intake cursor (#enterprise-bugs-and-feature-requests) ───

const SLACK_INTAKE_CURSOR_KEY = "csm:enterprise-requests-slack-intake-cursor:v1";

const EMPTY_SLACK_INTAKE_CURSOR: SlackIntakeCursorBlob = {
  intake_ts: null,
  updated_at: new Date(0).toISOString(),
};

export async function loadSlackIntakeCursor(): Promise<SlackIntakeCursorBlob> {
  return (
    (await kvGet<SlackIntakeCursorBlob>(SLACK_INTAKE_CURSOR_KEY)) ??
    EMPTY_SLACK_INTAKE_CURSOR
  );
}

export async function saveSlackIntakeCursor(
  intakeTs: string | null
): Promise<void> {
  await kvSet<SlackIntakeCursorBlob>(SLACK_INTAKE_CURSOR_KEY, {
    intake_ts: intakeTs,
    updated_at: new Date().toISOString(),
  });
}

// ─── Orphaned shipments (>14d old, unmatched) ───────────────────────

const ORPHANS_KEY = "csm:enterprise-requests-orphans:v1";

const EMPTY_ORPHANS: OrphanedShipmentsBlob = {
  orphans: {},
  updated_at: new Date(0).toISOString(),
};

export async function loadOrphans(): Promise<OrphanedShipmentsBlob> {
  return (await kvGet<OrphanedShipmentsBlob>(ORPHANS_KEY)) ?? EMPTY_ORPHANS;
}

export async function upsertOrphan(orphan: OrphanedShipment): Promise<void> {
  const blob = await loadOrphans();
  await kvSet<OrphanedShipmentsBlob>(ORPHANS_KEY, {
    orphans: { ...blob.orphans, [orphan.ship_permalink]: orphan },
    updated_at: new Date().toISOString(),
  });
}

export async function updateOrphanStatus(
  permalink: string,
  status: OrphanedShipment["status"],
  by: string
): Promise<void> {
  const blob = await loadOrphans();
  const current = blob.orphans[permalink];
  if (!current) return;
  await kvSet<OrphanedShipmentsBlob>(ORPHANS_KEY, {
    orphans: {
      ...blob.orphans,
      [permalink]: {
        ...current,
        status,
        dismissed_by: status === "pending" ? null : by.toLowerCase(),
        dismissed_at:
          status === "pending" ? null : new Date().toISOString(),
      },
    },
    updated_at: new Date().toISOString(),
  });
}

// ─── Digest-sent dedupe (weekly per-CSM Slack DM) ───────────────────

const DIGEST_SENT_KEY = "csm:enterprise-requests-dm-sent:v1";

const EMPTY_DIGEST_SENT: DigestSentBlob = {
  sent: {},
  updated_at: new Date(0).toISOString(),
};

export async function loadDigestSent(): Promise<DigestSentBlob> {
  return (await kvGet<DigestSentBlob>(DIGEST_SENT_KEY)) ?? EMPTY_DIGEST_SENT;
}

export async function recordDigestSent(
  entries: Array<{ csm_email: string; linear_issue_id: string }>
): Promise<void> {
  if (entries.length === 0) return;
  const blob = await loadDigestSent();
  const now = new Date().toISOString();
  const next: DigestSentBlob["sent"] = { ...blob.sent };
  for (const { csm_email, linear_issue_id } of entries) {
    const key = csm_email.toLowerCase();
    next[key] = { ...(next[key] ?? {}), [linear_issue_id]: now };
  }
  await kvSet<DigestSentBlob>(DIGEST_SENT_KEY, {
    sent: next,
    updated_at: now,
  });
}
