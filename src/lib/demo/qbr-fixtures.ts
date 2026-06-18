/**
 * Canned ChartSpecs for DEMO_MODE. Each of the 17 QBR Dashboard 694
 * presets gets a hand-tuned data shape that looks realistic at a
 * glance (subscriber growth ramps, spam rates in the 0.001-0.005%
 * band, ad earnings trending down, etc.) without ever hitting
 * Metabase.
 *
 * Returned synchronously — the demo route just looks up the preset
 * by questionId. Values vary slightly across the time series so the
 * charts don't all look identical or flat.
 */

import { getPreset } from "@/lib/qbr-charts/qbr-presets";
import type { ChartSpec } from "@/lib/qbr-charts/types";

const MONTHS = [
  "2025-07-01",
  "2025-08-01",
  "2025-09-01",
  "2025-10-01",
  "2025-11-01",
  "2025-12-01",
  "2026-01-01",
  "2026-02-01",
  "2026-03-01",
  "2026-04-01",
  "2026-05-01",
  "2026-06-01",
];

/** Linear-ish ramp from start → end across the months. Adds a small
 *  monthly perturbation so the line isn't perfectly straight. */
function ramp(start: number, end: number, jitter = 0): number[] {
  const steps = MONTHS.length - 1;
  return MONTHS.map((_, i) => {
    const v = start + ((end - start) * i) / steps;
    if (jitter === 0) return Math.round(v);
    const sign = i % 2 === 0 ? 1 : -1;
    return Math.round(v + sign * jitter * (i / steps));
  });
}

const SOURCE = "Demo data — DEMO_MODE";

/** Build the canned spec for a single preset id. Returns null when
 *  the questionId isn't one of the 17 QBR presets. */
