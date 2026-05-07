import { notFound } from "next/navigation";
import { loadCustomers } from "@/lib/data/load-customers";
import { fmtCompactCurrency, fmtDate, fmtNumber, fmtPct } from "@/components/format";
import { RiskLevelChip } from "@/components/risk-level-chip";
import { AccountOutreach } from "@/components/account-outreach";

export const dynamic = "force-dynamic";

export default async function AccountPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const decoded = decodeURIComponent(id);
  const all = await loadCustomers();
  const c = all.find(
    (x) =>
      x.workspace_id === decoded ||
      x.stripe_customer_id === decoded ||
      x.workspace_name === decoded
  );
  if (!c) return notFound();

  const utilPct =
    c.percent_of_max_subs != null
      ? c.percent_of_max_subs > 1
        ? c.percent_of_max_subs
        : c.percent_of_max_subs * 100
      : c.active_subs && c.max_subscriptions
        ? (c.active_subs / c.max_subscriptions) * 100
        : null;

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">
          {c.company_name ?? c.workspace_name}
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          {c.workspace_name} · {c.stripe_plan ?? "—"} · CSM:{" "}
          {c.customer_success_manager?.replace(/_/g, " ") ?? "unassigned"}
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Stat label="ARR" value={fmtCompactCurrency(c.arr)} />
        <Stat label="MRR" value={fmtCompactCurrency(c.mrr)} />
        <Stat label="Active subs" value={fmtNumber(c.active_subs)} />
        <Stat label="Sub utilization" value={fmtPct(utilPct)} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <Section title="Status">
          <Row label="Company status" value={c.property_company_status ?? "—"} />
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
          <Row label="Risk detail" value={c.property_risk_level_detail ?? "—"} />
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
        <Section title="Goals">
          <Row label="Goal" value={c.property_customer_goals ?? "—"} />
          <Row
            label="Detail"
            value={
              c.property_customer_goals_detail ? (
                <span className="whitespace-pre-wrap text-sm">
                  {c.property_customer_goals_detail}
                </span>
              ) : (
                "—"
              )
            }
          />
        </Section>
        <Section title="Monetization">
          <Row
            label="Direct sponsorships"
            value={c.direct_sponsorships_enabled ? "✓" : "—"}
          />
          <Row label="Ad placement" value={c.ad_placement ? "✓" : "—"} />
          <Row label="Grew via Boosts" value={c.grew_via_boost ? "✓" : "—"} />
          <Row
            label="Monetization via Boosts"
            value={c.monetization_via_boost ? "✓" : "—"}
          />
        </Section>
        <Section title="Contact">
          <Row label="Main contact" value={c.property_main_contact ?? "—"} />
          <Row label="Owner email" value={c.owner_email ?? "—"} />
          <Row label="Timezone" value={c.property_timezone ?? "—"} />
          <Row
            label="Agency / talent"
            value={c.property_agency_talent ?? "—"}
          />
        </Section>
        <Section title="T4 onboarding">
          <Row
            label="Started"
            value={c.have_started_t4_recommendations ? "✓" : "—"}
          />
          <Row
            label="Completed"
            value={c.completed_t4_recommendations ? "✓" : "—"}
          />
        </Section>
      </div>

      <AccountOutreach customer={c} />
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-2xl font-semibold mt-1">{value}</p>
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
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-semibold text-gray-900 mb-2">{title}</h3>
      <dl className="space-y-1.5">{children}</dl>
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
    <div className="flex justify-between gap-4 text-sm">
      <dt className="text-gray-500 whitespace-nowrap">{label}</dt>
      <dd className="text-gray-900 text-right">{value}</dd>
    </div>
  );
}
