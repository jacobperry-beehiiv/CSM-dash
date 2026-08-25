import type { Customer } from "@/lib/types";

/**
 * Shared renewal-date helpers used by both the client-side RenewalPanel
 * and the server-side milestone engine. Pure functions — no imports
 * from React or Node-only modules — so this file is safe to include in
 * either surface.
 *
 * Three anchors, each answering a different question:
 *   • `contractRenewalDate` — when the CONTRACT is up. Sourced from
 *     HubSpot's `contract_renewal` field. This is the anchor CSMs
 *     care about for renewal outreach and pricing conversations, and
 *     it's what the Renewals tab buckets by. Returns null for
 *     accounts where HubSpot hasn't populated the field — those
 *     surface in the tab's "Uncontracted" bucket as a data gap.
 *   • `nextPaymentDate` — when the customer is next charged.
 *     Sourced from Stripe's `next_invoice` (or `renewal_date` as
 *     fallback), with monthly-cadence day-of-month roll-forward.
 *     Used for anything payment-lifecycle related (past-due panel,
 *     next-charge column, at-risk signals, template merge tags).
 *     Named `nextRenewalDate` historically because we hadn't yet
 *     separated "next charge" from "contract renewal" as concepts.
 *   • `priorRenewalDate` — the inferred most-recent past renewal
 *     (used by the Calendar tab to backfill already-renewed rows for
 *     the picked month).
 *
 * `daysUntilRenewal` gives an integer whole-day count with UTC
 * midnight normalization, matching the semantics of the panel's
 * `daysUntil` but without pulling in the local-TZ helper.
 */

/**
 * Returns HubSpot's `contract_renewal` value for the customer, or
 * null when it hasn't been populated. Wrapped as a helper (rather
 * than inlined at every callsite) so future logic — year-1 midpoint
 * milestone for multi-year deals, contract-length override from a
 * separate HubSpot property, CSM manual overrides — has a single
 * anchor point to extend.
 */
export function contractRenewalDate(c: Customer): string | null {
  return c.contract_renewal ?? null;
}

/**
 * Computes the customer's next PAYMENT date (previously named
 * `nextRenewalDate`).
 *
 * Monthly customers' `next_invoice` from Stripe can drift far past 30
 * days (it represents the end of the current paid period, not the
 * next monthly charge). For monthly cadences we take the day-of-month
 * from next_invoice and roll forward to the next occurrence from
 * today. Annual / other cadences use the date as-is.
 *
 * DO NOT use this for renewal-outreach decisions — use
 * `contractRenewalDate` instead. `nextPaymentDate` answers "when is
 * Stripe about to bill them," which is not the same as "when is the
 * contract up."
 */
export function nextPaymentDate(c: Customer): string | null {
  const baseStr = c.next_invoice ?? c.renewal_date;
  if (!baseStr) return null;
  const base = new Date(baseStr);
  if (isNaN(base.getTime())) return null;

  const interval = (c.interval ?? "").toLowerCase();
  const isMonthly = interval === "month" || interval === "monthly";
  if (!isMonthly) return baseStr;

  const day = base.getUTCDate();
  const now = new Date();
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  let candidate = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day);
  if (candidate < today) {
    candidate = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, day);
  }
  return new Date(candidate).toISOString();
}

/**
 * Infer the customer's MOST-RECENT past renewal date by walking
 * backwards from their forward-looking renewal date one cadence-step
 * at a time. So an annual customer whose `next_invoice` has rolled
 * forward to 2027-06-05 implies a prior renewal on 2026-06-05.
 *
 * Returns null when the customer is monthly, churned, the inferred
 * prior is absurdly old (>5y — usually wrong cadence), or the base
 * date is already in the past (in which case `nextPaymentDate` is the
 * right surface for the row instead).
 */
export function priorRenewalDate(c: Customer): string | null {
  const baseStr = c.next_invoice ?? c.renewal_date;
  if (!baseStr) return null;
  const base = new Date(baseStr);
  if (isNaN(base.getTime())) return null;

  const now = Date.now();
  if (base.getTime() <= now) return null;

  let monthsBack: number | null = null;
  if (typeof c.interval_count === "number" && c.interval_count > 0) {
    if (c.interval_count === 1) return null;
    monthsBack = c.interval_count;
  } else {
    const t = (c.interval ?? "").trim().toLowerCase();
    if (t === "year" || t === "annual" || t === "yearly") monthsBack = 12;
    else if (t === "quarter" || t === "quarterly") monthsBack = 3;
    else if (t === "month" || t === "monthly") return null;
  }
  if (!monthsBack) return null;

  let cur = base;
  let safety = 12;
  while (cur.getTime() > now && safety-- > 0) {
    cur = new Date(
      Date.UTC(
        cur.getUTCFullYear(),
        cur.getUTCMonth() - monthsBack,
        cur.getUTCDate()
      )
    );
  }
  if (cur.getTime() > now) return null;

  const fiveYearsMs = 5 * 365 * 24 * 60 * 60 * 1000;
  if (now - cur.getTime() > fiveYearsMs) return null;
  return cur.toISOString();
}

/**
 * Whole-day distance from `now` to the parsed date, using UTC midnight
 * normalization on both sides. Positive = future, negative = past,
 * 0 = same UTC calendar day.
 *
 * Server-safe alternative to `daysUntil` in `src/components/format.ts`
 * (which uses local-TZ midnight). The milestone engine runs in UTC
 * on Vercel, so we want deterministic day-boundaries that don't drift
 * with DST or the runtime's timezone.
 */
export function daysUntilRenewal(
  dateStr: string | null,
  now: Date = new Date()
): number | null {
  if (!dateStr) return null;
  const parsed = new Date(dateStr);
  if (isNaN(parsed.getTime())) return null;

  const target = Date.UTC(
    parsed.getUTCFullYear(),
    parsed.getUTCMonth(),
    parsed.getUTCDate()
  );
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  return Math.round((target - today) / (1000 * 60 * 60 * 24));
}
