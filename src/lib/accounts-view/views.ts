import type { Customer } from "@/lib/types";
import { lastContacted, subUtilFraction } from "@/lib/customer-helpers";

/**
 * Saved views for the three-pane Accounts surface.
 *
 * Each of these is a tab today. The whole point of the surface is that
 * they stop being separate pages and become filters over ONE list, so
 * switching between them doesn't lose your place or reset your scroll.
 *
 * Kept as pure predicates over `Customer` — no KV, no engines, no
 * fetches — so the client can re-filter instantly as you click between
 * views. Anything needing an engine (deliverability alerts, at-risk
 * flag scoring) deliberately isn't here: those cost a sweep to compute
 * and would make view-switching a round-trip, which is exactly the
 * feel this design exists to avoid. They stay on their own tabs until
 * there's a cached per-workspace signal to filter on.
 */

export type ViewId =
  | "book"
  | "renewing"
  | "risk"
  | "quiet"
  | "requests";

export interface ViewDef {
  id: ViewId;
  label: string;
  /** One line under the list header, so the filter explains itself
   *  rather than leaving you to infer what you're looking at. */
  blurb: string;
}

export const VIEWS: ReadonlyArray<ViewDef> = [
  {
    id: "book",
    label: "My book",
    blurb: "Every account assigned to you, most recently engaged first.",
  },
  {
    id: "renewing",
    label: "Renewing < 90d",
    blurb: "Renewal date inside 90 days, soonest first.",
  },
  {
    id: "risk",
    label: "At risk",
    blurb: "Risk level is Red or Yellow in HubSpot.",
  },
  {
    id: "quiet",
    label: "No contact 30d",
    blurb:
      "Nothing logged in 30 days — Gmail, HubSpot activity, or a note.",
  },
  {
    id: "requests",
    label: "Open requests",
    blurb: "At least one feature request still in flight.",
  },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from now until `iso`. Negative when it's already past.
 *  Null when there's no usable date, which callers treat as "unknown"
 *  rather than "never" — a missing renewal date is a data gap, not a
 *  statement that the account doesn't renew. */
export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.floor((ms - Date.now()) / DAY_MS);
}

/** Whole days since `iso`, or null when unusable. */
export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.floor((Date.now() - ms) / DAY_MS);
}

/** Open-request count per workspace, from
 *  /api/enterprise-requests/open-workspaces. Empty when the requests
 *  feature is off for this viewer — the view then matches nothing
 *  rather than erroring. */
export type OpenRequestCounts = Record<
  string,
  { open: number; shipped: number; total: number }
>;

export function matchesView(
  c: Customer,
  view: ViewId,
  counts: OpenRequestCounts
): boolean {
  switch (view) {
    case "book":
      return true;
    case "renewing": {
      const d = daysUntil(c.renewal_date);
      // Past-due renewals stay in — an overdue renewal is more urgent
      // than one 80 days out, and dropping it here would hide it.
      return d !== null && d <= 90;
    }
    case "risk": {
      const level = (c.property_risk_level ?? "").trim().toLowerCase();
      return level === "red" || level === "yellow";
    }
    case "quiet": {
      const d = daysSince(lastContacted(c).date);
      // Null means we have no contact record at all, which is the
      // loudest possible version of "you haven't spoken".
      return d === null || d >= 30;
    }
    case "requests":
      return (counts[c.workspace_id ?? ""]?.open ?? 0) > 0;
  }
}

/**
 * The severity rail on a list row, and what the row sorts by.
 *
 * Three levels only. A four- or five-level scale reads as precision
 * the underlying data doesn't have — these come from a renewal date,
 * a HubSpot enum and a contact timestamp, not a model.
 */
export type Severity = "urgent" | "watch" | "calm";

export const SEVERITY_RANK: Record<Severity, number> = {
  urgent: 0,
  watch: 1,
  calm: 2,
};

