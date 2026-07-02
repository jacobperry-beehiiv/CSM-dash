/**
 * Client-safe types for the Wins & Opportunities Phase 1 surface.
 * Same split pattern as admin-flags-types / settings-types — the KV
 * store implementation lives in wins-store.ts (server-only).
 *
 * Phase 1 scope: read-only list of candidate wins with at-risk
 * suppression and a Dismiss action. No ranking, no curation, no
 * drafting — those get their own plans (Phase 2/3/4).
 */

export type WinCategory =
  | "craft"
  | "consistency"
  | "list-health"
  | "momentum"
  | "monetization";

export type WinComparisonBasis = "self" | "cohort" | "platform" | "goal";

export type WinConfidence = "high" | "medium" | "low";

export type WinStatus =
  | "candidate"
  | "surfaced"
  | "approved"
  | "sent"
  | "dismissed";

/** Every rule slot in the Phase 1 catalog. Extend the union when a
 *  new rule ships — the UI branches on `win_type` for the headline. */
export type WinType =
  | "verified_ctor_record"
  | "verified_open_streak"
  | "quality_growth"
  | "deliverability_streak";

export interface CandidateWin {
  /** Stable across daily runs — hash of
   *  (account_id, win_type, detection_week). A rule re-firing the
   *  next day updates in place rather than creating a duplicate. */
  win_id: string;
  /** workspace_id (uuid). Publications roll up to the workspace so
   *  we can suppress on at-risk which is workspace-keyed. */
  account_id: string;
  workspace_name: string | null;
  publication_id: string | null;
  publication_name: string | null;
  win_type: WinType;
  category: WinCategory;
  /** Plain-language headline the UI renders as the primary card title.
   *  Written by the rule that fired — e.g. "Best-ever click-to-open
   *  rate: 24.3%". */
  headline: string;
  /** The rule's numeric hit — CTOR / open rate / growth-pct / streak
   *  weeks depending on win_type. UI formats per category. */
  metric_value: number;
  /** What the metric_value beat. For self-comparison rules this is
   *  the prior best or the trailing baseline. */
  comparison_value: number;
  comparison_basis: WinComparisonBasis;
  /** ISO-8601 UTC timestamp. */
  detected_at: string;
  /** YYYY-'W'ww anchor used in win_id hashing so multi-day runs in
   *  the same ISO week dedupe cleanly. */
  detection_week: string;
  confidence: WinConfidence;
  /** Suggested soft next step for the CSM to consider — rendered as
   *  a static suggestion line in Phase 1 (no draft-outreach action). */
  mapped_opportunity: string;
  status: WinStatus;
  suppressed: boolean;
  suppression_reason?: string | null;
  csm_name: string | null;
}

export interface WinsBlob {
  candidates: Record<string, CandidateWin>;
  last_detection_at?: string;
  last_detection_summary?: {
    scanned: number;
    detected: number;
    suppressed: number;
    triggered_by: string;
  };
  fetched_at: string;
}

export const EMPTY_WINS_BLOB: WinsBlob = {
  candidates: {},
  fetched_at: new Date(0).toISOString(),
};

/** ISO week label (e.g. "2026-W27") for the given date, UTC. Used
 *  both as the `detection_week` field and as part of the win_id hash. */
export function isoWeekLabel(now: Date = new Date()): string {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7
  );
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Deterministic win_id — same inputs → same string. Cheap 32-bit
 *  FNV-ish hash; collisions are irrelevant because we key by the
 *  raw components too (any collision would be same account + same
 *  rule + same week which we'd want to dedupe anyway). */
export function winIdFor(
  accountId: string,
  winType: WinType,
  detectionWeek: string
): string {
  const key = `${accountId}|${winType}|${detectionWeek}`;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `win_${(h >>> 0).toString(36)}_${winType}`;
}
