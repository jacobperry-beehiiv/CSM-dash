import Link from "next/link";
import type { Customer } from "@/lib/types";
import { lastContacted } from "@/lib/customer-helpers";
import { fmtCurrency, fmtDate, fmtNumber } from "./format";
import { RiskLevelChip } from "./risk-level-chip";
import { FeatureUtilizationPanel } from "./feature-utilization-panel";
import { AdGapSummary } from "./ad-gap-summary";
import { CadenceToggle } from "./cadence-toggle";
import { HubSpotContactsSection } from "./hubspot-contacts-section";
import { CustomerPublicationsList } from "./customer-publications-list";
import { CustomerPaidSubsList } from "./customer-paid-subs-list";
import { CollapsibleSection } from "./collapsible-section";
import { CompanyNotes } from "./am/company-notes";
import { CopyButton } from "./copy-button";
import { CsmRefreshRow } from "./csm-refresh-row";
import { stripeCustomerUrl } from "@/lib/links";

interface Props {
  customer: Customer;
  /** Optional extra slot above the standard sections (e.g. flag list, post metrics). */
  topSlot?: React.ReactNode;
  /** Reserved for future per-view chrome toggles. Previously used to
   *  hide the static FeatureBreakdown grid; that section was replaced
   *  with the live CustomerPublicationsList. Kept on the prop list so
   *  existing callers (at-risk-table) keep type-checking — the value
   *  is currently ignored. */
  hideFeatureBreakdown?: boolean;
  /** Show the Paid Subscriptions section (tiers-with-subs + lifetime
   *  revenue). Opt-in because it adds a Metabase round-trip on row
   *  expand — only the /csm book view enables it. The AM workflow
   *  panels skip it; they're focused on past-due / renewals / approach
   *  signals rather than monetization breakdowns. */
  showPaidSubs?: boolean;
  /** Pre-fetched Gmail-direct "last contacted" ISO date for this
   *  customer's owner_email. Merged into the panel's "Last contacted"
   *  row via lastContacted(c, { gmailDate }). Comes from the parent
   *  table's useGmailLastContact() hook so a row in the table and the
   *  row's expanded panel show the same merged date.
   *
   *  Pass undefined when no Gmail data is available (no connection,
   *  scope missing, or just an unmatched email) — the panel will
   *  render HubSpot values only, same as before this feature shipped. */
  gmailDate?: string;
  /** Called when the user clicks the per-row "🔄 Refresh from Gmail"
   *  button. Force-busts the cache on the server and re-fetches just
   *  this row's value. Hidden when undefined (no owner_email or no
   *  Gmail connection). */
  onGmailRefresh?: () => void;
  /** Active CSM's Gmail token doesn't have gmail.readonly granted.
   *  Hides the per-row refresh button and shows a small inline
   *  "Reconnect Gmail" hint instead. */
  gmailScopeMissing?: boolean;
  /** Subject + From of the Gmail message that lit up the date —
   *  surfaced under the date so a CSM can sanity-check that an OOO
   *  auto-reply or newsletter isn't the reason "today" appears. */
  gmailMatch?: { subject: string | null; from: string | null } | null;
}

