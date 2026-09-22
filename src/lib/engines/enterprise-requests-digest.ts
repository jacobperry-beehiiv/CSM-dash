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
import { resolveConfidence } from "../data/enterprise-requests-types";
import { applyTodoOps, getTodosForUser } from "../personal-todos/store";
import { userKeyFromEmail } from "../personal-todos/identity";
import { newTodoId, type PersonalTodo } from "../personal-todos/types";
import {
  getConfigForSource,
  applyTemplate,
} from "../data/todo-source-configs";
import { resolveTodoTiming } from "../data/todo-source-configs-types";

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
 * book with a deep-link into `/csm?tab=live-requests&csm=<handle>`
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
  /** Rows inside the 7-day window that were withheld because their
   *  promotion is `needs_review`. Surfaced so a dry run tells you how
   *  much is waiting in the exceptions queue rather than silently
   *  reporting a quiet week. */
  rows_skipped_needs_review: number;
  /** Total un-decided `needs_review` rows across the whole snapshot,
   *  not just this week's. Drives the ops-channel nudge. */
  review_queue_depth: number;
  review_queue_posted: boolean;
  /** Personal to-dos created across all CSMs this run. Lower than
   *  rows_notified when a CSM already had an open to-do for the same
   *  (customer, issue) from a previous run. */
  todos_created: number;
  no_op: null | "disabled" | "cron_disabled" | "no_rows";
  dry_run: boolean;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DASHBOARD_URL_BASE =
  process.env.DASHBOARD_URL ?? "https://csm-dash.vercel.app";

/** Shift a YYYY-MM-DD string by whole days. Calendar-day math rather
 *  than raw ms so a DST boundary can't slide a due date. */
function shiftYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map((n) => Number.parseInt(n, 10));
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

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
  const cta = `\n_→ <${DASHBOARD_URL_BASE}/csm?tab=live-requests&csm=${encodeURIComponent(
    per.csm_handle
  )}|Open your Live requests queue on the dashboard>_`;
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
      rows_skipped_needs_review: 0,
      review_queue_depth: 0,
      review_queue_posted: false,
      todos_created: 0,
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
      rows_skipped_needs_review: 0,
      review_queue_depth: 0,
      review_queue_posted: false,
      todos_created: 0,
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
  // Rows in-window but withheld by the confidence gate. Reported on
  // the result so a dry run distinguishes "quiet week" from "three
  // things are sitting in the exceptions queue".
  let skippedNeedsReview = 0;
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
      // Confidence gate. Only unambiguous ships reach a CSM's DMs:
      // an exact changelog link, or a #devs-shipped hit on a Bug /
      // UI-UX ticket. Features seen only in #devs-shipped, fuzzy
      // changelog matches, and tickets whose work type we couldn't
      // resolve all sit in the exceptions queue until a human
      // confirms them — a late notification is recoverable, a CSM
      // telling a customer "your request shipped" about something
      // still behind a flag is not.
      if (resolveConfidence(row) !== "confirmed") {
        skippedNeedsReview += 1;
        continue;
      }
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

  // ── Review-queue nudge to one ops channel.
  //
  // Deliberately NOT per-CSM: these are ships we deliberately withheld
  // from CSMs, so pushing them at CSMs would defeat the gate. One
  // person clears the queue; confirming a row there makes it eligible
  // for next week's digest, which is what actually notifies.
  //
  // Counted across the whole snapshot rather than the 7-day window —
  // the queue's problem is rows accumulating unreviewed, and a stale
  // row is exactly the one worth nagging about.
  let reviewQueueDepth = 0;
  let oldestPendingAt: string | null = null;
  for (const bucket of Object.values(snapshot.rows)) {
    for (const row of Object.values(bucket) as EnterpriseRequestRow[]) {
      if (!row.promoted_at) continue;
      if (resolveConfidence(row) === "confirmed") continue;
      if (row.review?.decision === "dismissed") continue;
      reviewQueueDepth += 1;
      if (!oldestPendingAt || row.promoted_at < oldestPendingAt) {
        oldestPendingAt = row.promoted_at;
      }
    }
  }
  const reviewPref = resolveSlackNotificationPref(
    settings,
    "enterprise_requests_review_queue"
  );
  let reviewQueuePosted = false;
  if (
    reviewQueueDepth > 0 &&
    reviewPref.enabled &&
    !(isCron && reviewPref.cron_enabled === false) &&
    reviewPref.destination &&
    !dryRun
  ) {
    const oldestAge = oldestPendingAt
      ? Math.floor(
          (Date.now() - Date.parse(oldestPendingAt)) / (24 * 60 * 60 * 1000)
        )
      : null;
    const text =
      `:mag: *Enterprise Request Loop — ${reviewQueueDepth} shipped signal${reviewQueueDepth === 1 ? "" : "s"} waiting on review*\n` +
      `${reviewQueueDepth === 1 ? "This ship" : "These ships"} matched a customer request but couldn't be confidently called customer-visible, so no CSM has been notified.` +
      (oldestAge !== null && oldestAge > 0
        ? ` Oldest has been waiting ${oldestAge} day${oldestAge === 1 ? "" : "s"}.`
        : "") +
      `\n_→ <${DASHBOARD_URL_BASE}/settings/enterprise-requests/exceptions|Review the queue>_`;
    try {
      const channelId = await resolveSlackChannelId(reviewPref.destination);
      if (channelId) {
        await postSlackMessage({ channel: channelId, text });
        reviewQueuePosted = true;
      }
    } catch (e) {
      console.warn("[enterprise-requests-digest] review-queue ping failed", {
        error: e instanceof Error ? e.message : e,
      });
    }
  }

  if (byCsm.size === 0) {
    return {
      generated_at,
      per_csm: [],
      csms_notified: 0,
      rows_notified: 0,
      rows_skipped_needs_review: skippedNeedsReview,
      review_queue_depth: reviewQueueDepth,
      review_queue_posted: reviewQueuePosted,
      todos_created: 0,
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
  let todosCreated = 0;
  // Hoisted once — every CSM's to-dos render off the same config, and
  // getConfigForSource hits KV.
  const todoCfg = await getConfigForSource("enterprise_request_shipped");
  const todoTiming = resolveTodoTiming(todoCfg, null);

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

    // ── Personal to-dos.
    //
    // Created BEFORE the DM and independently of whether it lands: the
    // to-do is the durable artifact. A CSM with no Slack user ID
    // mapped (or a transient Slack failure) still needs the work item,
    // and a DM is easy to scroll past even when it does arrive.
    //
    // Dedupe is the to-do store's own, not the digest's dm-sent blob —
    // an OPEN to-do for the same (workspace, issue) means the CSM
    // already has this on their list, so re-running the digest is a
    // no-op. Same posture as the @bot assign playbook's
    // hubspot_company_id check. A COMPLETED to-do doesn't block: if
    // they closed it and the request resurfaced, a fresh one is
    // correct.
    if (!dryRun && csmEmail) {
      try {
        const userKey = userKeyFromEmail(csmEmail);
        const existing = await getTodosForUser(userKey);
        const openKeys = new Set(
          existing
            .filter(
              (t) =>
                t.source === "enterprise_request_shipped" &&
                t.completed_at === null
            )
            .map(
              (t) =>
                `${t.source_meta?.workspace_id ?? ""}:${t.source_meta?.linear_issue_id ?? ""}`
            )
        );
        const nowIso = new Date().toISOString();
        const newTodos: PersonalTodo[] = [];
        for (const r of rowsForCsm) {
          const key = `${r.workspace_id}:${r.linear_issue_id}`;
          if (openKeys.has(key)) continue;
          const title = applyTemplate(todoCfg.phrasing_template, {
            company_name: r.workspace_name ?? r.workspace_id,
            workspace_name: r.workspace_name,
            csm_name: csmHandle.replace(/_/g, " "),
            request_title: r.title,
            request_identifier: r.linear_identifier,
          }).trim();
          newTodos.push({
            id: newTodoId(),
            title: title || `Close the loop on ${r.linear_identifier}`,
            details:
              `${r.linear_identifier}: ${r.title}\n` +
              `Linear: ${r.url}\n` +
              (r.ship_url ? `Ship post: ${r.ship_url}\n` : "") +
              `\nShipped ${r.promoted_at.slice(0, 10)} — draft the ` +
              `close-the-loop note from the Live requests tab, then tick ` +
              `Notified there so it drops off next week's digest.`,
            due_date: shiftYmd(
              nowIso.slice(0, 10),
              todoTiming.due_offset_days ?? 3
            ),
            surface_at:
              todoTiming.surface_offset_days != null &&
              todoTiming.surface_offset_days > 0
                ? shiftYmd(
                    nowIso.slice(0, 10),
                    todoTiming.surface_offset_days
                  )
                : null,
            priority: null,
            source: "enterprise_request_shipped",
            source_meta: {
              workspace_id: r.workspace_id,
              linear_issue_id: r.linear_issue_id,
              linear_identifier: r.linear_identifier,
            },
            completed_at: null,
            remind_via_slack: true,
            created_at: nowIso,
            updated_at: nowIso,
          });
        }
        if (newTodos.length > 0) {
          await applyTodoOps(
            userKey,
            newTodos.map((todo) => ({ type: "add" as const, todo }))
          );
          todosCreated += newTodos.length;
        }
      } catch (e) {
        // Never let a to-do write failure block the DM — they're
        // independent closes on the same loop.
        console.warn("[enterprise-requests-digest] todo write failed", {
          csmHandle,
          error: e instanceof Error ? e.message : e,
        });
      }
    }

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
    rows_skipped_needs_review: skippedNeedsReview,
    review_queue_depth: reviewQueueDepth,
    review_queue_posted: reviewQueuePosted,
    todos_created: todosCreated,
    no_op: null,
    dry_run: dryRun,
  };
}
