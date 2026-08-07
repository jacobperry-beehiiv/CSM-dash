"use client";

import { useState } from "react";
import type {
  PillarKey,
  PillarScore,
  UpgradeAnalysisReport,
} from "@/lib/engines/upgrade-analysis/types";

/**
 * One card per pillar. Renders:
 *   - Score chip (green / amber / red)
 *   - Human-readable pillar label
 *   - Compact set of top-level counters most relevant to the pillar's
 *     decision (verified click rate for engagement, complaint rate for
 *     provider, etc.)
 *   - Expandable raw counter block for the reviewer who wants to see
 *     everything (kept collapsed by default — a green pillar's numbers
 *     usually aren't worth the vertical space).
 *
 * The numeric formatting is deliberately verbose (0.324% not 0.3%) —
 * the guardrails care about tenths of a percent, and rounding hides
 * exactly the signal a reviewer needs to see.
 */

interface Props {
  pillarKey: PillarKey;
  score: PillarScore;
  report: UpgradeAnalysisReport;
}

const PILLAR_LABELS: Record<PillarKey, string> = {
  identity: "Identity & setup",
  acquisition: "Acquisition & consent",
  funnel: "Deliverability funnel",
  engagement: "Engagement truth",
  provider: "Provider concentration",
  network: "Network & history",
};

const PILLAR_DESCRIPTIONS: Record<PillarKey, string> = {
  identity: "How old the pub is, plan settings, deletion state.",
  acquisition:
    "How subscribers came in + opt-in coverage. Behavior weighted heavier than form of intake.",
  funnel: "Deferrals, hard bounces, soft bounces over the lookback window.",
  engagement:
    "Verified clicks and CTOR (trusts verified clicks, ignores raw opens because Apple MPP inflates them).",
  provider:
    "Per-provider complaint rates. Comcast has its own red line — pub-attributable signal.",
  network:
    "Organization flags on this org (AUP, ip_already_used). Slack search intentionally deferred to PR 2.",
};

const SCORE_STYLES: Record<PillarScore, { label: string; classes: string }> = {
  green: {
    label: "Clear",
    classes:
      "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30",
  },
  amber: {
    label: "Watch",
    classes:
      "bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30",
  },
  red: {
    label: "Critical",
    classes: "bg-red-500/10 text-red-700 dark:text-red-300 border border-red-500/30",
  },
};

