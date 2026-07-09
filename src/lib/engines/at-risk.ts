import { loadCustomers } from "../data/load-customers";
import { loadResolutions, pruneResolutions } from "../data/flag-resolutions";
import { loadSettings, reRaisePeriodMs } from "../data/settings";
import { lastContacted, subUtilFraction } from "../customer-helpers";
import type {
  AtRiskAccount,
  Customer,
  RiskFlag,
  RiskFlagCode,
} from "../types";

/**
 * CSM Weekly At-Risk Engine
 * --------------------------
 * Ports the 6 risk-flag logic from the CSM plugin's `csm-weekly-at-risk`
 * skill, plus adds Flag G for CSM-self-flagged risk levels (Yellow/Red)
 * sourced from HubSpot via the CSV path.
 *
 * Flags A/B/C/G are evaluated from book-of-business fields. Flags D/E/F
 * require external signals (Gmail, HubSpot, web search) — those are stubbed
 * and return [] unless the caller supplies a signal source.
 */

/** Fallback "no send" threshold (days) used when a customer has
 *  neither a CSM-set expected cadence override nor enough send history
 *  (< 3 sends in the 120d lookback) for the daily sweep to infer one. */
const DEFAULT_DAYS_NO_SEND = 10;
/** Extra buffer added on top of the effective cadence before Flag A
 *  fires. A monthly sender is expected every ~30d, so we hold off on
 *  flagging until day 44 (30 + 14). Two-week tolerance was Jacob's
 *  choice over the initial "cadence + 7d" recommendation — a monthly
 *  cadence has enough day-of-week variance that a shorter buffer
 *  produced too many "just late" false positives. */
const CADENCE_TOLERANCE_DAYS = 14;
const PCT_UNDER_TIER = 0.75;
const ANNUAL_RENEWAL_WINDOW_DAYS = 90;

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// ─── Flag A: hasn't sent in longer than their cadence + 14d ─────────
// Label intentionally specific ("No publishing") — kept distinct from
// Flag B ("No login") because the two used to share the vague
// "Dormant" / "Inactive" naming that left CSMs hovering for tooltips
// to tell which signal had fired.
//
// Cadence-aware threshold: the fixed 10d floor was noisy for monthly
// senders. Effective cadence = max(CSM override, inferred median, 10)
// so a manual override can only relax, never tighten (a CSM saying
// "they send monthly" shouldn't force flagging at 30d when the
// snapshot says weekly). Then we add CADENCE_TOLERANCE_DAYS on top
// so a normal day-of-week slip doesn't fire the flag.
export function effectiveCadenceDays(c: Customer): {
  cadence: number;
  source: "override" | "inferred" | "default";
} {
  const override =
    typeof c.expected_send_cadence_days === "number" &&
    c.expected_send_cadence_days > 0
      ? Math.floor(c.expected_send_cadence_days)
      : null;
  const inferred =
    typeof c.inferred_cadence_days === "number" && c.inferred_cadence_days > 0
      ? Math.floor(c.inferred_cadence_days)
      : null;

  // Pick the LARGEST of the three so a stale inferred cadence can't
  // undercut a CSM's override AND vice-versa: this always relaxes the
  // threshold rather than tightening it. Rationale: false negatives
  // (missing a real dormancy) are recoverable — the CSM can flip a
  // manual override or wait a week. False positives (flagging every
  // monthly sender at 2 weeks) were the real problem.
  const candidates: Array<{
    value: number;
    source: "override" | "inferred" | "default";
  }> = [{ value: DEFAULT_DAYS_NO_SEND, source: "default" }];
  if (inferred != null) candidates.push({ value: inferred, source: "inferred" });
  if (override != null) candidates.push({ value: override, source: "override" });
  candidates.sort((a, b) => b.value - a.value);
  return { cadence: candidates[0].value, source: candidates[0].source };
}

