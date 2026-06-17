"use client";

import { useEffect } from "react";
import { BeehiivLogo } from "@/components/beehiiv-logo";
import { ChartCanvas } from "./chart-canvas";
import { formatValue } from "@/lib/qbr-charts/format";
import type { ChartSpec, SeriesConfig } from "@/lib/qbr-charts/types";

/**
 * QBR slide deck — designed against the Erzulie Year in Review
 * baseline (12-page customer deck the CS team has been hand-building
 * in Keynote / PowerPoint). The framework prints a contiguous run of
 * slides:
 *
 *   1. Cover    — workspace name + "beehiiv Year in Review"
 *   2. Section  — "Account Overview" + reporting period
 *   3. Chart    × N — one per ChartSpec, hasData-only
 *   4. Thanks   — closing slide
 *
 * Visual is dark-navy slide background with a pink section pill, big
 * white title, and a white inset card holding the chart itself
 * (ChartCanvas already uses a light palette so dropping it into white
 * works without theme overrides).
 *
 * Print: each .qbr-deck-slide forces a page break. The non-slide
 * chrome (toolbar, remove buttons) is hidden in print so window.print()
 * → save-as-PDF lands a clean, ready-to-share deck.
 *
 * Why no PPTX export yet: pptxgenjs needs per-chart-type layout work
 * and per-color matching the deck design. Print → PDF is the v1
 * delivery channel; PPTX is a deliberate follow-up.
 */

const DECK_BG = "#0E0A1E";
const ACCENT_PINK = "#E63A8C";
const MUTED_TEXT = "#A8A6BD";
const RAIL_TEXT = "#3A3651";

export interface DeckSlide {
  questionId: number;
  spec: ChartSpec;
}

export interface DeckContext {
  workspaceName: string | null;
  publicationName: string | null;
  startMonth: string | null;
  endMonth: string | null;
}

export function DeckPreview({
  slides,
  context,
  onClose,
  onRemoveSlide,
}: {
  slides: DeckSlide[];
  context: DeckContext;
  onClose: () => void;
  onRemoveSlide: (questionId: number) => void;
}) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const reportingPeriod = formatReportingPeriod(
    context.startMonth,
    context.endMonth
  );
  const scope = context.publicationName ?? "All publications";

  // Cover + divider + thanks add 3 to the chart count for the
  // running slide-number rail.
  const totalPages = slides.length === 0 ? 0 : slides.length + 3;

  return (
    <>
      <style
        dangerouslySetInnerHTML={{
          __html: PRINT_CSS,
        }}
      />

      <div
        className="qbr-deck-print-root fixed inset-0 z-50 overflow-y-auto"
        style={{ background: DECK_BG }}
        role="dialog"
        aria-modal="true"
        aria-label="QBR slide-deck preview"
      >
        <div
          className="qbr-deck-toolbar sticky top-0 z-10 border-b shadow-card"
          style={{ background: "rgba(14, 10, 30, 0.95)", borderColor: "#231C3D" }}
        >
          <div className="max-w-[1280px] mx-auto px-6 py-3 flex items-center gap-3 text-white">
            <div>
              <h2 className="text-base font-semibold">Deck preview</h2>
              <p className="text-[11px]" style={{ color: MUTED_TEXT }}>
                {slides.length === 0
                  ? "No chart slides — load some charts with data first"
                  : `${slides.length} chart ${slides.length === 1 ? "slide" : "slides"} · ${totalPages} pages total`}
              </p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => window.print()}
                disabled={slides.length === 0}
                className="px-3 py-1.5 text-xs font-medium rounded-md disabled:opacity-50"
                style={{ background: ACCENT_PINK, color: "#FFFFFF" }}
              >
                Print / save as PDF
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 text-xs font-medium rounded-md border"
                style={{ borderColor: "#3A3651", color: "#FFFFFF" }}
              >
                Close
              </button>
            </div>
          </div>
        </div>

        <div className="max-w-[1280px] mx-auto px-6 py-8 space-y-8">
          {slides.length === 0 ? (
            <div
              className="text-center text-sm py-20"
              style={{ color: MUTED_TEXT }}
            >
              Nothing in the deck yet. Close this and pick a workspace +
              load charts. Slides are added automatically for any chart
              with data; charts with no data are skipped.
            </div>
          ) : (
            <>
              <CoverSlide
                pageNo={1}
                totalPages={totalPages}
                workspaceName={context.workspaceName}
              />
              <SectionSlide
                pageNo={2}
                totalPages={totalPages}
                title="Account Overview"
                subtitle={reportingPeriod}
              />
              {slides.map((s, i) => (
                <ChartSlide
                  key={s.questionId}
                  slide={s}
                  pageNo={3 + i}
                  totalPages={totalPages}
                  sectionLabel="ACCOUNT OVERVIEW"
                  scope={scope}
                  onRemove={() => onRemoveSlide(s.questionId)}
                />
              ))}
              <ThanksSlide pageNo={totalPages} totalPages={totalPages} />
            </>
          )}
        </div>
      </div>
    </>
  );
}

