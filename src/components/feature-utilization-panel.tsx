"use client";

import { useEffect, useState } from "react";
import type { FeatureUtilization } from "@/lib/engines/feature-utilization";
import { fmtCurrency, fmtDate, fmtNumber } from "./format";
import { CollapsibleSection } from "./collapsible-section";

interface Props {
  workspaceId: string | null | undefined;
}

export function FeatureUtilizationPanel({ workspaceId }: Props) {
  const [data, setData] = useState<FeatureUtilization | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/feature-utilization?org=${encodeURIComponent(workspaceId)}`)
      .then(async (r) => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<FeatureUtilization>;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Unknown");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  if (!workspaceId) return null;

  if (loading) {
    return (
      <div className="bg-surface rounded-md border border-border p-3 flex items-center gap-2 text-sm text-muted">
        <span className="inline-block w-3 h-3 border-2 border-border-strong border-t-gray-700 rounded-full animate-spin" />
        Loading feature utilization…
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-md p-3 text-sm text-red-800 dark:text-red-300">
        Could not load feature utilization: {error}
      </div>
    );
  }

  if (!data) return null;

  return (
    <CollapsibleSection
      title="Feature utilization"
      trailing={
        <span className="text-[10px] text-subtle">
          live · {fmtDate(data.generated_at)}
        </span>
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        <Feature
          name="MCP"
          used={data.mcp_calls > 0}
          rows={[
            ["Last call", fmtDate(data.mcp_last_call)],
            ["Total calls", fmtNumber(data.mcp_calls)],
          ]}
        />
        <Feature
          name="Podcasts"
          used={data.podcast_episodes > 0}
          rows={[
            ["Shows", fmtNumber(data.podcast_shows)],
            ["Episodes", fmtNumber(data.podcast_episodes)],
            ["Last episode", fmtDate(data.podcast_last_episode)],
          ]}
        />
        <Feature
          name="Ad Network"
          used={data.ad_network_count > 0}
          rows={[
            ["Ads run", fmtNumber(data.ad_network_count)],
            ["Last run", fmtDate(data.ad_network_last_run)],
            ["Revenue", fmtCurrency(data.ad_network_revenue_usd)],
          ]}
        />
        <Feature
          name="Direct Sponsorships"
          used={data.direct_sponsorship_count > 0}
          rows={[
            ["Total", fmtNumber(data.direct_sponsorship_count)],
            ["Last run", fmtDate(data.direct_sponsorship_last_run)],
            ["Revenue", fmtCurrency(data.direct_sponsorship_revenue_usd)],
          ]}
        />
        <Feature
          name="Automations"
          used={data.automations_total > 0}
          activeBadge={
            data.automations_active > 0
              ? `${data.automations_active} active`
              : null
          }
          rows={[
            ["Total", fmtNumber(data.automations_total)],
            ["Last edited", fmtDate(data.automations_last_edited)],
            ["Last published", fmtDate(data.automations_last_published)],
          ]}
        />
        <Feature
          name="Segments"
          used={data.segments_total > 0}
          rows={[
            ["Total", fmtNumber(data.segments_total)],
            ["Last created", fmtDate(data.segments_last_created)],
            ["Last used", fmtDate(data.segments_last_used)],
          ]}
        />
        <Feature
          name="Boost — Monetize"
          used={data.boost_monetize_agreements > 0}
          rows={[
            ["Agreements", fmtNumber(data.boost_monetize_agreements)],
            ["Last send", fmtDate(data.boost_monetize_last_send)],
            [
              "Potential payout",
              fmtCurrency(data.boost_monetize_potential_payout_usd),
            ],
          ]}
        />
        <Feature
          name="Boost — Grow"
          used={data.boost_grow_offers > 0}
          rows={[
            ["Offers", fmtNumber(data.boost_grow_offers)],
            ["Last offer", fmtDate(data.boost_grow_last_offer)],
            ["Allocated", fmtCurrency(data.boost_grow_allocated_spend_usd)],
          ]}
        />
        <Feature
          name="Referrals"
          used={data.referral_program_created != null}
          activeBadge={
            data.referral_program_active === false ? "disabled" : null
          }
          rows={[["Created", fmtDate(data.referral_program_created)]]}
        />
        <Feature
          name="Polls"
          used={data.polls_total > 0}
          rows={[
            ["Total", fmtNumber(data.polls_total)],
            ["Last poll", fmtDate(data.polls_last_created)],
            ["Last response", fmtDate(data.polls_last_response)],
          ]}
        />
        <Feature
          name="T4 / Recommendations"
          used={data.t4_completed_at != null}
          activeBadge={
            data.t4_active_recs > 0 ? `${data.t4_active_recs} active` : null
          }
          rows={[
            ["Completed", fmtDate(data.t4_completed_at)],
            ["Total recs", fmtNumber(data.t4_total_recs)],
            ["Status", data.t4_status ?? "—"],
          ]}
        />
      </div>
    </CollapsibleSection>
  );
}

function Feature({
  name,
  used,
  rows,
  activeBadge,
}: {
  name: string;
  used: boolean;
  rows: [string, string][];
  activeBadge?: string | null;
}) {
  return (
    <div
      className={`rounded border p-2.5 ${
        used
          ? "border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/40"
          : "border-border bg-canvas/40"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={`text-sm font-medium ${
            used ? "text-fg" : "text-muted"
          }`}
        >
          {name}
        </span>
        <div className="flex items-center gap-1">
          {activeBadge ? (
            <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-500/30">
              {activeBadge}
            </span>
          ) : null}
          <span
            className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold border ${
              used
                ? "bg-emerald-100 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/30"
                : "bg-surface-2 text-muted border-border"
            }`}
          >
            {used ? "Active" : "Not used"}
          </span>
        </div>
      </div>
      <dl className="mt-1.5 space-y-0.5">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between text-xs">
            <dt className="text-muted">{label}</dt>
            <dd className="text-fg">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