export function flagA(c: Customer, now = new Date()): RiskFlag | null {
  const last = parseDate(c.last_send);
  if (!last) {
    return {
      code: "A",
      label: "No publishing (never)",
      detail: "Never sent a post",
    };
  }
  const days = daysBetween(last, now);
  const { cadence, source } = effectiveCadenceDays(c);
  const threshold = cadence + CADENCE_TOLERANCE_DAYS;
  if (days >= threshold) {
    const sourceLabel =
      source === "override"
        ? "CSM-set expected cadence"
        : source === "inferred"
          ? `inferred cadence (${cadence}d)`
          : "default threshold";
    return {
      code: "A",
      label: `No publishing (${days}d)`,
      detail:
        `No send in ${days} days (last: ${last.toISOString().slice(0, 10)}) — ` +
        `threshold ${threshold}d = ${cadence}d ${sourceLabel} + ${CADENCE_TOLERANCE_DAYS}d tolerance.`,
    };
  }
  return null;
}

// ─── Flag B: no recent login ────────────────────────────────────────
// last_log_in in q10600 is only populated if login < 14 days; NULL = stale
export function flagB(c: Customer): RiskFlag | null {
  if (c.last_log_in == null) {
    return {
      code: "B",
      label: "No login (14d+)",
      detail: "No admin login to beehiiv detected in 14+ days",
    };
  }
  return null;
}

// ─── Flag C: 25%+ below subscriber tier ─────────────────────────────
export function flagC(c: Customer): RiskFlag | null {
  // Use the shared subUtilFraction helper so the math agrees with
  // every other surface (review-digest, proactive-outreach,
  // at-risk-table). The old `> 1 ? /100` heuristic mis-divided
  // legitimate over-cap customers (e.g., 438K/250K = 1.75 stored
  // as a fraction → mistakenly treated as 175% → divided by 100 →
  // displayed as 2%, mis-firing the under-cap flag on a customer
  // who was actually 175% OVER cap).
  const pct = subUtilFraction(c);
  if (pct == null) return null;
  if (pct >= PCT_UNDER_TIER) return null;
  const pctStr = (pct * 100).toFixed(0);
  return {
    code: "C",
    label: `Under cap (${pctStr}%)`,
    detail: `${pctStr}% of max subs (${c.active_subs ?? 0} / ${c.max_subscriptions ?? "?"})`,
  };
}

// ─── Flag H: stale contact (last_contacted exceeds threshold) ───────
// Reads through lastContacted() which merges HubSpot's broader activity
// rollup with the narrower notes_last_contacted field — and, when
// callers pre-fetch a Gmail-direct date for the active CSM, that
// source too. The label flips between "Stale HubSpot activity" and
// "Stale email activity" depending on which source won the merge, so
// CSMs can tell at a glance whether the signal is HubSpot's gap-prone
// rollup or their own ground-truth Gmail.
export function flagH(
  c: Customer,
  thresholdDays: number,
  now = new Date(),
  opts?: { gmailDate?: string | null }
): RiskFlag | null {
  const resolved = lastContacted(c, {
    gmailDate: opts?.gmailDate ?? undefined,
  });
  const last = parseDate(resolved.date);
  const isGmailSource = resolved.source === "gmail";
  if (!last) {
    return {
      code: "H",
      label: isGmailSource ? "No email activity" : "No HubSpot activity",
      detail: isGmailSource
        ? "No Gmail message exchanged with this account's owner email."
        : "No HubSpot-tracked email / call / note activity recorded across any contact at this company.",
    };
  }
  const days = daysBetween(last, now);
  if (days >= thresholdDays) {
    return {
      code: "H",
      label: isGmailSource
        ? `Stale email activity (${days}d)`
        : `Stale HubSpot activity (${days}d)`,
      detail: isGmailSource
        ? `Last contacted ${days} days ago via Gmail (you) — threshold ${thresholdDays}d.`
        : `Last contacted ${days} days ago via ${resolved.source} (threshold ${thresholdDays}d).`,
    };
  }
  return null;
}

// ─── Flag G: CSM-flagged risk level (Yellow/Red from HubSpot) ──────
export function flagG(c: Customer): RiskFlag | null {
  const level = (c.property_risk_level ?? "").trim();
  if (!level) return null;
  const norm = level.toLowerCase();
  if (norm === "red") {
    return {
      code: "G",
      label: "CSM-flagged: Red",
      detail: c.property_risk_level_detail ?? "CSM marked as Red risk in HubSpot",
    };
  }
  if (norm === "yellow") {
    return {
      code: "G",
      label: "CSM-flagged: Yellow",
      detail:
        c.property_risk_level_detail ?? "CSM marked as Yellow risk in HubSpot",
    };
  }
  return null;
}