export function CustomerDetailPanel({
  customer: c,
  topSlot,
  showPaidSubs = false,
  gmailDate,
  onGmailRefresh,
  gmailScopeMissing,
  gmailMatch,
}: Props) {
  return (
    <div className="space-y-4">
      {topSlot}

      {c.workspace_id ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>Workspace ID:</span>
          <CopyButton value={c.workspace_id} label="Copy workspace ID" />
          {c.stripe_customer_id ? (
            <>
              <span className="text-subtle">·</span>
              <span>Stripe:</span>
              <CopyButton
                value={c.stripe_customer_id}
                label="Copy Stripe customer ID"
                href={stripeCustomerUrl(c.stripe_customer_id)}
                hrefLabel="Open in Stripe Dashboard"
              />
            </>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <Stat label="ARR" value={fmtCurrency(c.arr)} />
        <Stat label="MRR" value={fmtCurrency(c.mrr)} />
        <Stat label="Active subs" value={fmtNumber(c.active_subs)} />
      </div>

      <CadenceToggle customer={c} />

      {/* Status / Dates / Contact each render as full-width
       *  CollapsibleSection blocks matching the rest of the panel
       *  (HubSpot Contacts, Notes, Publications, …). Status defaults
       *  open because it carries the at-a-glance plan / risk /
       *  engagement signal; the others stay collapsed until needed. */}
      <div className="space-y-4">
        <Section title="Status" defaultOpen>
          <Row label="Plan" value={c.stripe_plan ?? "—"} />
          <Row label="Engagement" value={c.company_engagement ?? "—"} />
          <Row
            label="Risk level"
            value={
              <RiskLevelChip
                level={c.property_risk_level}
                detail={c.property_risk_level_detail}
              />
            }
          />
          {c.property_risk_level_detail ? (
            <Row
              label="Risk detail"
              value={c.property_risk_level_detail}
              block
            />
          ) : null}
          {c.property_customer_goals ? (
            <Row label="Goal" value={c.property_customer_goals} />
          ) : null}
          {c.property_customer_goals_detail ? (
            <Row
              label="Goal detail"
              value={c.property_customer_goals_detail}
              block
            />
          ) : null}
        </Section>
        <Section title="Dates">
          <Row label="Renewal" value={fmtDate(c.renewal_date)} />
          <Row label="Next invoice" value={fmtDate(c.next_invoice ?? null)} />
          <Row label="Last send" value={fmtDate(c.last_send)} />
          <Row label="Last log in" value={fmtDate(c.last_log_in)} />
          <Row
            label="Last contacted"
            value={
              (() => {
                const lc = lastContacted(c, { gmailDate });
                const showMatchHint =
                  lc.source === "gmail" &&
                  gmailMatch &&
                  (gmailMatch.subject || gmailMatch.from);
                return (
                  <div className="flex flex-col gap-0.5">
                    <span className="inline-flex items-center gap-2 flex-wrap">
                      <span title={`Source: ${lc.source}`}>
                        {fmtDate(lc.date)}
                      </span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                          lc.source === "gmail"
                            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200"
                            : lc.source === "none"
                              ? "bg-canvas text-subtle"
                              : "bg-surface-2 text-muted"
                        }`}
                        title={
                          lc.source === "gmail"
                            ? "Resolved from your Gmail mailbox (most-recent direct message with this account's owner email, excluding bounces / OOO / promo categories)."
                            : lc.source === "hubspot activity rollup"
                              ? "Resolved from HubSpot's company-level activity rollup. Note: HubSpot's rollup includes email-open events from their tracking pixel, which can bump the date even when no human reply happened."
                              : lc.source === "hubspot notes_last_contacted"
                                ? "Resolved from HubSpot's narrow notes_last_contacted property (manual marking)."
                                : "No activity found in HubSpot or Gmail."
                        }
                      >
                        {lc.source === "gmail"
                          ? "Gmail"
                          : lc.source === "hubspot activity rollup"
                            ? "HubSpot"
                            : lc.source === "hubspot notes_last_contacted"
                              ? "HubSpot (manual)"
                              : "—"}
                      </span>
                      {onGmailRefresh && !gmailScopeMissing ? (
                        <button
                          type="button"
                          onClick={onGmailRefresh}
                          className="text-[11px] text-accent hover:underline"
                          title="Force-fetch from your Gmail right now, bypassing the 6h cache."
                        >
                          🔄 Refresh from Gmail
                        </button>
                      ) : null}
                      {gmailScopeMissing ? (
                        <a
                          href="/settings/gmail"
                          className="text-[11px] text-amber-700 dark:text-amber-300 hover:underline"
                          title="Gmail read scope isn't granted yet — reconnect to enable Gmail-source contact dates."
                        >
                          Reconnect Gmail
                        </a>
                      ) : null}
                    </span>
                    {showMatchHint ? (
                      <span
                        className="text-[11px] text-muted truncate max-w-md"
                        title={
                          [
                            gmailMatch?.from
                              ? `From: ${gmailMatch.from}`
                              : null,
                            gmailMatch?.subject
                              ? `Subject: ${gmailMatch.subject}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join("\n")
                        }
                      >
                        matched: <em>{gmailMatch?.subject ?? "(no subject)"}</em>
                      </span>
                    ) : null}
                  </div>
                );
              })()
            }
          />
        </Section>
        <Section title="Contact">
          <Row label="Main contact" value={c.property_main_contact ?? "—"} />
          <Row label="Owner email" value={c.owner_email ?? "—"} />
          <Row label="Timezone" value={c.property_timezone ?? "—"} />
          {/* CSM gets its own row with a "🔄 HubSpot" refresh chip so a
           *  reassignment can land before the next nightly Metabase
           *  snapshot. The component is a "use client" island; the
           *  rest of the panel can stay server-rendered. */}
          <Row label="CSM" value={<CsmRefreshRow customer={c} />} />
        </Section>
      </div>

      <HubSpotContactsSection contacts={c.hubspot_contacts} />

      {/* Manual notes — same KV the CSM profile-page renders from, but
       *  scoped to kind:note so the inline editor stays a free-text
       *  scratchpad and doesn't crowd the structured skill signals. */}
      {c.workspace_id ? (
        <CompanyNotes workspaceId={c.workspace_id} />
      ) : null}

      {c.workspace_id ? (
        <CustomerPublicationsList workspaceId={c.workspace_id} />
      ) : null}

      {showPaidSubs && c.workspace_id ? (
        <CustomerPaidSubsList workspaceId={c.workspace_id} />
      ) : null}

      <FeatureUtilizationPanel workspaceId={c.workspace_id} />

      <AdGapSummary organizationId={c.workspace_id} />

      <div className="text-xs">
        {c.workspace_id ? (
          <Link
            href={`/account/${encodeURIComponent(c.workspace_id)}`}
            className="text-blue-600 dark:text-blue-400 hover:underline"
          >
            Open full account view →
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface rounded-md border border-border px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="text-lg font-semibold mt-1">{value}</p>
    </div>
  );
}

function Section({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <CollapsibleSection title={title} defaultOpen={defaultOpen}>
      {/* Bumped from space-y-2 → space-y-3 so dense fact rows breathe
       *  a bit; the section header is already padded, the body just
       *  needed inter-row air. */}
      <dl className="space-y-3">{children}</dl>
    </CollapsibleSection>
  );
}

function Row({
  label,
  value,
  /** When true, the value renders on its own line under the label
   *  instead of inline-right. Use for long-form prose (risk_detail,
   *  goal_detail, etc.) where right-aligning a two-line description
   *  reads awkwardly — eye starts on the right and runs back left. */
  block = false,
}: {
  label: string;
  value: React.ReactNode;
  block?: boolean;
}) {
  if (block) {
    return (
      <div className="text-sm space-y-1">
        <dt className="text-muted">{label}</dt>
        <dd className="text-fg break-words whitespace-pre-wrap leading-relaxed">
          {value}
        </dd>
      </div>
    );
  }
  return (
    <div className="flex justify-between items-baseline gap-4 text-sm">
      <dt className="text-muted whitespace-nowrap">{label}</dt>
      <dd className="text-fg text-right break-words min-w-0">{value}</dd>
    </div>
  );
}
