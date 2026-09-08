/**
 * Enterprise Request Loop — client-safe types.
 *
 * Split from the server-only store (`enterprise-requests.ts`) so that
 * React client components can `import type { EnterpriseRequestRow }`
 * without pulling in `kvGet` / `runNativeQuery` at bundle time.
 * Same pattern as `admin-flags-types.ts` vs `admin-flags.ts` and
 * `wins-types.ts` vs `wins.ts`.
 */

/** Linear issue state buckets we care about for the customer profile
 *  render. Linear's own `state.type` values are:
 *    `triage` | `unstarted` | `started` | `backlog` | `completed` | `canceled`
 *  We map those + our derived shipped-detection layer into 5 buckets
 *  the CSM actually reasons about. See the promotion state machine
 *  in `enterprise-requests-shipped-sweep.ts` for the transitions. */
export type EnterpriseRequestDerivedState =
  | "Open"
  | "In progress"
  | "Live"
  | "Live, possibly in beta"
  | "Not planned";

/** One-of the fixed Customer Impact labels enforced by Juliet's
 *  `feature-request-creator` skill. `null` when a ticket predates the
 *  skill or the label wasn't applied. Weighted per PDF:
 *    Churn Risk 1.0  ·  Blocking 0.6  ·  Friction 0.3  ·  Nice to have 0.1
 *  Weights only matter for the deferred portfolio ranking view; the
 *  per-customer render only surfaces the label text. */
export type CustomerImpactLabel =
  | "Churn Risk"
  | "Blocking"
  | "Friction"
  | "Nice to have";

/** Type of Work label — mirrors the Sybill/Juliet intake. */
export type WorkTypeLabel = "Bug" | "Feature" | "UI/UX Improvement";

/** How a row got promoted to a shipped state. Persisted alongside the
 *  row so a CSM can eyeball why we're calling something Live rather
 *  than trusting the label blind. */
export type PromotionSource =
  | "devs_shipped" // Matched a linear.app/beehiiv/issue/<KEY> URL in #devs-shipped
  | "changelog" // Exact link match in #topic-product-changelog Resources/links
  | "changelog_fuzzy" // Fuzzy match on name + description in the changelog
  | "linear_state" // Linear state → Dismissed/Canceled (→ Not planned)
  | "manual"; // CSM/admin manually stamped via the exception queue

export interface PromotionHistoryEntry {
  from_state: EnterpriseRequestDerivedState;
  to_state: EnterpriseRequestDerivedState;
  source: PromotionSource;
  at: string;
  permalink?: string | null;
}

/** A single Linear request as it applies to ONE customer. The same
 *  Linear issue can attach to N customer_needs; we fan out to one
 *  row per (workspace_id, linear_issue_id) so the profile render is
 *  a straight lookup and the aggregate-ARR math on the deferred
 *  portfolio view stays a plain sum. */
export interface EnterpriseRequestRow {
  linear_issue_id: string;
  linear_identifier: string; // e.g. "REQ-2207"
  title: string;
  url: string;
  /** Raw Linear state name (e.g. "Triage", "In Review"). Preserved
   *  for the audit trail; the UI reads `derived_state`. */
  linear_state_name: string;
  /** Raw Linear state.type — one of triage/unstarted/started/backlog
   *  /completed/canceled. Powers the "Has open Linear FR" filter chip. */
  linear_state_type: string;
  /** Bucket the UI actually renders. Starts as a mapping of the
   *  Linear state; promoted by the shipped-sweep engine. */
  derived_state: EnterpriseRequestDerivedState;
  work_type: WorkTypeLabel | null;
  customer_impact: CustomerImpactLabel | null;
  /** Whether the ticket carries the `Resurfaced` label — flagged in
   *  the row so the digest can surface "This came back around; the
   *  same customer asked again." */
  resurfaced: boolean;
  /** Linear's native `estimate` numeric field. XS=1 / S=2 / M=3 /
   *  L=5 / XL=8 (T-shirt table from Nicholai). `null` when the field
   *  isn't populated. */
  estimate: number | null;
  project_name: string | null;
  linear_completed_at: string | null;
  /** When the customer_need was created (i.e. when this CSM logged
   *  the request against this customer). */
  submitted_at: string;
  submitting_csm_email: string | null;
  /** ARR snapshot at the moment of the sweep. Frozen so the digest
   *  and the ranking view stay stable across refreshes even if
   *  Metabase's MRR shifts mid-day. */
  arr_snapshot: number | null;
  /** Ship metadata — populated by the shipped-sweep engine. */
  promotion_source: PromotionSource | null;
  promoted_at: string | null;
  ship_url: string | null;
  ship_date: string | null;
  promotion_history: PromotionHistoryEntry[];
}

/** A Linear customer that couldn't be resolved to a dash workspace.
 *  Powers the admin queue at /settings/enterprise-requests/unmatched. */