// ─── Flag D/E/F: signal-based ───────────────────────────────────────

export interface SignalSource {
  /** Flag D — last-30-day frustration signals */
  frustrationSignal?: (c: Customer) => Promise<RiskFlag | null>;
  /** Flag E — no contact in 90+ days */
  noContactSignal?: (c: Customer) => Promise<RiskFlag | null>;
  /** Flag F — notable news on contact/company */
  newsSignal?: (c: Customer) => Promise<RiskFlag | null>;
}

function renewalNote(c: Customer, now = new Date()): string | null {
  if (c.interval !== "annual") return null;
  const d = parseDate(c.renewal_date);
  if (!d) return null;
  const days = daysBetween(now, d);
  if (days < 0 || days > ANNUAL_RENEWAL_WINDOW_DAYS) return null;
  return `⚠ Annual renewal in ${days} days`;
}

export interface AtRiskRunOptions {
  /** Pre-loaded customer list. If omitted, loads via the unified loader. */
  customers?: Customer[];
  csmName?: string | null;
  signals?: SignalSource;
  /** Exclusion set — stripe_customer_ids to skip. */
  exclude?: Set<string>;
  now?: Date;
}

export interface AtRiskRunResult {
  csm_name: string | null;
  total_in_book: number;
  excluded: number;
  accounts: AtRiskAccount[];
  generated_at: string;
  /** Threshold (in days) the server used when computing Flag H.
   *  Passed down so the client can re-evaluate the "stale activity"
   *  decision against the Gmail-merged Last contacted date — the
   *  server only has HubSpot's view; the client has Gmail on top. */
  threshold_days_no_contact: number;
}

export function recommendedAction(flags: RiskFlag[]): string {
  const codes = new Set(flags.map((f) => f.code));
  if (codes.has("D")) {
    return "Address escalation signal — reach out with concrete next step and loop in support if needed.";
  }
  if (codes.has("E")) {
    return "Re-establish contact — schedule a quick check-in, reference their goals, confirm primary contact is current.";
  }
  if (codes.has("G")) {
    return "Self-flagged risk — confirm the underlying detail is still accurate, then plan a recovery touchpoint this week.";
  }
  if (codes.has("A") && codes.has("B")) {
    return "Dormant account — reach out with content reactivation play and a specific question about their program.";
  }
  if (codes.has("A")) {
    return "Send gap — ask what's blocking their next newsletter and offer an async review.";
  }
  if (codes.has("C")) {
    return "Growth push — share subscriber acquisition playbook (referrals, SEO, Boosts) targeted at their tier.";
  }
  if (codes.has("F")) {
    return "Context shift — acknowledge news, confirm champion is still in seat, realign on goals.";
  }
  return "Light-touch check-in.";
}

export function priorityScore(flags: RiskFlag[], arr: number): number {
  const weights: Record<RiskFlagCode, number> = {
    G: 6,
    D: 5,
    E: 4,
    F: 3,
    H: 3,
    A: 2,
    B: 1,
    C: 1,
  };
  const base = flags.reduce((s, f) => s + weights[f.code], 0);
  const revenueBonus = Math.log10(Math.max(arr, 1)) / 2;
  return base + revenueBonus;
}

