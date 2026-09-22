import type { Customer } from "../types";
import { loadCustomers } from "../data/load-customers";
import { loadOverrides } from "../data/customer-overrides";
import { intervalBucket } from "../customer-helpers";
import { contractRenewalDate, daysUntilRenewal } from "../renewals/date";
import { hasGraduatedOnboarding } from "../lifecycle/onboarding";
import { matchPlaybookTodos } from "../lifecycle/todos";
import { LIVE_ONGOING_GROUP } from "../lifecycle/live-quarter";
import { appendActionLog } from "../data/customer-signals";
import { applyTodoOps, loadAll } from "../personal-todos/store";
import { userKeyFromEmail } from "../personal-todos/identity";
import { newTodoId, type PersonalTodo } from "../personal-todos/types";
import {
  hasLiveQuarterCheckinFired,
  markLiveQuarterCheckinFired,
  type LiveQuarter,
} from "../data/live-quarter-checkins-fired";

/**
 * Live-board quarter check-in engine.
 *
 * Baseline "touch every 90 days" reminder for accounts on the Live
 * board's annual countdown — walks the customer book once and, on the
 * exact day a customer's days-until-renewal crosses into a new
 * quarter (see QUARTER_START_DAYS below, mirroring the day-windows
 * live-quarter.ts's computeLiveQuarter buckets Q1/Q2/Q3 with), creates
 * one personal-todo for the CSM: "{Company} — 90-day check-in", due
 * that same day, tagged into the same "Live" on-card checklist
 * grouping a CSM would use for a manually-created ongoing to-do (see
 * LIVE_ONGOING_GROUP) so it shows up right on the card, not just
 * buried in "Your to-dos".
 *
 * The (workspace_id, quarter, renewal_iso) dedupe set in
 * `csm:live-quarter-checkins-fired:v1` guarantees a re-run on the
 * same day (or a manual retrigger) doesn't double-fire.
 *
 * Excluded:
 *   • Monthly-billed customers — Q1/Q2/Q3 are computed backward from
 *     an annual `contract_renewal`, which a monthly cadence doesn't
 *     have in the same sense (see live-quarter.ts's MONTHLY_COLUMN).
 *   • Customers with no `contract_renewal` in HubSpot — same
 *     data-gap exclusion the renewal-milestones engine applies; no
 *     real date to compute a quarter-start from.
 *   • Customers still in Onboarding (haven't graduated per
 *     hasGraduatedOnboarding) — the Live board's quarters, and this
 *     reminder, only apply once an account is actually live.
 *   • Rows with no workspace_id or no CSM email — nobody to key the
 *     dedupe set or the todo to.
 */

/** Days-until-renewal that marks the FIRST day of each quarter — the
 *  upper bound of live-quarter.ts's own Q1/Q2/Q3 windows (271, 271,
 *  181 would all be "the day after" the boundary, so the boundary
 *  value itself, e.g. 365, is the quarter's first day counting down).
 *  Renewal (<=90d) deliberately has no entry here — that column
 *  already gets its own dedicated attention via the renewal-stage
 *  checklist and the 90/60/30/7-day renewal-milestones sweep. */
const QUARTER_START_DAYS: Record<LiveQuarter, number> = {
  Q1: 365,
  Q2: 270,
  Q3: 180,
};

interface FireResult {
  workspace_id: string;
  workspace_name: string | null;
  quarter: LiveQuarter;
  renewal_iso: string;
}

interface SkipResult {
  workspace_id: string | null;
  quarter: LiveQuarter | null;
  reason: string;
}

interface SweepResult {
  scanned: number;
  fired: FireResult[];
  skipped: SkipResult[];
  failures: { workspace_id: string; quarter: LiveQuarter; error: string }[];
}

interface SweepOpts {
  dryRun?: boolean;
  /** Optional whitelist for a manual retrigger. */
  workspaceIds?: string[];
  /** Fixed "now" for tests; defaults to real time. */
  now?: Date;
}

function companyLabel(c: Customer): string {
  return c.company_name ?? c.workspace_name ?? "an account";
}

