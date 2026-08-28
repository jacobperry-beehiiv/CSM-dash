import Link from "next/link";
import type { Customer } from "@/lib/types";
import { lastContacted } from "@/lib/customer-helpers";
import { fmtCurrency, fmtDate, fmtNumber } from "./format";
import { RiskLevelChip } from "./risk-level-chip";
import { FeatureUtilizationPanel } from "./feature-utilization-panel";
import { AdGapSummary } from "./ad-gap-summary";
import { CadenceToggle } from "./cadence-toggle";
import { SendCadenceEditor } from "./send-cadence-editor";
import { HubSpotContactsList } from "./hubspot-contacts-section";
import { CustomerPublicationsList } from "./customer-publications-list";
import { CustomerPaidSubsList } from "./customer-paid-subs-list";
import { CollapsibleSection } from "./collapsible-section";
import { CompanyNotes } from "./am/company-notes";
import { ReviewStatesSection } from "./am/review-states-section";
import { CustomerNewsSection } from "./am/customer-news-section";
import { CopyButton } from "./copy-button";
import { CsmRefreshRow } from "./csm-refresh-row";
import { HubSpotLinkBadge } from "./hubspot-link-badge";
import { MappedFieldEditor } from "./mapped-field-editor";
import { ProfileFieldsSection } from "./profile-fields-section";
import { StatusBadge } from "./status-badge";
import { UpgradeAnalysisPanelForWorkspace } from "./upgrade-analysis-panel";
import { MAPPABLE_DASHBOARD_FIELDS } from "@/lib/data/field-mappings-types";
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
  /** Mount the D&C Upgrade Analysis surface above `topSlot`. Off by
   *  default — the page-level renderer (csm/page.tsx, am/page.tsx)
   *  passes true when the viewer has the `upgrade-analysis` flag on.
   *  The panel itself only fetches on demand; leaving it off just
   *  hides the CTA rather than saving API cost. */
  upgradeAnalysisEnabled?: boolean;
  /** Mount the per-customer Recent News section. Gated behind the
   *  `news-feed` feature flag — noisy for CSMs who don't follow
   *  their book externally. Off by default. */
  newsEnabled?: boolean;
}