export async function runAtRiskCheck(
  opts: AtRiskRunOptions = {}
): Promise<AtRiskRunResult> {
  const csmName =
    opts.csmName === undefined ? process.env.CSM_NAME ?? null : opts.csmName;
  const now = opts.now ?? new Date();
  const exclude = opts.exclude ?? new Set<string>();

  const all = opts.customers ?? (await loadCustomers());
  const book = csmName
    ? all.filter((c) => c.customer_success_manager === csmName)
    : all;

  const excluded = book.filter(
    (c) => c.stripe_customer_id && exclude.has(c.stripe_customer_id)
  ).length;
  const candidates = book.filter(
    (c) => !c.stripe_customer_id || !exclude.has(c.stripe_customer_id)
  );

  // Load CSM-marked "I've reached out about this" resolutions. Resolved
  // (workspace_id, flag_code) pairs are filtered out below — except when
  // the resolution has aged past the per-flag re-raise period configured
  // on /settings, at which point the flag re-fires.
  const [resolutions, settings] = await Promise.all([
    loadResolutions(),
    loadSettings(),
  ]);
  const nowMs = now.getTime();
  function isResolutionActive(
    code: RiskFlagCode,
    resolvedAt: string | undefined
  ): boolean {
    if (!resolvedAt) return false;
    const ts = new Date(resolvedAt).getTime();
    if (isNaN(ts)) return false;
    const periodMs = reRaisePeriodMs(settings, code);
    if (periodMs === 0) return true; // never re-raise
    return nowMs - ts < periodMs;
  }

  const results: AtRiskAccount[] = [];
  // Collect (workspace_id, flag_code) pairs whose resolution has aged
  // past the re-raise period. We delete them in a single batched KV
  // write after the loop so the next render sees a clean slate — the
  // checkbox in flag-resolution-checkboxes.tsx is driven by record
  // existence, so without this purge a resurfaced row would render
  // with its boxes still ticked against a stale resolution.
  const expiredResolutions: Array<{
    workspaceId: string;
    flagCode: RiskFlagCode;
  }> = [];

  for (const c of candidates) {
    const flags: RiskFlag[] = [];
    const a = flagA(c, now);
    if (a) flags.push(a);
    const b = flagB(c);
    if (b) flags.push(b);
    const cc = flagC(c);
    if (cc) flags.push(cc);
    const g = flagG(c);
    if (g) flags.push(g);
    const h = flagH(c, settings.thresholds.days_no_contact_short, now);
    if (h) flags.push(h);

    if (opts.signals?.frustrationSignal) {
      try {
        const d = await opts.signals.frustrationSignal(c);
        if (d) flags.push(d);
      } catch {
        /* signal source failure is non-fatal */
      }
    }
    if (opts.signals?.noContactSignal) {
      try {
        const e = await opts.signals.noContactSignal(c);
        if (e) flags.push(e);
      } catch {
        /* ignore */
      }
    }
    if (opts.signals?.newsSignal) {
      try {
        const f = await opts.signals.newsSignal(c);
        if (f) flags.push(f);
      } catch {
        /* ignore */
      }
    }

    // Filter out resolved flags (CSM has marked "reached out about this").
    // Resolutions auto-expire per /settings — once aged out, the flag
    // re-raises so the CSM revisits the account. While filtering, note
    // any resolutions that exist-but-aged-out for batched purge below.
    const resolvedForCustomer = c.workspace_id
      ? resolutions[c.workspace_id] ?? {}
      : {};
    const liveFlags = flags.filter((f) => {
      const resolvedAt = resolvedForCustomer[f.code]?.resolved_at;
      const active = isResolutionActive(f.code, resolvedAt);
      if (!active && resolvedAt && c.workspace_id) {
        expiredResolutions.push({
          workspaceId: c.workspace_id,
          flagCode: f.code,
        });
      }
      return !active;
    });
    if (liveFlags.length === 0) continue;
    flags.length = 0;
    flags.push(...liveFlags);

    const renewal = renewalNote(c, now);
    if (renewal) {
      flags[flags.length - 1] = {
        ...flags[flags.length - 1],
        detail: `${flags[flags.length - 1].detail} — ${renewal}`,
      };
    }

    results.push({
      customer: c,
      flags,
      priority_score: priorityScore(flags, c.arr),
      recommended_action: recommendedAction(flags),
    });
  }

  // Garbage-collect resolutions whose re-raise period elapsed. Single
  // KV write regardless of pair count, idempotent, and best-effort —
  // a failed write doesn't change the response (the live filter above
  // already excluded them from `flags`). Next render's resolution
  // checkboxes will read clean state for resurfaced workspaces.
  if (expiredResolutions.length > 0) {
    await pruneResolutions(expiredResolutions);
  }

  results.sort((a, b) => b.priority_score - a.priority_score);

  return {
    csm_name: csmName,
    total_in_book: book.length,
    excluded,
    accounts: results,
    generated_at: now.toISOString(),
    threshold_days_no_contact: settings.thresholds.days_no_contact_short,
  };
}
