/**
 * Exact-dollar formatter — `$1,234,567`. Used everywhere ARR/MRR is
 * shown so CSMs see real numbers instead of rounded "$1.2M" badges.
 */
export function fmtCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

export function fmtNumber(n: number | null | undefined): string {
  if (n == null) return "-";
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return "-";
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null) return "-";
  return `${n.toFixed(digits)}%`;
}

export function fmtRate(n: number | null | undefined, digits = 2): string {
  if (n == null) return "-";
  return `${(n * 100).toFixed(digits)}%`;
}

export function daysUntil(d: string | null): number | null {
  if (!d) return null;
  const ms = new Date(d).getTime() - Date.now();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}