/* ─── Slide shells ─────────────────────────────────────────── */

/**
 * Common slide frame: 16:9 dark canvas, side rail with vertical
 * "YEAR IN REVIEW" + hive logo, page number bottom-left. The actual
 * content is rendered as children inside the main area to the right
 * of the rail.
 */
function SlideShell({
  pageNo,
  children,
  onRemove,
  showRail = true,
}: {
  pageNo: number;
  totalPages: number;
  children: React.ReactNode;
  onRemove?: () => void;
  showRail?: boolean;
}) {
  return (
    <article
      className="qbr-deck-slide relative w-full overflow-hidden"
      style={{
        aspectRatio: "16 / 9",
        background: DECK_BG,
        color: "#FFFFFF",
      }}
    >
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="qbr-deck-remove absolute top-3 right-3 z-10 text-[11px] px-2 py-1 rounded border"
          style={{
            background: "rgba(255,255,255,0.06)",
            borderColor: "#3A3651",
            color: "#FFFFFF",
          }}
          aria-label="Remove slide from deck"
        >
          Remove
        </button>
      ) : null}

      {showRail ? (
        <>
          {/* Left rail — vertical YEAR IN REVIEW + tiny hive icon. */}
          <div
            className="absolute left-0 top-0 bottom-0 flex flex-col items-center justify-between py-[2%] px-[0.6%] border-r"
            style={{
              width: "3.5%",
              borderColor: "#1A1530",
            }}
          >
            <span style={{ color: RAIL_TEXT }}>
              <BeehiivLogo className="h-4 w-4" />
            </span>
            <div
              className="text-[9px] tracking-[0.25em] uppercase font-semibold"
              style={{
                color: RAIL_TEXT,
                writingMode: "vertical-rl",
                transform: "rotate(180deg)",
                letterSpacing: "0.3em",
              }}
            >
              YEAR IN REVIEW
            </div>
            <span
              className="text-[10px]"
              style={{ color: RAIL_TEXT }}
              aria-label={`Page ${pageNo}`}
            >
              {pageNo}
            </span>
          </div>
        </>
      ) : null}

      <div
        className="absolute inset-0"
        style={{ paddingLeft: showRail ? "3.5%" : 0 }}
      >
        {children}
      </div>
    </article>
  );
}

/* ─── Individual slide layouts ─────────────────────────────── */

function CoverSlide({
  pageNo,
  totalPages,
  workspaceName,
}: {
  pageNo: number;
  totalPages: number;
  workspaceName: string | null;
}) {
  return (
    <SlideShell pageNo={pageNo} totalPages={totalPages} showRail={false}>
      <PillPattern />
      <div className="relative h-full flex flex-col items-center justify-center px-12 text-center">
        <BeehiivLogo className="h-12 w-12 mb-6" />
        <h1
          className="font-bold leading-tight mb-8"
          style={{ fontSize: "clamp(28px, 5vw, 56px)", color: "#FFFFFF" }}
        >
          beehiiv
          <br />
          Year in Review
        </h1>
        {workspaceName ? (
          <div
            className="px-6 py-2.5 rounded-full text-sm font-semibold"
            style={{
              background: ACCENT_PINK,
              color: "#FFFFFF",
            }}
          >
            {workspaceName}
          </div>
        ) : null}
      </div>
    </SlideShell>
  );
}

