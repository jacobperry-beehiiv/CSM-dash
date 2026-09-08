import { loadCustomers } from "../data/load-customers";
import { loadSettings } from "../data/settings";
import { resolveSlackNotificationPref } from "../data/settings-types";
import { postSlackMessage, resolveSlackChannelId } from "../integrations/slack";
import {
  loadDigestSent,
  loadEnterpriseRequestsSnapshot,
  loadNotifiedOverlay,
  recordDigestSent,
} from "../data/enterprise-requests";
import type {
  EnterpriseRequestRow,
  NotifiedEntry,
} from "../data/enterprise-requests-types";

/**
 * Enterprise Request Loop — weekly per-CSM DM digest.
 *
 * Walks the snapshot for rows that:
 *   1. `promoted_at` fell in the last 7 days, AND
 *   2. `notified_at` on the notify overlay is UNSET, AND
 *   3. haven't been DM'd about before (`dm-sent` dedupe blob).
 *
 * Groups by the customer's assigned CSM, opens a DM to each CSM via
 * `csm_user_ids[csm_handle]` → `resolveSlackChannelId`, and posts one
 * message per CSM listing every shipped-this-week request from their
 * book with a deep-link into `/csm?tab=live-this-week&csm=<handle>`
 * so they can draft the outreach.
 *
 * Dry-run mode returns the composed message + row set without
 * posting. Used by the manual "preview" query on the digest endpoint
 * and by local smoke tests.
 *
 * `no_op` reasons the engine short-circuits: the settings pref for
 * `enterprise_requests_digest` is disabled; a cron trigger with
 * cron_enabled off; nothing shipped this week for any CSM.
 */

export interface DigestRowSummary {
  workspace_id: string;
  workspace_name: string | null;
  linear_issue_id: string;
  linear_identifier: string;
  title: string;
  url: string;
  ship_url: string | null;
  promoted_at: string;
  beta: boolean;
}

export interface DigestPerCsm {
  csm_handle: string;
  csm_email: string | null;
  csm_user_id: string | null;
  rows: DigestRowSummary[];
  message: string;
  posted: boolean;
  error?: string;
}

