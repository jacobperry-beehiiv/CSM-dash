import { notFound } from "next/navigation";
import { loadCustomers } from "@/lib/data/load-customers";
import { lastContacted } from "@/lib/customer-helpers";
import { listSignals } from "@/lib/data/customer-signals";
import { hubspotCompanyUrl } from "@/lib/links";
import { fmtCurrency, fmtDate, fmtNumber, fmtPct } from "@/components/format";
import { RiskLevelChip } from "@/components/risk-level-chip";
import { AccountOutreach } from "@/components/account-outreach";
import { HubSpotContactsSection } from "@/components/hubspot-contacts-section";
import { CustomerSignalsSection } from "@/components/customer-signals-section";
import { CustomerPublicationsList } from "@/components/customer-publications-list";
import { AccountProfileFields } from "@/components/account-profile-fields";
import { loadProfileFieldOptions } from "@/lib/data/profile-field-options";

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

  // Fetch the signals stream (notes, touchpoints, risk signals, etc.)
  // posted via /api/customer-signals. Empty array when nothing's been
  // posted yet — the section renders a friendly empty state.
  const signals = c.workspace_id ? await listSignals(c.workspace_id) : [];

  // Shared, admin-managed option lists for the Prior ESP / Tech Stack
  // editors below.
  const profileOptions = await loadProfileFieldOptions();

  const utilPct =
    c.percent_of_max_subs != null
      ? c.percent_of_max_subs > 1
        ? c.percent_of_max_subs
        : c.percent_of_max_subs * 100
      : c.active_subs && c.max_subscriptions
        ? (c.active_subs / c.max_subscriptions) * 100
        : null;

  // HubSpot company-page deep link — set when the row has a
  // hubspot_company_id from the sync-time enrichment.
  const hubspotUrl = hubspotCompanyUrl(c.hubspot_company_id);

  return (
    <>
      <div className="mb-6">
        <h1 className="text-3xl font-semibold text-fg tracking-tight flex items-baseline gap-3 flex-wrap">
          <span>{c.company_name ?? c.workspace_name}</span>
          {hubspotUrl ? (
            <a
              href={hubspotUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-normal text-muted hover:text-fg underline decoration-dotted"
              title="Open this company in HubSpot"
            >
              HubSpot ↗
            </a>
          ) : null}
        </h1>
        <p className="text-sm text-muted mt-1">
          {c.workspace_name} · {c.stripe_plan ?? "—"} · CSM:{" "}
          {c.customer_success_manager?.replace(/_/g, " ") ?? "unassigned"}
          {c.owner_email ? (
            <>
              {" · "}
              <a
                href={`mailto:${c.owner_email}`}
                className="hover:text-fg underline decoration-dotted"
              >
                {c.owner_email}
              </a>
            </>
          ) : null}
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Stat label="ARR" value={fmtCurrency(c.arr)} />
        <Stat label="MRR" value={fmtCurrency(c.mrr)} />
        <Stat label="Active subs" value={fmtNumber(c.active_subs)} />
        <Stat label="Sub utilization" value={fmtPct(utilPct)} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <AccountProfileFields
          workspaceId={c.workspace_id}
          priorEsp={c.prior_esp ?? null}
          techStack={c.tech_stack ?? null}
          priorEspOptions={profileOptions.priorEsp}
          techStackOptions={profileOptions.techStack}
        />
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
            value={
              <span title={`Source: ${lastContacted(c).source}`}>
                {fmtDate(lastContacted(c).date)}
              </span>
            }
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

      <div className="mb-6">
        <CustomerSignalsSection signals={signals} />
      </div>

      <HubSpotContactsSection
        contacts={c.hubspot_contacts}
        ownerEmail={c.owner_email}
        ownerName={c.property_main_contact}
      />

      {/* Publications list — every newsletter associated with this
       *  workspace, with subscriber counts and per-pub metabase deep
       *  links. The detail panel inside the customer table already
       *  shows this; surfacing it here too means the standalone
       *  /account view doesn't omit something a CSM expects to
       *  find. Renders nothing when the workspace has no
       *  publications (cancelled workspace, etc.). */}
      {c.workspace_id ? (
        <div className="mb-6">
          <CustomerPublicationsList workspaceId={c.workspace_id} />
        </div>
      ) : null}

      <AccountOutreach customer={c} />
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface rounded-xl border border-border shadow-card p-4">
      <p className="text-sm text-muted">{label}</p>
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
    <div className="bg-surface rounded-xl border border-border shadow-card p-4">
      <h3 className="font-semibold text-fg mb-2">{title}</h3>
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
      <dt className="text-muted whitespace-nowrap">{label}</dt>
      <dd className="text-fg text-right">{value}</dd>
    </div>
  );
}
