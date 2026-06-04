"use client";

import { fmtCurrency, fmtNumber } from "./format";
import { CollapsibleSection } from "./collapsible-section";
import { useWorkspacePaidSubs } from "@/lib/hooks/customer-paid-subs-cache";

/**
 * Per-workspace paid-subscriptions summary. Shows which tiers currently
 * have active subscribers (grouped by publication) and the lifetime
 * revenue earned via beehiiv's paid-subs product.
 *
 * "Active paid subscriber" matches the canonical Metabase definition
 * (q3402/3403/3404): subscription with `status='active' AND
 * deleted_at IS NULL`, joined to a tier via subscription_tiers.
 *
 * Renders nothing-of-value when the workspace has zero tiers with
 * active subs — the section header still collapses cleanly so it
 * doesn't add clutter for publishers who haven't turned monetization
 * on.
 */

interface Props {
  workspaceId: string;
}

export function CustomerPaidSubsList({ workspaceId }: Props) {
  const state = useWorkspacePaidSubs(workspaceId);
  const summary =
    state && !(state instanceof Error) ? state : null;
  const error = state instanceof Error ? state.message : null;

  const tierCount = summary?.tiers.length ?? 0;
  const titleSuffix = summary ? ` (${tierCount})` : "";

  // Group tiers by publication so the UI reads "publication → tiers"
  // instead of an unsorted flat list. Most workspaces only have one
  // pub, but the few with multiple should still scan cleanly.
  const grouped = summary
    ? Object.entries(
        summary.tiers.reduce<
          Record<
            string,
            {
              publication_id: string;
              publication_name: string;
              tiers: typeof summary.tiers;
            }
          >
        >((acc, t) => {
          const key = t.publication_id;
          if (!acc[key]) {
            acc[key] = {
              publication_id: t.publication_id,
              publication_name: t.publication_name,
              tiers: [],
            };
          }
          acc[key].tiers.push(t);
          return acc;
        }, {})
      ).map(([, v]) => v)
    : [];

  return (
    <CollapsibleSection
      title={`Paid subscriptions${titleSuffix}`}
      // Body owns padding because the empty/loading/list states need
      // different visual treatments.
      bodyClassName=""
    >
      {error ? (
        <div className="p-3 text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-500/10">
          Paid-subs fetch failed: {error}
        </div>
      ) : summary === null ? (
        <div className="p-3 text-sm text-muted">Loading…</div>
      ) : summary.tiers.length === 0 ? (
        <div className="p-3 text-sm text-muted">
          No paid tiers with active subscribers.
          {summary.total_revenue_lifetime > 0 ? (
            <>
              {" "}
              Lifetime revenue:{" "}
              <strong>{fmtCurrency(summary.total_revenue_lifetime)}</strong>{" "}
              (historical — current subscribers have all churned or moved to
              another tier).
            </>
          ) : null}
        </div>
      ) : (
        <div className="divide-y divide-border">
          {grouped.map((g) => (
            <div key={g.publication_id} className="px-4 py-3">
              <div className="text-xs font-medium text-muted uppercase tracking-wide mb-1">
                {g.publication_name || "(unnamed publication)"}
              </div>
              <ul className="space-y-1">
                {g.tiers.map((t) => (
                  <li
                    key={t.tier_id}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="text-fg">{t.tier_name}</span>
                    <span className="text-muted">
                      {fmtNumber(t.active_subs)} active
                      {t.active_subs === 1 ? " sub" : " subs"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="px-4 py-3 bg-canvas/40 flex items-center justify-between text-sm">
            <span className="text-muted">
              <strong className="text-fg">
                {fmtNumber(summary.total_active_subs)}
              </strong>{" "}
              total active paid sub
              {summary.total_active_subs === 1 ? "" : "s"}
            </span>
            <span
              className="text-muted"
              title="Lifetime gross revenue (SUM of cash from materialized_stripe_saas_metrics_fallback)"
            >
              <strong className="text-fg">
                {fmtCurrency(summary.total_revenue_lifetime)}
              </strong>{" "}
              lifetime
            </span>
          </div>
        </div>
      )}
    </CollapsibleSection>
  );
}