export function CustomerDetailPanel({
  customer: c,
  topSlot,
  showPaidSubs = false,
  gmailDate,
  onGmailRefresh,
  gmailScopeMissing,
  gmailMatch,
  upgradeAnalysisEnabled = false,
  newsEnabled = false,
}: Props) {
  return (
    <div className="space-y-4">
      {upgradeAnalysisEnabled && c.workspace_id ? (
        <UpgradeAnalysisPanelForWorkspace
          workspaceId={c.workspace_id}
          ownerEmail={c.owner_email ?? null}
        />
      ) : null}
      {topSlot}

      {/* Top metadata strip — at-a-glance identifiers. Owner email
       *  is surfaced here (in addition to the Contact section below)
       *  so a CSM doesn't have to expand a collapsed section just to
       *  grab the email — it's almost always the first thing they
       *  want when opening the panel. */}
      {c.workspace_id || c.owner_email || c.stripe_customer_id ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          {c.owner_email ? (
            <span className="flex items-center gap-1.5">
              <span>Owner:</span>
              <CopyButton
                value={c.owner_email}
                label="Copy owner email"
                href={`mailto:${c.owner_email}`}
                hrefLabel="Open in mail client"
              />
            </span>
          ) : null}
          {c.workspace_id ? (
            <>
              {c.owner_email ? <span className="text-subtle">·</span> : null}
              <span>Workspace ID:</span>
              <CopyButton value={c.workspace_id} label="Copy workspace ID" />
            </>
          ) : null}
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
          {/* HubSpot link badge — confidence indicator for the join
           *  between this row and its HubSpot company record. Set by
           *  scripts/sync.ts based on which resolution path won. Drives
           *  whether the write-side affordances (CSM refresh, post-
           *  note, /update-csm) can find the HubSpot company. */}
          <span className="text-subtle">·</span>
          <HubSpotLinkBadge
            linkSource={c.hubspot_link_source ?? null}
            warning={c.hubspot_link_warning ?? null}
            hubspotCompanyId={c.hubspot_company_id ?? null}
            workspaceId={c.workspace_id ?? null}
            hasStripeId={Boolean(c.stripe_customer_id)}
          />
          {/* Drive folder shortcut. Auto-populated by @bot assign when
           *  it creates the folder; also editable inline (delegates to
           *  MappedFieldEditor, which pushes to HubSpot's customer_folder
           *  property when the field mapping's direction is push/both).
           *  Read-only renderer preserves the emerald pill affordance
           *  so the top strip still reads as "quick-link" not "form
           *  field." */}
          <span className="text-subtle">·</span>
          <MappedFieldEditor
            fieldDef={MAPPABLE_DASHBOARD_FIELDS.find(
              (f) => f.id === "property_customer_folder"
            )!}
            currentValue={c.property_customer_folder}
            workspaceId={c.workspace_id}
            renderReadOnly={(value) =>
              value ? (
                <a
                  href={value}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-full border border-emerald-300 bg-emerald-50 text-emerald-900 hover:bg-emerald-100 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200 dark:hover:bg-emerald-500/20"
                  title="Open the customer's shared Drive folder (HubSpot property: Customer Folder)"
                >
                  <span aria-hidden>📁</span>
                  Drive folder
                  <span aria-hidden>↗</span>
                </a>
              ) : (
                <span className="text-[11px] text-subtle italic">
                  No Drive folder linked
                </span>
              )
            }
          />
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
       *  (Notes, Publications, …). Status defaults open because it
       *  carries the at-a-glance plan / risk / engagement signal; the
       *  others stay collapsed until needed. HubSpot company contacts
       *  live inside Contact rather than as a sibling section. */}
      <div className="space-y-4">
        <Section title="Status" defaultOpen>
          <Row label="Plan" value={c.stripe_plan ?? "—"} />
          <Row
            label="Status"
            value={
              <MappedFieldEditor
                fieldDef={MAPPABLE_DASHBOARD_FIELDS.find(
                  (f) => f.id === "property_company_status"
                )!}
                currentValue={c.property_company_status}
                workspaceId={c.workspace_id}
                renderReadOnly={(v) => <StatusBadge value={v ?? null} />}
              />
            }
          />
          <Row
            label="Engagement"
            value={
              <MappedFieldEditor
                fieldDef={MAPPABLE_DASHBOARD_FIELDS.find(
                  (f) => f.id === "company_engagement"
                )!}
                currentValue={c.company_engagement}
                workspaceId={c.workspace_id}
              />
            }
          />
          <Row
            label="Risk level"
            value={
              <MappedFieldEditor
                fieldDef={MAPPABLE_DASHBOARD_FIELDS.find(
                  (f) => f.id === "property_risk_level"
                )!}
                currentValue={c.property_risk_level}
                workspaceId={c.workspace_id}
                renderReadOnly={(v) => (
                  <RiskLevelChip
                    level={v ?? null}
                    detail={c.property_risk_level_detail}
                  />
                )}
              />
            }
          />
          <Row
            label="Risk detail"
            value={
              <MappedFieldEditor
                fieldDef={MAPPABLE_DASHBOARD_FIELDS.find(
                  (f) => f.id === "property_risk_level_detail"
                )!}
                currentValue={c.property_risk_level_detail}
                workspaceId={c.workspace_id}
              />
            }
            block
          />
          <Row
            label="Goal"
            value={
              <MappedFieldEditor
                fieldDef={MAPPABLE_DASHBOARD_FIELDS.find(
                  (f) => f.id === "property_customer_goals"
                )!}
                currentValue={c.property_customer_goals}
                workspaceId={c.workspace_id}
              />
            }
          />
          <Row
            label="Goal detail"
            value={
              <MappedFieldEditor
                fieldDef={MAPPABLE_DASHBOARD_FIELDS.find(
                  (f) => f.id === "property_customer_goals_detail"
                )!}
                currentValue={c.property_customer_goals_detail}
                workspaceId={c.workspace_id}
              />
            }
            block
          />
        </Section>
        {/* CSM-owned stack fields. Override-backed (never from
         *  Metabase/HubSpot), so they save straight to the
         *  customer-overrides KV and survive the twice-daily snapshot
         *  refresh. Same component renders on /account/[id], which
         *  shares no layout code with this panel. Sits between Status
         *  and Dates because it's account context a CSM reads
         *  alongside risk, not a date. */}
        <Section title="Tech & Prior ESP">
          <ProfileFieldsSection
            workspaceId={c.workspace_id}
            priorEsp={c.prior_esp}
            techStack={c.tech_stack}
            techStackNotes={c.tech_stack_notes}
          />
        </Section>
        <Section title="Dates">
          <Row label="Renewal" value={fmtDate(c.renewal_date)} />
          <Row label="Next invoice" value={fmtDate(c.next_invoice ?? null)} />
          <Row label="Last send" value={fmtDate(c.last_send)} />
          {c.workspace_id ? (
            <Row
              label="Send cadence"
              block
              value={
                <SendCadenceEditor
                  workspaceId={c.workspace_id}
                  overrideDays={c.expected_send_cadence_days ?? null}
                  inferredDays={c.inferred_cadence_days ?? null}
                  inferredSampleSize={c.inferred_cadence_sample_size ?? null}
                  inferredUpdatedAt={c.inferred_cadence_updated_at ?? null}
                />
              }
            />
          ) : null}
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
        <Section
          title="Contact"
          trailing={
            c.hubspot_contacts?.length ? (
              <span className="text-[11px] text-subtle tabular-nums">
                {c.hubspot_contacts.length} HubSpot
              </span>
            ) : undefined
          }
        >
          <Row
            label="Main contact"
            value={
              <MappedFieldEditor
                fieldDef={MAPPABLE_DASHBOARD_FIELDS.find(
                  (f) => f.id === "property_main_contact"
                )!}
                currentValue={c.property_main_contact}
                workspaceId={c.workspace_id}
              />
            }
          />
          <Row label="Owner email" value={c.owner_email ?? "—"} />
          <Row label="Timezone" value={c.property_timezone ?? "—"} />
          {/* CSM gets its own row with a "🔄 HubSpot" refresh chip so a
           *  reassignment can land before the next nightly Metabase
           *  snapshot. The component is a "use client" island; the
           *  rest of the panel can stay server-rendered. */}
          <Row label="CSM" value={<CsmRefreshRow customer={c} />} />
          <HubSpotContactsList
            contacts={c.hubspot_contacts}
            workspaceId={c.workspace_id ?? null}
            ownerEmail={c.owner_email}
            ownerName={c.property_main_contact}
          />
        </Section>
      </div>

      {/* Review state — Past Due / Proactive / Renewals dropdowns.
       *  Lives here (not just on the workflow tabs) so a CSM who
       *  spots a wrong setting on one tab can fix it from any
       *  surface where the customer's detail panel appears. */}
      {c.workspace_id ? (
        <ReviewStatesSection workspaceId={c.workspace_id} />
      ) : null}

      {/* Recent news — Google News headlines scoped to this
       *  customer + categorized into structure / staffing / sales-
       *  funding signals. Cached daily by the news-refresh cron;
       *  Refresh button bypasses on demand. Gated on the
       *  `news-feed` feature flag — noisy for CSMs who don't
       *  follow their book externally. */}
      {newsEnabled && c.workspace_id ? (
        <CustomerNewsSection workspaceId={c.workspace_id} />
      ) : null}

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
  trailing,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <CollapsibleSection
      title={title}
      defaultOpen={defaultOpen}
      trailing={trailing}
      bodyClassName=""
    >
      {/* divide-y instead of space-y-N: each row gets a thin border
       *  above + py-2 padding inside, so the rows breathe AND read as
       *  a list. Wrapper is a div (not dl) so mixed content like the
       *  HubSpot contacts block can sit alongside Row items. */}
      <div className="divide-y divide-border/60 px-4 p-2">{children}</div>
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
  // first:pt-0 / last:pb-0 trims the leading + trailing inner
  // padding so a Section doesn't double up on chrome above/below
  // the first/last row. Padding inside rows is what gives the
  // section its rhythm; padding around the section is the
  // CollapsibleSection's job.
  const padClass = "py-2 first:pt-0 last:pb-0";
  if (block) {
    return (
      <div className={`text-sm space-y-1.5 ${padClass}`}>
        <dt className="text-muted text-xs uppercase tracking-wide font-medium">
          {label}
        </dt>
        <dd className="text-fg break-words whitespace-pre-wrap leading-relaxed">
          {value}
        </dd>
      </div>
    );
  }
  return (
    <div className={`flex justify-between items-baseline gap-4 text-sm ${padClass}`}>
      <dt className="text-muted whitespace-nowrap">{label}</dt>
      <dd className="text-fg text-right break-words min-w-0">{value}</dd>
    </div>
  );
}
