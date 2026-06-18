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
  type SlackNotificationKind,
} from "../data/settings-types";

/** Per-workflow notification kind. Each workflow has its own settings
 *  row in /settings/slack — destination channel + enabled toggle +
 *  cron_enabled toggle — so admins can route past-due to one channel,
 *  renewals to another, and silence individual workflows from the
 *  scheduled run without disabling the whole digest. */
const WORKFLOW_TO_KIND: Record<ReviewWorkflow, SlackNotificationKind> = {
  past_due: "digest_past_due",
  proactive: "digest_proactive",
  renewals: "digest_renewals",
};

/**
 * Per-CSM × per-workflow digest engine.
 *
 * Posts ONE message per (CSM, workflow) pair to that workflow's
 * configured channel. Each message is a past-due-style notification:
 *
 *     "Hey @CSM, you have 3 accounts that need review for renewals.
 *      Open the filtered list"
 *
 * The Slack ping is intentionally just a notification — there are no
 * in-Slack action buttons. The CSM clicks "Open the filtered list",
 * lands on the dashboard view filtered to their queue, and handles
 * each account via the existing review-state controls (Reach Out /
 * Skip / Done dropdowns on each row).
 *
 * Eligibility per workflow:
 *   • past_due    — any row in q24620 that classifies as past-due.
 *   • proactive   — Enterprise customer at ≥75% of plan cap.
 *   • renewals    — annual customer renewing within RENEWAL_WINDOW_DAYS.
 *
 * Per-workflow filter: each workflow has its own settings row
 * (digest_past_due / digest_proactive / digest_renewals) with
 * enabled + destination + cron_enabled. A workflow is silently
 * skipped when disabled, when no channel is configured, or when
 * cron_enabled is false on a cron-triggered run. Manual Send Digest
 * buttons gate on enabled + destination only.
 *
 * Per-CSM "needs review" count = eligible accounts whose
 * review_state[workflow] is reach_out OR unset. Skip + done drop out.
 * CSMs with 0 across all selected workflows get no message.
 *
 * Triggered by:
 *   • POST /api/review-digest/sweep (session auth — manual button)
 *   • POST /api/review-digest/sweep with Bearer CRON_SECRET (cron)
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

  // CSM handle → aggregated counts
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

/** Workflow label + dashboard tab + filtered-list URL builder. Used by
 *  both the multi-workflow bullet message (cron) and the per-workflow
 *  past-due-style header (manual "Send digest" buttons). */
function workflowMeta(
  workflow: ReviewWorkflow,
  csmHandle: string
): { label: string; noun: string; filteredUrl: string } {
  const base = dashboardUrl();
  const enc = encodeURIComponent(csmHandle);
  switch (workflow) {
    case "past_due":
      return {
        label: "past-due outreach",
        noun: "past-due account",
        filteredUrl: `${base}/am?tab=past-due&csm=${enc}&needs_review=1`,
      };
    case "proactive":
      return {
        label: "proactive outreach",
        noun: "Enterprise account approaching cap",
        filteredUrl: `${base}/am?tab=proactive&csm=${enc}&needs_review=1`,
      };
    case "renewals":
      return {
        label: "renewals",
        noun: "renewal",
        filteredUrl: `${base}/am?tab=renewals&csm=${enc}&needs_review=1`,
      };
  }
}

/** Past-due-style header used by the manual Send Digest buttons. Each
 *  button is scoped to exactly one workflow, so the message is a
 *  single sentence + a filtered-list link — same shape as the existing
 *  past-due ping.
 *
 *  Example:
 *    "Hey @CSM, you have 3 accounts that need review for renewals.
 *     <link|Open the filtered list>" */
function composeSingleWorkflowMessage(
  per: DigestPerCsm,
  workflow: ReviewWorkflow
): string {
  const meta = workflowMeta(workflow, per.csm);
  const count = per.counts[workflow];
  return `Hey ${per.mention}, you have *${count}* account${
    count === 1 ? "" : "s"
  } that need review for ${meta.label}. <${meta.filteredUrl}|Open the filtered list>`;
}

// (Note: composeMultiMessage was removed in the per-workflow refactor
// — every workflow now sends its own past-due-style header to its own
// channel, so the bullet-list shape isn't used anywhere.)

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

  // Resolve a channel + enabled state per workflow. Each workflow has
  // its own settings row now; the legacy unified `review_digest`
  // setting is the fallback when the per-workflow pref is unset (see
  // resolveSlackNotificationPref). Cron runs additionally gate on
  // each workflow's cron_enabled toggle so admins can mute one
  // workflow's scheduled run without touching the others.
  const isCron = opts.triggeredBy === "cron";
  const effective: Array<{ workflow: ReviewWorkflow; channel: string }> = [];
  const skipped: Array<{ workflow: ReviewWorkflow; reason: string }> = [];
  for (const wf of wfFilter) {
    const pref = resolveSlackNotificationPref(settings, WORKFLOW_TO_KIND[wf]);
    const channel = pref.destination.trim();
    if (!pref.enabled) {
      skipped.push({ workflow: wf, reason: "disabled" });
      continue;
    }
    if (!channel) {
      skipped.push({ workflow: wf, reason: "no_channel" });
      continue;
    }
    if (isCron && pref.cron_enabled === false) {
      skipped.push({ workflow: wf, reason: "cron_disabled" });
      continue;
    }
    effective.push({ workflow: wf, channel });
  }
  // If every workflow was skipped because no channel is configured,
  // surface the same `no_channel_configured` hint the manual button
  // checks for so admins get a clean error.
  if (effective.length === 0 && !dryRun) {
    const allMissingChannel = skipped.every(
      (s) => s.reason === "no_channel"
    );
    return {
      generated_at,
      per_csm: [],
      messages_sent: 0,
      messages_failed: 0,
      failures: [],
      dry_run: dryRun,
      no_channel_configured: allMissingChannel,
    };
  }
  // Narrow wfFilter to just the workflows we'll actually send so the
  // buildDigest call below doesn't compute counts we won't use.
  const sendingWorkflows = new Set(effective.map((e) => e.workflow));

  const perCsm = buildDigest({
    customers,
    pastDueRows,
    reviewStates,
    workflows: sendingWorkflows,
    now,
  })
    .filter((p) => p.total > 0)
    .map((p) => ({ ...p, mention: csmMention(p.csm, settings) }))
    .sort((a, b) => a.csm.localeCompare(b.csm));

  let messages_sent = 0;
  let messages_failed = 0;
  const failures: Array<{ csm: string; error: string }> = [];

  // One parent message per (CSM, workflow). Each workflow has its
  // own configured channel, so a CSM could get up to three messages
  // — one per workflow's destination — when the cron fires. Per-
  // account follow-up (Reach Out Approved / Skip / Done) is handled
  // entirely on the dashboard via the existing review-state controls;
  // the Slack ping is intentionally just a "you have N to review,
  // here's the filtered list" notification with no in-Slack actions.
  if (!dryRun) {
    for (const per of perCsm) {
      for (const { workflow, channel } of effective) {
        if (per.counts[workflow] === 0) continue;
        try {
          await postSlackMessage({
            channel,
            text: composeSingleWorkflowMessage(per, workflow),
          });
          messages_sent++;
        } catch (e) {
          messages_failed++;
          failures.push({
            csm: per.csm,
            error: `${workflow}: ${e instanceof Error ? e.message : "unknown"}`,
          });
        }
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
