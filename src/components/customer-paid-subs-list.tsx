"use client";

import { fmtCurrency, fmtNumber } from "./format";
import { CollapsibleSection } from "./collapsible-section";
import {
  useWorkspacePaidSubs,
  type TierPrice,
} from "@/lib/hooks/customer-paid-subs-cache";

/**
 * Per-workspace paid-subscriptions summary. Surfaces every paid tier
 * the publisher currently OFFERS — including tiers with zero subs —
 * with the prices configured against each, plus active-sub counts and
 * lifetime gross revenue.
 *
 * "Offered" = `tiers.default = false AND prices.enabled = true` (see
 * the route docstring). "Active paid subscriber" matches the canonical
 * Metabase definition from q3402/3403/3404.
 *
 * Sort order is highest-converted-tier first so the CSM scans the
 * tiers most worth talking about at the top, and an unused $50/mo tier
 * the publisher set up but never sold to anyone shows at the bottom.
 */

interface Props {
  workspaceId: string;
}

/** "$5.00 / month" or "$50.00 / year" or "$10.00 one-time" — keeps
 *  cents resolution because publishers do price like $4.99 and rounding
 *  to whole dollars would lie. Multiplies cents → dollars locally;
 *  `fmtCurrency` itself rounds to whole dollars which is the wrong
 *  default for tier prices. */
function formatPrice(p: TierPrice): string {
  const dollars = (p.amount_cents ?? 0) / 100;
  // Show cents when there's a non-zero fractional part; otherwise
  // hide them so "$5" reads cleaner than "$5.00".
  const amount = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: (p.currency || "usd").toUpperCase(),
    minimumFractionDigits: dollars % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(dollars);
  const interval = p.interval.toLowerCase();
  if (interval === "month") return `${amount} / mo`;
  if (interval === "year") return `${amount} / yr`;
  if (interval === "week") return `${amount} / wk`;
  if (interval === "day") return `${amount} / day`;
  if (interval === "one_time" || interval === "one-time") {
    return `${amount} one-time`;
  }
  if (interval === "donation" || interval === "name your price") {
    return "Name your price";
  }
  // Unknown interval — fall back to "$X / <raw>" rather than dropping
  // the signal entirely.
  return interval ? `${amount} / ${interval}` : amount;
}

export function CustomerPaidSubsList({ workspaceId }: Props) {
  const state = useWorkspacePaidSubs(workspaceId);
  const summary =
    state && !(state instanceof Error) ? state : null;
  const error = state instanceof Error ? state.message : null;

  const tierCount = summary?.tiers.length ?? 0;
  const titleSuffix = summary ? ` (${tierCount})` : "";

  // Group tiers by publication so multi-newsletter workspaces stay
  // readable. The endpoint sorts by active_subs DESC; preserve that
  // order within each publication group by appending in iteration order.
  const grouped = summary
    ? (() => {
        const groups: Array<{
          publication_id: string;
          publication_name: string;
          tiers: typeof summary.tiers;
        }> = [];
        const idx = new Map<string, number>();
        for (const t of summary.tiers) {
          const at = idx.get(t.publication_id);
          if (at == null) {
            idx.set(t.publication_id, groups.length);
            groups.push({
              publication_id: t.publication_id,
              publication_name: t.publication_name,
              tiers: [t],
            });
          } else {
            groups[at].tiers.push(t);
          }
        }
        return groups;
      })()
    : [];

  return (
    <CollapsibleSection
      title={`Paid subscriptions${titleSuffix}`}
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
          No paid tiers offered (publisher hasn't enabled monetization).
          {summary.total_revenue_lifetime > 0 ? (
            <>
              {" "}
              Lifetime revenue still on file:{" "}
              <strong>{fmtCurrency(summary.total_revenue_lifetime)}</strong>{" "}
              (historical — tiers have since been retired).
            </>
          ) : null}
        </div>
      ) : (
        <div className="divide-y divide-border">
          {grouped.map((g) => (
            <div key={g.publication_id} className="px-4 py-3">
              <div className="text-xs font-medium text-muted uppercase tracking-wide mb-2">
                {g.publication_name || "(unnamed publication)"}
              </div>
              <ul className="space-y-2">
                {g.tiers.map((t) => (
                  <li
                    key={t.tier_id}
                    className="flex flex-col gap-0.5"
                  >
                    <div className="flex items-center justify-between text-sm gap-3">
                      <span className="text-fg font-medium">{t.tier_name}</span>
                      <span
                        className={
                          t.active_subs > 0
                            ? "text-muted shrink-0"
                            : "text-subtle shrink-0"
                        }
                      >
                        {fmtNumber(t.active_subs)} active
                        {t.active_subs === 1 ? " sub" : " subs"}
                      </span>
                    </div>
                    <div className="text-xs text-muted flex flex-wrap gap-x-3 gap-y-0.5 pl-0.5">
                      {t.prices.length === 0 ? (
                        <span className="text-subtle italic">
                          No enabled prices
                        </span>
                      ) : (
                        t.prices.map((p) => (
                          <span key={p.price_id} className="whitespace-nowrap">
                            {formatPrice(p)}
                          </span>
                        ))
                      )}
                    </div>
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
