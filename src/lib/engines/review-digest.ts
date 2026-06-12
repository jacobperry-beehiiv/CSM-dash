import { isEnterprise, loadCustomers } from "../data/load-customers";
import { subUtilFraction } from "../customer-helpers";
import { loadPastDue, type PastDueRow } from "./am-cohorts";
import { loadSettings } from "../data/settings";
import {
  loadReviewStates,
  type ReviewStatesMap,
  type ReviewWorkflow,
} from "../data/review-states";
import { needsReview } from "../data/review-states-types";
import { postSlackMessage } from "../integrations/slack";
import type { Customer } from "../types";
import {
  resolveSlackNotificationPref,
  type SettingsShape,
} from "../data/settings-types";

/**
 * Aggregate per-CSM digest engine — Phase B of the review workflow.
 *
 * Replaces the per-customer Slack ping pattern with one summary
 * message per CSM:
 *
 *     :wave: Hey <@U…>, you have:
 *       • 3 past-due accounts to review
 *       • 2 Enterprise accounts approaching cap
 *       • 5 renewals in the next 30 days
 *
 *     Click in: <link to past-due needs-review> · <link to proactive> · <link to renewals>
 *
 * Eligibility per workflow:
 *   • past_due    — any row in q24620 that classifies as past-due.
 *   • proactive   — Enterprise customer at ≥75% of plan cap.
 *   • renewals    — annual customer renewing within RENEWAL_WINDOW_DAYS.
 *
 * Per-CSM "needs review" count = eligible accounts whose
 * review_state[workflow] is reach_out OR unset. Skip + done drop out.
 * CSMs with 0 across all three workflows get no message.
 *
 * Triggered by:
 *   • POST /api/review-digest/sweep (session auth — manual button)
 *   • POST /api/review-digest/sweep with Bearer CRON_SECRET (Phase C cron)
 */

const ENT_UTIL_THRESHOLD = 0.75;
const RENEWAL_WINDOW_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface DigestPerCsm {
  csm: string;
  csm_email: string | null;
  /** Slack mention shape — <@USERID> when the CSM has a Slack ID
   *  mapped in settings, plain name otherwise. */
  mention: string;
  counts: {
    past_due: number;
    proactive: number;
    renewals: number;
  };
  /** Total across all three; CSMs with 0 here are skipped entirely. */
  total: number;
}

export interface DigestResult {
  /** Wall-clock when the engine ran. */
  generated_at: string;
  /** CSMs we composed messages for. Includes those with 0 totals
   *  when dryRun is set so the response shows the full distribution.
   *  Real runs filter to total > 0. */
  per_csm: DigestPerCsm[];
  messages_sent: number;
  messages_failed: number;
  failures: Array<{ csm: string; error: string }>;
  dry_run: boolean;
  /** True when the channel ID isn't configured — the engine
   *  short-circuits without posting, lets the caller surface a clear
   *  "configure /settings/slack" hint. */
  no_channel_configured?: boolean;
}

interface BuildArgs {
  customers: Customer[];
  pastDueRows: PastDueRow[];
  reviewStates: ReviewStatesMap;
  workflows: Set<ReviewWorkflow>;
  now: Date;
}

/** Compute per-CSM digest data. Pure function — no IO — so the
 *  endpoint can return it in dryRun mode without sending Slack. */
export function buildDigest(args: BuildArgs): DigestPerCsm[] {
  const { customers, pastDueRows, reviewStates, workflows, now } = args;

  // Stripe customer_id → workspace_id index. PastDueRow.customer_id is
  // a Stripe ID; review-states are keyed by workspace_id.
  const wsByStripeId = new Map<string, string>();
  for (const c of customers) {
    if (c.stripe_customer_id && c.workspace_id) {
      wsByStripeId.set(c.stripe_customer_id, c.workspace_id);
    }
  }

  // CSM handle → { counts, csm_email }
  const acc = new Map<
    string,
    {
      counts: { past_due: number; proactive: number; renewals: number };
      csm_email: string | null;
    }
  >();

  const bump = (
    csmHandle: string,
    csmEmail: string | null,
    workflow: ReviewWorkflow
  ) => {
    const existing = acc.get(csmHandle) ?? {
      counts: { past_due: 0, proactive: 0, renewals: 0 },
      csm_email: csmEmail,
    };
    existing.counts[workflow] += 1;
    if (!existing.csm_email && csmEmail) existing.csm_email = csmEmail;
    acc.set(csmHandle, existing);
  };

  // past_due
  if (workflows.has("past_due")) {
    for (const row of pastDueRows) {
      if (!row.customer_success_manager || !row.customer_id) continue;
      const ws = wsByStripeId.get(row.customer_id) ?? null;
      if (!needsReview(ws ? reviewStates[ws] : undefined, "past_due")) {
        continue;
      }
      bump(row.customer_success_manager, null, "past_due");
    }
  }

  // proactive (Enterprise ≥ ENT_UTIL_THRESHOLD)
  if (workflows.has("proactive")) {
    for (const c of customers) {
      if (!c.customer_success_manager || !c.workspace_id) continue;
      if (!isEnterprise(c)) continue;
      const u = utilFraction(c);
      if (u == null || u < ENT_UTIL_THRESHOLD) continue;
      if (!needsReview(reviewStates[c.workspace_id], "proactive")) continue;
      bump(
        c.customer_success_manager,
        c.customer_success_manager_email ?? null,
        "proactive"
      );
    }
  }

  // renewals (annual, renewing within RENEWAL_WINDOW_DAYS)
  if (workflows.has("renewals")) {
    for (const c of customers) {
      if (!c.customer_success_manager || !c.workspace_id) continue;
      const renewIso = c.renewal_date ?? c.next_invoice ?? null;
      if (!renewIso) continue;
      const renew = new Date(renewIso).getTime();
      if (!Number.isFinite(renew)) continue;
      const days = Math.round((renew - now.getTime()) / MS_PER_DAY);
      if (days < 0 || days > RENEWAL_WINDOW_DAYS) continue;
      if (!needsReview(reviewStates[c.workspace_id], "renewals")) continue;
      bump(
        c.customer_success_manager,
        c.customer_success_manager_email ?? null,
        "renewals"
      );
    }
  }

  return [...acc.entries()].map(([csm, v]) => ({
    csm,
    csm_email: v.csm_email,
    mention: "", // Filled in by the caller (needs settings.slack.csm_user_ids)
    counts: v.counts,
    total:
      v.counts.past_due +
      v.counts.proactive +
      v.counts.renewals,
  }));
}