export interface RowSignal {
  severity: Severity;
  /** The single most useful sentence about this account right now.
   *  One line, not a list — the preview pane is where detail goes. */
  line: string;
}

/**
 * Reduce an account to one severity and one sentence.
 *
 * Deliberately returns the SINGLE strongest reason rather than
 * concatenating every signal. A row that says three things says
 * nothing; the list is for scanning and the preview pane is for
 * detail. Order below is the priority order.
 */
export function rowSignal(
  c: Customer,
  counts: OpenRequestCounts
): RowSignal {
  const renewIn = daysUntil(c.renewal_date);
  const quietFor = daysSince(lastContacted(c).date);
  const risk = (c.property_risk_level ?? "").trim().toLowerCase();
  const open = counts[c.workspace_id ?? ""]?.open ?? 0;

  // Renewal inside 30 days with no recent contact is the one
  // combination worth shouting about.
  if (renewIn !== null && renewIn >= 0 && renewIn <= 30) {
    if (quietFor !== null && quietFor >= 30) {
      return {
        severity: "urgent",
        line: `Renews in ${renewIn}d · no contact in ${quietFor}d`,
      };
    }
    return { severity: "urgent", line: `Renews in ${renewIn}d` };
  }
  if (renewIn !== null && renewIn < 0) {
    return {
      severity: "urgent",
      line: `Renewal date passed ${Math.abs(renewIn)}d ago`,
    };
  }
  if (risk === "red") {
    return {
      severity: "urgent",
      line: c.property_risk_level_detail?.trim()
        ? `Red · ${c.property_risk_level_detail.trim()}`
        : "Marked Red in HubSpot",
    };
  }
  // No contact record at all. This is what puts the account in the
  // "No contact 30d" view, so the row has to say so — otherwise a row
  // sitting in that view reads "Nothing outstanding", which is the
  // opposite of true.
  if (quietFor === null) {
    return { severity: "watch", line: "No contact on record" };
  }
  if (quietFor >= 60) {
    return { severity: "watch", line: `No contact in ${quietFor}d` };
  }
  if (risk === "yellow") {
    return {
      severity: "watch",
      line: c.property_risk_level_detail?.trim()
        ? `Yellow · ${c.property_risk_level_detail.trim()}`
        : "Marked Yellow in HubSpot",
    };
  }
  if (renewIn !== null && renewIn <= 90) {
    return { severity: "watch", line: `Renews in ${renewIn}d` };
  }
  const util = subUtilFraction(c);
  if (util !== null && util < 0.5) {
    return {
      severity: "watch",
      line: `Using ${Math.round(util * 100)}% of their subscriber ceiling`,
    };
  }
  if (quietFor >= 30) {
    return { severity: "watch", line: `No contact in ${quietFor}d` };
  }
  if (open > 0) {
    return {
      severity: "calm",
      line: `${open} open request${open === 1 ? "" : "s"}`,
    };
  }
  return { severity: "calm", line: "Nothing outstanding" };
}

/**
 * Sort for the list: severity first, then the thing that makes rows
 * within a severity comparable — ARR. Name last so the order is
 * stable across renders instead of jittering on ties.
 */
export function compareRows(
  a: { signal: RowSignal; customer: Customer },
  b: { signal: RowSignal; customer: Customer }
): number {
  const sev =
    SEVERITY_RANK[a.signal.severity] - SEVERITY_RANK[b.signal.severity];
  if (sev !== 0) return sev;
  const arr = (b.customer.arr ?? 0) - (a.customer.arr ?? 0);
  if (arr !== 0) return arr;
  return (a.customer.company_name ?? a.customer.workspace_name ?? "").localeCompare(
    b.customer.company_name ?? b.customer.workspace_name ?? ""
  );
}

/** Free-text match over the fields someone would actually type. */
export function matchesSearch(c: Customer, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    c.company_name,
    c.workspace_name,
    c.owner_email,
    c.property_main_contact,
  ]
    .filter(Boolean)
    .some((v) => (v as string).toLowerCase().includes(q));
}