function SectionSlide({
  pageNo,
  totalPages,
  title,
  subtitle,
}: {
  pageNo: number;
  totalPages: number;
  title: string;
  subtitle: string | null;
}) {
  return (
    <SlideShell pageNo={pageNo} totalPages={totalPages}>
      <div className="relative h-full flex flex-col items-center justify-center px-[6%] text-center">
        <h2
          className="font-bold leading-tight mb-3"
          style={{ fontSize: "clamp(24px, 4vw, 44px)", color: MUTED_TEXT }}
        >
          {title}
        </h2>
        {subtitle ? (
          <p
            className="font-semibold leading-snug max-w-[80%]"
            style={{ fontSize: "clamp(18px, 2.5vw, 28px)", color: MUTED_TEXT }}
          >
            {subtitle}
          </p>
        ) : null}
      </div>
    </SlideShell>
  );
}

function ChartSlide({
  slide,
  pageNo,
  totalPages,
  sectionLabel,
  scope,
  onRemove,
}: {
  slide: DeckSlide;
  pageNo: number;
  totalPages: number;
  sectionLabel: string;
  scope: string;
  onRemove: () => void;
}) {
  const { spec } = slide;
  const total = currencyTotalOf(spec);
  return (
    <SlideShell pageNo={pageNo} totalPages={totalPages} onRemove={onRemove}>
      <div className="relative h-full flex flex-col px-[5%] py-[3.5%]">
        {/* Header: section pill + title + subtitle */}
        <header className="flex-shrink-0">
          <div
            className="inline-block px-4 py-1 rounded-full border text-[10px] tracking-[0.18em] font-bold mb-3"
            style={{
              borderColor: ACCENT_PINK,
              color: "#FFFFFF",
              letterSpacing: "0.18em",
            }}
          >
            {sectionLabel}
          </div>
          <h2
            className="font-bold leading-tight"
            style={{ fontSize: "clamp(20px, 3.3vw, 40px)", color: "#FFFFFF" }}
          >
            {spec.title}
          </h2>
          <p
            className="font-semibold mt-1"
            style={{ fontSize: "clamp(14px, 1.6vw, 18px)", color: "#FFFFFF" }}
          >
            {scope}
          </p>
          {spec.subtitle ? (
            <p
              className="mt-1 max-w-[80%]"
              style={{
                fontSize: "clamp(10px, 1.05vw, 13px)",
                color: "#D4D2E4",
                lineHeight: 1.4,
              }}
            >
              {spec.subtitle}
            </p>
          ) : null}
        </header>

        {/* Optional currency-total accent badge — only shown when the
            chart's primary series is currency-formatted. Matches the
            "Total Ad Earnings: $124" / "Total Boost Earnings: $0" badge
            from the Erzulie deck. */}
        {total ? (
          <div className="self-end mt-3 mb-[-1.5%]" style={{ zIndex: 1 }}>
            <div
              className="px-4 py-2 text-sm font-bold"
              style={{ background: ACCENT_PINK, color: "#FFFFFF" }}
            >
              {total}
            </div>
          </div>
        ) : null}

        {/* Chart card — white interior, chart renders against light
            palette (ChartCanvas already uses light-theme colors). */}
        <div
          className="flex-1 mt-3 p-4 rounded-sm"
          style={{ background: "#FFFFFF", color: "#1F1F2E", minHeight: 0 }}
        >
          <div className="flex flex-col h-full">
            <div
              className="text-[11px] mb-2"
              style={{ color: "#6B6B7B" }}
            >
              {chartLabel(spec)}
            </div>
            <div className="flex-1 min-h-0">
              <ChartCanvas spec={spec} />
            </div>
          </div>
        </div>
      </div>
    </SlideShell>
  );
}