// Thin alias around the shared subUtilFraction helper — see
// src/lib/customer-helpers.ts for the heuristic + the bug it fixes.
const utilFraction = subUtilFraction;

function csmMention(csm: string, settings: SettingsShape): string {
  const slackId = settings.slack.csm_user_ids?.[csm];
  if (slackId) return `<@${slackId}>`;
  return csm.replace(/_/g, " ");
}

function dashboardUrl(): string {
  return process.env.DASHBOARD_BASE_URL ?? "https://csm-dash.vercel.app";
}

/** Slack-mrkdwn message body. Counts == 0 lines drop out so a CSM
 *  with only past-due to review sees a single bullet, not three with
 *  "0 renewals" noise. */
function composeMessage(per: DigestPerCsm): string {
  const base = dashboardUrl();
  const csmHandle = encodeURIComponent(per.csm);
  const lines: string[] = [];
  if (per.counts.past_due > 0) {
    lines.push(
      `• <${base}/am?tab=past-due&csm=${csmHandle}&needs_review=1|${per.counts.past_due} past-due account${per.counts.past_due === 1 ? "" : "s"} to review>`
    );
  }
  if (per.counts.proactive > 0) {
    lines.push(
      `• <${base}/am?tab=proactive&csm=${csmHandle}&needs_review=1|${per.counts.proactive} Enterprise account${per.counts.proactive === 1 ? "" : "s"} approaching cap>`
    );
  }
  if (per.counts.renewals > 0) {
    lines.push(
      `• <${base}/am?tab=renewals&csm=${csmHandle}&needs_review=1|${per.counts.renewals} renewal${per.counts.renewals === 1 ? "" : "s"} in the next ${RENEWAL_WINDOW_DAYS} days>`
    );
  }
  return [
    `:wave: Hey ${per.mention}, your review queue:`,
    ...lines,
    "",
    `Mark each account as :large_orange_circle: *Reach out* / :black_circle: *Skip* / :white_check_mark: *Done* on the dashboard, drop a note for the why, and the next digest only resurfaces what's still pending.`,
  ].join("\n");
}

export async function runReviewDigestSweep(
  opts: {
    dryRun?: boolean;
    triggeredBy?: "cron" | "manual";
    /** Limit to a subset of workflows. Empty / undefined = all three. */
    workflows?: ReviewWorkflow[];
  } = {}
): Promise<DigestResult> {
  const dryRun = Boolean(opts.dryRun);
  const wfFilter: Set<ReviewWorkflow> =
    opts.workflows && opts.workflows.length > 0
      ? new Set(opts.workflows)
      : new Set<ReviewWorkflow>(["past_due", "proactive", "renewals"]);

  const [customers, pastDueRows, reviewStates, settings] = await Promise.all([
    loadCustomers(),
    // past-due rows only matter when we're computing past-due; skip
    // the Metabase round-trip when the caller scoped past_due out.
    wfFilter.has("past_due") ? loadPastDue() : Promise.resolve([]),
    loadReviewStates(),
    loadSettings(),
  ]);

  const now = new Date();
  const generated_at = now.toISOString();

  const digestPref = resolveSlackNotificationPref(settings, "review_digest");
  const channelId = digestPref.destination.trim();
  if ((!digestPref.enabled || !channelId) && !dryRun) {
    return {
      generated_at,
      per_csm: [],
      messages_sent: 0,
      messages_failed: 0,
      failures: [],
      dry_run: dryRun,
      no_channel_configured: true,
    };
  }

  const perCsm = buildDigest({
    customers,
    pastDueRows,
    reviewStates,
    workflows: wfFilter,
    now,
  })
    .filter((p) => p.total > 0)
    .map((p) => ({ ...p, mention: csmMention(p.csm, settings) }))
    .sort((a, b) => a.csm.localeCompare(b.csm));

  let messages_sent = 0;
  let messages_failed = 0;
  const failures: Array<{ csm: string; error: string }> = [];

  if (!dryRun) {
    for (const per of perCsm) {
      try {
        await postSlackMessage({
          channel: channelId,
          text: composeMessage(per),
        });
        messages_sent++;
      } catch (e) {
        messages_failed++;
        failures.push({
          csm: per.csm,
          error: e instanceof Error ? e.message : "unknown",
        });
      }
    }
  }

  return {
    generated_at,
    per_csm: perCsm,
    messages_sent,
    messages_failed,
    failures,
    dry_run: dryRun,
  };
}
