import type { Customer } from "@/lib/types";
import type { SettingsShape } from "@/lib/data/settings-types";
import { fmtCurrency } from "@/components/format";

/**
 * Shared Slack-message formatting for the CSM-owned renewals
 * workflow. Both the milestone engine (auto-open on 90d) and the
 * `@normbot renewal` Slack command (manual open by a CSM) post the
 * same "renewal kickoff" shape into the configured
 * `settings.am.renewals_slack_channel_id`, and the confirmation
 * reply into that thread on lifecycle transition to
 * "Renewal Confirmed" reuses the deep-link helper.
 *
 * Keeping the formatters in one place means the pricing thread's
 * kickoff message reads identically whichever entry point the CSM
 * used — and if we later want to add / rearrange fields the change
 * lands in one file, not three.
 */

export function companyLabel(c: Customer): string {
  return c.company_name ?? c.workspace_name ?? "an account";
}

export function csmMention(c: Customer, settings: SettingsShape): string {
  const handle = c.customer_success_manager;
  if (!handle) return "the CSM";
  const slackId = settings.slack.csm_user_ids[handle];
  if (slackId) return `<@${slackId}>`;
  return handle.replace(/_/g, " ");
}

export function dashboardOrigin(): string {
  return (
    process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "https://csm-dash.vercel.app"
  ).replace(/\/+$/, "");
}

export function customerDeepLink(c: Customer): string {
  const params = new URLSearchParams({ tab: "renewals" });
  if (c.workspace_id) params.set("workspace_id", c.workspace_id);
  // Pass the CSM handle so the parent /csm page auto-scopes to that
  // CSM's book. Without this, a click from someone whose OWN book
  // doesn't include this customer (a lead, a teammate) lands on an
  // empty list even though the workspace_id was on the URL. The
  // renewal panel then filters the CSM's book down to the single
  // workspace_id so the click surfaces exactly one row.
  if (c.customer_success_manager) {
    params.set("csm", c.customer_success_manager);
  }
  return `${dashboardOrigin()}/csm?${params.toString()}`;
}

export function formatRenewalDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Slack thread ts (e.g. "1723486800.001200") → permalink-style
 *  timestamp query fragment used by Slack's archive URLs. Slack's
 *  message deep links look like
 *  https://slack.com/archives/<CHANNEL_ID>/p<TSNUMERIC>?thread_ts=…
 *  — this drops the dot so the ts becomes the p<numeric> suffix. */
export function tsPermalinkNumeric(ts: string): string {
  return ts.replace(/\./g, "");
}

/**
 * Full text for the top-level pricing-thread kickoff message. Used
 * both by the milestone engine's auto-open path at 90d and by the
 * `@normbot renewal` command's Confirm click. Optional
 * `openedByLine` lets the caller add context about who / what
 * opened the thread — e.g. "_opened by @jacob via @normbot renewal_"
 * — without duplicating the whole formatter.
 */
export function buildRenewalKickoffMessage(args: {
  customer: Customer;
  settings: SettingsShape;
  renewalIso: string;
  lifecycleStage: string | null;
  openedByLine?: string | null;
}): string {
  const { customer: c, settings, renewalIso, lifecycleStage, openedByLine } = args;
  const arrLine = c.arr != null ? `${fmtCurrency(c.arr)}/yr` : "—";
  const stageLine = lifecycleStage ?? "—";
  const link = customerDeepLink(c);
  const lines = [
    `:handshake: *Renewal kickoff — ${companyLabel(c)}*`,
    `• Plan: *${c.stripe_plan ?? "—"}*`,
    `• Current ARR: *${arrLine}*`,
    `• Lifecycle stage: *${stageLine}*`,
    `• Renewal date: *${formatRenewalDate(renewalIso)}*`,
    `• CSM: ${csmMention(c, settings)}`,
    ``,
    `Opening the pricing thread here so we track pacing in one place.`,
    `<${link}|Open in dashboard ↗>`,
  ];
  if (openedByLine) {
    lines.push("", openedByLine);
  }
  return lines.join("\n");
}

/**
 * Threaded reply text for a milestone hit (60 / 30 / 7 days out).
 * Kept alongside the kickoff formatter so both the engine and any
 * future manual "ping this renewal thread" affordance share the
 * same voice.
 */
