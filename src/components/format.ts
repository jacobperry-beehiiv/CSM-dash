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

/** Normalize a Date to local midnight (clears the time-of-day). Used
 *  by the calendar-day diff helpers below so we never get a fractional
 *  day from comparing "midnight UTC on the source date" against
 *  "current wall-clock time in the viewer's timezone". */
function localMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Whole calendar days between `d` and today, where today is `today` in
 * the viewer's local timezone. Positive = `d` is in the future,
 * negative = `d` is in the past, 0 = same calendar day. Returns null
 * for empty / unparseable input.
 *
 * Why this and not raw ms division: a column like `next_invoice` that
 * arrives as "2026-06-02" gets parsed by `new Date(...)` as midnight
 * UTC. A viewer in a +HH timezone watching the same row at 11am on
 * June 2 local sees `now > parsed` (because local midnight already
 * happened in their TZ but UTC midnight hasn't yet) — raw ms math
 * then `Math.ceil`s to 1 and the row reads "1 day until" on the day
 * it's already due. Local-midnight normalization sidesteps the whole
 * mess. Math.round absorbs the 23 / 25h hops on DST transition days.
 */
export function daysUntil(d: string | null): number | null {
  if (!d) return null;
  const parsed = new Date(d);
  if (isNaN(parsed.getTime())) return null;
  const ms =
    localMidnight(parsed).getTime() - localMidnight(new Date()).getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

/** Whole calendar days since `d`. Mirror of daysUntil for "last X" UI
 *  copy ("3d ago"). Clamps to 0 for future timestamps so a clock skew
 *  on the source can't surface as "-1d ago" — the at-risk table
 *  shouldn't ever count down. Returns null for unparseable input. */
export function daysAgo(d: string | null | undefined): number | null {
  if (!d) return null;
  const parsed = new Date(d);
  if (isNaN(parsed.getTime())) return null;
  const ms =
    localMidnight(new Date()).getTime() - localMidnight(parsed).getTime();
  return Math.max(0, Math.round(ms / (1000 * 60 * 60 * 24)));
}
