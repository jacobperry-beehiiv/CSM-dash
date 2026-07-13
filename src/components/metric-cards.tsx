import { fmtCurrency, fmtNumber } from "./format";
import type { CustomerWithMetrics } from "@/lib/types";

export function MetricCards({ customers }: { customers: CustomerWithMetrics[] }) {
  const totalArr = customers.reduce((s, c) => s + c.arr, 0);
  const totalMrr = customers.reduce((s, c) => s + c.mrr, 0);
  // Total active subscribers across the currently-visible book. Uses
  // active_subs (post-cleanse counts from q10600). Customers whose
  // row is missing active_subs contribute 0 rather than NaN.
  const totalSubs = customers.reduce((s, c) => s + (c.active_subs ?? 0), 0);

  const now = new Date();
  const thirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const renewalsSoon = customers.filter((c) => {
    if (!c.renewal_date) return false;
    const d = new Date(c.renewal_date);
    return d >= now && d <= thirtyDays;
  }).length;

  const cards = [
    { label: "Customers", value: String(customers.length) },
    { label: "Total ARR", value: fmtCurrency(totalArr) },
    { label: "Total MRR", value: fmtCurrency(totalMrr) },
    { label: "Subscribers supported", value: fmtNumber(totalSubs) },
    { label: "Renewals (30d)", value: String(renewalsSoon) },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
      {cards.map((card) => (
        <div
          key={card.label}
          className="bg-surface rounded-xl border border-border shadow-card px-5 py-5"
        >
          <p className="text-[13px] text-muted">{card.label}</p>
          <p className="text-[28px] leading-tight font-semibold mt-1 text-fg tracking-tight">
            {card.value}
          </p>
        </div>
      ))}
    </div>
  );
}