export function buildRenewalMilestoneReply(args: {
  customer: Customer;
  settings: SettingsShape;
  milestone: number;
  renewalIso: string;
  lifecycleStage: string | null;
}): string {
  const { customer: c, settings, milestone, renewalIso, lifecycleStage } = args;
  const stageLine = lifecycleStage ?? "—";
  const link = customerDeepLink(c);
  const daysLine =
    milestone === 7
      ? `Only *7 days* until renewal on ${formatRenewalDate(renewalIso)}.`
      : `*${milestone} days* until renewal on ${formatRenewalDate(renewalIso)}.`;
  // 30-day escalation: also @-mention the configured triage user
  // (Juliet by default) whenever the customer isn't yet Renewal
  // Confirmed. Blank setting or a non-30d milestone → no extra tag.
  // "Renewal Confirmed" is the fixed stage name (see
  // RENEWAL_CONFIRMED_STAGE in /api/customer-overrides/route.ts).
  const isRenewalConfirmed = (lifecycleStage ?? "").trim() === "Renewal Confirmed";
  const triageUserId = settings.am?.renewal_30d_triage_user_id?.trim();
  const escalationMention =
    milestone === 30 && !isRenewalConfirmed && triageUserId
      ? ` <@${triageUserId}>`
      : "";
  return [
    `:alarm_clock: ${daysLine} ${csmMention(c, settings)}${escalationMention}`,
    `Current lifecycle stage: *${stageLine}*.`,
    `<${link}|Open in dashboard ↗>`,
  ].join("\n");
}

/**
 * Confirmation reply text posted into the saved pricing thread when
 * a CSM transitions a customer's lifecycle stage TO "Renewal
 * Confirmed". Kept here so the wording matches the rest of the
 * renewals workflow's voice.
 */
export function buildRenewalConfirmedReply(args: {
  customer: Customer;
  csmDisplay: string;
}): string {
  const { customer: c, csmDisplay } = args;
  const link = customerDeepLink(c);
  return [
    `:tada: *Renewal confirmed* — ${companyLabel(c)}`,
    `Marked by ${csmDisplay}.`,
    `<${link}|Open in dashboard ↗>`,
  ].join("\n");
}

/**
 * Generic lifecycle-stage transition reply — posted into the pricing
 * thread whenever a CSM changes a customer's lifecycle_stage to
 * anything OTHER than "Renewal Confirmed" (that transition has its
 * own specialized reply + verification todo via
 * buildRenewalConfirmedReply). Handles four transition shapes:
 *
 *   • unset → stage         "Lifecycle stage set: <stage>"
 *   • stage → different     "Lifecycle stage: <prior> → <next>"
 *   • stage → cleared       "Lifecycle stage cleared (was <prior>)"
 *   • unset → cleared       — no-op, caller shouldn't fire this
 *
 * Keeps the thread audit trail complete without duplicating the
 * "Renewal Confirmed" celebration message on every routine stage
 * bump (Follow Up Sent → Call Scheduled, etc.).
 */
export function buildLifecycleChangeReply(args: {
  customer: Customer;
  priorStage: string | null;
  nextStage: string | null;
  actorDisplay: string;
}): string {
  const { customer: c, priorStage, nextStage, actorDisplay } = args;
  const link = customerDeepLink(c);
  let headline: string;
  if (!priorStage && nextStage) {
    headline = `:arrow_right: *Lifecycle stage set: ${nextStage}* — ${companyLabel(c)}`;
  } else if (priorStage && nextStage) {
    headline = `:arrow_right: *Lifecycle stage: ${priorStage} → ${nextStage}* — ${companyLabel(c)}`;
  } else {
    // priorStage && !nextStage — CSM cleared the dropdown.
    headline = `:arrow_right: *Lifecycle stage cleared* — ${companyLabel(c)} (was *${priorStage}*)`;
  }
  return [
    headline,
    `Updated by ${actorDisplay}.`,
    `<${link}|Open in dashboard ↗>`,
  ].join("\n");
}

/**
 * Threaded reply posted when a CSM manually fires the "📣 Slack"
 * button from the renewals panel on an account that ALREADY has a
 * pricing thread. Kept lightweight — the parent kickoff already
 * carries the full context — but names the CSM who pinged plus the
 * current lifecycle stage / days-to-renewal for scannability so a
 * teammate reading the thread doesn't have to click back to the
 * dashboard just to see why it fired.
 */
export function buildRenewalManualPingReply(args: {
  customer: Customer;
  settings: SettingsShape;
  renewalIso: string | null;
  lifecycleStage: string | null;
  actorDisplay: string;
}): string {
  const { customer: c, settings, renewalIso, lifecycleStage, actorDisplay } =
    args;
  const link = customerDeepLink(c);
  const daysLine = renewalIso
    ? `Renewal on *${formatRenewalDate(renewalIso)}*.`
    : `No contract renewal date set.`;
  const stageLine = lifecycleStage ? `Current stage: *${lifecycleStage}*.` : "";
  return [
    `:bell: Manual ping from ${actorDisplay} — ${csmMention(c, settings)} take a look.`,
    [daysLine, stageLine].filter(Boolean).join(" "),
    `<${link}|Open in dashboard ↗>`,
  ]
    .filter(Boolean)
    .join("\n");
}