function ThanksSlide({
  pageNo,
  totalPages,
}: {
  pageNo: number;
  totalPages: number;
}) {
  return (
    <SlideShell pageNo={pageNo} totalPages={totalPages} showRail={false}>
      <PillPattern />
      <div className="relative h-full flex flex-col items-center justify-center px-12 text-center">
        <BeehiivLogo className="h-12 w-12 mb-6" />
        <h1
          className="font-bold leading-tight"
          style={{ fontSize: "clamp(36px, 6vw, 64px)", color: "#FFFFFF" }}
        >
          Thank you!
        </h1>
      </div>
    </SlideShell>
  );
}

/* ─── Helpers ──────────────────────────────────────────────── */

/**
 * Decorative pill-pattern background for cover + thanks slides. Pure
 * CSS — small dim circles tiled across the slide. Subtle on purpose
 * so it doesn't fight the centered logo / title.
 */
function PillPattern() {
  return (
    <div
      aria-hidden
      className="absolute inset-0 opacity-30"
      style={{
        backgroundImage:
          "radial-gradient(circle at 1px 1px, #2A2444 1.2px, transparent 1.4px)",
        backgroundSize: "24px 24px",
      }}
    />
  );
}

/**
 * Pull the "(monthly)" / "(annual)" qualifier off the spec when we
 * can. Defaults to the spec's existing subtitle hint. Used as the
 * small label that lives inside the white chart card (e.g.
 * "Subscriber Count Per Month" or "Open & click rate (monthly)").
 */
function chartLabel(spec: ChartSpec): string {
  if (spec.subtitle && /monthly|annual|per month|trend/i.test(spec.subtitle)) {
    return spec.subtitle;
  }
  return `${spec.title} (over time)`;
}

/**
 * If the chart's primary series is currency-formatted, return the
 * summed total formatted with the same hint. Skipped for percent /
 * date / non-currency series — the badge only makes sense for $
 * aggregations (Ad Earnings, Boost Earnings, ARR).
 */
function currencyTotalOf(spec: ChartSpec): string | null {
  const primary: SeriesConfig | undefined = spec.series[0];
  if (!primary || primary.format !== "currency") return null;
  let sum = 0;
  for (const row of spec.data) {
    const v = row[primary.key];
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) sum += n;
  }
  return `Total ${primary.label}: ${formatValue(sum, "currency")}`;
}

/**
 * Format the deck's "Data covers from X to Y" line on the section
 * divider. Both ends optional; if neither is set, fall back to a
 * neutral phrase that still reads.
 */
function formatReportingPeriod(
  start: string | null,
  end: string | null
): string | null {
  if (!start && !end) return "(Data covers all available publications)";
  const fmt = (ymd: string | null) => {
    if (!ymd) return "?";
    const d = new Date(ymd);
    if (Number.isNaN(d.getTime())) return ymd;
    return d.toLocaleString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  };
  return `(Data covers all publications from ${fmt(start)} – ${fmt(end)})`;
}

/* ─── Print CSS ────────────────────────────────────────────── */

const PRINT_CSS = `
  @media print {
    @page {
      size: landscape;
      margin: 0;
    }
    body > *:not(.qbr-deck-print-root) {
      display: none !important;
    }
    .qbr-deck-print-root {
      position: static !important;
      background: ${DECK_BG} !important;
      overflow: visible !important;
    }
    .qbr-deck-toolbar,
    .qbr-deck-remove {
      display: none !important;
    }
    .qbr-deck-print-root > div {
      max-width: none !important;
      padding: 0 !important;
      margin: 0 !important;
    }
    .qbr-deck-print-root > div > div {
      max-width: none !important;
      padding: 0 !important;
      margin: 0 !important;
      gap: 0 !important;
    }
    .qbr-deck-slide {
      break-after: page;
      page-break-after: always;
      width: 100% !important;
      height: 100vh !important;
      aspect-ratio: auto !important;
      box-shadow: none !important;
      border: none !important;
    }
    .qbr-deck-slide:last-of-type {
      break-after: auto;
      page-break-after: auto;
    }
  }
`;