export interface UnmatchedNeed {
  linear_customer_id: string;
  linear_customer_name: string;
  external_ids: string[];
  domains: string[];
  need_id: string;
  need_body: string;
  first_seen_at: string;
}

export interface EnterpriseRequestsBlob {
  /** Bucketed by workspace_id so per-customer render is one lookup.
   *  Inner key is `linear_issue_id`. */
  rows: Record<string, Record<string, EnterpriseRequestRow>>;
  /** Linear customers we couldn't match — surfaced in the admin
   *  queue. Cleared each run and re-populated so a manual mapping
   *  taking effect drops the row out organically. */
  unmatched: UnmatchedNeed[];
  fetched_at: string;
  /** Rough summary counters for the sync's own logging. */
  last_run: {
    pulled: number;
    matched: number;
    unmatched: number;
  } | null;
}

/** Per-(workspace, issue) notified state. Two fields so the queue can
 *  distinguish "CSM opened the outreach draft" from "CSM confirmed
 *  they sent it." A row with only `drafted_at` still appears on the
 *  action queue as pending. */
export interface NotifiedEntry {
  drafted_at?: string | null;
  drafted_by?: string | null;
  notified_at?: string | null;
  notified_by?: string | null;
}

export interface NotifiedBlob {
  /** `Record<workspace_id, Record<linear_issue_id, NotifiedEntry>>`. */
  rows: Record<string, Record<string, NotifiedEntry>>;
  updated_at: string;
}

/** Admin-approved manual mappings from a Linear customer to a
 *  workspace_id. Consulted first by the sync engine's matcher, before
 *  the three-strike externalIds/domains fall-through. */
export interface ManualMap {
  /** `Record<linear_customer_id, workspace_id | "__skipped">`.
   *  `"__skipped"` means the admin explicitly said "this Linear
   *  customer isn't a dash customer — stop asking me." The sync
   *  drops it from the unmatched queue on subsequent runs. */
  by_linear_customer_id: Record<string, string>;
  updated_at: string;
}

/** Per-channel cursor for the shipped-sweep engine. Keeps track of
 *  the newest Slack `ts` we've processed in each source channel so
 *  the next run only pulls fresh messages. */
export interface ShippedCursorBlob {
  devs_shipped_ts: string | null;
  changelog_ts: string | null;
  updated_at: string;
}

/** Shipped-channel hits that couldn't match to any snapshot row after
 *  the 14-day grace window. Powers the orphans admin queue. */
export interface OrphanedShipment {
  source_channel: "devs_shipped" | "changelog";
  ship_permalink: string;
  ship_ts: string; // Slack ts
  linear_key: string | null; // Extracted linear.app URL fragment, if any
  feature_name: string | null; // Changelog "Feature Name" if any
  first_seen_at: string;
  status: "pending" | "not_customer_facing" | "dismissed";
  dismissed_by?: string | null;
  dismissed_at?: string | null;
}

export interface OrphanedShipmentsBlob {
  orphans: Record<string, OrphanedShipment>; // keyed by ship_permalink
  updated_at: string;
}

/** Dedupe row for the weekly Slack DM. Guarantees "one ping per
 *  shipped request per CSM" even across re-runs of the digest. */
export interface DigestSentBlob {
  /** `Record<csm_email, Record<linear_issue_id, sent_at>>`. */
  sent: Record<string, Record<string, string>>;
  updated_at: string;
}

// ─── Derivation helpers (pure, reusable server + client) ─────────

/** Map a Linear state.type onto the derived bucket the UI renders.
 *  Used at sync time to seed each row's `derived_state`; the shipped
 *  sweep can then promote from here. `unknown` state types fall
 *  through to `Open` so a new Linear state doesn't crash the render. */
export function linearStateToDerived(
  stateType: string
): EnterpriseRequestDerivedState {
  switch (stateType) {
    case "triage":
    case "backlog":
    case "unstarted":
      return "Open";
    case "started":
      return "In progress";
    case "canceled":
      return "Not planned";
    case "completed":
      // Deliberately NOT "Live" — Linear "completed" only means merged,
      // not released. The shipped-sweep is the only path to Live per the
      // PDF's Piece 3 rules ("never promote off Linear state alone").
      return "In progress";
    default:
      return "Open";
  }
}

/** Terminal states the "Has open Linear FR" filter chip excludes. */
export const OPEN_STATE_TYPES = new Set([
  "triage",
  "backlog",
  "unstarted",
  "started",
]);

/** Map Linear's integer `estimate` back to a T-shirt string for the
 *  Requests table. Nicholai's confirmed scale: XS=1 / S=2 / M=3 /
 *  L=5 / XL=8. Anything unmapped renders "—" via the fallback. */
export function estimateToTShirt(estimate: number | null): string | null {
  if (estimate == null) return null;
  switch (estimate) {
    case 1:
      return "XS";
    case 2:
      return "S";
    case 3:
      return "M";
    case 5:
      return "L";
    case 8:
      return "XL";
    default:
      return null;
  }
}