export function buildDemoChartSpec(questionId: number): ChartSpec | null {
  const preset = getPreset(questionId);
  if (!preset) return null;

  switch (questionId) {
    case 1850:
      // Subscribers to Start — scalar at the start of the period.
      return {
        title: preset.name,
        subtitle: preset.blurb,
        chartType: "scalar",
        series: [{ key: "total_sub_count", label: "Subscribers", format: "number" }],
        data: [{ total_sub_count: 76_200 }],
        source: SOURCE,
      };
    case 1851:
      // Subscribers Now — scalar at the end of the period.
      return {
        title: preset.name,
        subtitle: preset.blurb,
        chartType: "scalar",
        series: [{ key: "total_sub_count", label: "Subscribers", format: "number" }],
        data: [{ total_sub_count: 213_400 }],
        source: SOURCE,
      };
    case 1849: {
      // Subscriber Growth by Month — combo (bar = net adds, line = cumulative).
      const adds = ramp(2_800, 12_400, 1_500);
      let cum = 76_200;
      const cumulative = adds.map((a) => (cum += a));
      return {
        title: preset.name,
        subtitle: preset.blurb,
        chartType: "combo",
        xKey: "month",
        series: [
          {
            key: "active_sub_added",
            label: "Net new subs",
            format: "number",
            variant: "bar",
          },
          {
            key: "total_sub_count",
            label: "Total subs",
            format: "number",
            variant: "line",
          },
        ],
        data: MONTHS.map((m, i) => ({
          month: m,
          active_sub_added: adds[i],
          total_sub_count: cumulative[i],
        })),
        source: SOURCE,
      };
    }
    case 1852:
      // Subscribers Added Monthly — bar only.
      return {
        title: preset.name,
        subtitle: preset.blurb,
        chartType: "bar",
        xKey: "month",
        series: [
          { key: "active_sub_added", label: "Net new subs", format: "number" },
        ],
        data: MONTHS.map((m, i) => ({
          month: m,
          active_sub_added: ramp(2_800, 12_400, 1_500)[i],
        })),
        source: SOURCE,
      };
    case 1853: {
      // Open Rate & Click Through Rate — line, two series in 0-1 ratio form.
      const openRates = [0.467, 0.438, 0.419, 0.412, 0.441, 0.422, 0.408, 0.418, 0.412, 0.388, 0.394, 0.396];
      const clickRates = [0.0072, 0.0064, 0.0061, 0.0083, 0.0068, 0.0059, 0.0058, 0.0061, 0.0057, 0.0049, 0.0053, 0.0055];
      return {
        title: preset.name,
        subtitle: preset.blurb,
        chartType: "line",
        xKey: "month",
        series: [
          { key: "open_rate", label: "Open rate", format: "percent" },
          { key: "click_rate", label: "Click rate", format: "percent" },
        ],
        data: MONTHS.map((m, i) => ({
          month: m,
          open_rate: openRates[i],
          click_rate: clickRates[i],
        })),
        source: SOURCE,
      };
    }
    case 1855: {
      // Subscription Growth — line, single series.
      let cum = 76_200;
      const data = MONTHS.map((m, i) => {
        cum += ramp(2_800, 12_400, 800)[i];
        return { month: m, total_sub_count: cum };
      });
      return {
        title: preset.name,
        subtitle: preset.blurb,
        chartType: "line",
        xKey: "month",
        series: [
          { key: "total_sub_count", label: "Total subs", format: "number" },
        ],
        data,
        source: SOURCE,
      };
    }
    case 1882: {
      // Spam Rate — sub-percent values in 0-1 form, exercises the
      // auto-precision percent formatter.
      const spam = [
        0.0000087, 0.0000156, 0.0000264, 0.0000368, 0.0000654, 0.0000437,
        0.0000423, 0.0000461, 0.0000388, 0.0000077, 0.0000018, 0.0000022,
      ];
      return {
        title: preset.name,
        subtitle: preset.blurb,
        chartType: "line",
        xKey: "month",
        series: [{ key: "spam_rate", label: "Spam rate", format: "percent" }],
        data: MONTHS.map((m, i) => ({ month: m, spam_rate: spam[i] })),
        source: SOURCE,
      };
    }
    case 1883: {
      // Unsubscribe Rate — 0.2–0.5% range in 0-1 form.
      const unsub = [
        0.00276, 0.00251, 0.00198, 0.00514, 0.00370, 0.00342, 0.00362, 0.00368, 0.00295, 0.00257, 0.00231, 0.00171,
      ];
      return {
        title: preset.name,
        subtitle: preset.blurb,
        chartType: "line",
        xKey: "month",
        series: [{ key: "unsub_rate", label: "Unsubscribe rate", format: "percent" }],
        data: MONTHS.map((m, i) => ({ month: m, unsub_rate: unsub[i] })),
        source: SOURCE,
      };
    }
    case 1884: {
      // Upgrades & Downgrades — bar with two series (positive + negative).
      const upgrades = [4, 7, 6, 3, 5, 4, 6, 8, 4, 5, 6, 3];
      const downgrades = [1, 0, 2, 1, 1, 2, 0, 1, 2, 1, 0, 1];
      return {
        title: preset.name,
        subtitle: preset.blurb,
        chartType: "bar",
        xKey: "month",
        series: [
          { key: "upgrades", label: "Upgrades", format: "number" },
          { key: "downgrades", label: "Downgrades", format: "number" },
        ],
        data: MONTHS.map((m, i) => ({
          month: m,
          upgrades: upgrades[i],
          downgrades: downgrades[i],
        })),
        source: SOURCE,
      };
    }
    case 1885:
      // Average Days to Upgrade — scalar.
      return {
        title: preset.name,
        subtitle: preset.blurb,
        chartType: "scalar",
        series: [{ key: "avg_days", label: "Days", format: "number" }],
        data: [{ avg_days: 47 }],
        source: SOURCE,
      };
    case 1886: {
      // Boost Earnings — line, currency.
      const earnings = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      return {
        title: preset.name,
        subtitle: preset.blurb,
        chartType: "line",
        xKey: "month",
        series: [
          { key: "boost_earnings", label: "Boost earnings", format: "currency" },
        ],
        data: MONTHS.map((m, i) => ({ month: m, boost_earnings: earnings[i] })),
        source: SOURCE,
      };
    }
    case 1887:
      // Boost YTD Earnings — scalar, currency.
      return {
        title: preset.name,
        subtitle: preset.blurb,
        chartType: "scalar",
        series: [{ key: "ytd_earnings", label: "YTD Boost earnings", format: "currency" }],
        data: [{ ytd_earnings: 0 }],
        source: SOURCE,
      };
    case 1888: {
      // Ads Earnings — line, currency, slight downward trend.
      const earnings = [58, 56, 53, 49, 41, 32, 24, 16, 12, 8, 4, 0];
      return {
        title: preset.name,
        subtitle: preset.blurb,
        chartType: "line",
        xKey: "month",
        series: [
          { key: "ad_earnings", label: "Ad earnings", format: "currency" },
        ],
        data: MONTHS.map((m, i) => ({ month: m, ad_earnings: earnings[i] })),
        source: SOURCE,
      };
    }
    case 1889:
      // Ads Earnings YTD — scalar, currency.
      return {
        title: preset.name,
        subtitle: preset.blurb,
        chartType: "scalar",
        series: [{ key: "ytd_earnings", label: "YTD ad earnings", format: "currency" }],
        data: [{ ytd_earnings: 124 }],
        source: SOURCE,
      };
    case 1890:
      // Top 5 Acquisition Sources — table.
      return {
        title: preset.name,
        subtitle: preset.blurb,
        chartType: "table",
        xKey: "source",
        xLabel: "Source",
        series: [{ key: "subs_added", label: "Subs added", format: "number" }],
        data: [
          { source: "import: direct / none", subs_added: 132_055 },
          { source: "recommendation: northbridgeweekly.example.com / referral", subs_added: 412 },
          { source: "website: brewmakers.example.com / newsletter", subs_added: 286 },
          { source: "boost: channelecho.example.com / partner", subs_added: 198 },
          { source: "social: instagram / cta", subs_added: 87 },
        ],
        source: SOURCE,
      };
    case 1891:
      // Bottom 5 Acquisition Sources — table.
      return {
        title: preset.name,
        subtitle: preset.blurb,
        chartType: "table",
        xKey: "source",
        xLabel: "Source",
        series: [{ key: "subs_added", label: "Subs added", format: "number" }],
        data: [
          { source: "referral: cafeerzulie.example.com / newsletter", subs_added: 4 },
          { source: "referral: damballa-events.example.com / newsletter", subs_added: 3 },
          { source: "social: twitter / link", subs_added: 2 },
          { source: "search: bing / organic", subs_added: 1 },
          { source: "qr: print-card / event", subs_added: 1 },
        ],
        source: SOURCE,
      };
    case 1892:
      // Average Days to Unsubscribe — scalar.
      return {
        title: preset.name,
        subtitle: preset.blurb,
        chartType: "scalar",
        series: [{ key: "avg_days", label: "Days", format: "number" }],
        data: [{ avg_days: 73 }],
        source: SOURCE,
      };
    default:
      return null;
  }
}
