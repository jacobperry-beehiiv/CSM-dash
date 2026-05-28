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
import { CopyButton } from "./copy-button";
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
}

export function CustomerDetailPanel({
  customer: c,
  topSlot,
}: Props) {
  return (
    <div className="space-y-3">
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

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Stat label="ARR" value={fmtCurrency(c.arr)} />
        <Stat label="MRR" value={fmtCurrency(c.mrr)} />
        <Stat label="Active subs" value={fmtNumber(c.active_subs)} />
      </div>

      <CadenceToggle customer={c} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Section title="Status">
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
            <Row label="Risk detail" value={c.property_risk_level_detail} />
          ) : null}
          {c.property_customer_goals ? (
            <Row label="Goal" value={c.property_customer_goals} />
          ) : null}
          {c.property_customer_goals_detail ? (
            <Row
              label="Goal detail"
              value={
                <span className="whitespace-pre-wrap text-sm">
                  {c.property_customer_goals_detail}
                </span>
              }
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
              <span title={`Source: ${lastContacted(c).source}`}>
                {fmtDate(lastContacted(c).date)}
              </span>
            }
          />
        </Section>
        <Section title="Contact">
          <Row label="Main contact" value={c.property_main_contact ?? "—"} />
          <Row label="Owner email" value={c.owner_email ?? "—"} />
          <Row label="Timezone" value={c.property_timezone ?? "—"} />
          <Row label="CSM" value={c.customer_success_manager?.replace(/_/g, " ") ?? "—"} />
        </Section>
      </div>

      <HubSpotContactsSection contacts={c.hubspot_contacts} />

      {c.workspace_id ? (
        <CustomerPublicationsList workspaceId={c.workspace_id} />
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
    <div className="bg-surface rounded-md border border-border p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="text-lg font-semibold mt-0.5">{value}</p>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-surface rounded-md border border-border p-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">
        {title}
      </h4>
      <dl className="space-y-1">{children}</dl>
    </div>
  );
}

function Row({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <dt className="text-muted whitespace-nowrap">{label}</dt>
      <dd className="text-fg text-right break-words min-w-0">{value}</dd>
    </div>
  );
}