function pct(n: number, digits = 3): string {
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

function num(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toLocaleString();
}

export function UpgradeAnalysisPillarCard({ pillarKey, score, report }: Props) {
  const [expanded, setExpanded] = useState(false);
  const style = SCORE_STYLES[score];

  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-subtle">
              {PILLAR_LABELS[pillarKey]}
            </span>
            <span
              className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${style.classes}`}
            >
              {style.label}
            </span>
          </div>
          <p className="text-xs text-muted mt-0.5">
            {PILLAR_DESCRIPTIONS[pillarKey]}
          </p>
        </div>
      </div>

      {/* Top-line counters, pillar-specific. */}
      <div className="mt-2 text-sm">
        <PillarCounters pillarKey={pillarKey} report={report} />
      </div>

      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="mt-2 text-xs text-muted hover:text-fg underline underline-offset-2"
      >
        {expanded ? "Hide raw counters" : "Show raw counters"}
      </button>

      {expanded ? (
        <pre className="mt-2 text-[10px] leading-tight bg-surface-2 border border-border rounded p-2 overflow-x-auto max-h-80 overflow-y-auto">
          {JSON.stringify(report.pillars[pillarKey], null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

// ─── Pillar-specific counter renders ─────────────────────────────────────

function PillarCounters({
  pillarKey,
  report,
}: {
  pillarKey: PillarKey;
  report: UpgradeAnalysisReport;
}) {
  if (pillarKey === "identity") {
    const p = report.pillars.identity;
    return (
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <Row label="Pub age">{p.age_days == null ? "—" : `${p.age_days}d`}</Row>
        <Row label="Deleted">{p.deleted_at ? "Yes ⚠️" : "No"}</Row>
        <Row label="Double opt-in">
          {p.double_opt_required == null
            ? "—"
            : p.double_opt_required
              ? "On"
              : "Off"}
        </Row>
        <Row label="White-labeled">{p.white_labeled_at ? "Yes" : "No"}</Row>
      </dl>
    );
  }
  if (pillarKey === "acquisition") {
    const p = report.pillars.acquisition;
    return (
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <Row label="Total subs">{num(p.total_subs)}</Row>
        <Row label="Opt-in coverage">{pct(p.opt_in_coverage_pct, 1)}</Row>
        <Row label="Imports">{num(p.import_filenames.length)}</Row>
        <Row label="API keys">{num(p.api_key_names.length)}</Row>
      </dl>
    );
  }
  if (pillarKey === "funnel") {
    const f = report.pillars.funnel;
    const deferralRate = f.deliv ? f.deferred / f.deliv : 0;
    const hardBounceRate = f.deliv ? f.hard_b / f.deliv : 0;
    return (
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <Row label={`Delivered (${f.window_days}d)`}>{num(f.deliv)}</Row>
        <Row label="Deferral rate">{pct(deferralRate, 2)}</Row>
        <Row label="Hard bounce rate">{pct(hardBounceRate, 3)}</Row>
        <Row label="Kumo share of deferrals">
          {pct(report.pillars.provider.kumo_share_of_deferrals, 1)}
        </Row>
      </dl>
    );
  }
  if (pillarKey === "engagement") {
    const f = report.pillars.engagement;
    const vClickRate = f.deliv ? f.v_clicks / f.deliv : 0;
    const vCtor = f.v_opens ? f.v_clicks / f.v_opens : 0;
    const rawOpenRate = f.deliv ? f.opens / f.deliv : 0;
    return (
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <Row label="Verified click rate">{pct(vClickRate, 3)}</Row>
        <Row label="Verified CTOR">{pct(vCtor, 2)}</Row>
        <Row label="Raw open rate (untrusted)">{pct(rawOpenRate, 1)}</Row>
        <Row label="Unique subs">{num(f.uniq_subs)}</Row>
      </dl>
    );
  }
  if (pillarKey === "provider") {
    const p = report.pillars.provider;
    const blendedRate =
      report.pillars.funnel.deliv > 0
        ? report.pillars.funnel.spam / report.pillars.funnel.deliv
        : 0;
    const comcast = p.providers.find((r) => r.dom === "comcast.net");
    return (
      <div className="text-xs">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
          <Row label="Blended complaint rate">{pct(blendedRate, 4)}</Row>
          <Row label="Absolute complaints">
            {num(report.pillars.funnel.spam)}
          </Row>
          <Row label="Comcast complaint rate">
            {comcast && comcast.deliv > 0
              ? pct(comcast.spam / comcast.deliv, 4)
              : "—"}
          </Row>
          <Row label="Providers scanned">{num(p.providers.length)}</Row>
        </dl>
        {p.providers.length > 0 ? (
          <div className="mt-2 max-h-40 overflow-y-auto border border-border rounded">
            <table className="w-full text-[10px]">
              <thead className="bg-surface-2 text-subtle">
                <tr>
                  <th className="text-left px-2 py-1">Provider</th>
                  <th className="text-right px-2 py-1">Deliv</th>
                  <th className="text-right px-2 py-1">Spam %</th>
                  <th className="text-right px-2 py-1">Defer %</th>
                </tr>
              </thead>
              <tbody>
                {p.providers.slice(0, 12).map((row) => (
                  <tr key={row.dom} className="border-t border-border">
                    <td className="px-2 py-0.5">{row.dom}</td>
                    <td className="text-right px-2 py-0.5">{num(row.deliv)}</td>
                    <td className="text-right px-2 py-0.5">
                      {row.spam_pct.toFixed(3)}%
                    </td>
                    <td className="text-right px-2 py-0.5">
                      {row.defer_pct.toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    );
  }
  // network
  const n = report.pillars.network;
  const activeFlags = n.org_flags.filter((f) => !f.deleted_at);
  return (
    <div className="text-xs">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
        <Row label="Active org flags">{num(activeFlags.length)}</Row>
        <Row label="AUP prohibited">
          {n.aup_prohibited_use_active ? "Yes ⚠️" : "No"}
        </Row>
        <Row label="IP already used">
          {n.ip_already_used_active ? "Yes" : "No"}
        </Row>
        <Row label="Network map">
          {n.network_map_incomplete ? "Incomplete (Slack read pending)" : "Full"}
        </Row>
      </dl>
      {activeFlags.length > 0 ? (
        <ul className="mt-2 space-y-0.5">
          {activeFlags.slice(0, 5).map((f) => (
            <li
              key={f.flag + f.created_at}
              className="text-[10px] text-subtle"
            >
              <code className="bg-surface-2 px-1 rounded">{f.flag}</code>{" "}
              <span>set {new Date(f.created_at).toISOString().slice(0, 10)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-subtle">{label}</dt>
      <dd className="text-fg text-right font-medium tabular-nums">{children}</dd>
    </>
  );
}
