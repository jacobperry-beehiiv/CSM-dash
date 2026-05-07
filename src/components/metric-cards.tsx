import { fmtCompactCurrency } from "./format";
import type { CustomerWithMetrics } from "@/lib/types";

export function MetricCards({ customers }: { customers: CustomerWithMetrics[] }) {
  const totalArr = customers.reduce((s, c) => s + c.arr, 0);
  const totalMrr = customers.reduce((s, c) => s + c.mrr, 0);

  const now = new Date();
  const thirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const renewalsSoon = customers.filter((c) => {
    if (!c.renewal_date) return false;
    const d = new Date(c.renewal_date);
    return d >= now && d <= thirtyDays;
  }).length;

  const cards = [
    { label: "Customers", value: String(customers.length) },
    { label: "Total ARR", value: fmtCompactCurrency(totalArr) },
    { label: "Total MRR", value: fmtCompactCurrency(totalMrr) },
    { label: "Renewals (30d)", value: String(renewalsSoon) },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      {cards.map((card) => (
        <div
          key={card.label}
          className="bg-white rounded-lg border border-gray-200 p-4"
        >
          <p className="text-sm text-gray-500">{card.label}</p>
          <p className="text-2xl font-semibold mt-1">{card.value}</p>
        </div>
      ))}
    </div>
  );
}
