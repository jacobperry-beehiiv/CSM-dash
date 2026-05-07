import { loadCustomers } from "../data/load-customers";
import { loadResolutions } from "../data/flag-resolutions";
import { loadSettings, reRaisePeriodMs } from "../data/settings";
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

const DAYS_NO_SEND = 10;
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

// ─── Flag A: hasn't sent in 10+ days ────────────────────────────────
export function flagA(c: Customer, now = new Date()): RiskFlag | null {
  const last = parseDate(c.last_send);
  if (!last) {
    return {
      code: "A",
      label: "No send",
      detail: "Never sent a post",
    };
  }
  const days = daysBetween(last, now);
  if (days >= DAYS_NO_SEND) {
    return {
      code: "A",
      label: "Dormant",
      detail: `No send in ${days} days (last: ${last.toISOString().slice(0, 10)})`,
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
      label: "No login",
      detail: "No login detected in 14+ days",
    };
  }
  return null;
}

// ─── Flag C: 25%+ below subscriber tier ─────────────────────────────
export function flagC(c: Customer): RiskFlag | null {
  if (c.percent_of_max_subs == null) return null;
  const pct = c.percent_of_max_subs > 1 ? c.percent_of_max_subs / 100 : c.percent_of_max_subs;
  if (pct >= PCT_UNDER_TIER) return null;
  const pctStr = (pct * 100).toFixed(0);
  return {
    code: "C",
    label: "Under tier",
    detail: `${pctStr}% of max subs (${c.active_subs ?? 0} / ${c.max_subscriptions ?? "?"})`,
  };
}

// ─── Flag H: stale contact (last_contacted exceeds threshold) ───────
export function flagH(
  c: Customer,
  thresholdDays: number,
  now = new Date()
): RiskFlag | null {
  const last = parseDate(c.property_notes_last_contacted);
  if (!last) {
    return {
      code: "H",
      label: "Stale contact",
      detail: "No HubSpot last-contacted date on file.",
    };
  }
  const days = daysBetween(last, now);
  if (days >= thresholdDays) {
    return {
      code: "H",
      label: "Stale contact",
      detail: `Last contacted ${days} days ago (threshold ${thresholdDays}d).`,
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
      label: "CSM: Red",
      detail: c.property_risk_level_detail ?? "CSM marked as Red risk",
    };
  }
  if (norm === "yellow") {
    return {
      code: "G",
      label: "CSM: Yellow",
      detail: c.property_risk_level_detail ?? "CSM marked as Yellow risk",
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
    // re-raises so the CSM revisits the account.
    const resolvedForCustomer = c.workspace_id
      ? resolutions[c.workspace_id] ?? {}
      : {};
    const liveFlags = flags.filter(
      (f) => !isResolutionActive(f.code, resolvedForCustomer[f.code]?.resolved_at)
    );
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

  results.sort((a, b) => b.priority_score - a.priority_score);

  return {
    csm_name: csmName,
    total_in_book: book.length,
    excluded,
    accounts: results,
    generated_at: now.toISOString(),
  };
}
