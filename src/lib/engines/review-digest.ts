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
import { postSlackMessageRich } from "../integrations/slack";
import { buildDigestAccountBlocks } from "../integrations/digest-buttons";
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

/** One account that landed in a CSM's review queue. Carried alongside
 *  the aggregate counts so the engine can post a threaded reply per
 *  account with action buttons. workspace_name is the human label
 *  shown in the threaded reply; workspace_id is what we write to KV
 *  on a button click. */
export interface DigestAccount {
  workspace_id: string;
  workspace_name: string;
  workflow: ReviewWorkflow;
}

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
  /** Flat list of every account in this CSM's queue. Walked by the
   *  sender to emit one threaded Slack reply per account. */
  accounts: DigestAccount[];
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

  // workspace_id → workspace_name fallback. PastDueRow doesn't carry
  // the workspace name, so we resolve via the customer book.
  const nameByWorkspace = new Map<string, string>();
  for (const c of customers) {
    if (c.workspace_id) {
      nameByWorkspace.set(
        c.workspace_id,
        c.workspace_name ?? c.company_name ?? c.workspace_id
      );
    }
  }

  // CSM handle → aggregated row
  const acc = new Map<
    string,
    {
      counts: { past_due: number; proactive: number; renewals: number };
      accounts: DigestAccount[];
      csm_email: string | null;
    }
  >();

  const bump = (
    csmHandle: string,
    csmEmail: string | null,
    account: DigestAccount
  ) => {
    const existing = acc.get(csmHandle) ?? {
      counts: { past_due: 0, proactive: 0, renewals: 0 },
      accounts: [],
      csm_email: csmEmail,
    };
    existing.counts[account.workflow] += 1;
    existing.accounts.push(account);
    if (!existing.csm_email && csmEmail) existing.csm_email = csmEmail;
    acc.set(csmHandle, existing);
  };

  // past_due
  if (workflows.has("past_due")) {
    for (const row of pastDueRows) {
      if (!row.customer_success_manager || !row.customer_id) continue;
      const ws = wsByStripeId.get(row.customer_id) ?? null;
      if (!ws) continue;
      if (!needsReview(reviewStates[ws], "past_due")) continue;
      bump(row.customer_success_manager, null, {
        workspace_id: ws,
        workspace_name: nameByWorkspace.get(ws) ?? row.email ?? ws,
        workflow: "past_due",
      });
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
        {
          workspace_id: c.workspace_id,
          workspace_name:
            c.workspace_name ?? c.company_name ?? c.workspace_id,
          workflow: "proactive",
        }
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
        {
          workspace_id: c.workspace_id,
          workspace_name:
            c.workspace_name ?? c.company_name ?? c.workspace_id,
          workflow: "renewals",
        }
      );
    }
  }

  return [...acc.entries()].map(([csm, v]) => ({
    csm,
    csm_email: v.csm_email,
    mention: "", // Filled in by the caller (needs settings.slack.csm_user_ids)
    counts: v.counts,
    accounts: v.accounts,
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

/** Multi-workflow bullet body — used by the cron (which doesn't scope
 *  to one workflow). Same shape as before, just routed through the
 *  workflowMeta helper. */
function composeMultiMessage(
  per: DigestPerCsm,
  workflows: Set<ReviewWorkflow>
): string {
  const lines: string[] = [];
  if (workflows.has("past_due") && per.counts.past_due > 0) {
    const m = workflowMeta("past_due", per.csm);
    lines.push(
      `• <${m.filteredUrl}|${per.counts.past_due} ${m.noun}${per.counts.past_due === 1 ? "" : "s"} to review>`
    );
  }
  if (workflows.has("proactive") && per.counts.proactive > 0) {
    const m = workflowMeta("proactive", per.csm);
    lines.push(
      `• <${m.filteredUrl}|${per.counts.proactive} ${m.noun}${per.counts.proactive === 1 ? "" : "s"}>`
    );
  }
  if (workflows.has("renewals") && per.counts.renewals > 0) {
    const m = workflowMeta("renewals", per.csm);
    lines.push(
      `• <${m.filteredUrl}|${per.counts.renewals} ${m.noun}${per.counts.renewals === 1 ? "" : "s"} in the next ${RENEWAL_WINDOW_DAYS} days>`
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
        // Past-due-style header when the caller scoped to exactly one
        // workflow (the manual Send Digest button case). Otherwise
        // fall back to the bullet body used by the cron.
        const single =
          wfFilter.size === 1
            ? ([...wfFilter][0] as ReviewWorkflow)
            : null;
        const parentText = single
          ? composeSingleWorkflowMessage(per, single)
          : composeMultiMessage(per, wfFilter);
        const parent = await postSlackMessageRich({
          channel: channelId,
          text: parentText,
        });
        messages_sent++;

        // Threaded per-account replies — only the workflows the
        // caller asked for. Each has Reach Out Approved / Skip
        // buttons that write review_state to KV on click. The
        // threaded message itself is never updated; status is on the
        // dashboard.
        const accountsToPost = per.accounts.filter((a) =>
          wfFilter.has(a.workflow)
        );
        for (const account of accountsToPost) {
          try {
            await postSlackMessageRich({
              channel: channelId,
              thread_ts: parent.ts,
              text: account.workspace_name,
              blocks: buildDigestAccountBlocks({
                workspaceId: account.workspace_id,
                workspaceName: account.workspace_name,
                workflow: account.workflow,
              }),
            });
          } catch (e) {
            // A threaded-reply failure shouldn't take down the whole
            // digest run. Log the gap, leave the parent intact, keep
            // going.
            console.warn(
              "[review-digest] threaded reply failed",
              {
                csm: per.csm,
                workspace_id: account.workspace_id,
                error: e instanceof Error ? e.message : "unknown",
              }
            );
          }
        }
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