export interface DigestResult {
  generated_at: string;
  per_csm: DigestPerCsm[];
  csms_notified: number;
  rows_notified: number;
  no_op: null | "disabled" | "cron_disabled" | "no_rows";
  dry_run: boolean;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DASHBOARD_URL_BASE =
  process.env.DASHBOARD_URL ?? "https://csm-dash.vercel.app";

function humanCsm(csmHandle: string): string {
  return csmHandle.replace(/_/g, " ");
}

function composeMessage(
  per: DigestPerCsm,
  rows: DigestRowSummary[]
): string {
  const header = `:package: *Enterprise Request Loop — shipped this week*\nHi ${humanCsm(per.csm_handle).split(" ")[0]}, ${rows.length} feature request${rows.length === 1 ? "" : "s"} from your book shipped in the last 7 days. Draft outreach so we close the loop with the customer.`;
  const bullets = rows.slice(0, 10).map((r) => {
    const linkedTitle = `<${r.url}|${r.linear_identifier}: ${r.title}>`;
    const beta = r.beta ? " _(possibly in beta)_" : "";
    const shipLink = r.ship_url ? ` — <${r.ship_url}|ship link>` : "";
    const account = r.workspace_name ? `*${r.workspace_name}*` : "(unknown)";
    return `• ${account}: ${linkedTitle}${beta}${shipLink}`;
  });
  const cta = `\n_→ <${DASHBOARD_URL_BASE}/csm?tab=live-this-week&csm=${encodeURIComponent(
    per.csm_handle
  )}|Open the Live This Week queue on the dashboard>_`;
  const overflow =
    rows.length > 10 ? `\n_…and ${rows.length - 10} more._` : "";
  return `${header}\n\n${bullets.join("\n")}${overflow}${cta}`;
}

export async function runEnterpriseRequestsDigest(
  opts: {
    dryRun?: boolean;
    triggeredBy?: "cron" | "manual";
    /** Limit to one CSM handle. Used by the manual "preview" button. */
    csmHandle?: string;
  } = {}
): Promise<DigestResult> {
  const dryRun = Boolean(opts.dryRun);
  const generated_at = new Date().toISOString();

  const [customers, snapshot, notified, sent, settings] = await Promise.all([
    loadCustomers(),
    loadEnterpriseRequestsSnapshot(),
    loadNotifiedOverlay(),
    loadDigestSent(),
    loadSettings(),
  ]);

  const pref = resolveSlackNotificationPref(
    settings,
    "enterprise_requests_digest"
  );
  const isCron = opts.triggeredBy === "cron";
  if (!pref.enabled) {
    return {
      generated_at,
      per_csm: [],
      csms_notified: 0,
      rows_notified: 0,
      no_op: "disabled",
      dry_run: dryRun,
    };
  }
  if (isCron && pref.cron_enabled === false) {
    return {
      generated_at,
      per_csm: [],
      csms_notified: 0,
      rows_notified: 0,
      no_op: "cron_disabled",
      dry_run: dryRun,
    };
  }

  // Map workspace_id → CSM handle + email + workspace_name for the
  // grouping pass. A workspace with no CSM assignment is skipped
  // silently — nothing to DM.
  interface WsMeta {
    csm_handle: string;
    csm_email: string | null;
    workspace_name: string | null;
  }
  const wsMeta = new Map<string, WsMeta>();
  for (const c of customers) {
    if (!c.workspace_id || !c.customer_success_manager) continue;
    wsMeta.set(c.workspace_id, {
      csm_handle: c.customer_success_manager,
      csm_email: c.customer_success_manager_email ?? null,
      workspace_name: c.workspace_name ?? null,
    });
  }

  const cutoff = Date.now() - SEVEN_DAYS_MS;
  // Group by CSM handle.
  const byCsm = new Map<string, DigestRowSummary[]>();
  for (const [workspaceId, bucket] of Object.entries(snapshot.rows)) {
    const meta = wsMeta.get(workspaceId);
    if (!meta) continue;
    if (opts.csmHandle && meta.csm_handle !== opts.csmHandle) continue;
    const notifiedBucket = notified.rows[workspaceId] ?? {};
    const sentBucket =
      sent.sent[(meta.csm_email ?? meta.csm_handle).toLowerCase()] ?? {};
    for (const row of Object.values(bucket) as EnterpriseRequestRow[]) {
      if (!row.promoted_at) continue;
      const promotedAt = Date.parse(row.promoted_at);
      if (!Number.isFinite(promotedAt) || promotedAt < cutoff) continue;
      const entry: NotifiedEntry = notifiedBucket[row.linear_issue_id] ?? {};
      if (entry.notified_at) continue;
      if (sentBucket[row.linear_issue_id]) continue; // Already DM'd.
      const arr: DigestRowSummary = {
        workspace_id: workspaceId,
        workspace_name: meta.workspace_name,
        linear_issue_id: row.linear_issue_id,
        linear_identifier: row.linear_identifier,
        title: row.title,
        url: row.url,
        ship_url: row.ship_url,
        promoted_at: row.promoted_at,
        beta: row.derived_state === "Live, possibly in beta",
      };
      const list = byCsm.get(meta.csm_handle) ?? [];
      list.push(arr);
      byCsm.set(meta.csm_handle, list);
    }
  }

  if (byCsm.size === 0) {
    return {
      generated_at,
      per_csm: [],
      csms_notified: 0,
      rows_notified: 0,
      no_op: "no_rows",
      dry_run: dryRun,
    };
  }

  const csmUserIds = settings.slack.csm_user_ids ?? {};
  const perCsm: DigestPerCsm[] = [];
  const successEntries: Array<{ csm_email: string; linear_issue_id: string }> =
    [];
  let csmsNotified = 0;
  let rowsNotified = 0;

  for (const [csmHandle, rowsForCsm] of byCsm) {
    rowsForCsm.sort((a, b) => b.promoted_at.localeCompare(a.promoted_at));
    const csmEmail =
      customers.find(
        (c) =>
          c.customer_success_manager === csmHandle &&
          c.customer_success_manager_email
      )?.customer_success_manager_email ?? null;
    const userId = csmUserIds[csmHandle] ?? null;
    const per: DigestPerCsm = {
      csm_handle: csmHandle,
      csm_email: csmEmail,
      csm_user_id: userId,
      rows: rowsForCsm,
      message: "",
      posted: false,
    };
    per.message = composeMessage(per, rowsForCsm);
    if (!dryRun) {
      if (!userId) {
        per.error = `No Slack user ID mapped for ${csmHandle} in settings.slack.csm_user_ids — cannot DM.`;
      } else {
        try {
          const channelId = await resolveSlackChannelId(userId);
          if (!channelId) {
            per.error = `Failed to open DM channel for ${userId}.`;
          } else {
            await postSlackMessage({
              channel: channelId,
              text: per.message,
            });
            per.posted = true;
            csmsNotified++;
            rowsNotified += rowsForCsm.length;
            const dedupeKey = (csmEmail ?? csmHandle).toLowerCase();
            for (const r of rowsForCsm) {
              successEntries.push({
                csm_email: dedupeKey,
                linear_issue_id: r.linear_issue_id,
              });
            }
          }
        } catch (e) {
          per.error = e instanceof Error ? e.message : "unknown Slack failure";
        }
      }
    }
    perCsm.push(per);
  }

  if (!dryRun && successEntries.length > 0) {
    await recordDigestSent(successEntries);
  }

  return {
    generated_at,
    per_csm: perCsm.sort((a, b) =>
      a.csm_handle.localeCompare(b.csm_handle)
    ),
    csms_notified: csmsNotified,
    rows_notified: rowsNotified,
    no_op: null,
    dry_run: dryRun,
  };
}
