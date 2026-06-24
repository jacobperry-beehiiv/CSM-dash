/**
 * Migration warm-up algorithm — input/output shapes.
 *
 * Mirrors the dataclasses in the Python reference impl
 * (migration_warmup.py). Names + field types kept identical so
 * cross-language test fixtures still hold.
 *
 * Pure types — safe to import from client components.
 */

/** One newsletter / list to warm up. */
export interface ListInput {
  name: string;
  /** Effective (cleaned) send size. Accepts strings like "~150k",
   *  "15-25k", "270,000" — normalized server-side. */
  subscribers: number | string;
  /** Free text, e.g. "3x/week", "daily", "bi-weekly". */
  cadence: string;
  /** 0..1 or 0..100 (auto-detected). `null` / "unknown" allowed. */
  open_rate?: number | string | null;
  /** Weeks available before the migration must finish. */
  deadline_weeks?: number | null;
  /** Cold list, prior spam issues, low engagement, …. */
  deliverability_concern?: boolean;
}

/** A whole migration: customer + one or more lists. */
export interface PlanInput {
  customer_name: string;
  lists: ListInput[];
  /** "separate" (Option A: one tab per list) | "nls" (Option B:
   *  one tab per week). Default "separate". */
  structure?: "separate" | "nls";
  drive_folder_url?: string | null;
}

export interface Batch {
  /** 1-based batch number within its week. */
  index: number;
  /** Import size for this batch. */
  size: number;
  /** Total in publication after this batch. */
  cumulative: number;
}

export interface Week {
  number: number;
  /** "Week 1" or "Weeks 1-2" for bi-weekly. */
  label: string;
  week_total: number;
  cumulative: number;
  batches: Batch[];
}

export type Approach = "standard" | "conservative" | "aggressive";

export interface ListSchedule {
  name: string;
  subscribers: number;
  cadence: string;
  sends_per_week: number;
  open_rate: number | null;
  tier: string;
  approach: Approach;
  total_weeks: number;
  eta: string;
  flags: string[];
  weeks: Week[];
}

export interface MigrationPlan {
  customer_name: string;
  structure: "separate" | "nls";
  drive_folder_url: string | null;
  schedules: ListSchedule[];
}