function utcYmd(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

function buildTodo(c: Customer, quarter: LiveQuarter): PersonalTodo {
  const now = new Date();
  const nowIso = now.toISOString();
  const todayYmd = utcYmd(nowIso);
  return {
    id: newTodoId(),
    title: `${companyLabel(c)} — 90-day check-in`,
    details: null,
    due_date: todayYmd,
    surface_at: null,
    priority: "medium",
    source: "live_quarter_checkin",
    source_meta: {
      hubspot_company_id: c.hubspot_company_id ?? undefined,
      checklist_group: LIVE_ONGOING_GROUP,
      live_quarter: quarter,
    },
    completed_at: null,
    remind_via_slack: true,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

export async function runLiveQuarterCheckinSweep(
  opts: SweepOpts = {}
): Promise<SweepResult> {
  const result: SweepResult = { scanned: 0, fired: [], skipped: [], failures: [] };
  const now = opts.now ?? new Date();
  const [customers, overrides, todosState] = await Promise.all([
    loadCustomers(),
    loadOverrides(),
    loadAll(),
  ]);
  const scope = opts.workspaceIds
    ? new Set(opts.workspaceIds.filter(Boolean))
    : null;

  for (const c of customers) {
    if (!c.workspace_id) continue;
    if (scope && !scope.has(c.workspace_id)) continue;
    if (!c.hubspot_company_id) continue;
    if (intervalBucket(c) === "monthly") continue;
    const csmEmail = c.customer_success_manager_email;
    if (!csmEmail) continue;

    const renewalIso = contractRenewalDate(c);
    const daysUntil = daysUntilRenewal(renewalIso, now);
    if (renewalIso == null || daysUntil == null) continue;

    // Only fire for accounts that have actually graduated onboarding
    // — mirrors src/app/csm/page.tsx's own Live-board population
    // logic exactly, so this sweep's population never drifts from
    // what a CSM actually sees on the board.
    const csmTodos =
      todosState.by_user[userKeyFromEmail(csmEmail)]?.todos ?? [];
    const matched = matchPlaybookTodos(c, csmTodos);
    const explicitOnboardingStage = overrides[c.workspace_id]
      ?.onboarding_lifecycle_stage?.trim();
    const isLive = explicitOnboardingStage
      ? explicitOnboardingStage === "Launch"
      : hasGraduatedOnboarding(
          c,
          matched,
          overrides[c.workspace_id]?.lifecycle_stage,
          now
        );
    if (!isLive) continue;

    result.scanned++;
    const renewalYmd = utcYmd(renewalIso);

    for (const quarter of Object.keys(QUARTER_START_DAYS) as LiveQuarter[]) {
      if (daysUntil !== QUARTER_START_DAYS[quarter]) continue;

      let alreadyFired = false;
      try {
        alreadyFired = await hasLiveQuarterCheckinFired(
          c.workspace_id,
          quarter,
          renewalYmd
        );
      } catch (e) {
        result.failures.push({
          workspace_id: c.workspace_id,
          quarter,
          error:
            e instanceof Error ? e.message : "hasLiveQuarterCheckinFired failed",
        });
        continue;
      }
      if (alreadyFired) {
        result.skipped.push({
          workspace_id: c.workspace_id,
          quarter,
          reason: "already fired for this renewal cycle",
        });
        continue;
      }

      try {
        if (!opts.dryRun) {
          const todo = buildTodo(c, quarter);
          await applyTodoOps(userKeyFromEmail(csmEmail), [
            { type: "add", todo },
          ]);
          await appendActionLog([
            {
              workspace_id: c.workspace_id,
              text: `Live-board 90-day check-in scheduled (${quarter})`,
              action_kind: "live_quarter_checkin",
              metadata: { quarter, renewal_date: renewalIso },
            },
          ]);
          await markLiveQuarterCheckinFired({
            workspace_id: c.workspace_id,
            quarter,
            renewal_iso: renewalYmd,
            fired_at: new Date().toISOString(),
          });
        }
        result.fired.push({
          workspace_id: c.workspace_id,
          workspace_name: c.workspace_name ?? null,
          quarter,
          renewal_iso: renewalYmd,
        });
      } catch (e) {
        result.failures.push({
          workspace_id: c.workspace_id,
          quarter,
          error: e instanceof Error ? e.message : "fire failed",
        });
      }
    }
  }

  return result;
}
