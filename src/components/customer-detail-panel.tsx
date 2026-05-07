import Link from "next/link";
import type { Customer } from "@/lib/types";
import { fmtCompactCurrency, fmtDate, fmtNumber } from "./format";
import { RiskLevelChip } from "./risk-level-chip";
import { FeatureBreakdown } from "./feature-breakdown";
import { FeatureUtilizationPanel } from "./feature-utilization-panel";
import { AdGapSummary } from "./ad-gap-summary";
import { CadenceToggle } from "./cadence-toggle";

interface Props {
  customer: Customer;
  /** Optional extra slot above the standard sections (e.g. flag list, post metrics). */
  topSlot?: React.ReactNode;
  /** Hide the static FeatureBreakdown grid (Monetization/Growth/Onboarding/Activity).
   *  At-risk view sets this true since the live FeatureUtilizationPanel below
   *  already covers the same ground with real query data. */
  hideFeatureBreakdown?: boolean;
}

export function CustomerDetailPanel({
  customer: c,
  topSlot,
  hideFeatureBreakdown,
}: Props) {
  return (
    <div className="space-y-3">
      {topSlot}

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Stat label="ARR" value={fmtCompactCurrency(c.arr)} />
        <Stat label="MRR" value={fmtCompactCurrency(c.mrr)} />
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
            value={fmtDate(c.property_notes_last_contacted ?? null)}
          />
        </Section>
        <Section title="Contact">
          <Row label="Main contact" value={c.property_main_contact ?? "—"} />
          <Row label="Owner email" value={c.owner_email ?? "—"} />
          <Row label="Timezone" value={c.property_timezone ?? "—"} />
          <Row label="CSM" value={c.customer_success_manager?.replace(/_/g, " ") ?? "—"} />
        </Section>
      </div>

      {hideFeatureBreakdown ? null : <FeatureBreakdown customer={c} />}

      <FeatureUtilizationPanel workspaceId={c.workspace_id} />

      <AdGapSummary organizationId={c.workspace_id} />

      <div className="text-xs">
        {c.workspace_id ? (
          <Link
            href={`/account/${encodeURIComponent(c.workspace_id)}`}
            className="text-blue-600 hover:underline"
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
    <div className="bg-white rounded-md border border-gray-200 p-3">
      <p className="text-xs text-gray-500">{label}</p>
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
    <div className="bg-white rounded-md border border-gray-200 p-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
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
      <dt className="text-gray-500 whitespace-nowrap">{label}</dt>
      <dd className="text-gray-900 text-right break-words min-w-0">{value}</dd>
    </div>
  );
}
