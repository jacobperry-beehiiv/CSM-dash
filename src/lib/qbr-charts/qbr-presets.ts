import type { QbrPreset } from "./types";

/**
 * Metadata for the 17 questions on QBR Dashboard 694
 * (https://beehiiv.metabaseapp.com/dashboard/694). Names + default
 * chart types are mirrored from the live dashboard so QBR tiles
 * match what CSMs see in Metabase.
 *
 * SQL lives in Metabase, NOT here — every preset is a thin
 * questionId pointer. If a question's column shape changes upstream,
 * the heuristic formatter degrades gracefully (unknown columns →
 * number); chart titles + the Metabase-side name update automatically
 * on the next runCard() call.
 *
 * `tags` drive the heuristic prompt matcher in heuristic.ts —
 * lowercase keywords; Claude also reads them in PR B for richer
 * matching.
 *
 * To add a new preset: append an entry here and (PR C) it'll also
 * be reachable via the "Find more charts" search. No code changes
 * needed beyond this file.
 */
export const QBR_PRESETS: QbrPreset[] = [
  {
    questionId: 1850,
    name: "Subscribers to Start",
    defaultChartType: "scalar",
    blurb: "Total subscriber count at the start of the QBR period.",
    tags: ["subscribers", "starting", "baseline", "subs", "count"],
  },
  {
    questionId: 1849,
    name: "Subscriber Growth by Month",
    defaultChartType: "combo",
    blurb:
      "Monthly subscriber growth — net adds bar + cumulative line on a single chart.",
    tags: [
      "subscribers",
      "growth",
      "monthly",
      "net adds",
      "cumulative",
      "trend",
    ],
  },
  {
    questionId: 1851,
    name: "Subscribers Now",
    defaultChartType: "scalar",
    blurb: "Current total subscriber count.",
    tags: ["subscribers", "current", "now", "total", "count"],
  },
  {
    questionId: 1852,
    name: "Subscribers Added Monthly",
    defaultChartType: "bar",
    blurb: "Net new subscribers added each month over the QBR window.",
    tags: ["subscribers", "added", "monthly", "net new", "acquisition"],
  },
  {
    questionId: 1853,
    name: "Open Rate & Click Through Rate",
    defaultChartType: "line",
    blurb: "Email engagement over time — open rate and CTR side by side.",
    tags: [
      "open rate",
      "click rate",
      "ctr",
      "engagement",
      "email",
      "performance",
    ],
  },
  {
    questionId: 1855,
    name: "Subscription Growth",
    defaultChartType: "line",
    blurb: "Trend line of total subscriptions over the QBR window.",
    tags: ["subscriptions", "growth", "trend", "subs"],
  },
  {
    questionId: 1882,
    name: "Spam Rate",
    defaultChartType: "line",
    blurb: "Spam-complaint rate per send over time — deliverability health.",
    tags: ["spam", "rate", "deliverability", "complaints", "fbl"],
  },
  {
    questionId: 1883,
    name: "Unsubscribe Rate",
    defaultChartType: "line",
    blurb: "Unsubscribe rate per send — audience fatigue indicator.",
    tags: ["unsubscribe", "unsub", "rate", "churn", "fatigue"],
  },
  {
    questionId: 1884,
    name: "Upgrades & Downgrades",
    defaultChartType: "bar",
    blurb: "Monthly count of subscription upgrades vs downgrades.",
    tags: ["upgrades", "downgrades", "monetization", "paid", "tier"],
  },
  {
    questionId: 1885,
    name: "Average Days to Upgrade",
    defaultChartType: "scalar",
    blurb:
      "How long subscribers take to upgrade from free → paid, on average.",
    tags: ["upgrade", "days", "time", "conversion", "monetization"],
  },
  {
    questionId: 1886,
    name: "Boost Earnings",
    defaultChartType: "line",
    blurb: "Monthly Boost earnings over the QBR window.",
    tags: ["boost", "earnings", "revenue", "monetization", "monthly"],
  },
  {
    questionId: 1887,
    name: "Boost YTD Earnings",
    defaultChartType: "scalar",
    blurb: "Year-to-date Boost earnings — cumulative.",
    tags: ["boost", "ytd", "earnings", "revenue", "year to date"],
  },
  {
    questionId: 1888,
    name: "Ads Earnings",
    defaultChartType: "line",
    blurb: "Monthly ad-network earnings over the QBR window.",
    tags: ["ads", "earnings", "revenue", "ad network", "monetization"],
  },
  {
    questionId: 1889,
    name: "Ads Earnings YTD",
    defaultChartType: "scalar",
    blurb: "Year-to-date ad-network earnings — cumulative.",
    tags: ["ads", "ytd", "earnings", "revenue", "year to date"],
  },
  {
    questionId: 1890,
    name: "Top 5 Acquisition Sources",
    defaultChartType: "table",
    blurb:
      "Top 5 acquisition channels by subscriber count over the QBR window.",
    tags: ["acquisition", "sources", "channels", "top", "growth"],
  },
  {
    questionId: 1891,
    name: "Bottom 5 Acquisition Sources",
    defaultChartType: "table",
    blurb:
      "Bottom 5 acquisition channels — worth flagging for diversification.",
    tags: ["acquisition", "sources", "channels", "bottom", "underperforming"],
  },
  {
    questionId: 1892,
    name: "Average Days to Unsubscribe",
    defaultChartType: "scalar",
    blurb: "Average time between subscribing and unsubscribing.",
    tags: ["unsubscribe", "days", "churn", "retention", "time"],
  },
];

/** O(1) lookup by question id. Returns undefined for non-preset
 *  questions (the generic Metabase-search path in PR C). */
export function getPreset(questionId: number): QbrPreset | undefined {
  return QBR_PRESETS.find((p) => p.questionId === questionId);
}
