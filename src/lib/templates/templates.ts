import type { Customer } from "../types";

/**
 * Picks which seeded templates apply to a customer based on the same risk
 * patterns the at-risk engine uses. Returns template IDs that match the
 * seeded IDs in src/lib/templates/store.ts so a caller can fetch the
 * full HTML body via the /api/templates API.
 *
 * Storage of the actual template content lives in `./store.ts` (file-backed
 * + editable in the /templates UI).
 */

export type TemplateScenario =
  | "renewal-30d"
  | "dormant-no-send"
  | "growth-push-under-tier"
  | "escalation-yellow-red"
  | "approaching-ent"
  | "general-checkin"
  /** Enterprise Request Loop — Draft outreach for a request that
   *  just shipped. Opens from the Requests section on the customer
   *  profile + the "Live This Week" tab, with a `feature.*` merge
   *  context populated from the shipped request row. Not selected
   *  by suggestTemplates (never auto-suggested); the launcher sets
   *  it explicitly via initialScenario. */
  | "feature-shipped";

export function suggestTemplates(c: Customer): TemplateScenario[] {
  const out: TemplateScenario[] = [];
  const risk = (c.property_risk_level ?? "").toLowerCase();
  if (risk === "red" || risk === "yellow") out.push("escalation-yellow-red");

  if (c.renewal_date) {
    const days = Math.ceil(
      (new Date(c.renewal_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );
    if (days >= 0 && days <= 30) out.push("renewal-30d");
  }

  if (c.last_send) {
    const days = Math.ceil(
      (Date.now() - new Date(c.last_send).getTime()) / (1000 * 60 * 60 * 24)
    );
    if (days >= 10) out.push("dormant-no-send");
  }

  const pctVal = c.percent_of_max_subs;
  if (pctVal != null) {
    const v = pctVal > 1 ? pctVal / 100 : pctVal;
    if (v < 0.75) out.push("growth-push-under-tier");
  }

  const plan = (c.stripe_plan ?? "").toLowerCase();
  const arr = c.arr ?? 0;
  if (
    !plan.includes("enterprise") &&
    (arr >= 100_000 || c.mrr * 12 >= 100_000)
  ) {
    out.push("approaching-ent");
  }

  if (out.length === 0) out.push("general-checkin");
  return out;
}
